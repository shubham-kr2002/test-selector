import { Project, SourceFile, SyntaxKind } from 'ts-morph';
import * as path from 'path';
import { FileDiff, ImpactedTest, FileAnalysisResult, AnalysisReport, ImpactType } from './types';

/**
 * Represents extracted test block information including dynamic detection.
 */
interface TestBlockInfo {
  name: string;
  startLine: number;
  endLine: number;
  /**
   * True if the test name uses template literals with variables (${...}).
   * These cannot be safely grepped and require File Mode.
   */
  isDynamic: boolean;
}

/**
 * Analyzer uses ts-morph for AST-based analysis to:
 * 1. Find tests that overlap with changed lines (Intersection Logic)
 * 2. Find tests impacted by dependency changes (Dependency Logic)
 * 3. Detect dynamic test names that cannot be grepped
 */
export class Analyzer {
  private project: Project;
  private repoPath: string;

  constructor(repoPath: string) {
    this.repoPath = repoPath;
    this.project = new Project({
      tsConfigFilePath: path.join(repoPath, 'tsconfig.json'),
      skipAddingFilesFromTsConfig: true,
    });
  }

  /**
   * Checks if a file is a test file based on naming convention.
   * @param filePath - The file path to check
   * @returns True if the file is a test file
   */
  private isTestFile(filePath: string): boolean {
    return filePath.endsWith('.spec.ts') || filePath.endsWith('.test.ts');
  }

  /**
   * Extracts test blocks (test(), it(), describe()) from a source file.
   * Uses AST to find CallExpressions with test-related function names.
   * 
   * Dynamic Test Name Detection:
   * - Detects NoSubstitutionTemplateLiteral (backticks without variables)
   * - Detects TemplateExpression (backticks WITH variables like ${id})
   * - Template expressions with variables are marked as isDynamic: true
   * 
   * @param sourceFile - The ts-morph SourceFile to analyze
   * @returns Array of test information with name, line range, and dynamic flag
   */
  private extractTestBlocks(sourceFile: SourceFile): TestBlockInfo[] {
    const testBlocks: TestBlockInfo[] = [];
    
    // Find all call expressions
    const callExpressions = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression);
    
    for (const callExpr of callExpressions) {
      const expression = callExpr.getExpression();
      const functionName = expression.getText();
      
      // Check if this is a test function (test, it, describe)
      if (['test', 'it', 'describe'].includes(functionName)) {
        const args = callExpr.getArguments();
        const firstArg = args[0];
        
        let testName = 'unnamed test';
        let isDynamic = false;
        
        if (firstArg) {
          const argKind = firstArg.getKind();
          
          // Regular string literal: test('simple name', ...)
          if (argKind === SyntaxKind.StringLiteral) {
            testName = firstArg.getText().slice(1, -1); // Remove quotes
            isDynamic = false;
          }
          // Template literal without substitutions: test(`simple name`, ...)
          else if (argKind === SyntaxKind.NoSubstitutionTemplateLiteral) {
            testName = firstArg.getText().slice(1, -1); // Remove backticks
            isDynamic = false;
          }
          // Template expression with variables: test(`User ${id}`, ...)
          else if (argKind === SyntaxKind.TemplateExpression) {
            // Get the template string but mark as dynamic
            testName = firstArg.getText().slice(1, -1); // Remove backticks
            isDynamic = true;
          }
          // Other expressions (variables, function calls) - treat as dynamic
          else {
            testName = `[dynamic: ${firstArg.getText()}]`;
            isDynamic = true;
          }
        }
        
        const startLine = callExpr.getStartLineNumber();
        const endLine = callExpr.getEndLineNumber();
        
        testBlocks.push({
          name: testName,
          startLine,
          endLine,
          isDynamic,
        });
      }
    }
    
    return testBlocks;
  }

  /**
   * Intersection Algorithm:
   * Checks if any changed lines fall within the test block's line range.
   * Only tests with overlapping changes are selected.
   * 
   * @param testStartLine - The start line of the test block
   * @param testEndLine - The end line of the test block
   * @param changedLines - Array of changed line numbers
   * @returns True if there is an intersection
   */
  private hasIntersection(
    testStartLine: number,
    testEndLine: number,
    changedLines: number[]
  ): boolean {
    return changedLines.some(line => line >= testStartLine && line <= testEndLine);
  }

  /**
   * Checks if a file path is inside node_modules.
   * We skip external library files to avoid unnecessary traversal.
   * 
   * @param filePath - The file path to check
   * @returns True if the file is inside node_modules
   */
  private isNodeModulesFile(filePath: string): boolean {
    const normalizedPath = filePath.replace(/\\/g, '/');
    return normalizedPath.includes('/node_modules/') || normalizedPath.includes('\\node_modules\\');
  }

  /**
   * Finds all files that directly import a given source file.
   * Used as a helper for the BFS transitive dependency search.
   * 
   * @param targetFilePath - The absolute path to the file being imported
   * @returns Array of file paths that import this file
   */
  private findDirectImporters(targetFilePath: string): string[] {
    const importers: string[] = [];
    const targetFileName = path.basename(targetFilePath, '.ts');
    const targetFileNameWithoutExt = targetFileName.replace(/\.tsx?$/, '');
    
    const sourceFiles = this.project.getSourceFiles();
    
    for (const sourceFile of sourceFiles) {
      const filePath = sourceFile.getFilePath();
      
      // Skip node_modules files
      if (this.isNodeModulesFile(filePath)) {
        continue;
      }
      
      // Skip the target file itself
      if (path.resolve(filePath) === path.resolve(targetFilePath)) {
        continue;
      }
      
      // Check imports for the target file
      const importDeclarations = sourceFile.getImportDeclarations();
      for (const importDecl of importDeclarations) {
        const moduleSpecifier = importDecl.getModuleSpecifierValue();
        
        // Check if this import references our target file
        // Handle both relative imports (./helper) and the actual filename
        if (moduleSpecifier.includes(targetFileNameWithoutExt)) {
          importers.push(filePath);
          break;
        }
      }
    }
    
    return importers;
  }

  /**
   * Finds all test files that depend on a given source file using Breadth-First Search.
   * This implements TRANSITIVE dependency tracking - if A imports B, and B imports C,
   * and we change C, this will find A (not just B).
   * 
   * Algorithm (BFS):
   * 1. Start with the changed file in the queue
   * 2. Find all files that import it (parents/importers)
   * 3. If a parent is a Test File, add it to the Impact List
   * 4. If a parent is a Source File (and not visited), add it to queue to find ITS parents
   * 5. Repeat until queue is empty
   * 
   * Cycle Prevention: Use a visited Set to track processed files.
   * Performance: Skip files inside node_modules.
   * 
   * @param sourceFilePath - The path to the changed source file
   * @returns Array of unique test file paths that depend on this file (directly or transitively)
   */
  private findDependentTestFiles(sourceFilePath: string): string[] {
    const impactedTestFiles = new Set<string>();
    const visited = new Set<string>();
    const queue: string[] = [path.resolve(sourceFilePath)];
    
    try {
      // Add all TypeScript files in the project for reference searching
      // Only do this once at the start
      this.project.addSourceFilesAtPaths(path.join(this.repoPath, '**/*.ts'));
      
      // BFS traversal
      while (queue.length > 0) {
        const currentFile = queue.shift()!;
        const normalizedCurrentFile = path.resolve(currentFile);
        
        // Skip if already visited (cycle prevention)
        if (visited.has(normalizedCurrentFile)) {
          continue;
        }
        visited.add(normalizedCurrentFile);
        
        // Skip node_modules files
        if (this.isNodeModulesFile(normalizedCurrentFile)) {
          continue;
        }
        
        // Find all files that import the current file
        const importers = this.findDirectImporters(normalizedCurrentFile);
        
        for (const importerPath of importers) {
          const normalizedImporter = path.resolve(importerPath);
          
          // Skip if already visited
          if (visited.has(normalizedImporter)) {
            continue;
          }
          
          // Skip node_modules
          if (this.isNodeModulesFile(normalizedImporter)) {
            continue;
          }
          
          if (this.isTestFile(importerPath)) {
            // Found a test file - add to impact list
            impactedTestFiles.add(normalizedImporter);
          } else {
            // Source file - add to queue to find its parents (transitive search)
            queue.push(normalizedImporter);
          }
        }
      }
    } catch {
      // If we can't find dependencies, return empty array (silently)
    }
    
    return Array.from(impactedTestFiles);
  }

  /**
   * Analyzes changed files and determines which tests need to run.
   * 
   * For test files (.spec.ts): Uses Intersection Logic to find specific tests.
   * For source files: Uses Dependency Logic to find impacted tests.
   * 
   * @param changedFiles - Array of file diffs from GitService
   * @param commitSha - The commit SHA being analyzed
   * @returns Complete analysis report
   */
  analyze(changedFiles: FileDiff[], commitSha: string): AnalysisReport {
    const fileResults: FileAnalysisResult[] = [];
    const processedTestFiles = new Set<string>();

    for (const fileDiff of changedFiles) {
      const absolutePath = path.resolve(this.repoPath, fileDiff.path);
      
      if (this.isTestFile(fileDiff.path)) {
        // Handle test file changes with Intersection Logic
        const result = this.analyzeTestFile(absolutePath, fileDiff);
        if (result.tests.length > 0 || fileDiff.status === 'DELETED') {
          fileResults.push(result);
          processedTestFiles.add(absolutePath);
        }
      } else if (fileDiff.path.endsWith('.ts') && fileDiff.status !== 'DELETED') {
        // Handle source file changes with Dependency Logic
        const dependentTestFiles = this.findDependentTestFiles(absolutePath);
        
        for (const testFilePath of dependentTestFiles) {
          if (processedTestFiles.has(testFilePath)) {
            continue;
          }
          
          const result = this.analyzeDependentTestFile(testFilePath, fileDiff);
          if (result.tests.length > 0) {
            fileResults.push(result);
            processedTestFiles.add(testFilePath);
          }
        }
      }
    }

    const totalTestsSelected = fileResults.reduce(
      (sum, result) => sum + result.tests.length,
      0
    );

    return {
      commitSha,
      repoPath: this.repoPath,
      fileResults,
      totalTestsSelected,
    };
  }

  /**
   * Analyzes a test file to find tests that intersect with changed lines.
   * 
   * Dynamic Test Name Fallback Strategy:
   * If any impacted test has a dynamic name (template literal with variables),
   * we cannot safely generate a grep pattern for it. In this case:
   * 1. Mark hasDynamicTests: true on the FileAnalysisResult
   * 2. The file should be run in File Mode (without --grep)
   * 3. Dynamic tests are excluded from grep pattern generation
   */
  private analyzeTestFile(absolutePath: string, fileDiff: FileDiff): FileAnalysisResult {
    const tests: ImpactedTest[] = [];
    let hasDynamicTests = false;

    if (fileDiff.status === 'DELETED') {
      // For deleted files, we mark all tests as REMOVED
      try {
        // Note: We can't read deleted files from disk, so we just report the file
        return {
          filePath: fileDiff.path,
          status: fileDiff.status,
          tests: [],
          hasDynamicTests: false,
        };
      } catch {
        return {
          filePath: fileDiff.path,
          status: fileDiff.status,
          tests: [],
          hasDynamicTests: false,
        };
      }
    }

    try {
      const sourceFile = this.project.addSourceFileAtPath(absolutePath);
      const testBlocks = this.extractTestBlocks(sourceFile);

      for (const testBlock of testBlocks) {
        if (this.hasIntersection(testBlock.startLine, testBlock.endLine, fileDiff.changedLines)) {
          // Check if this test has a dynamic name
          if (testBlock.isDynamic) {
            hasDynamicTests = true;
          }
          
          tests.push({
            testName: testBlock.name,
            fileName: fileDiff.path,
            impactType: 'DIRECT',
            isDynamic: testBlock.isDynamic,
          });
        }
      }
    } catch {
      // Silently skip files that can't be parsed
    }

    return {
      filePath: fileDiff.path,
      status: fileDiff.status,
      tests,
      hasDynamicTests,
    };
  }

  /**
   * Analyzes a test file that depends on a changed source file.
   * Marks all tests as DEPENDENCY impact.
   * 
   * Dynamic Test Name Handling:
   * If any test has a dynamic name, mark hasDynamicTests: true.
   */
  private analyzeDependentTestFile(
    testFilePath: string,
    sourceFileDiff: FileDiff
  ): FileAnalysisResult {
    const tests: ImpactedTest[] = [];
    const relativePath = path.relative(this.repoPath, testFilePath);
    let hasDynamicTests = false;

    try {
      const sourceFile = this.project.addSourceFileAtPath(testFilePath);
      const testBlocks = this.extractTestBlocks(sourceFile);

      for (const testBlock of testBlocks) {
        if (testBlock.isDynamic) {
          hasDynamicTests = true;
        }
        
        tests.push({
          testName: testBlock.name,
          fileName: relativePath,
          impactType: 'DEPENDENCY',
          isDynamic: testBlock.isDynamic,
        });
      }
    } catch {
      // Silently skip files that can't be parsed
    }

    return {
      filePath: relativePath,
      status: sourceFileDiff.status,
      tests,
      hasDynamicTests,
    };
  }
}

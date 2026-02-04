import { Project, SourceFile, SyntaxKind } from 'ts-morph';
import * as path from 'path';
import { FileDiff, ImpactedTest, FileAnalysisResult, AnalysisReport, ImpactType } from './types';

/**
 * Analyzer uses ts-morph for AST-based analysis to:
 * 1. Find tests that overlap with changed lines (Intersection Logic)
 * 2. Find tests impacted by dependency changes (Dependency Logic)
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
   * @param sourceFile - The ts-morph SourceFile to analyze
   * @returns Array of test information with name and line range
   */
  private extractTestBlocks(sourceFile: SourceFile): Array<{
    name: string;
    startLine: number;
    endLine: number;
  }> {
    const testBlocks: Array<{ name: string; startLine: number; endLine: number }> = [];
    
    // Find all call expressions
    const callExpressions = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression);
    
    for (const callExpr of callExpressions) {
      const expression = callExpr.getExpression();
      const functionName = expression.getText();
      
      // Check if this is a test function (test, it, describe)
      if (['test', 'it', 'describe'].includes(functionName)) {
        const args = callExpr.getArguments();
        const firstArg = args[0];
        
        // Get the test name from the first argument (should be a string literal)
        let testName = 'unnamed test';
        if (firstArg && firstArg.getKind() === SyntaxKind.StringLiteral) {
          testName = firstArg.getText().slice(1, -1); // Remove quotes
        }
        
        const startLine = callExpr.getStartLineNumber();
        const endLine = callExpr.getEndLineNumber();
        
        testBlocks.push({
          name: testName,
          startLine,
          endLine,
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
   * Finds all test files that import a given source file.
   * Uses ts-morph's reference finding capabilities.
   * 
   * @param sourceFilePath - The path to the source file
   * @returns Array of test file paths that depend on this file
   */
  private findDependentTestFiles(sourceFilePath: string): string[] {
    const dependentTestFiles: string[] = [];
    
    try {
      // Add all TypeScript files in the project for reference searching
      this.project.addSourceFilesAtPaths(path.join(this.repoPath, '**/*.ts'));
      
      const sourceFiles = this.project.getSourceFiles();
      const targetFileName = path.basename(sourceFilePath, '.ts');
      
      for (const sourceFile of sourceFiles) {
        const filePath = sourceFile.getFilePath();
        
        // Only check test files
        if (!this.isTestFile(filePath)) {
          continue;
        }
        
        // Check imports for the changed file
        const importDeclarations = sourceFile.getImportDeclarations();
        for (const importDecl of importDeclarations) {
          const moduleSpecifier = importDecl.getModuleSpecifierValue();
          
          // Check if this import references our changed file
          if (moduleSpecifier.includes(targetFileName)) {
            dependentTestFiles.push(filePath);
            break;
          }
        }
      }
    } catch {
      // If we can't find dependencies, return empty array (silently)
    }
    
    return dependentTestFiles;
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
   */
  private analyzeTestFile(absolutePath: string, fileDiff: FileDiff): FileAnalysisResult {
    const tests: ImpactedTest[] = [];

    if (fileDiff.status === 'DELETED') {
      // For deleted files, we mark all tests as REMOVED
      try {
        // Note: We can't read deleted files from disk, so we just report the file
        return {
          filePath: fileDiff.path,
          status: fileDiff.status,
          tests: [],
        };
      } catch {
        return {
          filePath: fileDiff.path,
          status: fileDiff.status,
          tests: [],
        };
      }
    }

    try {
      const sourceFile = this.project.addSourceFileAtPath(absolutePath);
      const testBlocks = this.extractTestBlocks(sourceFile);

      for (const testBlock of testBlocks) {
        if (this.hasIntersection(testBlock.startLine, testBlock.endLine, fileDiff.changedLines)) {
          tests.push({
            testName: testBlock.name,
            fileName: fileDiff.path,
            impactType: 'DIRECT',
          });
        }
      }
    } catch (error) {
      // Silently skip files that can't be parsed
    }

    return {
      filePath: fileDiff.path,
      status: fileDiff.status,
      tests,
    };
  }

  /**
   * Analyzes a test file that depends on a changed source file.
   * Marks all tests as DEPENDENCY impact.
   */
  private analyzeDependentTestFile(
    testFilePath: string,
    sourceFileDiff: FileDiff
  ): FileAnalysisResult {
    const tests: ImpactedTest[] = [];
    const relativePath = path.relative(this.repoPath, testFilePath);

    try {
      const sourceFile = this.project.addSourceFileAtPath(testFilePath);
      const testBlocks = this.extractTestBlocks(sourceFile);

      for (const testBlock of testBlocks) {
        tests.push({
          testName: testBlock.name,
          fileName: relativePath,
          impactType: 'DEPENDENCY',
        });
      }
    } catch {
      // Silently skip files that can't be parsed
    }

    return {
      filePath: relativePath,
      status: sourceFileDiff.status,
      tests,
    };
  }
}

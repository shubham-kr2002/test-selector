#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import * as path from 'path';
import * as fs from 'fs';
import { Project } from 'ts-morph';
import { GitService } from './git';
import { Analyzer } from './analyzer';
import { AnalysisReport, FileAnalysisResult, FileStatus, ImpactType, FileDiff } from './types';

/**
 * Smart Test Selector CLI
 * 
 * Identifies which tests need to run based on a Git commit SHA.
 * Uses AST analysis to provide granular test selection.
 */

const program = new Command();

program
  .name('test-selector')
  .description('Identify which tests need to run based on Git changes')
  .version('1.0.0')
  .option('--commit <sha>', 'The commit SHA to compare against HEAD')
  .requiredOption('--repo <path>', 'Path to the Git repository')
  .option('--json', 'Output results as JSON (for CI pipelines)', false)
  .option('--all', 'Analyze ALL tests in the repository (ignores git)', false)
  .parse(process.argv);

const options = program.opts<{ commit?: string; repo: string; json: boolean; all: boolean }>();

/**
 * JSON output schema for CI pipelines.
 */
interface JsonOutput {
  files: string[];
  tests: string[];
  /** Playwright-compatible regex pattern for -g/--grep flag */
  grep: string;
  /** Files that contain dynamic test names and must be run in File Mode */
  filesWithDynamicTests: string[];
  /** True if any tests have dynamic names requiring File Mode fallback */
  hasDynamicTests: boolean;
}

/**
 * Escapes special regex characters in a string.
 * This ensures test names with special characters like () [] ? + * don't break the regex pattern.
 * 
 * @param str - The string to escape
 * @returns The escaped string safe for use in regex
 */
function escapeRegExp(str: string): string {
  // Escape all regex special characters: \ ^ $ . | ? * + ( ) [ ] { }
  return str.replace(/[\\^$.|?*+()\[\]{}]/g, '\\$&');
}

/**
 * Logger utility that respects JSON mode.
 * In JSON mode, all logging is silenced to avoid breaking JSON parsing.
 */
const logger = {
  log: (...args: unknown[]): void => {
    if (!options.json) {
      console.log(...args);
    }
  },
  error: (...args: unknown[]): void => {
    if (!options.json) {
      console.error(...args);
    }
  },
};

/**
 * Returns a chalk color function based on file status.
 * @param status - The file status
 * @returns Chalk color function
 */
function getStatusColor(status: FileStatus): typeof chalk.green {
  switch (status) {
    case 'ADDED':
      return chalk.green;
    case 'MODIFIED':
      return chalk.yellow;
    case 'DELETED':
      return chalk.red;
    case 'RENAMED':
      return chalk.blue;
    default:
      return chalk.white;
  }
}

/**
 * Returns a status icon based on file status.
 * @param status - The file status
 * @returns Status icon string
 */
function getStatusIcon(status: FileStatus): string {
  switch (status) {
    case 'ADDED':
      return '✚';
    case 'MODIFIED':
      return '●';
    case 'DELETED':
      return '✖';
    case 'RENAMED':
      return '➜';
    default:
      return '○';
  }
}

/**
 * Returns a label for the impact type.
 * @param impactType - The impact type
 * @returns Chalk-formatted label
 */
function getImpactLabel(impactType: ImpactType): string {
  switch (impactType) {
    case 'DIRECT':
      return chalk.cyan('[DIRECT IMPACT]');
    case 'DEPENDENCY':
      return chalk.magenta('[DEPENDENCY]');
    case 'REMOVED':
      return chalk.red('[REMOVED]');
    default:
      return chalk.gray('[UNKNOWN]');
  }
}

/**
 * Prints a file result group to the console.
 * @param fileResult - The file analysis result to print
 */
function printFileResult(fileResult: FileAnalysisResult): void {
  const color = getStatusColor(fileResult.status);
  const icon = getStatusIcon(fileResult.status);
  
  logger.log();
  logger.log(color(`${icon} ${fileResult.filePath} [${fileResult.status}]`));
  
  // REMOVED THE BLOCKER HERE (The "if DELETED return" check)
  
  if (fileResult.tests.length === 0) {
    if (fileResult.status === 'DELETED') {
      logger.log(chalk.gray('   └── File was deleted (No specific tests found)'));
    } else {
      logger.log(chalk.gray('   └── No tests affected'));
    }
    return;
  }
  
  for (let i = 0; i < fileResult.tests.length; i++) {
    const test = fileResult.tests[i];
    if (!test) continue;
    
    const isLast = i === fileResult.tests.length - 1;
    const prefix = isLast ? '└──' : '├──';
    
    // Handle REMOVED impact specifically
    let impactLabel = getImpactLabel(test.impactType);
    if (test.impactType === 'REMOVED') {
      impactLabel = chalk.red('[REMOVED]');
    }
    
    logger.log(
      chalk.gray(`   ${prefix} `) +
      chalk.white(`"${test.testName}"`) +
      ` ${impactLabel}`
    );
  }
}

/**
 * Prints the complete analysis report to the console.
 * @param report - The analysis report to print
 */
function printReport(report: AnalysisReport): void {
  logger.log();
  logger.log(chalk.bold.underline('📊 Smart Test Selector Report'));
  logger.log();
  logger.log(chalk.gray('Commit:    ') + chalk.white(report.commitSha));
  logger.log(chalk.gray('Repo:      ') + chalk.white(report.repoPath));
  logger.log(chalk.gray('Files:     ') + chalk.white(report.fileResults.length.toString()));
  logger.log(chalk.gray('Tests:     ') + chalk.white(report.totalTestsSelected.toString()));
  
  logger.log();
  logger.log(chalk.bold('Legend:'));
  logger.log(chalk.green('  ✚ ADDED') + chalk.gray(' - New files'));
  logger.log(chalk.yellow('  ● MODIFIED') + chalk.gray(' - Changed files'));
  logger.log(chalk.red('  ✖ DELETED') + chalk.gray(' - Removed files'));
  logger.log(chalk.blue('  ➜ RENAMED') + chalk.gray(' - Renamed files'));
  logger.log(chalk.cyan('  [DIRECT IMPACT]') + chalk.gray(' - Test code was changed'));
  logger.log(chalk.magenta('  [DEPENDENCY]') + chalk.gray(' - Test depends on changed code'));
  logger.log(chalk.red('  [REMOVED]') + chalk.gray(' - Test was removed'));
  
  logger.log();
  logger.log(chalk.bold('─'.repeat(60)));
  logger.log(chalk.bold('Tests by File:'));
  
  for (const fileResult of report.fileResults) {
    printFileResult(fileResult);
  }
  
  logger.log();
  logger.log(chalk.bold('─'.repeat(60)));
  logger.log();
  
  if (report.totalTestsSelected === 0) {
    logger.log(chalk.yellow('⚠ No tests were selected to run.'));
  } else {
    logger.log(
      chalk.green(`✓ ${report.totalTestsSelected} test(s) selected across ${report.fileResults.length} file(s).`)
    );
  }
  
  logger.log();
}

/**
 * Converts an analysis report to JSON output format.
 * Generates a Playwright-compatible grep pattern for granular test execution.
 * 
 * Dynamic Test Name Fallback Strategy:
 * - Tests with dynamic names (template literals with ${...}) cannot be safely grepped
 * - If a file contains dynamic tests, it's added to filesWithDynamicTests
 * - Dynamic tests are EXCLUDED from the grep pattern
 * - The runner script should detect hasDynamicTests and run those files in File Mode
 * 
 * @param report - The analysis report to convert
 * @returns JSON output object with files, tests arrays, grep pattern, and dynamic test info
 */
function toJsonOutput(report: AnalysisReport): JsonOutput {
  const filesSet = new Set<string>();
  const testsSet = new Set<string>();
  const dynamicFilesSet = new Set<string>();
  let hasDynamicTests = false;

  for (const fileResult of report.fileResults) {
    // Check if this file has dynamic tests
    if (fileResult.hasDynamicTests) {
      hasDynamicTests = true;
      dynamicFilesSet.add(fileResult.filePath);
      // Still add to files list for File Mode execution
      filesSet.add(fileResult.filePath);
      // Skip adding tests from this file to the grep pattern
      continue;
    }

    // Add file path if it has impacted tests
    if (fileResult.tests.length > 0) {
      filesSet.add(fileResult.filePath);
    }

    // Add each non-dynamic test name
    for (const test of fileResult.tests) {
      // Double-check: skip individual dynamic tests even if file isn't flagged
      if (test.isDynamic) {
        hasDynamicTests = true;
        dynamicFilesSet.add(fileResult.filePath);
        continue;
      }
      testsSet.add(test.testName);
    }
  }

  const testsArray = Array.from(testsSet);
  
  // Generate Playwright-compatible grep pattern
  // Only include non-dynamic test names
  // Join escaped test names with | (OR operator in regex)
  const grepPattern = testsArray.length > 0
    ? testsArray.map(escapeRegExp).join('|')
    : '';

  return {
    files: Array.from(filesSet),
    tests: testsArray,
    grep: grepPattern,
    filesWithDynamicTests: Array.from(dynamicFilesSet),
    hasDynamicTests,
  };
}

/**
 * Main entry point for the CLI.
 */
async function main(): Promise<void> {
  try {
    // Resolve the repository path (handles relative paths)
    const repoPath = path.resolve(options.repo);
    const commitSha = options.commit || 'ALL';
    
    // Validate required options
    if (!options.all && !options.commit) {
      if (options.json) {
        console.log(JSON.stringify({ files: [], tests: [], grep: "" }));
        process.exit(1);
      }
      logger.error(chalk.red('✖ Error: Either --commit or --all must be specified'));
      process.exit(1);
    }
    
    // Validate repository path exists
    if (!fs.existsSync(repoPath)) {
      if (options.json) {
        // In JSON mode, output empty result and exit
        console.log(JSON.stringify({ files: [], tests: [], grep: "" }));
        process.exit(1);
      }
      logger.error(chalk.red(`✖ Error: Repository path does not exist: ${repoPath}`));
      process.exit(1);
    }
    
    // Check if path is a directory
    const stat = fs.statSync(repoPath);
    if (!stat.isDirectory()) {
      if (options.json) {
        console.log(JSON.stringify({ files: [], tests: [], grep: "" }));
        process.exit(1);
      }
      logger.error(chalk.red(`✖ Error: Path is not a directory: ${repoPath}`));
      process.exit(1);
    }
    
    logger.log(chalk.gray('Analyzing changes...'));
    logger.log(chalk.gray(`Repository: ${repoPath}`));
    logger.log(chalk.gray(`Commit: ${commitSha}`));
    
    let changedFiles: FileDiff[];
    
    if (options.all) {
      // --- NEW LOGIC: SCAN EVERYTHING ---
      logger.log(chalk.blue('🔍 Scanning entire repository (Mode: ALL)...'));
      
      // Create a temporary project just to get all source files
      const project = new Project({
        tsConfigFilePath: path.join(repoPath, 'tsconfig.json'),
        skipAddingFilesFromTsConfig: false,
      });
      
      // Get every .ts file in the repo
      const allSourceFiles = project.getSourceFiles();
      
      // Filter out node_modules and map to FileDiff structure
      changedFiles = allSourceFiles
        .filter(file => {
          const filePath = file.getFilePath();
          return !filePath.includes('node_modules');
        })
        .map(file => ({
          path: path.relative(repoPath, file.getFilePath()),
          status: 'MODIFIED' as const, // Pretend everything is modified so the analyzer checks it
          changedLines: [], // Empty since we're analyzing all tests
        }));
      
      logger.log(chalk.gray(`Found ${changedFiles.length} source file(s) to analyze.`));
      logger.log();
      
    } else {
      // --- EXISTING LOGIC: GIT ONLY ---
      // Instantiate GitService and fetch changed files
      const gitService = new GitService(repoPath);
      
      try {
        changedFiles = await gitService.getChangedFiles(commitSha);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        if (options.json) {
          console.log(JSON.stringify({ files: [], tests: [], grep: "" }));
          process.exit(1);
        }
        logger.error(chalk.red(`✖ Git Error: ${message}`));
        process.exit(1);
      }
      
      // Exit early if no changes found
      if (changedFiles.length === 0) {
        if (options.json) {
          console.log(JSON.stringify({ files: [], tests: [], grep: "" }));
          process.exit(0);
        }
        logger.log();
        logger.log(chalk.yellow('⚠ No file changes found between the commit and HEAD.'));
        logger.log(chalk.gray('This could mean:'));
        logger.log(chalk.gray('  • The commit SHA is the same as HEAD'));
        logger.log(chalk.gray('  • All changes have been reverted'));
        logger.log();
        process.exit(0);
      }
      
      logger.log(chalk.gray(`Found ${changedFiles.length} changed file(s).`));
      logger.log();
    }
    
    // Calculate parent commit SHA for REMOVED test detection
    let parentCommitSha: string | null = null;
    let activeGitService: GitService | null = null;
    
    if (!options.all && options.commit) {
      activeGitService = new GitService(repoPath);
      try {
        parentCommitSha = await activeGitService.getParentCommitSha(options.commit);
        if (parentCommitSha) {
          logger.log(chalk.gray(`Parent commit: ${parentCommitSha.substring(0, 8)}...`));
        }
      } catch {
        // No parent commit (initial commit) - continue without REMOVED detection
        logger.log(chalk.gray('No parent commit found (initial commit or shallow clone).'));
      }
    }
    
    // Instantiate Analyzer and analyze the changes
    const analyzer = new Analyzer(repoPath);
    
    // Safety wrap: Catch AST parsing errors and fall back gracefully
    let report: AnalysisReport;
    try {
      report = await analyzer.analyze(changedFiles, commitSha, parentCommitSha, activeGitService);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.log(chalk.yellow(`⚠ Analysis error: ${errorMessage}`));
      logger.log(chalk.yellow('⚠ Falling back to File Mode (all changed files will be tested).'));
      
      // Fallback: Create a minimal report with just file paths
      const fallbackResults: FileAnalysisResult[] = changedFiles
        .filter(f => f.path.endsWith('.spec.ts') || f.path.endsWith('.test.ts'))
        .map(f => ({
          filePath: f.path,
          status: f.status,
          tests: [],
          hasDynamicTests: true, // Force file mode
        }));
      
      report = {
        commitSha,
        repoPath,
        fileResults: fallbackResults,
        totalTestsSelected: 0,
      };
    }
    
    // Output based on mode
    if (options.json) {
      // JSON mode: Output single valid JSON object
      const jsonOutput = toJsonOutput(report);
      console.log(JSON.stringify(jsonOutput));
    } else {
      // Human-readable mode: Print the colorized report
      printReport(report);
    }
    
  } catch (error) {
    const message = error instanceof Error ? error.message : 'An unexpected error occurred';
    if (options.json) {
      console.log(JSON.stringify({ files: [], tests: [], grep: "" }));
      process.exit(1);
    }
    logger.error(chalk.red(`✖ Error: ${message}`));
    process.exit(1);
  }
}

// Run the CLI
main().catch((error: unknown) => {
  if (options.json) {
    console.log(JSON.stringify({ files: [], tests: [], grep: "" }));
  } else {
    console.error(chalk.red('Fatal error:'), error);
  }
  process.exit(1);
});

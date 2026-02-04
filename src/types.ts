/**
 * Represents a file diff with specific changed lines.
 * Shared between GitService (producer) and Analyzer (consumer).
 */
export interface FileDiff {
  path: string;
  status: 'ADDED' | 'MODIFIED' | 'DELETED' | 'RENAMED';
  changedLines: number[]; // The specific line numbers (e.g., [10, 11, 12])
}

/**
 * The type of impact that caused a test to be selected.
 */
export type ImpactType = 'DIRECT' | 'DEPENDENCY' | 'REMOVED';

/**
 * Represents a test that has been impacted by changes.
 */
export interface ImpactedTest {
  testName: string;
  fileName: string;
  impactType: ImpactType;
}

/**
 * Helper type for file status.
 */
export type FileStatus = FileDiff['status'];

/**
 * Represents the analysis result for a single file.
 */
export interface FileAnalysisResult {
  /** The file path */
  filePath: string;
  /** The status of the file */
  status: FileStatus;
  /** The tests selected from this file */
  tests: ImpactedTest[];
}

/**
 * The complete analysis report.
 */
export interface AnalysisReport {
  /** The commit SHA that was analyzed */
  commitSha: string;
  /** The repository path */
  repoPath: string;
  /** Results grouped by file */
  fileResults: FileAnalysisResult[];
  /** Total number of tests selected */
  totalTestsSelected: number;
}

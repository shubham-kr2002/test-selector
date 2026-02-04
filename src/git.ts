import simpleGit, { SimpleGit } from 'simple-git';
import { FileDiff, FileStatus } from './types';

/**
 * GitService handles all Git operations for retrieving file changes.
 * Uses `git diff -U0` (zero context) to get precise line-level changes.
 */
export class GitService {
  private git: SimpleGit;
  private repoPath: string;

  constructor(repoPath: string) {
    this.repoPath = repoPath;
    this.git = simpleGit(repoPath);
  }

  /**
   * Validates that the repository path is a valid Git repository.
   * @throws Error if not a valid Git repository
   */
  async validateRepository(): Promise<void> {
    const isRepo = await this.git.checkIsRepo();
    if (!isRepo) {
      throw new Error(`Path "${this.repoPath}" is not a valid Git repository.`);
    }
  }

  /**
   * Validates that a commit SHA exists in the repository.
   * @param sha - The commit SHA to validate
   * @throws Error if the SHA is invalid
   */
  async validateCommitSha(sha: string): Promise<void> {
    try {
      await this.git.revparse([sha]);
    } catch {
      throw new Error(`Invalid commit SHA: "${sha}"`);
    }
  }

  /**
   * Parses unified diff hunk headers to extract changed line numbers.
   * Hunk format: @@ -oldStart,oldCount +newStart,newCount @@
   * 
   * @param hunkHeader - The hunk header string (e.g., "@@ -10,0 +15,3 @@")
   * @returns Array of line numbers that were changed in the new file
   */
  private parseHunkHeader(hunkHeader: string): number[] {
    const changedLines: number[] = [];
    
    // Match the new file portion: +start,count or +start
    const match = hunkHeader.match(/@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (!match) {
      return changedLines;
    }

    const startLine = parseInt(match[1] ?? '0', 10);
    const lineCount = parseInt(match[2] ?? '1', 10);

    // Generate all changed line numbers
    for (let i = 0; i < lineCount; i++) {
      changedLines.push(startLine + i);
    }

    return changedLines;
  }

  /**
   * Gets all file changes introduced by a specific commit.
   * Uses `git show -U0` for zero-context diffs to get precise line numbers.
   * 
   * @param commitSha - The commit SHA to analyze
   * @returns Array of FileDiff objects with changed line information
   */
  async getChangedFiles(commitSha: string): Promise<FileDiff[]> {
    await this.validateRepository();
    await this.validateCommitSha(commitSha);

    try {
      // Use 'git show' to get the changes INTRODUCED by this specific commit
      // -U0: Zero context (we only want changed lines)
      // --format="": Skip the commit message header
      const rawDiff = await this.git.raw([
        'show',
        '--format=',
        '-U0',
        commitSha,
      ]);

      // Also get name-status for this specific commit
      const statusOutput = await this.git.raw([
        'show',
        '--name-status',
        '--format=',
        commitSha,
      ]);

      // Debug: Uncomment to see raw git output
      // console.log('[DEBUG] Git show output:', rawDiff.substring(0, 500));

      // Parse file statuses
      const fileStatuses = new Map<string, FileStatus>();
      const statusLines = statusOutput.split('\n').filter(line => line.trim());

      for (const line of statusLines) {
        // Skip diff headers and hunk lines
        if (line.startsWith('diff ') || line.startsWith('@@') || 
            line.startsWith('index ') || line.startsWith('---') || 
            line.startsWith('+++') || line.startsWith('+') || 
            line.startsWith('-') || line.startsWith('\\')) {
          continue;
        }

        const parts = line.split('\t');
        if (parts.length >= 2) {
          const statusChar = parts[0]?.charAt(0);
          // For renames (R100), the new path is in parts[2], otherwise parts[1]
          const filePath = parts.length >= 3 ? parts[2] ?? '' : parts[1] ?? '';

          if (!filePath) continue;

          let status: FileStatus;
          switch (statusChar) {
            case 'A':
              status = 'ADDED';
              break;
            case 'D':
              status = 'DELETED';
              break;
            case 'R':
              status = 'RENAMED';
              break;
            default:
              status = 'MODIFIED';
          }

          fileStatuses.set(filePath, status);
        }
      }

      // Parse the diff output to extract changed lines per file
      const fileDiffs: FileDiff[] = [];
      let currentFile: string | null = null;
      let currentChangedLines: number[] = [];

      const diffLines = rawDiff.split('\n');

      for (const line of diffLines) {
        // Match file header: diff --git a/path b/path
        const fileMatch = line.match(/^diff --git a\/.+ b\/(.+)$/);
        if (fileMatch) {
          // Save previous file if exists
          if (currentFile !== null) {
            fileDiffs.push({
              path: currentFile,
              status: fileStatuses.get(currentFile) ?? 'MODIFIED',
              changedLines: [...currentChangedLines],
            });
          }

          currentFile = fileMatch[1] ?? '';
          currentChangedLines = [];
          continue;
        }

        // Match hunk headers: @@ -start,count +start,count @@
        if (line.startsWith('@@')) {
          const lineNumbers = this.parseHunkHeader(line);
          currentChangedLines.push(...lineNumbers);
        }
      }

      // Don't forget the last file
      if (currentFile !== null) {
        fileDiffs.push({
          path: currentFile,
          status: fileStatuses.get(currentFile) ?? 'MODIFIED',
          changedLines: [...currentChangedLines],
        });
      }

      return fileDiffs;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown git error';
      throw new Error(`Failed to get changed files for commit ${commitSha}: ${message}`);
    }
  }
}

# Smart Test Selector 🧠

A granular impact analysis tool for Playwright repositories. It uses AST (Abstract Syntax Tree) parsing and dependency graph traversal to determine exactly which tests need to run based on a Git commit SHA.

## 🚀 Features

* **Granular Selection:** Runs only the specific *test cases* modified, not the whole file.
* **Dependency Tracking:** Detects when a helper file (e.g., `pages/github.ts`) changes and finds all tests that import it.
* **Machine-Readable Output:** Outputs structured JSON for CI/CD integration.
* **Playwright Bridge:** Includes a PowerShell runner that automatically feeds impacted tests into Playwright.
* **Zero Context Diffs:** Uses `git show --format= -U0` for precise line-level change detection.

## ⚡ Quick Start

### 1. Install Dependencies
```bash
npm install
```

### 2. CLI Mode (JSON Output)
Analyze a commit without running tests:
```bash
npx ts-node src/index.ts --repo <path-to-target-repo> --commit <SHA> --json
```

**Output:**
```json
{
  "files": ["tests/auth.spec.ts", "tests/pages/helpers.ts"],
  "tests": ["should login successfully", "should handle errors"],
  "grep": "should login successfully|should handle errors"
}
```

### 3. The Magic Runner (Analysis + Execution)
Analyze changes AND run Playwright tests automatically:

**PowerShell:**
```powershell
./run-smart-tests.ps1 -RepoPath "../flash-tests" -CommitSha "HEAD"
```

**Bash:**
```bash
./run-smart-tests.sh ../flash-tests HEAD
```

## 📁 Project Structure

```
src/
├── types.ts        # Shared interfaces (FileDiff, ImpactedTest, etc.)
├── git.ts          # Git service (commit analysis, file changes)
├── analyzer.ts     # AST parser (test detection, dependency mapping)
└── index.ts        # CLI entry point (commander, chalk, orchestration)

run-smart-tests.ps1 # Production-grade PowerShell runner
run-smart-tests.sh  # Bash runner (Unix/macOS)
```

## 🔧 How It Works

1. **Git Analysis:** Fetches changed files and line numbers using `git show`
2. **AST Parsing:** Uses `ts-morph` to extract test blocks from `*.spec.ts` files
3. **Intersection Logic:** Maps changed lines to specific test cases
4. **Dependency Resolution:** For non-test files, finds all tests that import them
5. **Grep Generation:** Creates a regex pattern compatible with Playwright's `--grep` flag

## 📊 Example Output

```
✓ Smart Test Selector Report

Repository: /path/to/flash-tests
Commit:     abc123def456

📋 Analysis Results:
   Files impacted: 3
   Tests impacted: 5

✓ Impacted Tests:
   [+] should verify branch restore
   [+] should handle merge conflicts
   [+] should validate PR comments
   [+] should process commits
   [+] should update status

🎯 Launching Playwright with --grep filter...
```

## 🎯 CI/CD Integration

Use the `--json` flag to integrate with your CI pipeline:

```bash
result=$(npx ts-node src/index.ts --repo . --commit HEAD --json)
tests=$(echo $result | jq -r '.tests | join("|")')
npx playwright test --grep "$tests"
```

## 🛠️ Tech Stack

* **Runtime:** Node.js + TypeScript
* **Git:** `simple-git` (wrapper), `git show -U0` (zero context diffs)
* **AST Parser:** `ts-morph`
* **CLI:** `commander`, `chalk`

## 📝 License

MIT

---

**Built for developers who care about fast CI/CD pipelines.** ⚡

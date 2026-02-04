# Smart Test Selector 🧠

A granular test impact analysis tool for Playwright repositories. It uses **AST Parsing (ts-morph)** and **Dependency Graphing** to determine exactly which tests need to run based on a Git commit SHA.

## 🚀 Features

* **Granular Selection:** Identifies specific `test()` blocks modified, not just files.
* **Dependency Tracking:** Recursively finds tests that depend on modified helper files.
* **Time Travel Analysis:** Detects and lists names of **Deleted Tests** by analyzing previous commit history.
* **Playwright Bridge:** Includes a PowerShell runner that pipes the analysis directly to `npx playwright test`.
* **Zero Context Diffs:** Uses `git show --format= -U0` for precise line-level change detection.
* **Dynamic Test Detection:** Flags tests with template literals that cannot be grepped safely.
* **Transitive Dependencies:** BFS-based traversal to find all impacted tests across the dependency graph.

## 🛠️ Setup & Usage

**Prerequisites:** Node.js >= 18

### 1. Clone this repo:
```bash
git clone https://github.com/shubham-kr2002/test-selector.git
cd test-selector
```

### 2. Install & Build:
```bash
npm install
npm run build
```

### 3. Link (Optional - for CLI usage):
```bash
npm link
```

## 🏃 How to Run

You can run the tool against any local clone of your test repository.

### Option 1: CLI Analysis (Human-Readable Report)
```bash
# If npm link was used:
smart-test --repo <path-to-repo> --commit HEAD

# Or using node directly:
node dist/index.js --repo <path-to-repo> --commit HEAD
```

### Option 2: JSON Output (for CI/CD)
```bash
smart-test --repo <path-to-repo> --commit HEAD --json
```

**Output:**
```json
{
  "files": ["tests/auth.spec.ts"],
  "tests": ["should login successfully", "should handle errors"],
  "grep": "should login successfully|should handle errors",
  "filesWithDynamicTests": [],
  "hasDynamicTests": false
}
```

### Option 3: Run the Actual Tests (PowerShell)
This script analyzes the changes and automatically runs the impacted tests in Playwright.

```powershell
./run-smart-tests.ps1 -RepoPath "../flash-tests" -CommitSha "HEAD"
```

### Option 4: Scan All Tests (No Git)
Analyze ALL tests in the repository without Git dependency:

```bash
smart-test --repo <path-to-repo> --all
```

## 📁 Project Structure

```
src/
├── types.ts        # Shared interfaces (FileDiff, ImpactedTest, AnalysisReport)
├── git.ts          # Git service (commit analysis, file changes, time travel)
├── analyzer.ts     # AST parser (test detection, dependency mapping, REMOVED tests)
└── index.ts        # CLI entry point (commander, chalk, orchestration)

run-smart-tests.ps1 # Production-grade PowerShell runner
run-smart-tests.sh  # Bash runner (Unix/macOS)
```

## 🔧 How It Works

1. **Git Analysis:** Fetches changed files and line numbers using `git show -U0`
2. **AST Parsing:** Uses `ts-morph` to extract test blocks from `*.spec.ts` files
3. **Intersection Logic:** Maps changed lines to specific test cases (not whole files)
4. **Dependency Resolution:** For non-test files, finds all tests that import them (transitive BFS)
5. **REMOVED Test Detection:** Compares current vs parent commit to find deleted tests
6. **Grep Generation:** Creates a regex pattern compatible with Playwright's `--grep` flag

## 📊 Example Output

```
📊 Smart Test Selector Report

Commit:    HEAD
Repo:      C:\projects\flash-tests
Files:     3
Tests:     5

Legend:
  ✚ ADDED - New files
  ● MODIFIED - Changed files
  ✖ DELETED - Removed files
  ➜ RENAMED - Renamed files
  [DIRECT IMPACT] - Test code was changed
  [DEPENDENCY] - Test depends on changed code
  [REMOVED] - Test was removed

────────────────────────────────────────────────────────────
Tests by File:

● tests/auth.spec.ts [MODIFIED]
  ├── "should login successfully" [DIRECT IMPACT]
  └── "should handle errors" [DIRECT IMPACT]

✖ tests/analytics.spec.ts [DELETED]
  ├── "should track session view events" [REMOVED]
  └── "should track button clicks" [REMOVED]

────────────────────────────────────────────────────────────

✓ 4 test(s) selected across 2 file(s).
```

## 🎯 CI/CD Integration

Use the `--json` flag to integrate with your CI pipeline:

### GitHub Actions
```yaml
- name: Run Smart Test Selector
  run: |
    result=$(node dist/index.js --repo . --commit HEAD --json)
    grep_pattern=$(echo $result | jq -r '.grep')
    npx playwright test --grep "$grep_pattern"
```

### GitLab CI
```yaml
test:
  script:
    - npm run build
    - GREP=$(node dist/index.js --repo . --commit HEAD --json | jq -r '.grep')
    - npx playwright test --grep "$GREP"
```

## ⚠️ Troubleshooting

### Error: Shallow Clone Detected
If you see:
```
✖ Error: This is a shallow clone. The Analyzer needs history to compare changes.
```

**Fix:** Update your CI checkout configuration:
```yaml
- uses: actions/checkout@v4
  with:
    fetch-depth: 0  # Fetch full history
```

### Error: Invalid Commit SHA
```bash
✖ Error: Invalid commit SHA: "INVALID_SHA"
```
Ensure the commit exists in your repository. Use `git log` to verify.

## 🧪 Testing

Test the tool on itself:
```bash
smart-test --repo . --commit HEAD
```

## 📝 License

MIT

## 🛠️ Tech Stack

* **Runtime:** Node.js + TypeScript
* **Git:** `simple-git` (wrapper), `git show -U0` (zero context diffs)
* **AST Parser:** `ts-morph`
* **CLI:** `commander`, `chalk`

## 📝 License

MIT

---

**Built for developers who care about fast CI/CD pipelines.** ⚡

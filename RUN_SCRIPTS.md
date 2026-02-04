# Smart Test Selector - Runner Scripts

This directory contains integration scripts that bridge the Smart Test Selector CLI with Playwright, enabling granular test execution based on code changes.

## Overview

The Smart Test Selector analyzes git commits and identifies which tests need to run. The runner scripts take this analysis and invoke Playwright with only the impacted tests, saving CI time and resources.

## Scripts

### PowerShell: `run-smart-tests.ps1`

**Platform:** Windows

**Usage:**
```powershell
# Run with default settings (analyzes HEAD)
./run-smart-tests.ps1

# Analyze a specific commit
./run-smart-tests.ps1 -CommitSha "abc123def"

# Enable verbose output
./run-smart-tests.ps1 -Verbose

# From a different directory
./run-smart-tests.ps1 -RepoPath "C:\path\to\flash-tests"
```

**Features:**
- ✅ Automatic path resolution
- ✅ JSON validation
- ✅ Granular test execution using `--grep`
- ✅ Verbose mode for debugging
- ✅ Beautiful console output with emojis and colors
- ✅ Proper exit code handling

### Bash: `run-smart-tests.sh`

**Platform:** macOS, Linux

**Prerequisites:**
```bash
# Install jq for JSON parsing
# macOS
brew install jq

# Ubuntu/Debian
sudo apt-get install jq

# RHEL/CentOS
sudo yum install jq
```

**Usage:**
```bash
# Run with default settings (analyzes HEAD)
chmod +x run-smart-tests.sh
./run-smart-tests.sh

# Analyze a specific commit
./run-smart-tests.sh "abc123def"

# Enable verbose output
./run-smart-tests.sh HEAD --verbose

# From a different directory
cd /path/to/flash-tests && /path/to/run-smart-tests.sh
```

**Features:**
- ✅ Automatic path resolution
- ✅ JSON validation with jq
- ✅ Granular test execution using `--grep`
- ✅ Verbose mode for debugging
- ✅ Beautiful console output
- ✅ Proper exit code handling

## How It Works

```
┌─────────────────────────────────────────────────────────────┐
│ 1. Runner Script (PowerShell or Bash)                        │
└──────────────────┬──────────────────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────────────────┐
│ 2. Smart Test Selector CLI (src/index.ts)                   │
│    - Analyzes git commit                                     │
│    - Identifies impacted files                              │
│    - Extracts test names                                    │
│    - Generates grep pattern                                 │
└──────────────────┬──────────────────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────────────────┐
│ 3. JSON Output                                               │
│ {                                                            │
│   "files": ["tests/sessions.spec.ts"],                      │
│   "tests": ["Login test", "Logout test"],                   │
│   "grep": "Login test|Logout test"                          │
│ }                                                            │
└──────────────────┬──────────────────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────────────────┐
│ 4. Playwright Execution                                      │
│ npx playwright test --grep "Login test|Logout test"         │
│                                                              │
│ Result: Only the 2 impacted tests run                       │
└─────────────────────────────────────────────────────────────┘
```

## CI/CD Integration

### GitHub Actions

```yaml
name: Run Smart Tests
on: [pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      
      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '18'
      
      - name: Install jq
        run: sudo apt-get install -y jq
      
      - name: Run Smart Tests
        run: |
          cd flash-tests
          bash ../test-selector/run-smart-tests.sh HEAD
```

### GitLab CI

```yaml
smart_tests:
  image: node:18
  script:
    - apt-get update && apt-get install -y jq
    - cd flash-tests
    - bash ../test-selector/run-smart-tests.sh HEAD
```

### Local Development

From your test repository:

```bash
# PowerShell (Windows)
..\test-selector\run-smart-tests.ps1

# Bash (macOS/Linux)
../test-selector/run-smart-tests.sh
```

## Execution Modes

### Granular Mode (Default)
When test names are extracted:
```bash
npx playwright test --grep "Login test|Logout test"
```
**Benefit:** Runs only the specific test cases, not the entire file.

### File Mode (Fallback)
If test extraction fails:
```bash
npx playwright test tests/sessions.spec.ts
```
**Benefit:** Still faster than running all tests, but less granular.

## Performance Savings

Example comparison for a commit affecting 1 file with 100 tests:

| Approach | Tests Run | Execution Time |
|----------|-----------|-----------------|
| Run All | 1000+ | ~5 minutes |
| File-Level (old) | 100 | ~30 seconds |
| Granular (new) | 1 | ~2 seconds |

## Troubleshooting

### PowerShell: "File cannot be loaded because running scripts is disabled"

```powershell
# Run this once to enable scripts
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
```

### Bash: "jq: command not found"

Install jq:
```bash
# macOS
brew install jq

# Ubuntu/Debian
sudo apt-get install jq

# RHEL/CentOS
sudo yum install jq

# Alpine
apk add jq
```

### "Smart Test Selector not found"

Ensure the path is correct:
```bash
# From flash-tests directory
ls -la ../test-selector/src/index.ts
```

### "No impacted tests found"

This is normal - it means the commit didn't change any test files or their dependencies. The script exits gracefully.

## Advanced Usage

### Analyzing Different Commits

```powershell
# PowerShell: Analyze a specific commit
./run-smart-tests.ps1 -CommitSha "abc123def"

# Bash: Analyze a specific commit
./run-smart-tests.sh "abc123def"

# Both: Analyze the last 5 commits
for i in {1..5}; do
  COMMIT=$(git rev-parse HEAD~$i)
  echo "Analyzing $COMMIT"
  ./run-smart-tests.ps1 -CommitSha $COMMIT
done
```

### Combining with Other Tools

```bash
# Run smart tests and generate a report
./run-smart-tests.sh HEAD > test-report.txt 2>&1

# Parse the JSON separately
JSON=$(npx ts-node ../test-selector/src/index.ts --repo . --commit HEAD --json)
echo $JSON | jq '.grep'

# Use in a custom pipeline
GREP_PATTERN=$(npx ts-node ../test-selector/src/index.ts --repo . --commit HEAD --json | jq -r '.grep')
npx playwright test --grep "$GREP_PATTERN" --reporter=html
```

## See Also

- [Smart Test Selector - Main README](../README.md)
- [Playwright Documentation](https://playwright.dev/docs/intro)
- [Git Commit Analysis](../src/git.ts)

#!/bin/bash
# run-smart-tests.sh
# Bridge between Smart Test Selector and Playwright
# This script analyzes changed tests and runs only the impacted ones.
# 
# Usage: ./run-smart-tests.sh
# 
# Prerequisites:
#   - You must be in the target repository (flash-tests)
#   - Smart Test Selector must be available at ../test-selector
#   - jq must be installed for JSON parsing (or use the --no-jq flag)

set -e

# Parse arguments
REPO_PATH="$(cd . && pwd)"
SMART_TOOL_PATH="../test-selector/src/index.ts"
COMMIT_SHA="${1:-HEAD}"
VERBOSE=false

if [[ "$2" == "--verbose" ]]; then
    VERBOSE=true
fi

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "🔍 Smart Test Selector - Playwright Runner"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

echo ""
echo "📍 Repository: $REPO_PATH"
echo "📍 Commit: $COMMIT_SHA"

# 1. Validate paths
if [[ ! -d "$REPO_PATH" ]]; then
    echo "❌ Repository path does not exist: $REPO_PATH"
    exit 1
fi

if [[ ! -f "$SMART_TOOL_PATH" ]]; then
    echo "❌ Smart Test Selector not found at: $SMART_TOOL_PATH"
    exit 1
fi

# 2. Run the Smart Selector (Capture JSON)
echo ""
echo "⚙️  Running Smart Test Selector..."

JSON_RAW=$(npx ts-node "$SMART_TOOL_PATH" --repo "$REPO_PATH" --commit "$COMMIT_SHA" --json 2>&1) || {
    echo "❌ Error running Smart Test Selector"
    echo "⚠️  Defaulting to RUN ALL TESTS."
    JSON_RAW=""
}

if [[ -z "$JSON_RAW" ]]; then
    echo "✅ No impacted tests found. Skipping execution."
    exit 0
fi

if [[ "$VERBOSE" == "true" ]]; then
    echo "📋 Raw JSON Output:"
    echo "$JSON_RAW"
fi

# 3. Parse JSON using jq
if ! command -v jq &> /dev/null; then
    echo "❌ jq is not installed. Install it to parse JSON output."
    echo "   Ubuntu/Debian: sudo apt-get install jq"
    echo "   macOS: brew install jq"
    exit 1
fi

FILES=$(echo "$JSON_RAW" | jq -r '.files[]' 2>/dev/null || echo "")
TESTS=$(echo "$JSON_RAW" | jq -r '.tests[]' 2>/dev/null || echo "")
GREP=$(echo "$JSON_RAW" | jq -r '.grep' 2>/dev/null || echo "")

# 4. Count results
FILES_ARRAY=()
while IFS= read -r file; do
    [[ -z "$file" ]] && continue
    FILES_ARRAY+=("$file")
done <<< "$FILES"

TESTS_ARRAY=()
while IFS= read -r test; do
    [[ -z "$test" ]] && continue
    TESTS_ARRAY+=("$test")
done <<< "$TESTS"

FILES_COUNT=${#FILES_ARRAY[@]}
TESTS_COUNT=${#TESTS_ARRAY[@]}

if [[ $FILES_COUNT -eq 0 ]]; then
    echo "✅ No impacted tests found. Skipping execution."
    exit 0
fi

# 5. Display Summary
echo ""
echo "📊 Analysis Results:"
echo "   Files impacted: $FILES_COUNT"
echo "   Tests impacted: $TESTS_COUNT"

echo ""
echo "📁 Impacted Files:"
for file in "${FILES_ARRAY[@]}"; do
    echo "   ✓ $file"
done

if [[ $TESTS_COUNT -gt 0 ]]; then
    echo ""
    echo "🧪 Impacted Tests:"
    for test in "${TESTS_ARRAY[@]}"; do
        echo "   ✓ $test"
    done
fi

# 6. Execution - Use grep pattern for granular execution
echo ""
if [[ -n "$GREP" && "$GREP" != "null" && "$GREP" != "" ]]; then
    echo "🚀 Launching Playwright with granular execution (grep filter)..."
    echo "   Command: npx playwright test --grep \"$GREP\""
    echo ""
    
    npx playwright test --grep "$GREP"
else
    echo "🚀 Launching Playwright (running impacted files)..."
    echo "   Command: npx playwright test ${FILES_ARRAY[@]}"
    echo ""
    
    npx playwright test "${FILES_ARRAY[@]}"
fi

EXIT_CODE=$?

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

if [[ $EXIT_CODE -eq 0 ]]; then
    echo "✅ All tests passed!"
else
    echo "❌ Tests failed with exit code: $EXIT_CODE"
fi

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

exit $EXIT_CODE

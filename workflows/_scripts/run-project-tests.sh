#!/bin/bash
set -euo pipefail

# === Script: run-project-tests.sh ===
# Description: Detect and run the project test suite, outputting JSON results.
# Usage: run-project-tests.sh [output-path]
# Output: JSON to stdout AND to output-path (for extract_json compatibility)
# Exit codes: 0 = all tests passed, 1 = tests failed, 2 = error

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/common.sh"

# --help flag
if [ "${1:-}" == "--help" ]; then
  echo "Usage: run-project-tests.sh [output-path]"
  echo ""
  echo "Detect and run the project test suite."
  echo "Outputs structured JSON compatible with DAWE extract_json."
  echo ""
  echo "Arguments:"
  echo "  output-path   File path to write JSON results (default: /tmp/dawe/latest-test.json)"
  echo ""
  echo "Detection order:"
  echo "  1. npm test (if package.json exists)"
  echo "  2. make test (if Makefile with test target exists)"
  echo "  3. pytest (if pytest is available and tests/ exists)"
  echo ""
  echo "Exit codes:"
  echo "  0  All tests passed"
  echo "  1  One or more tests failed"
  echo "  2  Error (no test runner found, execution failure)"
  exit 0
fi

OUTPUT_PATH="${1:-/tmp/dawe/latest-test.json}"

# Ensure the output directory exists
mkdir -p "$(dirname "$OUTPUT_PATH")"

# Detect test runner
RUNNER=""
RUNNER_CMD=""

if [ -f "package.json" ]; then
  RUNNER="npm"
  RUNNER_CMD="npm test -- --reporter=json 2>&1"
elif [ -f "Makefile" ] && grep -q "^test:" Makefile; then
  RUNNER="make"
  RUNNER_CMD="make test 2>&1"
elif command -v pytest &>/dev/null && [ -d "tests" ]; then
  RUNNER="pytest"
  RUNNER_CMD="pytest --tb=short -q 2>&1"
else
  json_error "No test runner detected (checked: npm, make, pytest)"
  exit 2
fi

# Run the tests and capture output
TEST_OUTPUT=""
TEST_EXIT_CODE=0
TEST_OUTPUT=$(eval "$RUNNER_CMD") || TEST_EXIT_CODE=$?

# Build structured JSON result
PASSED=0
FAILED=0
TOTAL=0
FAILED_TESTS="[]"

# Try to extract counts from output (best-effort parsing)
if [ "$RUNNER" == "npm" ]; then
  # Try to parse vitest/jest JSON output
  TOTAL=$(echo "$TEST_OUTPUT" | grep -oP '(\d+) (tests?|passed|failed)' | head -1 | grep -oP '^\d+' || echo "0")
  PASSED=$(echo "$TEST_OUTPUT" | grep -oP '(\d+) passed' | grep -oP '^\d+' || echo "0")
  FAILED=$(echo "$TEST_OUTPUT" | grep -oP '(\d+) failed' | grep -oP '^\d+' || echo "0")
fi

# Determine status
if [ "$TEST_EXIT_CODE" -eq 0 ]; then
  STATUS="passed"
else
  STATUS="failed"
fi

# Build output JSON
RESULT=$(cat <<EOF
{
  "runner": "$RUNNER",
  "status": "$STATUS",
  "exit_code": $TEST_EXIT_CODE,
  "total": $TOTAL,
  "passed": $PASSED,
  "failed": $FAILED,
  "failed_tests": $FAILED_TESTS,
  "output_truncated": $(echo "$TEST_OUTPUT" | tail -50 | jq -Rs .)
}
EOF
)

# Write to file (for extract_json)
echo "$RESULT" > "$OUTPUT_PATH"

# Also output to stdout
json_output "$RESULT"

exit "$TEST_EXIT_CODE"

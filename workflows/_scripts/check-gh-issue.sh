#!/bin/bash
set -euo pipefail

# === Script: check-gh-issue.sh ===
# Description: Search for existing GitHub issues matching a query.
# Usage: check-gh-issue.sh <repo> <search-query>
# Output: JSON to stdout
# Exit codes: 0 = found, 1 = not found, 2 = error

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/common.sh"

# --help flag
if [ "${1:-}" == "--help" ]; then
  echo "Usage: check-gh-issue.sh <repo> <search-query>"
  echo ""
  echo "Search for existing GitHub issues matching a query."
  echo ""
  echo "Arguments:"
  echo "  repo           GitHub repository (e.g., owner/repo)"
  echo "  search-query   Text to search for in issue titles"
  echo ""
  echo "Exit codes:"
  echo "  0  Issues found (JSON array on stdout)"
  echo "  1  No matching issues found"
  echo "  2  Error (missing args, missing tools, API failure)"
  exit 0
fi

# Argument validation
REPO="${1:?Usage: check-gh-issue.sh <repo> <search-query>}"
QUERY="${2:?Usage: check-gh-issue.sh <repo> <search-query>}"

# Check dependencies
require_command "gh"
require_command "jq"

# Execute search
RESULT=$(gh issue list --repo "$REPO" --search "$QUERY" --json number,title,state --limit 5 2>&1) || {
  json_error "Failed to search issues: $RESULT"
  exit 2
}

COUNT=$(echo "$RESULT" | jq length)
if [ "$COUNT" -gt 0 ]; then
  json_output "{\"issues\": $RESULT, \"count\": $COUNT}"
  exit 0
else
  json_output '{"issues": [], "count": 0}'
  exit 1
fi

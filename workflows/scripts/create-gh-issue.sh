#!/bin/bash
set -euo pipefail

# === Script: create-gh-issue.sh ===
# Description: Create a new GitHub issue.
# Usage: create-gh-issue.sh <repo> <title> [body]
# Output: JSON to stdout with issue number and URL
# Exit codes: 0 = created, 2 = error

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/common.sh"

# --help flag
if [ "${1:-}" == "--help" ]; then
  echo "Usage: create-gh-issue.sh <repo> <title> [body]"
  echo ""
  echo "Create a new GitHub issue."
  echo ""
  echo "Arguments:"
  echo "  repo    GitHub repository (e.g., owner/repo)"
  echo "  title   Issue title"
  echo "  body    Issue body text (optional)"
  echo ""
  echo "Exit codes:"
  echo "  0  Issue created successfully"
  echo "  2  Error (missing args, missing tools, API failure)"
  exit 0
fi

# Argument validation
REPO="${1:?Usage: create-gh-issue.sh <repo> <title> [body]}"
TITLE="${2:?Usage: create-gh-issue.sh <repo> <title> [body]}"
BODY="${3:-}"

# Check dependencies
require_command "gh"
require_command "jq"

# Build the gh command
GH_ARGS=(issue create --repo "$REPO" --title "$TITLE" --json number,url)
if [ -n "$BODY" ]; then
  GH_ARGS+=(--body "$BODY")
fi

# Execute
RESULT=$(gh "${GH_ARGS[@]}" 2>&1) || {
  json_error "Failed to create issue: $RESULT"
  exit 2
}

# Output the result (gh --json returns structured JSON)
json_output "$RESULT"
exit 0

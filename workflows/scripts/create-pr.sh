#!/bin/bash
set -euo pipefail

# === Script: create-pr.sh ===
# Description: Create a pull request on GitHub.
# Usage: create-pr.sh <repo> <title> <body> [base-branch]
# Output: JSON to stdout with PR number and URL
# Exit codes: 0 = created, 2 = error

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/common.sh"

# --help flag
if [ "${1:-}" == "--help" ]; then
  echo "Usage: create-pr.sh <repo> <title> <body> [base-branch]"
  echo ""
  echo "Create a pull request on GitHub."
  echo ""
  echo "Arguments:"
  echo "  repo           GitHub repository (e.g., owner/repo)"
  echo "  title          PR title"
  echo "  body           PR body / description"
  echo "  base-branch    Base branch to merge into (default: main)"
  echo ""
  echo "Exit codes:"
  echo "  0  PR created successfully"
  echo "  2  Error (missing args, missing tools, API failure)"
  exit 0
fi

# Argument validation
REPO="${1:?Usage: create-pr.sh <repo> <title> <body> [base-branch]}"
TITLE="${2:?Usage: create-pr.sh <repo> <title> <body> [base-branch]}"
BODY="${3:?Usage: create-pr.sh <repo> <title> <body> [base-branch]}"
BASE="${4:-main}"

# Check dependencies
require_command "gh"
require_command "jq"

# Execute
RESULT=$(gh pr create \
  --repo "$REPO" \
  --title "$TITLE" \
  --body "$BODY" \
  --base "$BASE" \
  --json number,url 2>&1) || {
  json_error "Failed to create PR: $RESULT"
  exit 2
}

json_output "$RESULT"
exit 0

#!/bin/bash
set -euo pipefail

# === Script: create-pr.sh ===
# Description: Create a pull request on GitHub and return structured JSON.
# Usage: create-pr.sh <repo> <title> <body> [base-branch] [json-fields]
# Output: JSON to stdout with PR details (hydrated via gh pr view)
# Exit codes: 0 = created, 2 = error
#
# Uses a two-phase create→hydrate pattern:
#   1. `gh pr create` returns the PR URL
#   2. `gh pr view --json` fetches structured data for the new PR
# This works around `gh pr create` not supporting --json directly.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/common.sh"

# --help flag
if [ "${1:-}" == "--help" ]; then
  echo "Usage: create-pr.sh <repo> <title> <body> [base-branch] [json-fields]"
  echo ""
  echo "Create a pull request on GitHub and return structured JSON."
  echo ""
  echo "Arguments:"
  echo "  repo           GitHub repository (e.g., owner/repo)"
  echo "  title          PR title"
  echo "  body           PR body / description"
  echo "  base-branch    Base branch to merge into (default: main)"
  echo "  json-fields    Comma-separated gh fields (default: number,url,title,state,baseRefName,headRefName,createdAt)"
  echo ""
  echo "Exit codes:"
  echo "  0  PR created successfully"
  echo "  2  Error (missing args, missing tools, API failure)"
  exit 0
fi

# Argument validation
REPO="${1:?Usage: create-pr.sh <repo> <title> <body> [base-branch] [json-fields]}"
TITLE="${2:?Usage: create-pr.sh <repo> <title> <body> [base-branch] [json-fields]}"
BODY="${3:?Usage: create-pr.sh <repo> <title> <body> [base-branch] [json-fields]}"
BASE="${4:-main}"
FIELDS="${5:-number,url,title,state,baseRefName,headRefName,createdAt}"

# Check dependencies
require_command "gh"
require_command "jq"

# Phase 1: Create the PR (gh pr create returns the URL to stdout)
PR_URL=$(gh pr create \
  --repo "$REPO" \
  --title "$TITLE" \
  --body "$BODY" \
  --base "$BASE" 2>&1) || {
  json_error "Failed to create PR: $PR_URL"
  exit 2
}

# Phase 2: Hydrate — fetch structured JSON for the newly created PR
RESULT=$(gh pr view "$PR_URL" --repo "$REPO" --json "$FIELDS" 2>&1) || {
  json_error "PR created ($PR_URL) but failed to fetch details: $RESULT"
  exit 2
}

json_output "$RESULT"
exit 0

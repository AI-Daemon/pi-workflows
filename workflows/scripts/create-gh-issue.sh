#!/bin/bash
set -euo pipefail

# === Script: create-gh-issue.sh ===
# Description: Create a new GitHub issue and return structured JSON.
# Usage: create-gh-issue.sh <repo> <title> [body] [json-fields]
# Output: JSON to stdout with issue details (hydrated via gh issue view)
# Exit codes: 0 = created, 2 = error
#
# Uses a two-phase create→hydrate pattern:
#   1. `gh issue create` returns the issue URL
#   2. `gh issue view --json` fetches structured data for the new issue
# This works around `gh issue create` not supporting --json directly.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/common.sh"

# --help flag
if [ "${1:-}" == "--help" ]; then
  echo "Usage: create-gh-issue.sh <repo> <title> [body] [json-fields]"
  echo ""
  echo "Create a new GitHub issue and return structured JSON."
  echo ""
  echo "Arguments:"
  echo "  repo          GitHub repository (e.g., owner/repo)"
  echo "  title         Issue title"
  echo "  body          Issue body text (optional, pass '' to skip)"
  echo "  json-fields   Comma-separated gh fields (default: number,url,title,state,labels,createdAt)"
  echo ""
  echo "Exit codes:"
  echo "  0  Issue created successfully"
  echo "  2  Error (missing args, missing tools, API failure)"
  exit 0
fi

# Argument validation
REPO="${1:?Usage: create-gh-issue.sh <repo> <title> [body] [json-fields]}"
TITLE="${2:?Usage: create-gh-issue.sh <repo> <title> [body] [json-fields]}"
BODY="${3:-}"
FIELDS="${4:-number,url,title,state,labels,createdAt}"

# Check dependencies
require_command "gh"
require_command "jq"

# Phase 1: Create the issue (gh issue create returns the URL to stdout)
CREATE_ARGS=(issue create --repo "$REPO" --title "$TITLE")
if [ -n "$BODY" ]; then
  CREATE_ARGS+=(--body "$BODY")
fi

ISSUE_URL=$(gh "${CREATE_ARGS[@]}" 2>&1) || {
  json_error "Failed to create issue: $ISSUE_URL"
  exit 2
}

# Phase 2: Hydrate — fetch structured JSON for the newly created issue
RESULT=$(gh issue view "$ISSUE_URL" --repo "$REPO" --json "$FIELDS" 2>&1) || {
  json_error "Issue created ($ISSUE_URL) but failed to fetch details: $RESULT"
  exit 2
}

json_output "$RESULT"
exit 0

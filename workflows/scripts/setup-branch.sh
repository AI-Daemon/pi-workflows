#!/bin/bash
set -euo pipefail

# === Script: setup-branch.sh ===
# Description: Create and checkout a feature branch for an issue.
# Usage: setup-branch.sh <branch-prefix> <issue-number>
# Output: JSON to stdout with branch name
# Exit codes: 0 = success, 2 = error

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/common.sh"

# --help flag
if [ "${1:-}" == "--help" ]; then
  echo "Usage: setup-branch.sh <branch-prefix> <issue-number>"
  echo ""
  echo "Create and checkout a feature branch for an issue."
  echo "Branch name format: <prefix>/issue-<number>"
  echo ""
  echo "Arguments:"
  echo "  branch-prefix   Branch prefix (e.g., feat, fix, chore)"
  echo "  issue-number    GitHub issue number"
  echo ""
  echo "Exit codes:"
  echo "  0  Branch created and checked out"
  echo "  2  Error (missing args, missing tools, git failure)"
  exit 0
fi

# Argument validation
PREFIX="${1:?Usage: setup-branch.sh <branch-prefix> <issue-number>}"
ISSUE_NUMBER="${2:?Usage: setup-branch.sh <branch-prefix> <issue-number>}"

# Check dependencies
require_command "git"

BRANCH_NAME="${PREFIX}/issue-${ISSUE_NUMBER}"

# Create and checkout the branch
git checkout -b "$BRANCH_NAME" 2>&1 || {
  json_error "Failed to create branch: $BRANCH_NAME"
  exit 2
}

json_output "{\"branch\": \"$BRANCH_NAME\", \"issue_number\": $ISSUE_NUMBER}"
exit 0

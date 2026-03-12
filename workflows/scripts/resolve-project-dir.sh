#!/bin/bash
set -euo pipefail

# === Script: resolve-project-dir.sh ===
# Description: Resolve the local directory for a GitHub repository.
# Usage: resolve-project-dir.sh <repo>
# Output: JSON to stdout with the resolved directory path
# Exit codes: 0 = found, 1 = not found, 2 = error
#
# Search order:
#   1. Current working directory (if it matches the repo name)
#   2. /root/<repo-name> (common Pi container layout)
#   3. ~/.pi/agent/git/github.com/<owner>/<repo> (pi install location)
#   4. Subdirectory of CWD matching repo name

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/common.sh"

# --help flag
if [ "${1:-}" == "--help" ]; then
  echo "Usage: resolve-project-dir.sh <repo>"
  echo ""
  echo "Resolve the local directory for a GitHub repository."
  echo ""
  echo "Arguments:"
  echo "  repo   GitHub repository (e.g., owner/repo)"
  echo ""
  echo "Search order:"
  echo "  1. Current working directory (if basename matches repo name)"
  echo "  2. /root/<repo-name>"
  echo "  3. ~/.pi/agent/git/github.com/<owner>/<repo>"
  echo "  4. Subdirectory of CWD matching repo name"
  echo ""
  echo "Exit codes:"
  echo "  0  Directory found (JSON with path on stdout)"
  echo "  1  Directory not found"
  echo "  2  Error (missing args)"
  exit 0
fi

# Argument validation
REPO="${1:?Usage: resolve-project-dir.sh <repo>}"

# Extract owner and repo name
REPO_NAME="${REPO##*/}"
OWNER="${REPO%%/*}"

# 1. Current working directory
if [ "$(basename "$PWD")" == "$REPO_NAME" ] && [ -d ".git" ]; then
  json_output "{\"project_dir\": \"$PWD\"}"
  exit 0
fi

# 2. /root/<repo-name>
if [ -d "/root/$REPO_NAME" ]; then
  json_output "{\"project_dir\": \"/root/$REPO_NAME\"}"
  exit 0
fi

# 3. Pi install location
PI_PATH="$HOME/.pi/agent/git/github.com/$OWNER/$REPO_NAME"
if [ -d "$PI_PATH" ]; then
  json_output "{\"project_dir\": \"$PI_PATH\"}"
  exit 0
fi

# 4. Subdirectory of CWD
if [ -d "$PWD/$REPO_NAME" ]; then
  json_output "{\"project_dir\": \"$PWD/$REPO_NAME\"}"
  exit 0
fi

json_output "{\"project_dir\": null, \"error\": \"Could not find local directory for $REPO\"}"
exit 1

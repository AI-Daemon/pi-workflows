#!/bin/bash
set -euo pipefail

# === Script: init-workflow.sh ===
# Description: Initialize a new workflow directory with a scaffold YAML from the template.
# Usage: init-workflow.sh <workflow-name>
# Output: JSON to stdout with created paths
# Exit codes: 0 = success, 2 = error

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$DAWE_SCRIPTS_DIR/lib/common.sh"

# --help flag
if [ "${1:-}" == "--help" ]; then
  echo "Usage: init-workflow.sh <workflow-name>"
  echo ""
  echo "Creates a new workflow directory under ~/.pi/workflows/ and copies"
  echo "the scaffold template into it with the correct name."
  echo ""
  echo "Arguments:"
  echo "  workflow-name   Kebab-case name for the new workflow"
  echo ""
  echo "Exit codes:"
  echo "  0  Directory created and template copied"
  echo "  2  Error (missing args, directory already exists, template not found)"
  exit 0
fi

# Argument validation
require_args 1 "$@"
WORKFLOW_NAME="$1"

WORKFLOWS_DIR="$HOME/.pi/workflows"
WORKFLOW_DIR="$WORKFLOWS_DIR/$WORKFLOW_NAME"
# Derive template path relative to this script: scripts/ -> ../resources/
TEMPLATE_SRC="$SCRIPT_DIR/../resources/workflow-template.yml"
DEST_FILE="$WORKFLOW_DIR/$WORKFLOW_NAME.yml"

# Check template exists
if [ ! -f "$TEMPLATE_SRC" ]; then
  json_error "Template not found at $TEMPLATE_SRC"
  exit 2
fi

# Check if directory already exists
if [ -d "$WORKFLOW_DIR" ]; then
  json_error "Workflow directory already exists: $WORKFLOW_DIR"
  exit 2
fi

# Create the directory
mkdir -p "$WORKFLOW_DIR"

# Copy and rename the template, replacing the placeholder workflow_name
sed "s/^workflow_name: create-workflow/workflow_name: $WORKFLOW_NAME/" "$TEMPLATE_SRC" > "$DEST_FILE"

json_output "{\"workflow_dir\": \"$WORKFLOW_DIR\", \"workflow_file\": \"$DEST_FILE\", \"workflow_name\": \"$WORKFLOW_NAME\"}"
exit 0

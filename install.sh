#!/bin/bash
# pi-workflows post-install setup
#
# This script is run automatically by `pi install` after cloning and npm install.
# It is idempotent — safe to run multiple times (reinstall, update).

WORKFLOWS_DIR="${HOME}/.pi/workflows"

# Create user workflows directory
if [ ! -d "$WORKFLOWS_DIR" ]; then
  mkdir -p "$WORKFLOWS_DIR"
  echo "✅ Created $WORKFLOWS_DIR — place your .yml workflow files here."
fi

echo ""
echo "🔧 pi-workflows installed successfully!"
echo ""
echo "   The advance_workflow tool is now available."
echo "   Restart Pi, then try:"
echo ""
echo "     advance_workflow({ action: 'list' })"
echo ""
echo "   Author workflows in: $WORKFLOWS_DIR"
echo "   Documentation: https://github.com/AI-Daemon/pi-workflows/blob/main/docs/installation.md"
echo ""

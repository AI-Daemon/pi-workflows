#!/bin/bash
set -euo pipefail

# === Script: scan-scripts.sh ===
# Description: Scan the global scripts directory and produce an inventory.
# Usage: scan-scripts.sh [json-output-path]
# Output: JSON to stdout with script names and their --help descriptions
# Exit codes: 0 = success, 2 = error

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/common.sh"

# --help flag
if [ "${1:-}" == "--help" ]; then
  echo "Usage: scan-scripts.sh [json-output-path]"
  echo ""
  echo "Scans the global scripts directory (\$DAWE_SCRIPTS_DIR) and produces"
  echo "a JSON inventory of all scripts with their descriptions and usage."
  echo ""
  echo "Arguments:"
  echo "  json-output-path   Path to write JSON output (default: /tmp/dawe/script-inventory.json)"
  echo ""
  echo "Exit codes:"
  echo "  0  Success"
  echo "  2  Error (scripts directory not found)"
  exit 0
fi

OUTPUT_FILE="${1:-/tmp/dawe/script-inventory.json}"
mkdir -p "$(dirname "$OUTPUT_FILE")"

SCRIPTS_DIR="$DAWE_SCRIPTS_DIR"

if [ ! -d "$SCRIPTS_DIR" ]; then
  json_error "Scripts directory not found: $SCRIPTS_DIR"
  exit 2
fi

# Build JSON array of scripts with their descriptions
echo "{\"scripts\": [" > "$OUTPUT_FILE"
FIRST=true

for script in "$SCRIPTS_DIR"/*.sh; do
  [ -f "$script" ] || continue
  NAME="$(basename "$script")"

  # Extract description from the header comment (line starting with "# Description:")
  DESC=$(grep -m1 "^# Description:" "$script" 2>/dev/null | sed 's/^# Description: *//' || echo "")
  USAGE=$(grep -m1 "^# Usage:" "$script" 2>/dev/null | sed 's/^# Usage: *//' || echo "")

  if [ "$FIRST" = true ]; then
    FIRST=false
  else
    echo "," >> "$OUTPUT_FILE"
  fi

  # Escape quotes in description/usage for valid JSON
  DESC=$(echo "$DESC" | sed 's/"/\\"/g')
  USAGE=$(echo "$USAGE" | sed 's/"/\\"/g')

  printf '  {"name": "%s", "description": "%s", "usage": "%s"}' "$NAME" "$DESC" "$USAGE" >> "$OUTPUT_FILE"
done

# Scan lib/ for shared libraries
echo "], \"libs\": [" >> "$OUTPUT_FILE"
FIRST=true

if [ -d "$SCRIPTS_DIR/lib" ]; then
  for lib in "$SCRIPTS_DIR/lib"/*.sh; do
    [ -f "$lib" ] || continue
    NAME="$(basename "$lib")"
    DESC=$(grep -m1 "^# ===" "$lib" 2>/dev/null | sed 's/^# === *//' | sed 's/ *===$//' || echo "")
    DESC=$(echo "$DESC" | sed 's/"/\\"/g')

    if [ "$FIRST" = true ]; then
      FIRST=false
    else
      echo "," >> "$OUTPUT_FILE"
    fi

    printf '  {"name": "%s", "description": "%s"}' "$NAME" "$DESC" >> "$OUTPUT_FILE"
  done
fi

echo "]}" >> "$OUTPUT_FILE"

cat "$OUTPUT_FILE"
exit 0

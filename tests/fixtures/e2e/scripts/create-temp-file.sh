#!/bin/bash
# Creates a temp file to verify script execution
# File path includes the project name for identification
PROJECT="${1:-unknown}"
TEMP_DIR="${TMPDIR:-/tmp}"
TEMP_FILE="${TEMP_DIR}/dawe-e2e-${PROJECT}-$$"
echo "created" > "$TEMP_FILE"
echo "{\"temp_file\": \"${TEMP_FILE}\", \"project\": \"${PROJECT}\", \"created\": true}"
exit 0

#!/bin/bash
# === Shared utility functions for DAWE workflow scripts ===
#
# Source this file from any workflow script:
#   SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
#   source "$SCRIPT_DIR/lib/common.sh"

# Output a JSON string to stdout.
# Usage: json_output '{"key": "value"}'
json_output() {
  echo "$1"
}

# Output a JSON error object to stderr and optionally exit.
# Usage: json_error "Something went wrong"
json_error() {
  echo "{\"error\": \"$1\"}" >&2
}

# Check that a required command is available.
# Exits with code 2 if the command is not found.
# Usage: require_command "gh"
require_command() {
  if ! command -v "$1" &>/dev/null; then
    json_error "$1 is required but not installed"
    exit 2
  fi
}

# Validate that the minimum number of positional arguments were provided.
# Usage: require_args 2 "$@"   # requires at least 2 args
require_args() {
  local min="$1"
  shift
  if [ "$#" -lt "$min" ]; then
    json_error "Expected at least $min argument(s), got $#"
    exit 2
  fi
}

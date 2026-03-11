#!/bin/bash
# Simulates checking if a GitHub issue exists for a project
# Exit 0 if project is "has-issue", exit 1 otherwise
PROJECT="$1"
if [ "$PROJECT" == "has-issue" ]; then
  echo '{"issue_number": 42, "state": "open"}'
  exit 0
else
  echo '{"error": "no issue found"}'
  exit 1
fi

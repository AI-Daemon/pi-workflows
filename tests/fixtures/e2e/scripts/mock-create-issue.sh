#!/bin/bash
# Simulates creating a GitHub issue for a project
# Always succeeds, returns issue number 12
PROJECT="$1"
echo "{\"issue_number\": 12, \"title\": \"Issue for ${PROJECT}\", \"state\": \"open\"}"
exit 0

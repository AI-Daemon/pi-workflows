#!/bin/bash
# Simulates creating a GitHub PR for a project
# Always succeeds, returns PR number 42
PROJECT="$1"
echo "{\"pr_number\": 42, \"title\": \"PR for ${PROJECT}\", \"state\": \"open\"}"
exit 0

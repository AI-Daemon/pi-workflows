#!/bin/bash
# Dumps selected environment variables as JSON
echo "{"
first=true
for var in "$@"; do
  if [ "$first" = true ]; then
    first=false
  else
    echo ","
  fi
  value="${!var}"
  echo -n "  \"$var\": \"$value\""
done
echo ""
echo "}"

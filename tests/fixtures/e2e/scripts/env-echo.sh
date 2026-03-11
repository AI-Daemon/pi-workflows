#!/bin/bash
# Echoes DAWE_* environment variables as JSON
echo "{"
first=true
for var in $(env | grep "^DAWE_" | sort); do
  key="${var%%=*}"
  value="${var#*=}"
  if [ "$first" = true ]; then
    first=false
  else
    echo ","
  fi
  printf '  "%s": "%s"' "$key" "$value"
done
echo ""
echo "}"

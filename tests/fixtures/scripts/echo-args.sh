#!/bin/bash
# Echoes all arguments as a JSON array
echo -n '{"args": ['
first=true
for arg in "$@"; do
  if [ "$first" = true ]; then
    first=false
  else
    echo -n ','
  fi
  # JSON-escape the argument
  echo -n "\"$(echo "$arg" | sed 's/\\/\\\\/g; s/"/\\"/g')\""
done
echo ']}'

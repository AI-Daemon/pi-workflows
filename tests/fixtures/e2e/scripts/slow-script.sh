#!/bin/bash
# Sleeps for N seconds (default 10)
# Used for timeout testing
DURATION="${1:-10}"
sleep "$DURATION"
echo '{"completed": true}'
exit 0

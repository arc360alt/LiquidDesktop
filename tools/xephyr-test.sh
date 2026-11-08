#!/bin/sh
# kept for compatibility: see tools/nested.sh
LIQUID_NESTED=xephyr exec "$(dirname "$0")/nested.sh" "$@"

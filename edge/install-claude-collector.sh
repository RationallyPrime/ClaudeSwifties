#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
PYTHON_BIN=${PYTHON_BIN:-python3}
if [ "${1:-}" = "--uninstall" ]; then
    shift
    exec "$PYTHON_BIN" "$SCRIPT_DIR/ai_usage.py" uninstall --provider claude "$@"
fi
exec "$PYTHON_BIN" "$SCRIPT_DIR/ai_usage.py" install --provider claude "$@"

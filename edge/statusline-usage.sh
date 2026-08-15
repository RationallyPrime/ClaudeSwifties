#!/bin/sh
# Tiny Claude status-line entry point. All parsing and local atomic spooling is
# performed by the adjacent stdlib-only Python package; this path never opens a
# network connection.
set -u

case $0 in
    */*) SCRIPT_DIR=${0%/*} ;;
    *) SCRIPT_DIR=. ;;
esac
PYTHON_BIN=${PYTHON_BIN:-python3}
exec "$PYTHON_BIN" "$SCRIPT_DIR/ai_usage.py" statusline "$@"

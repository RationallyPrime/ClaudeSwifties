#!/bin/sh
set -eu

LABEL="is.sokrates.codex-usage"
USER_ID=$(id -u)
LAUNCH_DOMAIN="gui/$USER_ID"
INSTALL_ROOT="${AI_USAGE_INSTALL_ROOT:-$HOME/.local/libexec/ai-usage}"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/codex-usage"
CONFIG_FILE="$CONFIG_DIR/config"
LAUNCH_AGENT="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs/AIUsage"
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

if [ "${1:-}" = "--uninstall" ]; then
    launchctl bootout "$LAUNCH_DOMAIN/$LABEL" >/dev/null 2>&1 || true
    rm -f "$LAUNCH_AGENT" "$INSTALL_ROOT/codex_usage.py"
    echo "Removed the Codex usage LaunchAgent. Kept $CONFIG_FILE."
    exit 0
fi

CODEX_BIN=$(command -v codex 2>/dev/null || true)
PYTHON_BIN=$(command -v python3 2>/dev/null || true)
[ -n "$CODEX_BIN" ] || { echo "codex is not on PATH" >&2; exit 1; }
[ -n "$PYTHON_BIN" ] || { echo "python3 is not on PATH" >&2; exit 1; }

mkdir -p "$INSTALL_ROOT" "$CONFIG_DIR" "$HOME/Library/LaunchAgents" "$LOG_DIR"
install -m 755 "$SCRIPT_DIR/codex_usage.py" "$INSTALL_ROOT/codex_usage.py"

if [ ! -f "$CONFIG_FILE" ]; then
    umask 077
    : >"$CONFIG_FILE"
fi
if ! grep -q '^CODEX_BIN=' "$CONFIG_FILE"; then
    printf 'CODEX_BIN="%s"\n' "$CODEX_BIN" >>"$CONFIG_FILE"
fi
chmod 600 "$CONFIG_FILE"

{
    printf '%s\n' '<?xml version="1.0" encoding="UTF-8"?>'
    printf '%s\n' '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">'
    printf '%s\n' '<plist version="1.0"><dict>'
    printf '%s\n' '  <key>Label</key>' "  <string>$LABEL</string>"
    printf '%s\n' '  <key>ProgramArguments</key><array>'
    printf '    <string>%s</string>\n' "$PYTHON_BIN" "$INSTALL_ROOT/codex_usage.py"
    printf '%s\n' '    <string>--config</string>'
    printf '    <string>%s</string>\n' "$CONFIG_FILE"
    printf '%s\n' '  </array>'
    printf '%s\n' '  <key>RunAtLoad</key><true/>'
    printf '%s\n' '  <key>StartInterval</key><integer>300</integer>'
    printf '  <key>StandardOutPath</key><string>%s/codex-usage.log</string>\n' "$LOG_DIR"
    printf '  <key>StandardErrorPath</key><string>%s/codex-usage.log</string>\n' "$LOG_DIR"
    printf '%s\n' '</dict></plist>'
} >"$LAUNCH_AGENT"
plutil -lint "$LAUNCH_AGENT" >/dev/null

launchctl bootout "$LAUNCH_DOMAIN/$LABEL" >/dev/null 2>&1 || true
launchctl bootstrap "$LAUNCH_DOMAIN" "$LAUNCH_AGENT"
launchctl kickstart -k "$LAUNCH_DOMAIN/$LABEL"

echo "Installed $LABEL (every 5 minutes)."
echo "Collector config: $CONFIG_FILE"
echo "Collector log: $LOG_DIR/codex-usage.log"

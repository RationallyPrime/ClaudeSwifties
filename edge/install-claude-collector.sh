#!/bin/sh
set -eu

INSTALL_ROOT="${AI_USAGE_INSTALL_ROOT:-$HOME/.local/libexec/ai-usage}"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/claude-usage"
CONFIG_FILE="$CONFIG_DIR/config"
SETTINGS_FILE="${CLAUDE_SETTINGS_FILE:-$HOME/.claude/settings.json}"
SETTINGS_BACKUP="$SETTINGS_FILE.before-ai-usage"
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
INSTALLED_SCRIPT="$INSTALL_ROOT/statusline-usage.sh"

ACCOUNT_ID="${USAGE_ACCOUNT_ID:-}"
LABEL="${USAGE_LABEL:-}"
ENDPOINT="${USAGE_ENDPOINT:-}"
TOKEN="${USAGE_TOKEN:-}"

[ -n "$ACCOUNT_ID" ] || { echo "USAGE_ACCOUNT_ID is required" >&2; exit 1; }
[ -n "$LABEL" ] || { echo "USAGE_LABEL is required" >&2; exit 1; }
[ -n "$ENDPOINT" ] || { echo "USAGE_ENDPOINT is required" >&2; exit 1; }
[ ${#TOKEN} -ge 16 ] || { echo "USAGE_TOKEN must be at least 16 characters" >&2; exit 1; }
case "$ACCOUNT_ID" in *[!A-Za-z0-9._-]*|'') echo "USAGE_ACCOUNT_ID is invalid" >&2; exit 1 ;; esac
[ ${#ACCOUNT_ID} -le 64 ] || { echo "USAGE_ACCOUNT_ID is too long" >&2; exit 1; }
[ ${#LABEL} -le 80 ] || { echo "USAGE_LABEL is too long" >&2; exit 1; }
case "$ENDPOINT" in https://*) ;; *) echo "USAGE_ENDPOINT must use HTTPS" >&2; exit 1 ;; esac
case "$ACCOUNT_ID$LABEL$ENDPOINT$TOKEN" in *"'"*) echo "configuration values cannot contain apostrophes" >&2; exit 1 ;; esac
case "$ACCOUNT_ID$LABEL$ENDPOINT$TOKEN" in *"
"*) echo "configuration values cannot contain newlines" >&2; exit 1 ;; esac

PYTHON_BIN=$(command -v python3 2>/dev/null || true)
[ -n "$PYTHON_BIN" ] || { echo "python3 is required to install the Claude status line" >&2; exit 1; }

mkdir -p "$INSTALL_ROOT" "$CONFIG_DIR" "$(dirname -- "$SETTINGS_FILE")"
install -m 755 "$SCRIPT_DIR/statusline-usage.sh" "$INSTALLED_SCRIPT"

config_tmp=$(mktemp "$CONFIG_DIR/.config.XXXXXX")
settings_tmp=""
cleanup() {
    [ -z "$config_tmp" ] || rm -f "$config_tmp"
    [ -z "$settings_tmp" ] || rm -f "$settings_tmp"
}
trap cleanup EXIT HUP INT TERM

umask 077
{
    printf "USAGE_ACCOUNT_ID='%s'\n" "$ACCOUNT_ID"
    printf "USAGE_LABEL='%s'\n" "$LABEL"
    printf "USAGE_ENDPOINT='%s'\n" "$ENDPOINT"
    printf "USAGE_TOKEN='%s'\n" "$TOKEN"
} >"$config_tmp"
chmod 600 "$config_tmp"
mv "$config_tmp" "$CONFIG_FILE"
config_tmp=""

if [ ! -f "$SETTINGS_FILE" ]; then
    printf '{}\n' >"$SETTINGS_FILE"
    chmod 600 "$SETTINGS_FILE"
fi
if [ ! -f "$SETTINGS_BACKUP" ]; then
    cp -p "$SETTINGS_FILE" "$SETTINGS_BACKUP"
fi

settings_tmp=$(mktemp "$(dirname -- "$SETTINGS_FILE")/.settings.XXXXXX")
"$PYTHON_BIN" - "$SETTINGS_FILE" "$settings_tmp" "$INSTALLED_SCRIPT" <<'PY'
import json
import os
import pathlib
import sys

source = pathlib.Path(sys.argv[1])
destination = pathlib.Path(sys.argv[2])
command = sys.argv[3]

try:
    settings = json.loads(source.read_text(encoding="utf-8"))
except json.JSONDecodeError as error:
    raise SystemExit(f"invalid Claude settings JSON: {error}")
if not isinstance(settings, dict):
    raise SystemExit("Claude settings must contain a JSON object")

settings["statusLine"] = {"type": "command", "command": command}
destination.write_text(
    json.dumps(settings, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
    encoding="utf-8",
)
os.chmod(destination, source.stat().st_mode & 0o777)
PY
mv "$settings_tmp" "$SETTINGS_FILE"
settings_tmp=""

echo "Installed the Claude usage status line."
echo "Account: $ACCOUNT_ID"
echo "Claude settings: $SETTINGS_FILE"
echo "Previous settings: $SETTINGS_BACKUP"
echo "Collector config: $CONFIG_FILE"

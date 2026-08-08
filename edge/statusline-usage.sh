#!/bin/sh
# Claude Code statusLine command that doubles as the usage ingress.
#
# Claude Code hands this script a JSON payload on stdin containing
# `rate_limits.{five_hour,seven_day}.{used_percentage,resets_at}` for Pro/Max
# subscribers. We render a status line from it AND forward it to the aggregator,
# so no credential is ever read, stored, or refreshed by us — the numbers arrive
# as a documented part of an already-authenticated session.
#
# Constraints this script is written around:
#   * It runs on every status line render. It must be fast and must never fail
#     in a way that breaks the user's prompt.
#   * `rate_limits` is absent until the first API response of a session, and
#     each window may be independently absent.
#   * The push must not block rendering, hence the backgrounded curl.
#
# Configure via ~/.config/claude-usage/config:
#   USAGE_ACCOUNT_ID=rp-team
#   USAGE_LABEL="Team · rationallyprime"
#   USAGE_ENDPOINT=https://timaeus:8443/ingest
#   USAGE_TOKEN=...
set -u

CONFIG="${XDG_CONFIG_HOME:-$HOME/.config}/claude-usage/config"
# shellcheck source=/dev/null
[ -f "$CONFIG" ] && . "$CONFIG"

HOST=$(hostname -s 2>/dev/null || echo unknown)
ACCOUNT_ID="${USAGE_ACCOUNT_ID:-$HOST}"
LABEL="${USAGE_LABEL:-$ACCOUNT_ID}"
ENDPOINT="${USAGE_ENDPOINT:-}"
TOKEN="${USAGE_TOKEN:-}"
PUSH_INTERVAL="${USAGE_PUSH_INTERVAL:-60}"

INGRESS_ENABLED=1
case "$ACCOUNT_ID" in
    *[!A-Za-z0-9._-]*|'') INGRESS_ENABLED=0 ;;
esac
[ ${#ACCOUNT_ID} -le 64 ] || INGRESS_ENABLED=0
[ "$INGRESS_ENABLED" -eq 1 ] || ACCOUNT_ID="invalid-account"

CACHE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/claude-usage"
CACHE="$CACHE_DIR/$ACCOUNT_ID.json"
STAMP="$CACHE_DIR/$ACCOUNT_ID.pushed"
mkdir -p "$CACHE_DIR" 2>/dev/null || true

input=$(cat)

# Parse with jq where it is already available. Python is a complete fallback,
# not a reduced display-only mode: the cx53 edge deliberately has no jq.
payload=""
if command -v jq >/dev/null 2>&1; then
    # Bail before anything else if stdin isn't parseable, so a malformed
    # payload renders a plain status line instead of jq errors and an empty
    # "[]".
    if ! printf '%s' "$input" | jq -e . >/dev/null 2>&1; then
        printf '[claude]\n'
        exit 0
    fi

    model=$(printf '%s' "$input" | jq -r '.model.display_name // "claude"' 2>/dev/null)
    [ -z "$model" ] && model="claude"

    # `// empty` throughout: absent windows must yield nothing, not "null".
    five_h=$(printf '%s' "$input" | jq -r '.rate_limits.five_hour.used_percentage // empty' 2>/dev/null)
    seven_d=$(printf '%s' "$input" | jq -r '.rate_limits.seven_day.used_percentage // empty' 2>/dev/null)

    line="[$model]"
    [ -n "$five_h" ] && line="$line  5h $(printf '%.0f' "$five_h")%"
    [ -n "$seven_d" ] && line="$line  7d $(printf '%.0f' "$seven_d")%"
    printf '%s\n' "$line"

    # Nothing to report until the session has had its first API response.
    [ -z "$five_h" ] && [ -z "$seven_d" ] && exit 0

    payload=$(printf '%s' "$input" | jq -c \
        --arg id "$ACCOUNT_ID" \
        --arg label "$LABEL" \
        --arg host "$HOST" \
        --arg now "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '
        .rate_limits as $r |
        {
          id: $id,
          label: $label,
          provider: "claude",
          source_host: $host,
          as_of: $now,
          status: "ok",
          windows: ([
            (if $r.five_hour == null then null
             else { id: "five-hour", label: "5h", duration_minutes: 300,
                    utilization: ($r.five_hour.used_percentage / 100),
                    resets_at: ($r.five_hour.resets_at | todate) } end),
            (if $r.seven_day == null then null
             else { id: "seven-day", label: "7d", duration_minutes: 10080,
                    utilization: ($r.seven_day.used_percentage / 100),
                    resets_at: ($r.seven_day.resets_at | todate) } end)
          ] | map(select(. != null))),
          five_hour: (
            if $r.five_hour == null then null
            else { utilization: ($r.five_hour.used_percentage / 100),
                   resets_at: ($r.five_hour.resets_at | todate) } end
          ),
          seven_day: (
            if $r.seven_day == null then null
            else { utilization: ($r.seven_day.used_percentage / 100),
                   resets_at: ($r.seven_day.resets_at | todate) } end
          )
        }' 2>/dev/null) || exit 0
elif command -v python3 >/dev/null 2>&1; then
    parsed=$(printf '%s' "$input" | python3 -c '
import datetime as dt
import json
import sys

account_id, label, host = sys.argv[1:4]

try:
    source = json.load(sys.stdin)
except (json.JSONDecodeError, OSError):
    print("[claude]")
    raise SystemExit(0)

model = source.get("model")
model_name = model.get("display_name", "claude") if isinstance(model, dict) else "claude"
model_name = str(model_name).replace("\\n", " ") or "claude"
limits = source.get("rate_limits")
limits = limits if isinstance(limits, dict) else {}

def window(key, identifier, window_label, duration):
    raw = limits.get(key)
    if not isinstance(raw, dict):
        return None, None
    used = raw.get("used_percentage")
    reset = raw.get("resets_at")
    if isinstance(used, bool) or not isinstance(used, (int, float)) or not 0 <= used <= 100:
        return None, None
    if isinstance(reset, bool) or not isinstance(reset, (int, float)):
        return used, None
    reset_at = dt.datetime.fromtimestamp(reset, tz=dt.timezone.utc).isoformat().replace("+00:00", "Z")
    generic = {
        "id": identifier,
        "label": window_label,
        "duration_minutes": duration,
        "utilization": used / 100,
        "resets_at": reset_at,
    }
    legacy = {"utilization": used / 100, "resets_at": reset_at}
    return used, (generic, legacy)

five_used, five = window("five_hour", "five-hour", "5h", 300)
seven_used, seven = window("seven_day", "seven-day", "7d", 10080)
line = f"[{model_name}]"
if five_used is not None:
    line += f"  5h {five_used:.0f}%"
if seven_used is not None:
    line += f"  7d {seven_used:.0f}%"
print(line)

windows = [entry[0] for entry in (five, seven) if entry is not None]
if not windows:
    raise SystemExit(0)

payload = {
    "id": account_id,
    "label": label,
    "provider": "claude",
    "source_host": host,
    "as_of": dt.datetime.now(tz=dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
    "status": "ok",
    "windows": windows,
    "five_hour": five[1] if five is not None else None,
    "seven_day": seven[1] if seven is not None else None,
}
print(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
' "$ACCOUNT_ID" "$LABEL" "$HOST" 2>/dev/null) || {
        printf '[claude]\n'
        exit 0
    }
    line=$(printf '%s\n' "$parsed" | sed -n '1p')
    payload=$(printf '%s\n' "$parsed" | sed -n '2p')
    printf '%s\n' "${line:-[claude]}"
    [ -n "$payload" ] || exit 0
else
    # No parser means no ingress, but a status-line failure must not break the
    # user's prompt.
    printf '%s' "$input" | sed -n 's/.*"display_name":"\([^"]*\)".*/[\1]/p'
    exit 0
fi

[ -z "$payload" ] && exit 0
[ "$INGRESS_ENABLED" -eq 1 ] || exit 0

# Always cache locally: this file is what a cron fallback ships when no session
# is live, and what survives if the aggregator is unreachable.
printf '%s' "$payload" >"$CACHE" 2>/dev/null || true

[ -z "$ENDPOINT" ] && exit 0

# Throttle. The status line renders far more often than usage meaningfully moves.
now_s=$(date +%s)
if [ -f "$STAMP" ]; then
    last=$(cat "$STAMP" 2>/dev/null || echo 0)
    [ $((now_s - last)) -lt "$PUSH_INTERVAL" ] && exit 0
fi
printf '%s' "$now_s" >"$STAMP" 2>/dev/null || true

push() {
    if [ -n "$TOKEN" ]; then
        curl -fsS -m 5 -X POST "$ENDPOINT" \
            -H 'Content-Type: application/json' \
            -H "Authorization: Bearer $TOKEN" \
            --data-binary "$payload" >/dev/null 2>&1
    else
        curl -fsS -m 5 -X POST "$ENDPOINT" \
            -H 'Content-Type: application/json' \
            --data-binary "$payload" >/dev/null 2>&1
    fi
}

# Detached: rendering must never wait on the network.
push &

exit 0

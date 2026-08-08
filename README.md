# ClaudeSwifties

A widget for iOS and macOS showing subscription usage and reset times across
three Claude accounts that live on three different machines.

## How the numbers are obtained

Claude Code's `statusLine` command receives a JSON payload on stdin that
includes, for Pro/Max subscribers:

```
rate_limits.five_hour.used_percentage    0–100
rate_limits.five_hour.resets_at          unix epoch seconds
rate_limits.seven_day.used_percentage
rate_limits.seven_day.resets_at
```

This is the entire data source. **No credential is read, stored, or refreshed
by anything in this repo.** The numbers arrive as a documented part of a session
that is already authenticated, on the machine that owns that account.

Rejected alternatives, and why:

- **Reading the OAuth token and calling `/api/oauth/usage`.** That endpoint is
  real and returns the same fields, but it is undocumented, requires a
  `User-Agent: claude-code/<version>` header to avoid a punitive rate-limit
  bucket, and needs a credential per account. On macOS the keychain ACL also
  makes unattended reads prompt. All of this to obtain data the statusline hands
  over for free.
- **Refreshing tokens from a poller.** If refresh tokens rotate, a poller
  refreshing independently of the client that owns the credential can invalidate
  a live session. Nothing here refreshes anything.
- **`claude usage --json`.** Does not exist. The feature request
  (anthropics/claude-code#44328) was closed as a duplicate.

## Shape

```
edge (×3)                  aggregator            widget (iOS + macOS)
statusLine shim  ──push──▶  timaeus devbox  ──GET──▶  three tiles
```

Edges push; the aggregator never dials out. Two of the three edges are laptops
that roam and sleep, so pull would not work for them.

### Known gap

`rate_limits` only appears **after the first API response in a session**, and
each window may be independently absent. So this is a live-session ingress: it
cannot report while an account is idle. Two mitigations, both implemented:

- Each edge caches its last payload locally, so a cron fallback can ship the
  last-known-good value with no session running.
- Staleness is a first-class part of the data model rather than an error case.
  Where a reading is old but every window's `resets_at` has since passed, the
  widget infers the window is empty and renders with confidence instead of
  greying out — see `AccountUsage.isSupersededByReset(now:)`.

## Layout

| Path | What it is |
| --- | --- |
| `UsageKit/Sources/UsageKit` | Contract types, staleness rules, formatting, providers, App Group store. Platform-free and fully tested. |
| `UsageKit/Sources/UsageUI` | SwiftUI tiles, shared by the app and the widget so the two cannot drift. |
| `App/` | The host app. Exists because WidgetKit requires one. |
| `Widget/` | The widget extension. Timeline refreshes every 15 minutes — WidgetKit grants only ~40–70 a day. |
| `edge/statusline-usage.sh` | The `statusLine` command. Renders the status line *and* forwards usage. Runs on every render, so it is fast, never blocks on the network, and never fails loudly. |

The Xcode project is hand-authored using filesystem-synchronized groups, so adding
a file to `App/` or `Widget/` needs no project-file edit.

```bash
xcodebuild -scheme ClaudeSwifties -destination 'platform=iOS Simulator,name=iPhone 17 Pro' build
```

macOS is configured in the build settings (`SDKROOT = auto`) but not yet verified —
a macOS widget must be sandboxed and signed to load into Notification Centre, which
needs a development team set.

## Contract

```json
{
  "schema": 1,
  "generated_at": "2026-08-07T21:40:00Z",
  "accounts": [
    {
      "id": "sokrates-team",
      "label": "Sokrates · Team",
      "source_host": "timaeus-mbp",
      "as_of": "2026-08-07T21:38:12Z",
      "status": "ok",
      "five_hour": { "utilization": 0.42, "resets_at": "2026-08-07T23:10:00Z" },
      "seven_day": { "utilization": 0.71, "resets_at": "2026-08-09T04:00:00Z" }
    }
  ]
}
```

`status` is `ok | stale | auth_expired | error`; unrecognised values decode to
`unknown` so a server-side addition degrades one tile rather than the widget.
`utilization` is 0–1 here — the shim divides the payload's 0–100 percentage.

## Edge setup

```bash
mkdir -p ~/.config/claude-usage
cat > ~/.config/claude-usage/config <<'EOF'
USAGE_ACCOUNT_ID=rp-team
USAGE_LABEL="Team · rationallyprime"
USAGE_ENDPOINT=https://timaeus:8443/ingest
USAGE_TOKEN=...
EOF
```

Then point `statusLine` at `edge/statusline-usage.sh` in that machine's Claude
Code settings. With no `USAGE_ENDPOINT` set the shim still renders and caches
locally, which is the way to try it before any aggregator exists.

## Tests

```bash
cd UsageKit && swift test
```

## Not covered

ChatGPT Pro and SuperGrok. Neither exposes subscription usage through anything
supported — OpenAI's usage APIs cover platform API keys, which is separate
billing from a ChatGPT subscription, and xAI does not publish consumer plan
limits at all. Reaching either would mean lifting a browser session cookie.
Those tiles stay absent rather than pretending.

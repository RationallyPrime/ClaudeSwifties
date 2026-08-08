# AI Usage

A native SwiftUI app and WidgetKit extension for iPhone and macOS that shows
Claude and Codex subscription limits, reset times, and reading age.

The Xcode project still uses the historical `ClaudeSwifties` product name, but
the user-facing app and widget are called **AI Usage**.

## What is real today

- One multiplatform app target builds for iOS 17+ and macOS 14+.
- One widget extension builds for both platforms.
- The app and widget share endpoint settings, a read token, and the last good
  snapshot through an App Group.
- Claude Code readings arrive through its status-line JSON.
- Codex readings come from Codex's own
  [`account/rateLimits/read` app-server method](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md#7-rate-limits-chatgpt).
- A small authenticated aggregator keeps the last reading from every machine so
  a phone widget can fetch one compact document.

No collector reads a browser cookie, copies an OAuth token, refreshes a token,
or calls a private web endpoint directly. Claude and Codex remain the owners of
their authenticated sessions.

## Architecture

```text
Claude Code statusLine ─┐
                        ├── authenticated push ──▶ usage aggregator ──▶ iOS/macOS app + widget
Codex app-server RPC ───┘                         public HTTPS + read bearer
```

Edges push because laptops sleep and roam. The aggregator never dials into a
machine, and it stores only the latest reading for each account.

## Design rules

The display is deliberately conservative:

- A stale number stays visible with its age and reduced emphasis.
- Passing a reset timestamp does **not** turn an old reading into zero. The
  account may have been used after the reset without this collector seeing it.
- An unconfigured app shows no readings. It never substitutes plausible demo
  percentages for live data.
- A failed refresh may fall back to the last good snapshot, but the host app
  labels that result **Cached** and shows the failure.
- Provider windows carry their own label and duration. The app no longer assumes
  every service always exposes exactly a five-hour and seven-day pair.

WidgetKit controls actual refresh execution. The extension requests a new
timeline after 15 minutes; iOS or macOS may coalesce that request.

## Repository layout

| Path | Purpose |
| --- | --- |
| `UsageKit/Sources/UsageKit` | Wire model, decoding compatibility, freshness, HTTP provider, shared App Group store |
| `UsageKit/Sources/UsageUI` | SwiftUI meters used by both the host app and widget |
| `App/` | Multiplatform host app and per-platform entitlements |
| `Widget/` | Multiplatform WidgetKit extension and per-platform entitlements |
| `edge/statusline-usage.sh` | Claude status-line renderer and collector |
| `edge/codex_usage.py` | Codex app-server collector; Python standard library only |
| `edge/install-codex-collector.sh` | Installs the Codex collector as a five-minute macOS LaunchAgent |
| `aggregator/` | Bun service, container, persistence, validation, and deployment notes |

## Usage contract

Schema 2 adds provider identity and generic windows. The server also emits
`five_hour` and `seven_day` compatibility fields when those durations are
present, so a schema-1 app remains useful during rollout.

```json
{
  "schema": 2,
  "generated_at": "2026-08-08T00:20:00Z",
  "accounts": [
    {
      "id": "codex-mac",
      "label": "Codex · Pro",
      "provider": "codex",
      "source_host": "Mac",
      "as_of": "2026-08-08T00:19:50Z",
      "status": "ok",
      "windows": [
        {
          "id": "primary-10080m",
          "label": "7d",
          "duration_minutes": 10080,
          "utilization": 0.45,
          "resets_at": "2026-08-09T17:36:32Z"
        }
      ],
      "five_hour": null,
      "seven_day": {
        "utilization": 0.45,
        "resets_at": "2026-08-09T17:36:32Z"
      }
    }
  ]
}
```

`utilization` is used capacity from 0 to 1. `resets_at` may be null when a
provider does not publish a boundary. Unknown account status or provider values
degrade one tile rather than blanking the complete widget.

## Run the aggregator

Generate two different random tokens:

```bash
openssl rand -hex 32
openssl rand -hex 32
```

Then run locally:

```bash
cd aggregator
bun install --frozen-lockfile
INGEST_TOKEN=replace-with-ingest-token \
READ_TOKEN=replace-with-read-token \
DATA_DIR=./.data PORT=8099 \
bun run src/index.ts
```

The production service must be behind HTTPS, retain its `/data` volume, and
keep the ingest and read tokens distinct. See
[`aggregator/README.md`](aggregator/README.md) for its threat model and
[`aggregator/DEPLOY.md`](aggregator/DEPLOY.md) for the current host topology.

## Collect Claude

Create `~/.config/claude-usage/config` on every Claude machine:

```bash
USAGE_ACCOUNT_ID=claude-team
USAGE_LABEL="Claude · Team"
USAGE_ENDPOINT=https://your-host/v1/ingest
USAGE_TOKEN=replace-with-ingest-token
```

Configure Claude Code's `statusLine` command to run the absolute path to
`edge/statusline-usage.sh`. The script still renders a status line when the
network, configuration, or `jq` is unavailable.

Claude's `rate_limits` values appear only after a session has received a model
response. The script caches the last payload locally, but a cache is not a
current reading and the UI treats its age accordingly.

## Collect Codex

The Codex collector performs the normal app-server initialization handshake and
then calls `account/rateLimits/read`. It prefers
`rateLimitsByLimitId.codex` and uses the backwards-compatible `rateLimits`
field only when needed.

Try it without pushing:

```bash
edge/codex_usage.py --print --no-push
```

Configure `~/.config/codex-usage/config`:

```bash
CODEX_BIN="$HOME/.local/bin/codex"
USAGE_ACCOUNT_ID=codex-mac
USAGE_LABEL="Codex · Pro"
USAGE_ENDPOINT=https://your-host/v1/ingest
USAGE_TOKEN=replace-with-ingest-token
```

Install the five-minute LaunchAgent:

```bash
edge/install-codex-collector.sh
```

The installer copies the collector to `~/.local/libexec/ai-usage`, preserves
the config on uninstall, and logs only errors to
`~/Library/Logs/AIUsage/codex-usage.log`.

## Put it on an iPhone

A native iOS widget is not installed by hosting an `.app` on a web server.
There are two routes:

1. **Immediate development install:** connect the iPhone, enable Developer Mode,
   select the phone in Xcode, and press Run.
2. **Ongoing distribution:** archive and upload through App Store Connect, then
   install through TestFlight or the App Store.

For the direct Xcode route:

1. Open `ClaudeSwifties.xcodeproj`.
2. In Xcode Settings → Accounts, sign into the Apple developer account for the
   configured team. Change the team on both targets if needed.
3. Keep the same App Group on both targets:
   `group.is.sokrates.claudeswifties`.
4. On the iPhone, open Settings → Privacy & Security → Developer Mode, turn it
   on, restart, confirm, and enter the device passcode.
5. Select the iPhone as the run destination and run the `ClaudeSwifties`
   scheme.
6. In AI Usage, enter the aggregator's HTTPS `/v1/usage` URL and **read** token.
7. Long-press the Home Screen, add the **AI usage** widget, and choose medium or
   large.

The app and extension both require the App Group provisioning entitlement.
A compile-only build is not proof that settings will cross the process boundary;
inspect the signed app and extension entitlements when diagnosing TestFlight.

## Verify

```bash
cd UsageKit && swift test
```

```bash
cd aggregator && bun install --frozen-lockfile && bun test && bun run check
```

```bash
cd edge && python3 -m unittest -v test_codex_usage.py
```

```bash
xcodebuild -scheme ClaudeSwifties -project ClaudeSwifties.xcodeproj \
  -destination 'generic/platform=iOS Simulator' build
```

```bash
xcodebuild -scheme ClaudeSwifties -project ClaudeSwifties.xcodeproj \
  -destination 'platform=macOS,arch=arm64' build
```

## Deliberately not covered

The general OpenAI API usage endpoints report API-key billing, not a ChatGPT
subscription. That does not make Codex limits unavailable: Codex exposes its
ChatGPT-backed quota through its own app-server protocol, which is the source
used here. SuperGrok remains absent because no supported local or public
consumer-plan usage interface has been established.

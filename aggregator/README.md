# usage-aggregator

Stores the last validated reading for each Claude or Codex account. Collectors
push; the Apple app and widget read one snapshot.

## Endpoints

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/health` | none | Liveness only |
| `POST` | `/v1/ingest` | `INGEST_TOKEN` | Validate and upsert one account |
| `GET` | `/v1/usage` | `READ_TOKEN` | Return the complete schema-2 snapshot |

The service refuses to start when either token is missing, shorter than 16
characters, or equal to the other token. Ingest and read credentials are
separate because they live on different machines and grant different authority.

Every response carries `Cache-Control: no-store`. Request bodies cap at 8 KiB,
bearers are compared in constant time, account/window identifiers are bounded,
timestamps must be ISO-8601 UTC instants, and all usage values must be finite
fractions from 0 to 1.

## Persistence

`DATA_DIR/usage.json` is a tiny last-known-good store written through an atomic
rename. Writes are serialized inside the process. Schema-1 stored accounts are
validated and migrated in memory when schema 2 starts.

The `/data` volume is load-bearing. Losing it does not lose credentials or a
history database—there is no history—but every tile remains empty until its
collector reports again.

## Public exposure

A public URL lets an iPhone widget work without depending on a VPN. That trade
is acceptable only with HTTPS and strong bearers. Interactive access products
such as Cloudflare Access do not fit the widget extension because it cannot
complete a browser login while refreshing a timeline.

The current temporary deployment uses a Tailscale Serve/Funnel proxy to a
container bound only on `127.0.0.1:8080`. See [DEPLOY.md](DEPLOY.md).

## Local development

```bash
bun install --frozen-lockfile
INGEST_TOKEN=dev-ingest-0123456789 \
READ_TOKEN=dev-read-0123456789 \
DATA_DIR=./.data PORT=8099 \
bun run src/index.ts
```

```bash
bun test
bun run check
```

## Freshness ownership

The server preserves the edge-reported status and timestamp. The client computes
age from `as_of`, dims stale readings, and never infers zero merely because an
old reset boundary passed. Silence is normal for Claude's live-session
status-line source; Codex can be polled while idle.

# usage-aggregator

Holds the last-known-good usage reading per Claude account. Edges push; the
widget reads. Nothing else.

## Endpoints

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/health` | none | Coolify health check. Reveals only liveness. |
| `POST` | `/v1/ingest` | `INGEST_TOKEN` | One account object, as emitted by `edge/statusline-usage.sh`. Upserts by `id`. |
| `GET` | `/v1/usage` | `READ_TOKEN` | The full snapshot, in the contract the widget decodes. |

Two tokens, not one, because they have different blast radii: the ingest token
sits in a shell config file on three machines, the read token sits on a phone.
The service refuses to start if either is missing, under 16 characters, or if
they are equal.

## Deploying

Currently running on a temporary host over a private tailnet with a real TLS
cert, pending a permanent home. That is deliberate and cheap to undo: the stored
state is last-known-good cache that every edge rebuilds on its next live
session, so relocating is a one-line `USAGE_ENDPOINT` change with nothing to
migrate.

See [DEPLOY.md](DEPLOY.md). It is a Coolify **service** (compose resource) on
cx43, exposed by a cloudflared sidecar — no published ports and no Traefik, per
that box's conventions. [compose.yml](compose.yml) is the resource definition.

Two things that are load-bearing rather than stylistic:

- **A volume at `/data`.** Without it, readings reset on every redeploy and every
  tile goes blank until each edge next has a live session.
- **`${VAR}` placeholders, never literal tokens, in compose.** Coolify
  interpolates service envs at deploy time; a literal is served to the widget as
  the string `${USAGE_READ_TOKEN}` and every fetch 401s.

## Note on exposure

Reaching this over the public internet rather than the tailnet is a deliberate
trade, not a straight win. A public hostname means the phone works anywhere
without the VPN connected — which matters, because a widget that silently stops
updating whenever Tailscale drops is worse than useless. The cost is an
internet-reachable endpoint, which is why both endpoints are authenticated,
tokens are compared in constant time, bodies cap at 8 KB, every field is
validated, and the container has zero runtime dependencies.

**It must stay bearer-only and never go behind CF Access.** A widget extension
cannot complete an interactive auth flow, so CF Access in front of this would
make the widget permanently unable to fetch. That is why the read token is 32
random bytes rather than something memorable.

## Local development

```bash
INGEST_TOKEN=dev-ingest-0123456789 READ_TOKEN=dev-read-0123456789 \
  DATA_DIR=./.data PORT=8099 bun run src/index.ts
```

```bash
bun test
```

## Design note: silence is not staleness

The service deliberately does **not** downgrade a quiet account to
`status: "stale"`. The statusline ingress only reports while a Claude Code
session is live, so silence is the normal resting state, not a fault. The client
derives age from `as_of` itself, and a server-side `stale` would suppress the
widget's window-reset inference — the thing that lets an idle tile still answer
"have I recovered yet?".

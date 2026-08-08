# Deploying usage-aggregator

## Current temporary host

The live container is on `agent-cx53`, reachable to operators at
`root@167.233.120.83`. Despite the old cx43 notes, this machine is **not** the
Coolify host: it has no `/data/coolify` tree.

Current topology:

- Source staging: `/opt/usage/aggregator`
- Secret environment file: `/opt/usage/.env`
- Container: `usage-aggregator`
- Image: a locally built `usage-aggregator:<tag>`
- Bind: `127.0.0.1:8080 → 8080`
- Persistent volume: `usage-data:/data`
- Public HTTPS: Tailscale Funnel at
  `https://agent-cx53.tail1f9f2e.ts.net`

The client read URL is
`https://agent-cx53.tail1f9f2e.ts.net/v1/usage`. It is public-reachable but
still requires the read bearer; unauthenticated reads must return 401.

The container runs as the image's unprivileged `bun` user. An existing volume
created by the older root-running image needs a one-time ownership correction
before the swap; root can still read it for rollback.

Never print `.env`, `docker inspect ... .Config.Env`, or bearer headers.
Printing key names for a structural check is sufficient.

## Build and test a candidate

Stage source without copying local secrets or dependencies:

```bash
rsync -az --delete \
  --exclude node_modules --exclude .data --exclude .env --exclude '._*' \
  aggregator/ root@167.233.120.83:/opt/usage/aggregator-candidate/
```

Build with a unique tag, ideally the Git commit:

```bash
ssh root@167.233.120.83 \
  'docker build -t usage-aggregator:<commit> /opt/usage/aggregator-candidate'
```

Run the candidate on a separate loopback port and a temporary volume. Pass the
existing env file directly to Docker; do not source or echo it:

```bash
ssh root@167.233.120.83 \
  'docker run -d --name usage-aggregator-candidate --rm \
   --env-file /opt/usage/.env -e DATA_DIR=/data \
   -p 127.0.0.1:8081:8080 -v usage-candidate-data:/data \
   usage-aggregator:<commit>'
```

Verify `/health`, reject an unauthenticated `/v1/usage` request, and perform
an authenticated read using the secret only inside the remote shell. A green
health check alone proves nothing about the bearer path.

## Recoverable production swap

Keep the previous container stopped under a rollback name:

```bash
docker run --rm --user root -v usage-data:/data \
  --entrypoint sh oven/bun:1.3.14-alpine -c 'chown -R bun:bun /data'
docker stop usage-aggregator
docker rename usage-aggregator usage-aggregator-previous
docker run -d --name usage-aggregator --restart unless-stopped \
  --env-file /opt/usage/.env \
  -p 127.0.0.1:8080:8080 \
  -v usage-data:/data \
  usage-aggregator:<commit>
```

Verify container health, authenticated schema, and public behavior before
removing the previous container. Rollback is the reverse: stop and rename the
new container, restore the previous name, then start it.

## Public HTTPS

Tailnet-only Serve:

```bash
tailscale serve --bg --yes 8080
```

Public Funnel:

```bash
tailscale funnel --bg --yes 8080
```

After enabling Funnel, verify from a machine outside the host:

- `GET /health` returns 200.
- `GET /v1/usage` without a bearer returns 401.
- The read bearer returns schema 2.
- The ingest bearer is rejected on `/v1/usage`.
- A collector push appears in the next authenticated snapshot.

## Future Coolify move

The compose file remains suitable for a Coolify service with a cloudflared
sidecar, but the actual Coolify host must be rediscovered first. Do not use
`167.233.120.83` as if it were that box. Any eventual Coolify compose edit is a
dual write to the service's database copy and rendered file, followed by public
URL verification.

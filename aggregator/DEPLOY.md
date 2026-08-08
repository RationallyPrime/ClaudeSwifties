# Deploying usage-aggregator to cx43

Follows the `deploy-to-cx43` conventions: Coolify **service** (compose resource),
cloudflared sidecar, no published ports, no Traefik, dual-write on every later
compose edit.

> **Verify the host first.** The address recorded in the `deploy-to-cx43` skill
> answers as a CI runner, not the Coolify box — no `/data/coolify`, no
> containers. Confirm you are pointed at the right machine before running any of
> this, or you will be dual-writing into a box that has no Coolify on it.

## 0. Parameters

```bash
export COOLIFY_HOST=<real-cx43-ip>
export AGG_FQDN=usage.sokrates.is
```

## 1. Tokens

Two, and they must differ — the service refuses to start otherwise. The ingest
token ends up in a shell config on three machines; the read token ends up on a
phone.

```bash
echo "INGEST: $(openssl rand -hex 32)"; echo "READ: $(openssl rand -hex 32)"
```

## 2. Cloudflare tunnel (your side)

Create a tunnel for this service in the Cloudflare dashboard, add a public
hostname routing `$AGG_FQDN` → `http://usage-aggregator:8080`, and copy the
tunnel token. DNS becomes a proxied CNAME to `{tunnel-id}.cfargotunnel.com`.

**Leave CF Access off.** This is an API, not a frontend. A widget extension
cannot complete an interactive auth flow, so CF Access would permanently break
the widget. Bearer-only is the whole protection here, which is why the tokens
are 32 random bytes.

## 3. Create the service and set envs

Create a Docker Compose service in Coolify pointed at this repo, base directory
`/aggregator`. Note its uuid, then:

```bash
export SERVICE_UUID=<uuid-from-coolify>
```

Export the Coolify API token from your secret store without echoing it:

```bash
export COOLIFY_TOKEN=$(<your secret-store command>)
```

Set the three envs. Compose references these as `${VAR}` — never literals, per
scar 7:

```bash
for kv in "USAGE_INGEST_TOKEN=$INGEST" "USAGE_READ_TOKEN=$READ" "USAGE_TUNNEL_TOKEN=$TUNNEL"; do curl -sS -X POST "http://$COOLIFY_HOST:8000/api/v1/services/$SERVICE_UUID/envs" -H "Authorization: Bearer $COOLIFY_TOKEN" -H 'content-type: application/json' --data "{\"key\":\"${kv%%=*}\",\"value\":\"${kv#*=}\",\"is_preview\":false}" >/dev/null && echo "set ${kv%%=*}"; done
```

## 4. Push the compose and deploy

`docker_compose_raw` must be **base64-encoded** or the API returns 422:

```bash
curl -sS -X PATCH "http://$COOLIFY_HOST:8000/api/v1/services/$SERVICE_UUID" -H "Authorization: Bearer $COOLIFY_TOKEN" -H 'content-type: application/json' --data "{\"docker_compose_raw\":\"$(base64 -w0 < compose.yml)\"}"
```

```bash
curl -sS -X POST "http://$COOLIFY_HOST:8000/api/v1/deploy?uuid=$SERVICE_UUID" -H "Authorization: Bearer $COOLIFY_TOKEN"
```

A dashboard-triggered deploy renders the DB copy to
`/data/coolify/services/$SERVICE_UUID/docker-compose.yml`, so creation via the
API needs no dual-write. **Every later compose edit does** — file and DB
together, or the next deploy reverts you.

## 5. Verification ladder

Container up:

```bash
ssh root@$COOLIFY_HOST 'docker ps --format "{{.Names}}\t{{.Status}}" | grep usage-aggregator'
```

Liveness — necessary, and proof of nothing else (scar 9: an unauthenticated
health endpoint says nothing about the bearer path):

```bash
curl -sS "https://$AGG_FQDN/health"
```

**The check that actually matters.** Bearer path returns the contract, and the
ingest token is rejected on the read endpoint:

```bash
curl -sS -H "Authorization: Bearer $READ" "https://$AGG_FQDN/v1/usage" | jq .
```

```bash
curl -sS -o /dev/null -w "no token: %{http_code}\ningest token on read: " "https://$AGG_FQDN/v1/usage"; curl -sS -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer $INGEST" "https://$AGG_FQDN/v1/usage"
```

Expect `200` on the first, `401` on both of the second. Use curl, not
`Python-urllib` — Cloudflare bans that UA with error 1010 (scar 2).

Round-trip a push before trusting it:

```bash
curl -sS -X POST "https://$AGG_FQDN/v1/ingest" -H "Authorization: Bearer $INGEST" -H 'content-type: application/json' --data '{"id":"probe","label":"probe","source_host":"laptop","as_of":"2026-08-07T21:38:12Z","status":"ok","five_hour":{"utilization":0.5,"resets_at":"2026-08-07T23:10:00Z"},"seven_day":null}'
```

If a token looks wrong, resolved values exist only inside the container —
inspect, never `docker exec … env` (scar 5), and export rather than print
(scar 7):

```bash
ssh root@$COOLIFY_HOST 'docker inspect $(docker ps --filter name=usage-aggregator -q) --format "{{json .Config.Env}}" | jq -r ".[]" | cut -d= -f1'
```

That prints key names only.

## 6. Point the edges at it

On each of the three machines, with `$INGEST` from step 1:

```bash
mkdir -p ~/.config/claude-usage && cat > ~/.config/claude-usage/config <<EOF
USAGE_ACCOUNT_ID=rp-team
USAGE_LABEL="Team · rationallyprime"
USAGE_ENDPOINT=https://usage.sokrates.is/v1/ingest
USAGE_TOKEN=$INGEST
EOF
```

Then set that machine's Claude Code `statusLine` to `edge/statusline-usage.sh`.
Give each edge a distinct `USAGE_ACCOUNT_ID` and `USAGE_LABEL` — the aggregator
upserts by `id`, so two edges sharing one would overwrite each other.

Delete the probe account once real pushes land:

```bash
ssh root@$COOLIFY_HOST 'docker exec $(docker ps --filter name=usage-aggregator -q) sh -c "cat /data/usage.json"' | jq '[.[] | select(.account.id != "probe")]'
```

(There is no delete endpoint — the service only upserts. Removing the probe means
editing the volume file directly, or leaving it as a harmless fourth tile.)

# Deploying usage-aggregator schema 3

This public document intentionally contains no live hostname, IP address,
login, endpoint, private-network name, filesystem path, or container name.
Keep those coordinates in the private operations corpus.

## Topology and trust boundaries

Run the aggregator as an unprivileged container with a persistent volume at
`/data`. Expose the read surface through HTTPS. Prefer routing ingest only over
a private listener/network when the deployment platform can split the surfaces
cleanly.

The public liveness probe is `GET /health`. Readiness is not public:
`GET /ready` requires the read bearer and proves that a SQLite write transaction
can commit. An authenticated `GET /doctor` adds the conflict count without
returning observations or provider metadata.

Required secrets/configuration:

- `READ_TOKEN`: app/widget bearer;
- `EDGE_CREDENTIALS_JSON`: token SHA-256 → edge/profile allow-list map;
- proxy/tunnel credentials, when the chosen HTTPS ingress requires them.

Never print environment values, Authorization headers, container environment,
or raw collector configuration during structural checks.

## Build and test a candidate

Build from the repository root or `aggregator/` according to the deployment
system, pinning the image to the exact Git commit rather than `latest`.

```sh
cd aggregator
bun install --frozen-lockfile
bun test
bun run check
docker build -t usage-aggregator:<commit> .
```

Run the candidate on a separate private port and a temporary persistent volume.
Pass secrets through the platform secret mechanism or an environment file that
is never sourced, echoed, or committed.

Verify all of the following, not merely container health:

- `/health` is 200 without credentials;
- `/ready` is 401 without credentials and 200 with the read bearer;
- unauthenticated `/v3/usage` is 401;
- an edge bearer cannot read and the read bearer cannot ingest;
- one edge bearer cannot claim another edge/profile;
- a valid observation receives a matching-ID 2xx ACK and appears in the next
  authenticated schema-3 snapshot;
- `/doctor` is authenticated and reports readiness plus conflict count;
- the database, WAL, and shared-memory files are private to the service user.

## One-time schema-2 cutover

Do not replace the live schema-2 service in place before testing the schema-3
candidate.

1. Back up the persistent volume using the private operations procedure.
2. Copy `usage.json` into the candidate volume without printing it.
3. Start the candidate with `REQUIRE_LEGACY_IMPORT=true`.
4. Confirm startup imported provisional pools, committed the migration marker,
   and removed `usage.json`.
5. Install one schema-3 canary edge and prove duplicate/retry delivery.
6. Update the app/widget and remaining edges.
7. Exercise real pool switches and shared-pool bindings.
8. Retire schema 2 only after the terminal KRA-1096 live proof succeeds.

There is no dual-format endpoint and no permanent schema-2 importer. If the
legacy input is missing or corrupt in required-import mode, startup must remain
failed until the operator restores the intended input or explicitly chooses a
fresh-install deployment.

## Credential rotation

After all edges use their per-edge tokens:

1. retire the old fleet-wide ingest bearer;
2. verify the retired bearer fails both read and ingest;
3. rotate the read bearer after every signed client has migrated it to
   Keychain;
4. verify the old read bearer fails;
5. inspect bounded logs, process listings, preferences, repository artifacts,
   and crash output for accidental bearer exposure.

Roll back by restoring the prior immutable image and its backed-up volume. Do
not point a schema-2 process at a schema-3 SQLite volume.

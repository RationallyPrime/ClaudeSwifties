import { randomUUID } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { digestToken, type EdgeCredential } from "./config.js";
import type { UsageObservation } from "./contract.js";
import { createApp, MAX_BODY_BYTES, type UsageApp } from "./server.js";
import { DEFAULT_STORE_OPTIONS, openStore, type UsageStore } from "./store.js";
import { VALID_OBSERVATION } from "./test-fixtures.js";

const READ_TOKEN = "read-token-0123456789";
const EDGE_TOKEN = "edge-token-0123456789";
const OTHER_EDGE_TOKEN = "other-edge-token-0123456789";

interface TestApp {
  app: UsageApp;
  store: UsageStore;
  setNow(value: string): void;
}

async function freshApp(
  auth: { maximum?: number; windowMs?: number } = {},
): Promise<TestApp> {
  const dir = await mkdtemp(join(tmpdir(), "usage-v3-server-"));
  const store = await openStore(dir, DEFAULT_STORE_OPTIONS);
  let current = new Date("2026-08-15T15:30:01Z");
  const credentials: EdgeCredential[] = [
    {
      tokenDigest: digestToken(EDGE_TOKEN),
      edgeId: "edge-linux",
      profileIds: new Set(["desktop-a", "build-station-b"]),
    },
    {
      tokenDigest: digestToken(OTHER_EDGE_TOKEN),
      edgeId: "edge-other",
      profileIds: new Set(["other-profile"]),
    },
  ];
  return {
    store,
    app: createApp({
      store,
      readTokenDigest: digestToken(READ_TOKEN),
      edgeCredentials: credentials,
      invalidAuthMaxAttempts: auth.maximum ?? 20,
      invalidAuthWindowMs: auth.windowMs ?? 60_000,
      now: () => current,
      log: () => {},
    }),
    setNow(value: string) {
      current = new Date(value);
    },
  };
}

function observation(
  overrides: Partial<Record<keyof UsageObservation, unknown>> = {},
): Record<string, unknown> {
  return {
    ...VALID_OBSERVATION,
    observation_id: randomUUID(),
    ...overrides,
  };
}

function bearer(token: string): string {
  return `Bearer ${token}`;
}

function post(
  body: unknown,
  token = EDGE_TOKEN,
  headers: Record<string, string> = {},
): Request {
  return new Request("http://usage.test/v3/observations", {
    method: "POST",
    headers: {
      authorization: bearer(token),
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function get(path: string, token?: string): Request {
  const headers = token ? { authorization: bearer(token) } : undefined;
  return new Request(`http://usage.test${path}`, { headers });
}

describe("schema-3 HTTP server", () => {
  test("health stays public while readiness requires read auth and commits a write probe", async () => {
    const { app, store } = await freshApp();
    expect((await app.fetch(get("/health"))).status).toBe(200);
    expect(await (await app.fetch(get("/health"))).json()).toEqual({ ok: true });
    expect((await app.fetch(get("/ready"))).status).toBe(401);
    const ready = await app.fetch(get("/ready", READ_TOKEN));
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({ ready: true });
    store.close();
  });

  test("ingests with a per-edge credential and returns the exact durable ACK shape", async () => {
    const { app, store } = await freshApp();
    const item = observation();
    const response = await app.fetch(post(item), "client-a");
    expect(response.status).toBe(200);
    const ack = await response.json() as Record<string, unknown>;
    expect(ack).toEqual({
      ok: true,
      observation_id: item.observation_id,
      outcome: "accepted",
      clock_skewed: false,
    });
    expect(Object.keys(ack).sort()).toEqual([
      "clock_skewed",
      "observation_id",
      "ok",
      "outcome",
    ]);
    store.close();
  });

  test("returns a strict schema-3 snapshot and separates read/ingest roles", async () => {
    const { app, store } = await freshApp();
    expect((await app.fetch(post(observation()), "edge-client")).status).toBe(200);

    const edgeRead = await app.fetch(get("/v3/usage", EDGE_TOKEN), "edge-client-2");
    expect(edgeRead.status).toBe(401);
    const readIngest = await app.fetch(post(observation(), READ_TOKEN), "read-client");
    expect(readIngest.status).toBe(401);

    const response = await app.fetch(get("/v3/usage", READ_TOKEN), "reader");
    expect(response.status).toBe(200);
    const snapshot = await response.json() as Record<string, unknown>;
    expect(snapshot.schema).toBe(3);
    expect(snapshot).not.toHaveProperty("accounts");
    expect((snapshot.pools as unknown[])).toHaveLength(1);
    store.close();
  });

  test("does not retain schema-1/2 HTTP compatibility routes", async () => {
    const { app, store } = await freshApp();
    expect((await app.fetch(get("/v1/usage", READ_TOKEN))).status).toBe(404);
    const legacyIngest = new Request("http://usage.test/v1/ingest", {
      method: "POST",
      headers: {
        authorization: bearer(EDGE_TOKEN),
        "content-type": "application/json",
      },
      body: JSON.stringify({ id: "legacy-account" }),
    });
    expect((await app.fetch(legacyIngest)).status).toBe(404);
    store.close();
  });

  test("one edge credential cannot claim another edge or profile", async () => {
    const { app, store } = await freshApp();
    const wrongEdge = await app.fetch(post(observation({ edge_id: "edge-other" })), "client-a");
    const wrongProfile = await app.fetch(post(observation({ profile_id: "other-profile" })), "client-b");
    expect(wrongEdge.status).toBe(403);
    expect(wrongProfile.status).toBe(403);
    expect(await wrongEdge.text()).toBe('{"error":"forbidden"}');
    expect(store.snapshot("2026-08-15T15:31:00Z").pools).toEqual([]);
    store.close();
  });

  test("all invalid credentials receive the same fixed-shape 401", async () => {
    const { app, store } = await freshApp();
    const missing = await app.fetch(get("/v3/usage"), "a");
    const malformed = await app.fetch(new Request("http://usage.test/v3/usage", {
      headers: { authorization: "Basic abc" },
    }), "b");
    const wrong = await app.fetch(get("/v3/usage", "wrong-token-0123456789"), "c");
    expect([missing.status, malformed.status, wrong.status]).toEqual([401, 401, 401]);
    const bodies = await Promise.all([missing.text(), malformed.text(), wrong.text()]);
    expect(new Set(bodies).size).toBe(1);
    store.close();
  });

  test("bounds rotating invalid auth attempts without locking out a valid credential", async () => {
    const { app, store, setNow } = await freshApp({ maximum: 2, windowMs: 1_000 });
    expect((await app.fetch(get("/v3/usage", "wrong-token-a-012345"), "attacker")).status)
      .toBe(401);
    expect((await app.fetch(get("/v3/usage", "wrong-token-b-012345"), "attacker")).status)
      .toBe(401);
    const limited = await app.fetch(
      get("/v3/usage", "wrong-token-c-012345"),
      "attacker",
    );
    expect(limited.status).toBe(401);
    expect(limited.headers.get("retry-after")).toBe("1");
    expect(await limited.text()).toBe('{"error":"unauthorised"}');
    // Authentication precedes invalid-attempt limiting, so a noisy client
    // behind a shared proxy cannot lock out a valid credential.
    expect((await app.fetch(get("/v3/usage", READ_TOKEN), "attacker")).status).toBe(200);
    expect((await app.fetch(get("/v3/usage", READ_TOKEN), "reader")).status).toBe(200);
    // A valid request bypasses the limiter but cannot erase the attack history
    // accumulated for the shared client key.
    const stillLimited = await app.fetch(
      get("/v3/usage", "wrong-token-d-012345"),
      "attacker",
    );
    expect(stillLimited.headers.get("retry-after")).toBe("1");
    expect((await app.fetch(get("/v3/usage", READ_TOKEN), "attacker")).status).toBe(200);
    setNow("2026-08-15T15:30:02.001Z");
    expect((await app.fetch(
      get("/v3/usage", "wrong-token-e-012345"),
      "attacker",
    )).headers.get("retry-after"))
      .toBeNull();
    store.close();
  });

  test("rejects non-JSON and compressed request bodies before parsing", async () => {
    const { app, store } = await freshApp();
    expect((await app.fetch(post(observation(), EDGE_TOKEN, { "content-type": "text/plain" }))).status)
      .toBe(415);
    expect((await app.fetch(post(observation(), EDGE_TOKEN, { "content-encoding": "gzip" }))).status)
      .toBe(415);
    store.close();
  });

  test("terminates a chunked body once UTF-8 bytes exceed 8 KiB", async () => {
    const { app, store } = await freshApp();
    let pulls = 0;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(new Uint8Array(3_000).fill(0x78));
        if (pulls > 10) controller.close();
      },
      cancel() {
        cancelled = true;
      },
    });
    const request = new Request("http://usage.test/v3/observations", {
      method: "POST",
      headers: {
        authorization: bearer(EDGE_TOKEN),
        "content-type": "application/json",
      },
      body,
      // Required by the Fetch standard for streaming request bodies. Bun's
      // Request accepts it even though older DOM typings omit the property.
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    const response = await app.fetch(request, "stream-client");
    expect(response.status).toBe(413);
    expect(cancelled).toBeTrue();
    expect(pulls).toBeLessThanOrEqual(3);
    store.close();
  });

  test("applies the byte bound, not JavaScript UTF-16 string length", async () => {
    const { app, store } = await freshApp();
    const body = JSON.stringify({ payload: "é".repeat(MAX_BODY_BYTES / 2) });
    expect(body.length).toBeLessThanOrEqual(MAX_BODY_BYTES);
    const response = await app.fetch(new Request("http://usage.test/v3/observations", {
      method: "POST",
      headers: {
        authorization: bearer(EDGE_TOKEN),
        "content-type": "application/json",
      },
      body,
    }), "unicode-client");
    expect(response.status).toBe(413);
    store.close();
  });

  test("strict unknown-field validation fails closed at the HTTP boundary", async () => {
    const { app, store } = await freshApp();
    const response = await app.fetch(post({ ...observation(), access_token: "must-not-persist" }));
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("unknown field");
    expect(store.snapshot("2026-08-15T15:31:00Z").pools).toEqual([]);
    store.close();
  });

  test("future clock clamp is named in ACK and cannot create a permanently fresh tile", async () => {
    const { app, store } = await freshApp();
    const item = observation({
      observed_at: "2099-01-01T00:00:01Z",
      sampled_at: "2099-01-01T00:00:00Z",
    });
    const response = await app.fetch(post(item));
    const ack = await response.json() as Record<string, unknown>;
    expect(ack.clock_skewed).toBeTrue();
    const duplicate = await (await app.fetch(post(item))).json() as Record<string, unknown>;
    expect(duplicate.outcome).toBe("duplicate");
    expect(duplicate.clock_skewed).toBeTrue();
    expect(store.snapshot("2026-08-15T15:30:02Z").pools[0]?.sampled_at)
      .toBe("2026-08-15T15:30:01.000Z");
    store.close();
  });

  test("authenticated doctor surfaces readiness and identity conflict count without payloads", async () => {
    const { app, store, setNow } = await freshApp();
    const first = observation({
      sequence: 1,
      windows: [{
        id: "five-hour",
        label: "5h",
        duration_minutes: 300,
        utilization: 0.58,
        resets_at: "2026-08-15T18:00:00Z",
      }],
    });
    expect((await app.fetch(post(first))).status).toBe(200);
    setNow("2026-08-15T15:31:01Z");
    const conflicting = observation({
      sequence: 2,
      sampled_at: "2026-08-15T15:31:00Z",
      observed_at: "2026-08-15T15:31:00Z",
      windows: [{
        id: "five-hour",
        label: "5h",
        duration_minutes: 300,
        utilization: 0.4,
        resets_at: "2026-08-15T18:00:00Z",
      }],
    });
    expect((await app.fetch(post(conflicting))).status).toBe(200);

    expect((await app.fetch(get("/doctor"))).status).toBe(401);
    const response = await app.fetch(get("/doctor", READ_TOKEN), "doctor-client");
    expect(response.status).toBe(200);
    const body = await response.json() as Record<string, unknown>;
    expect(body.schema).toBe(3);
    expect(body.ready).toBe(true);
    expect(body.conflict_count).toBe(1);
    expect(body.identity_key_mismatch_count).toBe(0);
    expect(body.last_identity_key_mismatch).toBeNull();

    // The reporting profile carries its full operational projection.
    const profiles = body.profiles as Record<string, unknown>[];
    const reporting = profiles.find((row) => row.profile_id === "desktop-a");
    expect(reporting).toMatchObject({
      configured: true,
      edge_id: "edge-linux",
      provider: "claude",
      observer_instance_id: VALID_OBSERVATION.observer_instance_id,
      identity_key_id: VALID_OBSERVATION.identity_key_id,
      last_sequence: 2,
      freshness: "current",
    });
    expect(reporting?.first_seen_at).toBeTruthy();
    const lastConflict = reporting?.last_conflict as Record<string, unknown>;
    expect(typeof lastConflict.kind).toBe("string");
    expect(typeof lastConflict.at).toBe("string");

    // Configured-but-silent profiles appear as never-seen, not as absent.
    const silent = profiles.find((row) => row.profile_id === "other-profile");
    expect(silent).toMatchObject({
      configured: true,
      edge_id: "edge-other",
      freshness: "never",
      last_received_at: null,
    });

    // Doctor exposes bounded evidence, never payloads or provider subjects.
    const raw = JSON.stringify(body);
    expect(raw).not.toContain(VALID_OBSERVATION.provider_subject);
    expect(raw).not.toContain("payload");
    store.close();
  });

  test("a wrong identity-key namespace is rejected loudly and counted", async () => {
    const dir = await mkdtemp(join(tmpdir(), "usage-v3-keyid-"));
    const store = await openStore(dir, DEFAULT_STORE_OPTIONS);
    const app = createApp({
      store,
      readTokenDigest: digestToken(READ_TOKEN),
      edgeCredentials: [{
        tokenDigest: digestToken(EDGE_TOKEN),
        edgeId: "edge-linux",
        profileIds: new Set(["desktop-a"]),
      }],
      invalidAuthMaxAttempts: 20,
      invalidAuthWindowMs: 60_000,
      expectedIdentityKeyId: VALID_OBSERVATION.identity_key_id,
      log: () => {},
    });

    const accepted = await app.fetch(post(observation({ sequence: 1 })));
    expect(accepted.status).toBe(200);

    const mismatched = await app.fetch(post(observation({
      sequence: 2,
      identity_key_id: "Zz9y8X7w6V5u4T3s",
    })));
    expect(mismatched.status).toBe(422);
    expect(await mismatched.json()).toEqual({
      error: "identity_key_id does not match this aggregator's namespace",
      presented_key_id: "Zz9y8X7w6V5u4T3s",
      expected_key_id: VALID_OBSERVATION.identity_key_id,
    });

    const doctor = await app.fetch(get("/doctor", READ_TOKEN), "doctor-client");
    const body = await doctor.json() as Record<string, unknown>;
    expect(body.identity_key_mismatch_count).toBe(1);
    expect(body.last_identity_key_mismatch).toMatchObject({
      profile_id: "desktop-a",
      edge_id: "edge-linux",
      presented_key_id: "Zz9y8X7w6V5u4T3s",
    });
    store.close();
  });
});

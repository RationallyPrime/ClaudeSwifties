import { timingSafeEqual } from "node:crypto";

import { ValidationError, parseAccount } from "./contract.js";
import { openStore } from "./store.js";

const PORT = Number(process.env.PORT ?? 8080);
const DATA_DIR = process.env.DATA_DIR ?? "/data";
const MAX_ACCOUNTS = Number(process.env.MAX_ACCOUNTS ?? 16);
const MAX_BODY_BYTES = 8 * 1024;

/**
 * Separate tokens by blast radius: the ingest token lives on three edges and in
 * a shell config file; the read token lives on a phone. A leak of one must not
 * grant the other.
 */
const INGEST_TOKEN = process.env.INGEST_TOKEN ?? "";
const READ_TOKEN = process.env.READ_TOKEN ?? "";

// Refuse to start unauthenticated. Coolify will hand this service a public
// domain, and an aggregator that boots without tokens would silently serve
// account telemetry to the internet.
for (const [name, value] of [
  ["INGEST_TOKEN", INGEST_TOKEN],
  ["READ_TOKEN", READ_TOKEN],
] as const) {
  if (value.length < 16) {
    console.error(`${name} must be set to at least 16 characters; refusing to start`);
    process.exit(1);
  }
}

if (INGEST_TOKEN === READ_TOKEN) {
  console.error("INGEST_TOKEN and READ_TOKEN must differ; refusing to start");
  process.exit(1);
}

const store = await openStore(DATA_DIR, MAX_ACCOUNTS);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}

/** Constant-time so a wrong token can't be recovered by timing the response. */
function tokenMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function authorised(request: Request, expected: string): boolean {
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return false;
  return tokenMatches(header.slice("Bearer ".length), expected);
}

async function readBody(request: Request): Promise<unknown> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES) throw new ValidationError("body too large");

  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw new ValidationError("body too large");

  try {
    return JSON.parse(text);
  } catch {
    throw new ValidationError("body is not valid JSON");
  }
}

const server = Bun.serve({
  port: PORT,
  hostname: "0.0.0.0",
  async fetch(request) {
    const url = new URL(request.url);

    // Unauthenticated on purpose: Coolify's health check has no credentials,
    // and this reveals nothing beyond liveness.
    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true });
    }

    if (request.method === "POST" && url.pathname === "/v1/ingest") {
      if (!authorised(request, INGEST_TOKEN)) return json({ error: "unauthorised" }, 401);
      try {
        const account = parseAccount(await readBody(request));
        await store.upsert(account, new Date().toISOString());
        // Log the identity, never the payload — utilization figures are the
        // thing this service exists to keep private.
        console.log(`ingest ${account.id} from ${account.source_host}`);
        return json({ ok: true });
      } catch (error) {
        if (error instanceof ValidationError) return json({ error: error.message }, 400);
        console.error("ingest failed", error);
        return json({ error: "internal error" }, 500);
      }
    }

    if (request.method === "GET" && url.pathname === "/v1/usage") {
      if (!authorised(request, READ_TOKEN)) return json({ error: "unauthorised" }, 401);
      return json(store.snapshot(new Date().toISOString()));
    }

    return json({ error: "not found" }, 404);
  },
});

console.log(`usage aggregator listening on :${server.port}, data in ${DATA_DIR}`);

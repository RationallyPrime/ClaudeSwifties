import { createHash, timingSafeEqual } from "node:crypto";

import { DEFAULT_STORE_OPTIONS, type StoreOptions } from "./store.js";

const HEX_SHA256 = /^[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const PRESENTED_TOKEN = /^[\x21-\x7e]{16,512}$/;

export interface EdgeCredential {
  tokenDigest: Buffer;
  edgeId: string;
  profileIds: ReadonlySet<string>;
}

export interface RuntimeConfig {
  port: number;
  dataDir: string;
  readTokenDigest: Buffer;
  edgeCredentials: readonly EdgeCredential[];
  store: StoreOptions;
  requireLegacyImport: boolean;
  invalidAuthMaxAttempts: number;
  invalidAuthWindowMs: number;
}

export function digestToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

export function digestsEqual(a: Uint8Array, b: Uint8Array): boolean {
  // All configured values are SHA-256, so this comparison never takes the
  // variable-length early-return branch that raw bearer comparison would.
  return a.byteLength === 32 && b.byteLength === 32 && timingSafeEqual(a, b);
}

export function parseRuntimeConfig(
  env: Record<string, string | undefined>,
): RuntimeConfig {
  const port = integerEnv(env.PORT, "PORT", 8080, 1, 65_535);
  const maxPools = integerEnv(env.MAX_POOLS, "MAX_POOLS", 64, 1, 1_000);
  const futureSkewSeconds = numberEnv(
    env.MAX_FUTURE_SKEW_SECONDS,
    "MAX_FUTURE_SKEW_SECONDS",
    DEFAULT_STORE_OPTIONS.maxFutureSkewMs / 1_000,
    0,
    3_600,
  );
  const resetSkewSeconds = numberEnv(
    env.RESET_SKEW_SECONDS,
    "RESET_SKEW_SECONDS",
    DEFAULT_STORE_OPTIONS.resetSkewMs / 1_000,
    0,
    3_600,
  );
  const regressionTolerance = numberEnv(
    env.UTILIZATION_REGRESSION_TOLERANCE,
    "UTILIZATION_REGRESSION_TOLERANCE",
    DEFAULT_STORE_OPTIONS.regressionTolerance,
    0,
    0.1,
  );
  const invalidAuthMaxAttempts = integerEnv(
    env.INVALID_AUTH_MAX_ATTEMPTS,
    "INVALID_AUTH_MAX_ATTEMPTS",
    20,
    1,
    1_000,
  );
  const invalidAuthWindowSeconds = integerEnv(
    env.INVALID_AUTH_WINDOW_SECONDS,
    "INVALID_AUTH_WINDOW_SECONDS",
    60,
    1,
    3_600,
  );

  const dataDir = env.DATA_DIR ?? "/data";
  if (dataDir.length === 0 || dataDir.length > 4_096 || CONTROL_CHARACTERS.test(dataDir)) {
    throw new Error("DATA_DIR must be a non-empty control-free path");
  }

  const readToken = env.READ_TOKEN ?? "";
  validatePresentedToken(readToken, "READ_TOKEN");
  const readTokenDigest = digestToken(readToken);
  const edgeCredentials = parseEdgeCredentials(env.EDGE_CREDENTIALS_JSON ?? "");
  if (edgeCredentials.some((credential) => digestsEqual(credential.tokenDigest, readTokenDigest))) {
    throw new Error("READ_TOKEN must differ from every edge ingest token");
  }

  return {
    port,
    dataDir,
    readTokenDigest,
    edgeCredentials,
    store: {
      maxPools,
      maxFutureSkewMs: futureSkewSeconds * 1_000,
      resetSkewMs: resetSkewSeconds * 1_000,
      regressionTolerance,
    },
    requireLegacyImport: booleanEnv(
      env.REQUIRE_LEGACY_IMPORT,
      "REQUIRE_LEGACY_IMPORT",
      false,
    ),
    invalidAuthMaxAttempts,
    invalidAuthWindowMs: invalidAuthWindowSeconds * 1_000,
  };
}

function parseEdgeCredentials(raw: string): EdgeCredential[] {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("EDGE_CREDENTIALS_JSON must be valid JSON");
  }
  if (!Array.isArray(value) || value.length === 0 || value.length > 128) {
    throw new Error("EDGE_CREDENTIALS_JSON must contain 1..128 credential entries");
  }

  const credentials: EdgeCredential[] = [];
  const hashes = new Set<string>();
  const profileOwners = new Map<string, string>();
  for (const [index, item] of value.entries()) {
    const field = `EDGE_CREDENTIALS_JSON[${index}]`;
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error(`${field} must be an object`);
    }
    const record = item as Record<string, unknown>;
    const unknown = Object.keys(record).filter((key) =>
      !["token_sha256", "edge_id", "profile_ids"].includes(key)
    );
    if (unknown.length > 0) throw new Error(`${field} contains unknown field(s): ${unknown.join(", ")}`);

    if (typeof record.token_sha256 !== "string" || !HEX_SHA256.test(record.token_sha256)) {
      throw new Error(`${field}.token_sha256 must be a lowercase SHA-256 hex digest`);
    }
    if (hashes.has(record.token_sha256)) throw new Error(`${field}.token_sha256 is duplicated`);
    hashes.add(record.token_sha256);

    const edgeId = configId(record.edge_id, `${field}.edge_id`);
    if (!Array.isArray(record.profile_ids) || record.profile_ids.length === 0 || record.profile_ids.length > 128) {
      throw new Error(`${field}.profile_ids must contain 1..128 profile ids`);
    }
    const profileIds = record.profile_ids.map((profile, profileIndex) =>
      configId(profile, `${field}.profile_ids[${profileIndex}]`)
    );
    if (new Set(profileIds).size !== profileIds.length) {
      throw new Error(`${field}.profile_ids must be unique`);
    }
    for (const profileId of profileIds) {
      const owner = profileOwners.get(profileId);
      if (owner !== undefined && owner !== edgeId) {
        throw new Error(
          `${field}.profile_ids contains ${profileId} already assigned to edge ${owner}`,
        );
      }
      profileOwners.set(profileId, edgeId);
    }

    credentials.push({
      tokenDigest: Buffer.from(record.token_sha256, "hex"),
      edgeId,
      profileIds: new Set(profileIds),
    });
  }
  return credentials;
}

function validatePresentedToken(token: string, name: string): void {
  if (!PRESENTED_TOKEN.test(token)) {
    throw new Error(`${name} must contain 16..512 ASCII graphic characters`);
  }
}

function configId(value: unknown, name: string): string {
  if (typeof value !== "string" || !SAFE_ID.test(value)) {
    throw new Error(`${name} must be a safe identifier of 1..64 chars`);
  }
  return value;
}

function integerEnv(
  raw: string | undefined,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be an integer`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be within ${minimum}..${maximum}`);
  }
  return value;
}

function numberEnv(
  raw: string | undefined,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be within ${minimum}..${maximum}`);
  }
  return value;
}

function booleanEnv(raw: string | undefined, name: string, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  throw new Error(`${name} must be true, false, 1, or 0`);
}

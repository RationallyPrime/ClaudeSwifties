import { describe, expect, test } from "bun:test";

import { digestToken, parseRuntimeConfig } from "./config.js";

const READ_TOKEN = "read-token-0123456789";
const EDGE_TOKEN = "edge-token-0123456789";

function edgeConfig(token = EDGE_TOKEN): string {
  return JSON.stringify([{
    token_sha256: digestToken(token).toString("hex"),
    edge_id: "edge-linux",
    profile_ids: ["desktop-a", "build-station-b"],
  }]);
}

function validEnv(): Record<string, string> {
  return {
    READ_TOKEN,
    EDGE_CREDENTIALS_JSON: edgeConfig(),
  };
}

describe("parseRuntimeConfig", () => {
  test("parses hash-only per-edge credentials and bounded defaults", () => {
    const config = parseRuntimeConfig(validEnv());
    expect(config.port).toBe(8080);
    expect(config.store.maxPools).toBe(64);
    expect(config.store.maxFutureSkewMs).toBe(300_000);
    expect(config.edgeCredentials[0]?.edgeId).toBe("edge-linux");
    expect([...config.edgeCredentials[0]!.profileIds]).toEqual(["desktop-a", "build-station-b"]);
  });

  test("rejects unbounded or malformed numeric configuration", () => {
    const invalid: Array<[string, string]> = [
      ["PORT", "0"],
      ["PORT", "65536"],
      ["PORT", "8080.5"],
      ["MAX_POOLS", "0"],
      ["MAX_FUTURE_SKEW_SECONDS", "3601"],
      ["RESET_SKEW_SECONDS", "-1"],
      ["UTILIZATION_REGRESSION_TOLERANCE", "0.2"],
    ];
    for (const [name, value] of invalid) {
      expect(() => parseRuntimeConfig({ ...validEnv(), [name]: value })).toThrow(name);
    }
  });

  test("requires a valid explicit cutover flag", () => {
    expect(parseRuntimeConfig({ ...validEnv(), REQUIRE_LEGACY_IMPORT: "true" }).requireLegacyImport)
      .toBeTrue();
    expect(() => parseRuntimeConfig({ ...validEnv(), REQUIRE_LEGACY_IMPORT: "sometimes" }))
      .toThrow(/REQUIRE_LEGACY_IMPORT/);
  });

  test("rejects raw edge tokens, unknown fields, unsafe ids, and duplicate hashes", () => {
    expect(() => parseRuntimeConfig({
      ...validEnv(),
      EDGE_CREDENTIALS_JSON: JSON.stringify([{
        token_sha256: EDGE_TOKEN,
        edge_id: "edge-linux",
        profile_ids: ["desktop-a"],
      }]),
    })).toThrow(/SHA-256/);

    expect(() => parseRuntimeConfig({
      ...validEnv(),
      EDGE_CREDENTIALS_JSON: JSON.stringify([{
        token_sha256: digestToken(EDGE_TOKEN).toString("hex"),
        edge_id: "edge-linux",
        profile_ids: ["desktop-a"],
        token: EDGE_TOKEN,
      }]),
    })).toThrow(/unknown field/);

    expect(() => parseRuntimeConfig({
      ...validEnv(),
      EDGE_CREDENTIALS_JSON: JSON.stringify([{
        token_sha256: digestToken(EDGE_TOKEN).toString("hex"),
        edge_id: "../edge",
        profile_ids: ["desktop-a"],
      }]),
    })).toThrow(/safe identifier/);

    const item = {
      token_sha256: digestToken(EDGE_TOKEN).toString("hex"),
      edge_id: "edge-linux",
      profile_ids: ["desktop-a"],
    };
    expect(() => parseRuntimeConfig({
      ...validEnv(),
      EDGE_CREDENTIALS_JSON: JSON.stringify([item, { ...item, edge_id: "edge-mac" }]),
    })).toThrow(/duplicated/);
  });

  test("rejects role reuse between read and ingest credentials", () => {
    expect(() => parseRuntimeConfig({
      READ_TOKEN,
      EDGE_CREDENTIALS_JSON: edgeConfig(READ_TOKEN),
    })).toThrow(/must differ/);
  });

  test("never accepts an empty credential map or a short read token", () => {
    expect(() => parseRuntimeConfig({ READ_TOKEN, EDGE_CREDENTIALS_JSON: "[]" }))
      .toThrow(/1\.\.128/);
    expect(() => parseRuntimeConfig({
      READ_TOKEN: "short",
      EDGE_CREDENTIALS_JSON: edgeConfig(),
    })).toThrow(/READ_TOKEN/);
  });

  test("accepts only bearer values representable by the HTTP wire grammar", () => {
    for (const token of [
      "contains a space 12345",
      "contains-delete-\u007f-12345",
      "contains-unicode-é-12345",
    ]) {
      expect(() => parseRuntimeConfig({
        ...validEnv(),
        READ_TOKEN: token,
      })).toThrow(/ASCII graphic/);
    }
  });
});

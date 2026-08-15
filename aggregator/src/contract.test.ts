import { describe, expect, test } from "bun:test";

import { ValidationError, parseObservation } from "./contract.js";
import { VALID_OBSERVATION } from "./test-fixtures.js";

describe("parseObservation", () => {
  test("accepts and normalises a complete schema-3 observation", () => {
    const observation = parseObservation(VALID_OBSERVATION);
    expect(observation.schema).toBe(3);
    expect(observation.provider).toBe("claude");
    expect(observation.observed_at).toBe("2026-08-15T15:30:00.000Z");
    expect(observation.sampled_at).toBe("2026-08-15T15:29:58.123Z");
    expect(observation.windows.map((window) => window.id)).toEqual([
      "five-hour",
      "seven-day",
    ]);
  });

  test("accepts all first-class providers and absent identity", () => {
    const observation = parseObservation({
      ...VALID_OBSERVATION,
      provider: "grok",
      provider_subject: null,
      identity_evidence: "unknown",
      provider_client_version: null,
      session_id: null,
      windows: [],
      status: "auth_expired",
    });
    expect(observation.provider).toBe("grok");
    expect(observation.provider_subject).toBeNull();
  });

  test("accepts an explicit billing-unavailable degraded state", () => {
    const observation = parseObservation({
      ...VALID_OBSERVATION,
      provider: "grok",
      status: "billing_unavailable",
      windows: [],
    });
    expect(observation.status).toBe("billing_unavailable");
  });

  test("rejects schema 1/2 instead of retaining a compatibility shim", () => {
    expect(() => parseObservation({ ...VALID_OBSERVATION, schema: 2 })).toThrow(/schema must be 3/);
    expect(() => parseObservation({ id: "old-account", schema: 1 })).toThrow(ValidationError);
  });

  test("fails closed on unknown top-level and nested secret-shaped fields", () => {
    expect(() => parseObservation({ ...VALID_OBSERVATION, bearer_token: "secret" }))
      .toThrow(/unknown field.*bearer_token/);
    expect(() => parseObservation({
      ...VALID_OBSERVATION,
      windows: [{ ...VALID_OBSERVATION.windows[0], oauth_token: "secret" }],
    })).toThrow(/unknown field.*oauth_token/);
  });

  test("rejects control characters in every logged or displayed string", () => {
    expect(() => parseObservation({ ...VALID_OBSERVATION, source_host: "host\nforged-log" }))
      .toThrow(/control/);
    expect(() => parseObservation({ ...VALID_OBSERVATION, profile_label: "Desktop\u001b[31m" }))
      .toThrow(/control/);
    expect(() => parseObservation({ ...VALID_OBSERVATION, pool_label: "   " }))
      .toThrow(/1\.\.128/);
    expect(() => parseObservation({
      ...VALID_OBSERVATION,
      windows: [{ ...VALID_OBSERVATION.windows[0], label: "5h\rforged" }],
    })).toThrow(/control/);
  });

  test("rejects raw percentages, non-finite values, and duplicate windows", () => {
    expect(() => parseObservation({
      ...VALID_OBSERVATION,
      windows: [{ ...VALID_OBSERVATION.windows[0], utilization: 58 }],
    })).toThrow(/0\.\.1/);
    expect(() => parseObservation({
      ...VALID_OBSERVATION,
      windows: [{ ...VALID_OBSERVATION.windows[0], utilization: Number.NaN }],
    })).toThrow(/finite/);
    expect(() => parseObservation({
      ...VALID_OBSERVATION,
      windows: [VALID_OBSERVATION.windows[0], VALID_OBSERVATION.windows[0]],
    })).toThrow(/unique/);
  });

  test("rejects non-UUID observation ids and unsafe sequences", () => {
    expect(() => parseObservation({ ...VALID_OBSERVATION, observation_id: "not-a-uuid" }))
      .toThrow(/UUID/);
    expect(() => parseObservation({ ...VALID_OBSERVATION, sequence: -1 }))
      .toThrow(/non-negative/);
    expect(() => parseObservation({ ...VALID_OBSERVATION, sequence: Number.MAX_SAFE_INTEGER + 1 }))
      .toThrow(/safe integer/);
  });

  test("requires UTC instants and a valid identity evidence pairing", () => {
    expect(() => parseObservation({ ...VALID_OBSERVATION, sampled_at: "2026-08-15T15:30:00+00:00" }))
      .toThrow(/UTC instant/);
    expect(() => parseObservation({
      ...VALID_OBSERVATION,
      provider_subject: null,
      identity_evidence: "email",
    })).toThrow(/must be unknown/);
  });

  test("rejects calendar-impossible UTC instants instead of normalising them", () => {
    expect(() => parseObservation({
      ...VALID_OBSERVATION,
      sampled_at: "2026-02-31T15:30:00Z",
    })).toThrow(/valid timestamp/);
    expect(() => parseObservation({
      ...VALID_OBSERVATION,
      observed_at: "2026-08-15T24:00:00Z",
    })).toThrow(/valid timestamp/);
  });

  test("requires every contract field rather than guessing defaults", () => {
    const missing = { ...VALID_OBSERVATION } as Record<string, unknown>;
    delete missing.sample_time_quality;
    expect(() => parseObservation(missing)).toThrow(ValidationError);
  });
});

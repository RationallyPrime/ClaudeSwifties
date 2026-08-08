import { describe, expect, test } from "bun:test";

import { ValidationError, parseAccount } from "./contract.js";

const valid = {
  id: "rp-team",
  label: "Team · rationallyprime",
  source_host: "hetzner-cx53",
  as_of: "2026-08-07T21:38:12.482Z",
  status: "ok",
  five_hour: { utilization: 0.42, resets_at: "2026-08-07T23:10:00Z" },
  seven_day: null,
};

describe("parseAccount", () => {
  test("accepts a well-formed push and normalises timestamps", () => {
    const account = parseAccount(valid);
    expect(account.id).toBe("rp-team");
    expect(account.provider).toBe("claude");
    expect(account.windows.map((window) => window.label)).toEqual(["5h"]);
    expect(account.five_hour?.utilization).toBe(0.42);
    expect(account.seven_day).toBeNull();
    // Fractional seconds preserved through normalisation.
    expect(account.as_of).toBe("2026-08-07T21:38:12.482Z");
  });

  test("accepts a plain (non-fractional) timestamp from a different edge", () => {
    const account = parseAccount({ ...valid, as_of: "2026-08-07T21:38:12Z" });
    expect(account.as_of).toBe("2026-08-07T21:38:12.000Z");
  });

  /** The shim divides by 100; a raw percentage would silently render as 100%. */
  test("rejects utilization sent as a percentage", () => {
    expect(() => parseAccount({ ...valid, five_hour: { utilization: 42, resets_at: valid.five_hour.resets_at } }))
      .toThrow(ValidationError);
  });

  test("rejects unknown status values", () => {
    expect(() => parseAccount({ ...valid, status: "quota_hold" })).toThrow(ValidationError);
  });

  test("rejects ids that could escape their own namespace", () => {
    expect(() => parseAccount({ ...valid, id: "../../etc/passwd" })).toThrow(ValidationError);
    expect(() => parseAccount({ ...valid, id: "" })).toThrow(ValidationError);
  });

  test("rejects unparseable timestamps", () => {
    expect(() => parseAccount({ ...valid, as_of: "yesterday" })).toThrow(ValidationError);
    expect(() => parseAccount({ ...valid, as_of: "08/07/2026 21:38" })).toThrow(ValidationError);
  });

  test("accepts provider-defined Codex windows", () => {
    const account = parseAccount({
      id: "codex-pro",
      label: "Codex · Pro",
      provider: "codex",
      source_host: "hakon-mbp",
      as_of: "2026-08-08T00:20:00Z",
      status: "ok",
      windows: [
        {
          id: "primary-10080m",
          label: "7d",
          duration_minutes: 10_080,
          utilization: 0.45,
          resets_at: "2026-08-09T17:36:32Z",
        },
      ],
    });

    expect(account.provider).toBe("codex");
    expect(account.windows[0]?.duration_minutes).toBe(10_080);
    expect(account.seven_day?.utilization).toBe(0.45);
  });

  test("rejects duplicate provider window ids", () => {
    const window = {
      id: "weekly",
      label: "7d",
      duration_minutes: 10_080,
      utilization: 0.45,
      resets_at: null,
    };
    expect(() => parseAccount({ ...valid, windows: [window, window] })).toThrow(/unique/);
  });

  test("rejects oversized labels", () => {
    expect(() => parseAccount({ ...valid, label: "x".repeat(200) })).toThrow(ValidationError);
  });

  test("rejects non-objects", () => {
    expect(() => parseAccount(null)).toThrow(ValidationError);
    expect(() => parseAccount("nope")).toThrow(ValidationError);
  });
});

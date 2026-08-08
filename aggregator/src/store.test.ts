import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import type { AccountUsage } from "./contract.js";
import { openStore } from "./store.js";

function account(id: string, asOf = "2026-08-07T21:38:12.000Z"): AccountUsage {
  return {
    id,
    label: id,
    provider: "claude",
    source_host: "edge",
    as_of: asOf,
    status: "ok",
    windows: [
      {
        id: "five-hour",
        label: "5h",
        duration_minutes: 300,
        utilization: 0.4,
        resets_at: "2026-08-07T23:10:00.000Z",
      },
    ],
    five_hour: { utilization: 0.4, resets_at: "2026-08-07T23:10:00.000Z" },
    seven_day: null,
  };
}

async function freshStore(maxAccounts = 16) {
  const dir = await mkdtemp(join(tmpdir(), "usage-store-"));
  return { dir, store: await openStore(dir, maxAccounts) };
}

describe("UsageStore", () => {
  test("upserts by id rather than accumulating", async () => {
    const { store } = await freshStore();
    await store.upsert(account("a"), "2026-08-07T21:39:00.000Z");
    await store.upsert(account("a", "2026-08-07T22:00:00.000Z"), "2026-08-07T22:00:05.000Z");

    const snapshot = store.snapshot("2026-08-07T22:00:10.000Z");
    expect(snapshot.accounts).toHaveLength(1);
    expect(snapshot.accounts[0]?.as_of).toBe("2026-08-07T22:00:00.000Z");
  });

  test("survives a restart", async () => {
    const { dir, store } = await freshStore();
    await store.upsert(account("a"), "2026-08-07T21:39:00.000Z");

    const reopened = await openStore(dir, 16);
    expect(reopened.snapshot("2026-08-07T22:00:00.000Z").accounts[0]?.id).toBe("a");
  });

  test("serialises concurrent pushes from several edges", async () => {
    const { dir, store } = await freshStore();
    await Promise.all([
      store.upsert(account("a"), "2026-08-07T21:39:00.000Z"),
      store.upsert(account("b"), "2026-08-07T21:39:01.000Z"),
      store.upsert(account("c"), "2026-08-07T21:39:02.000Z"),
    ]);

    // The file must be valid JSON containing all three, not an interleaved mess.
    const raw = await readFile(join(dir, "usage.json"), "utf8");
    expect(JSON.parse(raw)).toHaveLength(3);
    expect(store.snapshot("2026-08-07T21:40:00.000Z").accounts.map((a) => a.id)).toEqual(["a", "b", "c"]);
  });

  test("refuses to grow past the account limit", async () => {
    const { store } = await freshStore(2);
    await store.upsert(account("a"), "2026-08-07T21:39:00.000Z");
    await store.upsert(account("b"), "2026-08-07T21:39:00.000Z");

    await expect(store.upsert(account("c"), "2026-08-07T21:39:00.000Z")).rejects.toThrow(/limit/);
    // An existing account must still be updatable once the limit is reached.
    await store.upsert(account("a", "2026-08-07T22:00:00.000Z"), "2026-08-07T22:00:00.000Z");
    expect(store.snapshot("2026-08-07T22:01:00.000Z").accounts).toHaveLength(2);
  });

  test("a quiet account is never downgraded to stale by the server", async () => {
    const { store } = await freshStore();
    await store.upsert(account("a", "2026-08-01T00:00:00.000Z"), "2026-08-01T00:00:00.000Z");

    // Days later the status is still whatever the edge said. Staleness is the
    // client's inference from as_of, so its reset logic keeps working.
    expect(store.snapshot("2026-08-07T22:00:00.000Z").accounts[0]?.status).toBe("ok");
  });
});

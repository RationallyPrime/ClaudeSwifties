import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { AccountUsage, UsageSnapshot } from "./contract.js";

interface StoredAccount {
  account: AccountUsage;
  /** When the aggregator received it, as distinct from when the edge read it. */
  received_at: string;
}

/**
 * Last-known-good per account, persisted as a single JSON file.
 *
 * A file rather than a database because the entire dataset is a handful of
 * records that are overwritten in place — there is nothing to query, and an
 * operator being able to `cat` the state is worth more here than indexes.
 */
export class UsageStore {
  private readonly path: string;
  private readonly maxAccounts: number;
  private accounts = new Map<string, StoredAccount>();
  /** Serialises writes; concurrent pushes from three edges must not interleave. */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(dataDir: string, maxAccounts: number) {
    this.path = join(dataDir, "usage.json");
    this.maxAccounts = maxAccounts;
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.path, "utf8");
      const parsed = JSON.parse(raw) as StoredAccount[];
      for (const entry of parsed) {
        if (entry?.account?.id) this.accounts.set(entry.account.id, entry);
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // A missing file is a cold start. Anything else means the volume is
      // unreadable or the state is corrupt, and starting with a silently empty
      // store would look identical to "all your edges went quiet".
      if (code !== "ENOENT") throw error;
    }
  }

  upsert(account: AccountUsage, receivedAt: string): Promise<void> {
    const run = async () => {
      if (!this.accounts.has(account.id) && this.accounts.size >= this.maxAccounts) {
        throw new Error(`account limit of ${this.maxAccounts} reached`);
      }
      this.accounts.set(account.id, { account, received_at: receivedAt });
      await this.persist();
    };
    this.queue = this.queue.then(run, run);
    return this.queue as Promise<void>;
  }

  snapshot(generatedAt: string): UsageSnapshot {
    return {
      schema: 1,
      generated_at: generatedAt,
      // Deliberately NOT downgrading quiet accounts to `stale`. Silence is the
      // normal state: the statusline ingress only reports while a session is
      // live. The client already derives age from `as_of`, and marking `stale`
      // here would suppress its window-reset inference — the one thing that
      // lets an idle tile stay useful.
      accounts: [...this.accounts.values()]
        .map((entry) => entry.account)
        .sort((a, b) => a.id.localeCompare(b.id)),
    };
  }

  private async persist(): Promise<void> {
    const payload = JSON.stringify([...this.accounts.values()], null, 2);
    const temporary = `${this.path}.${process.pid}.tmp`;
    // Write-then-rename: a crash mid-write must not truncate the good state.
    await writeFile(temporary, payload, "utf8");
    await rename(temporary, this.path);
  }
}

export async function openStore(dataDir: string, maxAccounts: number): Promise<UsageStore> {
  await mkdir(dataDir, { recursive: true });
  const store = new UsageStore(dataDir, maxAccounts);
  await store.load();
  return store;
}

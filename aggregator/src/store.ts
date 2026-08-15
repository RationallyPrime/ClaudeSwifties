import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";

import { Database } from "bun:sqlite";

import {
  parseObservation,
  parseTimestamp,
  type BindingConfidence,
  type PoolIdentityState,
  type PoolProfile,
  type PoolStatus,
  type SampleTimeQuality,
  type UsageObservation,
  type UsagePool,
  type UsageProvider,
  type UsageSnapshot,
  type UsageWindow,
} from "./contract.js";

const CURRENT_PROFILE_MS = 15 * 60 * 1_000;
const RECENT_PROFILE_MS = 24 * 60 * 60 * 1_000;

export interface StoreOptions {
  maxPools: number;
  maxFutureSkewMs: number;
  resetSkewMs: number;
  regressionTolerance: number;
}

export interface StoreOpenOptions {
  /** Cutover gate: fail closed unless legacy state exists or was already imported. */
  requireLegacyImport?: boolean;
}

export const DEFAULT_STORE_OPTIONS: StoreOptions = {
  maxPools: 64,
  maxFutureSkewMs: 5 * 60 * 1_000,
  resetSkewMs: 5 * 60 * 1_000,
  regressionTolerance: 0.005,
};

export type IngestOutcome = "accepted" | "duplicate" | "ignored" | "conflict";

export interface IngestResult {
  observation_id: string;
  outcome: IngestOutcome;
  clock_skewed: boolean;
}

interface PoolRow {
  id: string;
  provider: UsageProvider;
  subject_digest: string | null;
  label: string;
  identity_state: PoolIdentityState;
  status: PoolStatus;
  sampled_at: string;
  received_at: string;
  sample_quality: SampleTimeQuality;
  windows_json: string;
  created_at: string;
  sort_order: number;
}

interface BindingRow {
  profile_id: string;
  session_key: string;
  provider: UsageProvider;
  pool_id: string;
  label: string;
  source_host: string;
  last_seen_at: string;
  binding_confidence: BindingConfidence;
}

type ReconciliationDecision =
  | "accept"
  | "same"
  | "older"
  | "regression"
  | "invalid_reset";

export class StoreCapacityError extends Error {}

export class UsageStore {
  private readonly db: Database;
  private readonly options: StoreOptions;

  constructor(path: string, options: StoreOptions) {
    this.db = new Database(path, { create: true, strict: true });
    this.options = options;
    this.initialiseSchema();
  }

  close(): void {
    this.db.close();
  }

  ingest(observation: UsageObservation, receivedAt: string): IngestResult {
    const received = new Date(receivedAt).toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.ingestTransaction(observation, received);
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  snapshot(generatedAt: string): UsageSnapshot {
    const generated = new Date(generatedAt).toISOString();
    const generatedMs = Date.parse(generated);
    const pools = this.db.query<PoolRow, []>(`
      SELECT id, provider, subject_digest, label, identity_state, status,
             sampled_at, received_at, sample_quality, windows_json,
             created_at, sort_order
      FROM pools
      ORDER BY
        CASE provider WHEN 'claude' THEN 0 WHEN 'codex' THEN 1 ELSE 2 END,
        sort_order ASC
    `).all();

    const bindings = this.db.query<BindingRow, []>(`
      SELECT profile_id, session_key, provider, pool_id, label, source_host,
             last_seen_at, binding_confidence
      FROM bindings
      ORDER BY last_seen_at DESC, profile_id ASC
    `).all();

    const profilesByPool = new Map<string, Map<string, PoolProfile>>();
    for (const binding of bindings) {
      let profiles = profilesByPool.get(binding.pool_id);
      if (!profiles) {
        profiles = new Map();
        profilesByPool.set(binding.pool_id, profiles);
      }

      // A profile can have multiple live sessions. On the same pool it should
      // still render once; on contradictory pools it appears on both, which is
      // the deliberate and honest ambiguity signal during an account switch.
      if (profiles.has(binding.profile_id)) continue;
      const age = Math.max(0, generatedMs - Date.parse(binding.last_seen_at));
      profiles.set(binding.profile_id, {
        id: binding.profile_id,
        label: binding.label,
        source_host: binding.source_host,
        last_seen_at: binding.last_seen_at,
        state: age <= CURRENT_PROFILE_MS
          ? "current"
          : age <= RECENT_PROFILE_MS
            ? "recent"
            : "stale",
        binding_confidence: binding.binding_confidence,
      });
    }

    return {
      schema: 3,
      generated_at: generated,
      pools: pools.map((pool): UsagePool => ({
        id: pool.id,
        provider: pool.provider,
        label: pool.label,
        identity_state: pool.identity_state,
        status: pool.status,
        sampled_at: pool.sampled_at,
        received_at: pool.received_at,
        windows: parseStoredWindows(pool.windows_json),
        profiles: [...(profilesByPool.get(pool.id)?.values() ?? [])]
          .sort((a, b) => a.id.localeCompare(b.id)),
      })),
    };
  }

  /** A readiness probe must prove a write transaction can commit. */
  probeReady(at: string): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.query("INSERT OR REPLACE INTO readiness_probe (id, checked_at) VALUES (1, ?)")
        .run(new Date(at).toISOString());
      this.db.query("DELETE FROM readiness_probe WHERE id = 1").run();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Test/doctor evidence without exposing observation payloads. */
  conflictCount(): number {
    const row = this.db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM conflicts").get();
    return row?.count ?? 0;
  }

  latestSessionObservationId(profileId: string, sessionId: string | null): string | null {
    return this.db.query<{ observation_id: string }, [string, string]>(`
      SELECT observation_id FROM latest_session_observations
      WHERE profile_id = ? AND session_key = ?
    `).get(profileId, sessionId ?? "__profile__")?.observation_id ?? null;
  }

  legacyImportComplete(): boolean {
    return this.db.query<{ value: string }, [string]>(
      "SELECT value FROM metadata WHERE key = ?",
    ).get("legacy_import_completed")?.value === "1";
  }

  importLegacy(
    items: readonly { observation: UsageObservation; receivedAt: string }[],
  ): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const { observation, receivedAt } of items) {
        this.ingestTransaction(observation, new Date(receivedAt).toISOString());
      }
      this.db.query("INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)")
        .run("legacy_import_completed", "1");
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private initialiseSchema(): void {
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = FULL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA busy_timeout = 5000");
    const poolSchema = this.db.query<{ sql: string }, [string]>(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
    ).get("pools")?.sql;
    if (poolSchema && !poolSchema.includes("billing_unavailable")) {
      this.migrateStatusConstraint();
    }

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS pools (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL CHECK (provider IN ('claude', 'codex', 'grok')),
        subject_digest TEXT,
        label TEXT NOT NULL,
        identity_state TEXT NOT NULL CHECK (identity_state IN ('verified', 'provisional', 'conflict')),
        status TEXT NOT NULL CHECK (status IN ('ok', 'stale', 'auth_expired', 'billing_unavailable', 'error')),
        sampled_at TEXT NOT NULL,
        received_at TEXT NOT NULL,
        sample_quality TEXT NOT NULL,
        windows_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        sort_order INTEGER NOT NULL UNIQUE
      );

      CREATE UNIQUE INDEX IF NOT EXISTS pools_by_subject
        ON pools(provider, subject_digest)
        WHERE subject_digest IS NOT NULL;

      CREATE TABLE IF NOT EXISTS profile_sequences (
        profile_id TEXT PRIMARY KEY,
        edge_id TEXT NOT NULL,
        last_sequence INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS bindings (
        profile_id TEXT NOT NULL,
        session_key TEXT NOT NULL,
        provider TEXT NOT NULL,
        pool_id TEXT NOT NULL REFERENCES pools(id) ON DELETE RESTRICT,
        label TEXT NOT NULL,
        source_host TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        binding_confidence TEXT NOT NULL,
        PRIMARY KEY (profile_id, session_key)
      );

      CREATE INDEX IF NOT EXISTS bindings_by_pool ON bindings(pool_id);

      CREATE TABLE IF NOT EXISTS observations (
        id TEXT PRIMARY KEY,
        profile_id TEXT NOT NULL,
        session_key TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        edge_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        sampled_at TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        received_at TEXT NOT NULL,
        outcome TEXT NOT NULL,
        pool_id TEXT,
        clock_skewed INTEGER NOT NULL,
        payload_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS observations_profile_sequence
        ON observations(profile_id, sequence);

      CREATE TABLE IF NOT EXISTS latest_session_observations (
        profile_id TEXT NOT NULL,
        session_key TEXT NOT NULL,
        observation_id TEXT NOT NULL UNIQUE,
        sequence INTEGER NOT NULL,
        pool_id TEXT NOT NULL REFERENCES pools(id) ON DELETE RESTRICT,
        outcome TEXT NOT NULL,
        sampled_at TEXT NOT NULL,
        received_at TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        PRIMARY KEY (profile_id, session_key)
      );

      CREATE TABLE IF NOT EXISTS conflicts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        observation_id TEXT NOT NULL,
        profile_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        hinted_pool_id TEXT,
        matched_pool_id TEXT,
        created_at TEXT NOT NULL,
        evidence_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS readiness_probe (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        checked_at TEXT NOT NULL
      );

      PRAGMA user_version = 5;
    `);
  }

  /**
   * Early schema-3 candidates allowed only four statuses. SQLite cannot alter
   * a CHECK constraint in place, so rebuild the two related tables without
   * losing pool order, bindings, or foreign-key integrity.
   */
  private migrateStatusConstraint(): void {
    this.db.exec("PRAGMA foreign_keys = OFF");
    try {
      this.db.exec(`
        BEGIN IMMEDIATE;
        ALTER TABLE bindings RENAME TO bindings_status_v3;
        ALTER TABLE pools RENAME TO pools_status_v3;

        CREATE TABLE pools (
          id TEXT PRIMARY KEY,
          provider TEXT NOT NULL CHECK (provider IN ('claude', 'codex', 'grok')),
          subject_digest TEXT,
          label TEXT NOT NULL,
          identity_state TEXT NOT NULL CHECK (identity_state IN ('verified', 'provisional', 'conflict')),
          status TEXT NOT NULL CHECK (status IN ('ok', 'stale', 'auth_expired', 'billing_unavailable', 'error')),
          sampled_at TEXT NOT NULL,
          received_at TEXT NOT NULL,
          sample_quality TEXT NOT NULL,
          windows_json TEXT NOT NULL,
          created_at TEXT NOT NULL,
          sort_order INTEGER NOT NULL UNIQUE
        );
        INSERT INTO pools SELECT * FROM pools_status_v3;

        CREATE TABLE bindings (
          profile_id TEXT NOT NULL,
          session_key TEXT NOT NULL,
          provider TEXT NOT NULL,
          pool_id TEXT NOT NULL REFERENCES pools(id) ON DELETE RESTRICT,
          label TEXT NOT NULL,
          source_host TEXT NOT NULL,
          last_seen_at TEXT NOT NULL,
          binding_confidence TEXT NOT NULL,
          PRIMARY KEY (profile_id, session_key)
        );
        INSERT INTO bindings SELECT * FROM bindings_status_v3;

        DROP TABLE bindings_status_v3;
        DROP TABLE pools_status_v3;
        CREATE UNIQUE INDEX pools_by_subject
          ON pools(provider, subject_digest)
          WHERE subject_digest IS NOT NULL;
        CREATE INDEX bindings_by_pool ON bindings(pool_id);
        COMMIT;
      `);
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Preserve the original migration error.
      }
      throw error;
    } finally {
      this.db.exec("PRAGMA foreign_keys = ON");
    }
  }

  private ingestTransaction(original: UsageObservation, receivedAt: string): IngestResult {
    const duplicate = this.db.query<{ id: string; clock_skewed: number }, [string]>(
      "SELECT id, clock_skewed FROM observations WHERE id = ?",
    ).get(original.observation_id);
    if (duplicate) {
      return {
        observation_id: original.observation_id,
        outcome: "duplicate",
        clock_skewed: duplicate.clock_skewed === 1,
      };
    }

    const { observation, clockSkewed } = this.clampTimestamps(original, receivedAt);
    const sessionKey = observation.session_id ?? "__profile__";
    const sequence = this.db.query<{ edge_id: string; last_sequence: number }, [string]>(
      "SELECT edge_id, last_sequence FROM profile_sequences WHERE profile_id = ?",
    ).get(observation.profile_id);

    if (sequence && observation.sequence <= sequence.last_sequence) {
      this.recordObservation(observation, receivedAt, "ignored", null, clockSkewed, sessionKey);
      return {
        observation_id: observation.observation_id,
        outcome: "ignored",
        clock_skewed: clockSkewed,
      };
    }

    this.db.query(`
      INSERT INTO profile_sequences (profile_id, edge_id, last_sequence)
      VALUES (?, ?, ?)
      ON CONFLICT(profile_id) DO UPDATE SET
        edge_id = excluded.edge_id,
        last_sequence = excluded.last_sequence
    `).run(observation.profile_id, observation.edge_id, observation.sequence);

    const existingBinding = this.db.query<BindingRow, [string, string]>(`
      SELECT profile_id, session_key, provider, pool_id, label, source_host,
             last_seen_at, binding_confidence
      FROM bindings WHERE profile_id = ? AND session_key = ?
    `).get(observation.profile_id, sessionKey);

    let hintedPool = observation.provider_subject
      ? this.poolBySubject(observation.provider, observation.provider_subject)
      : null;
    let pool: PoolRow | null = hintedPool;
    let confidence: BindingConfidence = observation.provider_subject ? "subject" : "provisional";
    let forcedConflict = false;

    if (!pool && !observation.provider_subject && existingBinding?.provider === observation.provider) {
      pool = this.poolById(existingBinding.pool_id);
      confidence = "profile_history";
    }

    // A profile may begin reporting before its provider subject is available,
    // and every schema-2 import deliberately starts that way. When the subject
    // first appears, preserve the existing pool's stable id/order and attach
    // the subject instead of projecting a duplicate verified pool. The bound
    // profile/session is the strongest candidate; without it, promotion is
    // safe only when exact window continuity identifies one provisional pool.
    if (observation.provider_subject) {
      const matches = this.provisionalContinuityMatches(observation);
      const boundMatch = existingBinding?.provider === observation.provider
        ? matches.find((candidate) => candidate.id === existingBinding.pool_id)
        : undefined;
      if (!pool) {
        const promotionCandidate = boundMatch ?? (matches.length === 1 ? matches[0] : undefined);
        if (promotionCandidate) {
          pool = this.promoteProvisionalPool(
            promotionCandidate,
            observation.provider_subject,
          );
          hintedPool = pool;
          confidence = "subject";
        }
      } else {
        // The subject may already have a canonical pool while this session is
        // still bound to a subjectless provisional tile. Retire only that exact
        // bound continuation. A legacy candidate without a live binding is
        // also safe when it is the sole match; coincident imports remain
        // deliberately ambiguous instead of being guessed together.
        const retirementCandidate = boundMatch ??
          (!existingBinding && matches.length === 1 ? matches[0] : undefined);
        if (
          retirementCandidate &&
          pool.identity_state === "verified" &&
          this.sharesExactContinuity(pool, observation)
        ) {
          this.retireProvisionalPool(retirementCandidate.id, pool.id);
        }
      }
    }

    // An unbound degraded heartbeat has no quota-pool evidence. Creating a
    // provisional pool from the observer profile would collapse the canonical
    // nouns the schema is designed to keep separate. Retain and acknowledge
    // the observation, but wait for subject or window evidence before binding.
    if (!pool && !observation.provider_subject && observation.windows.length === 0) {
      this.recordObservation(
        observation,
        receivedAt,
        "ignored",
        null,
        clockSkewed,
        sessionKey,
      );
      return {
        observation_id: observation.observation_id,
        outcome: "ignored",
        clock_skewed: clockSkewed,
      };
    }

    // Anthropic #81231 falsifier: auth can claim A while live rate-limit
    // windows are a continuation of B. An exact B continuity match is stronger
    // than a contradictory Claude identity hint and must never overwrite A.
    if (hintedPool && observation.provider === "claude" &&
        resetTuple(parseStoredWindows(hintedPool.windows_json)) !== resetTuple(observation.windows)) {
      const matches = this.continuityMatches(observation, hintedPool.id);
      if (matches.length === 1) {
        pool = matches[0] ?? null;
        confidence = "window_continuity";
        forcedConflict = true;
        this.markPoolConflict(hintedPool.id);
        this.recordConflict(
          observation,
          "identity_hint_conflict",
          hintedPool.id,
          pool?.id ?? null,
          receivedAt,
          { reason: "windows continued a different pool" },
        );
      }
    }

    if (!pool) {
      pool = observation.provider_subject
        ? this.createPool(observation, receivedAt, "verified", observation.provider_subject)
        : this.createOrFindProvisionalPool(observation, receivedAt);
      confidence = observation.provider_subject ? "subject" : "provisional";
      hintedPool = hintedPool ?? (observation.provider_subject ? pool : null);
    }

    let decision = this.assess(pool, observation);
    if (
      hintedPool &&
      pool.id === hintedPool.id &&
      observation.provider === "claude" &&
      (decision === "regression" || decision === "invalid_reset")
    ) {
      const matches = this.continuityMatches(observation, hintedPool.id);
      if (matches.length === 1) {
        pool = matches[0] ?? pool;
        confidence = "window_continuity";
        decision = this.assess(pool, observation);
      } else {
        pool = this.createOrFindProvisionalPool(observation, receivedAt);
        confidence = "provisional";
        decision = this.assess(pool, observation);
      }
      forcedConflict = true;
      this.markPoolConflict(hintedPool.id);
      this.recordConflict(
        observation,
        "identity_hint_conflict",
        hintedPool.id,
        pool.id,
        receivedAt,
        { reason: "hinted pool rejected window continuity" },
      );
    }

    const authenticatedPresence =
      observation.status !== "auth_expired" && observation.status !== "error";
    const liveContradictions = authenticatedPresence
      ? this.liveContradictoryBindings(observation, sessionKey, pool.id)
      : [];
    if (liveContradictions.length > 0) {
      forcedConflict = true;
      this.markPoolConflict(pool.id);
      for (const contradictoryPoolId of liveContradictions) {
        this.markPoolConflict(contradictoryPoolId);
      }
      this.recordConflict(
        observation,
        "concurrent_session_ambiguity",
        hintedPool?.id ?? null,
        pool.id,
        receivedAt,
        { contradictory_pool_ids: liveContradictions },
      );
    }

    let outcome: IngestOutcome;
    if (decision === "regression" || decision === "invalid_reset") {
      outcome = "conflict";
      this.recordConflict(
        observation,
        decision,
        hintedPool?.id ?? null,
        pool.id,
        receivedAt,
        { existing_windows: parseStoredWindows(pool.windows_json) },
      );
    } else if (decision === "older") {
      outcome = forcedConflict ? "conflict" : "ignored";
    } else {
      outcome = forcedConflict ? "conflict" : "accepted";
      if (decision === "accept") {
        this.updatePool(
          pool,
          observation,
          receivedAt,
          confidence !== "window_continuity",
        );
      }
      // `same` is a heartbeat/retry with the same provider sample: update the
      // visible provider status without making sampled_at or windows fresher.
      if (decision === "same" && pool.status !== observation.status) {
        this.db.query("UPDATE pools SET status = ?, received_at = ? WHERE id = ?")
          .run(observation.status, receivedAt, pool.id);
      }
    }

    // Failed/auth-expired polls update pool degradation without keeping a
    // profile artificially current forever. Presence advances only when the
    // collector has authenticated provider evidence.
    if (authenticatedPresence) {
      this.updateBinding(observation, pool.id, confidence, sessionKey);
    }
    this.recordObservation(observation, receivedAt, outcome, pool.id, clockSkewed, sessionKey);
    this.recordLatestSessionObservation(
      observation,
      receivedAt,
      outcome,
      pool.id,
      sessionKey,
    );
    return {
      observation_id: observation.observation_id,
      outcome,
      clock_skewed: clockSkewed,
    };
  }

  private clampTimestamps(
    observation: UsageObservation,
    receivedAt: string,
  ): { observation: UsageObservation; clockSkewed: boolean } {
    const receivedMs = Date.parse(receivedAt);
    let observedMs = Date.parse(observation.observed_at);
    let sampledMs = Date.parse(observation.sampled_at);
    let clockSkewed = false;

    if (observedMs > receivedMs + this.options.maxFutureSkewMs) {
      observedMs = receivedMs;
      clockSkewed = true;
    }
    if (sampledMs > receivedMs + this.options.maxFutureSkewMs || sampledMs > observedMs) {
      sampledMs = Math.min(receivedMs, observedMs);
      clockSkewed = true;
    }

    return {
      observation: {
        ...observation,
        observed_at: new Date(observedMs).toISOString(),
        sampled_at: new Date(sampledMs).toISOString(),
      },
      clockSkewed,
    };
  }

  private assess(pool: PoolRow, observation: UsageObservation): ReconciliationDecision {
    const incomingMs = Date.parse(observation.sampled_at);
    const existingMs = Date.parse(pool.sampled_at);
    if (incomingMs < existingMs) return "older";
    if (
      incomingMs === existingMs &&
      qualityRank(observation.sample_time_quality) < qualityRank(pool.sample_quality)
    ) {
      return "older";
    }

    const existing = parseStoredWindows(pool.windows_json);
    if (observation.windows.length === 0) return "same";
    if (existing.length === 0) return "accept";

    for (const incoming of observation.windows) {
      const previous = existing.find((window) => window.id === incoming.id);
      if (!previous) continue;

      if (previous.resets_at === incoming.resets_at) {
        if (incoming.utilization + this.options.regressionTolerance < previous.utilization) {
          return "regression";
        }
        continue;
      }

      // A missing reset cannot prove a new quota generation. When both are
      // known, the old boundary must have arrived before a lower post-reset
      // value is allowed to replace the last good reading.
      if (previous.resets_at === null) {
        if (incoming.utilization + this.options.regressionTolerance < previous.utilization) {
          return "regression";
        }
        continue;
      }
      if (previous.resets_at !== null) {
        if (incoming.resets_at === null) return "invalid_reset";
        const oldResetMs = Date.parse(previous.resets_at);
        const incomingResetMs = Date.parse(incoming.resets_at);
        if (incomingResetMs <= oldResetMs) return "invalid_reset";
        if (incomingMs + this.options.resetSkewMs < oldResetMs) return "invalid_reset";
      }
    }

    if (
      incomingMs === existingMs &&
      JSON.stringify(observation.windows) === JSON.stringify(existing) &&
      observation.status === pool.status
    ) {
      return "same";
    }
    return "accept";
  }

  private continuityMatches(observation: UsageObservation, excludePoolId: string): PoolRow[] {
    if (resetTuple(observation.windows).length === 0) return [];
    const candidates = this.db.query<PoolRow, [UsageProvider, string]>(`
      SELECT id, provider, subject_digest, label, identity_state, status,
             sampled_at, received_at, sample_quality, windows_json,
             created_at, sort_order
      FROM pools WHERE provider = ? AND id != ?
    `).all(observation.provider, excludePoolId);

    return candidates.filter((candidate) => this.followsExactContinuity(candidate, observation));
  }

  private provisionalContinuityMatches(observation: UsageObservation): PoolRow[] {
    if (resetTuple(observation.windows).length === 0) return [];
    const candidates = this.db.query<PoolRow, [UsageProvider]>(`
      SELECT id, provider, subject_digest, label, identity_state, status,
             sampled_at, received_at, sample_quality, windows_json,
             created_at, sort_order
      FROM pools
      WHERE provider = ? AND subject_digest IS NULL AND identity_state = 'provisional'
    `).all(observation.provider);

    return candidates.filter((candidate) => this.followsExactContinuity(candidate, observation));
  }

  private followsExactContinuity(pool: PoolRow, observation: UsageObservation): boolean {
    const incomingTuple = resetTuple(observation.windows);
    if (incomingTuple.length === 0) return false;
    const windows = parseStoredWindows(pool.windows_json);
    if (resetTuple(windows) !== incomingTuple) return false;
    if (Date.parse(observation.sampled_at) < Date.parse(pool.sampled_at)) return false;
    return observation.windows.every((incoming) => {
      const previous = windows.find((window) => window.id === incoming.id);
      return previous !== undefined &&
        incoming.utilization + this.options.regressionTolerance >= previous.utilization;
    });
  }

  private sharesExactContinuity(pool: PoolRow, observation: UsageObservation): boolean {
    const incomingTuple = resetTuple(observation.windows);
    if (incomingTuple.length === 0) return false;
    const windows = parseStoredWindows(pool.windows_json);
    if (resetTuple(windows) !== incomingTuple) return false;
    const incomingIsNewer = Date.parse(observation.sampled_at) >= Date.parse(pool.sampled_at);
    return observation.windows.every((incoming) => {
      const previous = windows.find((window) => window.id === incoming.id);
      if (!previous) return false;
      return incomingIsNewer
        ? incoming.utilization + this.options.regressionTolerance >= previous.utilization
        : previous.utilization + this.options.regressionTolerance >= incoming.utilization;
    });
  }

  private promoteProvisionalPool(pool: PoolRow, subjectDigest: string): PoolRow {
    this.db.query(`
      UPDATE pools
      SET subject_digest = ?, identity_state = 'verified'
      WHERE id = ? AND subject_digest IS NULL AND identity_state = 'provisional'
    `).run(subjectDigest, pool.id);
    return this.poolById(pool.id) as PoolRow;
  }

  private retireProvisionalPool(sourcePoolId: string, targetPoolId: string): void {
    this.db.query("UPDATE bindings SET pool_id = ? WHERE pool_id = ?")
      .run(targetPoolId, sourcePoolId);
    this.db.query("UPDATE latest_session_observations SET pool_id = ? WHERE pool_id = ?")
      .run(targetPoolId, sourcePoolId);
    this.db.query("UPDATE observations SET pool_id = ? WHERE pool_id = ?")
      .run(targetPoolId, sourcePoolId);
    this.db.query(`
      UPDATE conflicts SET
        hinted_pool_id = CASE WHEN hinted_pool_id = ? THEN ? ELSE hinted_pool_id END,
        matched_pool_id = CASE WHEN matched_pool_id = ? THEN ? ELSE matched_pool_id END
      WHERE hinted_pool_id = ? OR matched_pool_id = ?
    `).run(
      sourcePoolId,
      targetPoolId,
      sourcePoolId,
      targetPoolId,
      sourcePoolId,
      sourcePoolId,
    );
    const deleted = this.db.query(`
      DELETE FROM pools
      WHERE id = ? AND subject_digest IS NULL AND identity_state = 'provisional'
    `).run(sourcePoolId);
    if (deleted.changes !== 1) {
      throw new Error("provisional pool retirement lost its guarded source row");
    }
  }

  private createPool(
    observation: UsageObservation,
    receivedAt: string,
    identityState: PoolIdentityState,
    subjectDigest: string | null,
    idOverride?: string,
  ): PoolRow {
    const count = this.db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM pools").get()?.count ?? 0;
    if (count >= this.options.maxPools) {
      throw new StoreCapacityError(`pool limit of ${this.options.maxPools} reached`);
    }
    const sortOrder = this.db.query<{ next: number }, []>(
      "SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM pools",
    ).get()?.next ?? 0;
    const id = idOverride ?? (subjectDigest
      ? `${observation.provider}-${subjectDigest}`
      : provisionalPoolId(observation));
    this.db.query(`
      INSERT INTO pools (
        id, provider, subject_digest, label, identity_state, status,
        sampled_at, received_at, sample_quality, windows_json, created_at, sort_order
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      observation.provider,
      subjectDigest,
      observation.pool_label,
      identityState,
      observation.status,
      observation.sampled_at,
      receivedAt,
      observation.sample_time_quality,
      JSON.stringify(observation.windows),
      receivedAt,
      sortOrder,
    );
    return this.poolById(id) as PoolRow;
  }

  private createOrFindProvisionalPool(
    observation: UsageObservation,
    receivedAt: string,
  ): PoolRow {
    const id = provisionalPoolId(observation);
    return this.poolById(id) ?? this.createPool(observation, receivedAt, "provisional", null, id);
  }

  private updatePool(
    pool: PoolRow,
    observation: UsageObservation,
    receivedAt: string,
    updateLabel: boolean,
  ): void {
    const hasGoodSample = observation.windows.length > 0;
    if (!hasGoodSample) {
      this.db.query("UPDATE pools SET status = ?, received_at = ? WHERE id = ?")
        .run(observation.status, receivedAt, pool.id);
      return;
    }
    this.db.query(`
      UPDATE pools SET
        label = ?, status = ?, sampled_at = ?, received_at = ?,
        sample_quality = ?, windows_json = ?
      WHERE id = ?
    `).run(
      updateLabel ? observation.pool_label : pool.label,
      observation.status,
      observation.sampled_at,
      receivedAt,
      observation.sample_time_quality,
      JSON.stringify(observation.windows),
      pool.id,
    );
  }

  private updateBinding(
    observation: UsageObservation,
    poolId: string,
    confidence: BindingConfidence,
    sessionKey: string,
  ): void {
    const previous = this.db.query<{ last_seen_at: string }, [string, string]>(
      "SELECT last_seen_at FROM bindings WHERE profile_id = ? AND session_key = ?",
    ).get(observation.profile_id, sessionKey);
    const lastSeen = previous && Date.parse(previous.last_seen_at) > Date.parse(observation.observed_at)
      ? previous.last_seen_at
      : observation.observed_at;
    this.db.query(`
      INSERT INTO bindings (
        profile_id, session_key, provider, pool_id, label, source_host,
        last_seen_at, binding_confidence
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(profile_id, session_key) DO UPDATE SET
        provider = excluded.provider,
        pool_id = excluded.pool_id,
        label = excluded.label,
        source_host = excluded.source_host,
        last_seen_at = excluded.last_seen_at,
        binding_confidence = excluded.binding_confidence
    `).run(
      observation.profile_id,
      sessionKey,
      observation.provider,
      poolId,
      observation.profile_label,
      observation.source_host,
      lastSeen,
      confidence,
    );
  }

  private liveContradictoryBindings(
    observation: UsageObservation,
    sessionKey: string,
    poolId: string,
  ): string[] {
    const threshold = new Date(
      Date.parse(observation.observed_at) - CURRENT_PROFILE_MS,
    ).toISOString();
    const rows = this.db.query<{ pool_id: string }, [string, string, string, string]>(`
      SELECT DISTINCT pool_id
      FROM bindings
      WHERE profile_id = ?
        AND session_key != ?
        AND pool_id != ?
        AND last_seen_at >= ?
    `).all(observation.profile_id, sessionKey, poolId, threshold);
    return rows.map((row) => row.pool_id).sort();
  }

  private updatePoolIdentityState(id: string, identityState: PoolIdentityState): void {
    this.db.query("UPDATE pools SET identity_state = ? WHERE id = ?")
      .run(identityState, id);
  }

  private markPoolConflict(id: string): void {
    this.updatePoolIdentityState(id, "conflict");
  }

  private recordObservation(
    observation: UsageObservation,
    receivedAt: string,
    outcome: IngestOutcome,
    poolId: string | null,
    clockSkewed: boolean,
    sessionKey: string,
  ): void {
    this.db.query(`
      INSERT INTO observations (
        id, profile_id, session_key, sequence, edge_id, provider,
        sampled_at, observed_at, received_at, outcome, pool_id,
        clock_skewed, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      observation.observation_id,
      observation.profile_id,
      sessionKey,
      observation.sequence,
      observation.edge_id,
      observation.provider,
      observation.sampled_at,
      observation.observed_at,
      receivedAt,
      outcome,
      poolId,
      clockSkewed ? 1 : 0,
      JSON.stringify(observation),
    );
  }

  private recordLatestSessionObservation(
    observation: UsageObservation,
    receivedAt: string,
    outcome: IngestOutcome,
    poolId: string,
    sessionKey: string,
  ): void {
    this.db.query(`
      INSERT INTO latest_session_observations (
        profile_id, session_key, observation_id, sequence, pool_id,
        outcome, sampled_at, received_at, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(profile_id, session_key) DO UPDATE SET
        observation_id = excluded.observation_id,
        sequence = excluded.sequence,
        pool_id = excluded.pool_id,
        outcome = excluded.outcome,
        sampled_at = excluded.sampled_at,
        received_at = excluded.received_at,
        payload_json = excluded.payload_json
    `).run(
      observation.profile_id,
      sessionKey,
      observation.observation_id,
      observation.sequence,
      poolId,
      outcome,
      observation.sampled_at,
      receivedAt,
      JSON.stringify(observation),
    );
  }

  private recordConflict(
    observation: UsageObservation,
    kind: string,
    hintedPoolId: string | null,
    matchedPoolId: string | null,
    receivedAt: string,
    evidence: Record<string, unknown>,
  ): void {
    this.db.query(`
      INSERT INTO conflicts (
        observation_id, profile_id, kind, hinted_pool_id,
        matched_pool_id, created_at, evidence_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      observation.observation_id,
      observation.profile_id,
      kind,
      hintedPoolId,
      matchedPoolId,
      receivedAt,
      JSON.stringify(evidence),
    );
  }

  private poolBySubject(provider: UsageProvider, subject: string): PoolRow | null {
    return this.db.query<PoolRow, [UsageProvider, string]>(`
      SELECT id, provider, subject_digest, label, identity_state, status,
             sampled_at, received_at, sample_quality, windows_json,
             created_at, sort_order
      FROM pools WHERE provider = ? AND subject_digest = ?
    `).get(provider, subject) ?? null;
  }

  private poolById(id: string): PoolRow | null {
    return this.db.query<PoolRow, [string]>(`
      SELECT id, provider, subject_digest, label, identity_state, status,
             sampled_at, received_at, sample_quality, windows_json,
             created_at, sort_order
      FROM pools WHERE id = ?
    `).get(id) ?? null;
  }
}

function qualityRank(quality: SampleTimeQuality): number {
  switch (quality) {
    case "provider_time": return 3;
    case "transcript_mtime": return 2;
    case "sensor_time": return 1;
    case "unknown": return 0;
  }
}

function resetTuple(windows: UsageWindow[]): string {
  return windows
    .map((window) => `${window.id}:${window.resets_at ?? "none"}`)
    .sort()
    .join("|");
}

function parseStoredWindows(raw: string): UsageWindow[] {
  const value = JSON.parse(raw) as unknown;
  if (!Array.isArray(value)) throw new Error("stored pool windows must be an array");
  return value as UsageWindow[];
}

function provisionalPoolId(observation: UsageObservation): string {
  const continuity = resetTuple(observation.windows) ||
    "no-window-generation";
  const digest = createHash("sha256")
    .update(
      `${observation.provider}|${observation.profile_id}|` +
      `${observation.session_id ?? "profile"}|${continuity}`,
    )
    .digest("hex")
    .slice(0, 24);
  return `${observation.provider}-provisional-${digest}`;
}

interface LegacyAccount {
  id: string;
  label: string;
  provider?: string;
  source_host: string;
  as_of: string;
  status: string;
  windows?: unknown[];
  five_hour?: { utilization?: unknown; resets_at?: unknown } | null;
  seven_day?: { utilization?: unknown; resets_at?: unknown } | null;
}

function legacyObservation(
  value: unknown,
  index: number,
): { observation: UsageObservation; receivedAt: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`legacy usage entry ${index} must be an object`);
  }
  const entry = value as Record<string, unknown>;
  if (typeof entry.account !== "object" || entry.account === null || Array.isArray(entry.account)) {
    throw new Error(`legacy usage entry ${index}.account must be an object`);
  }
  const account = entry.account as unknown as LegacyAccount;
  const provider: UsageProvider = account.provider === "codex" || account.id?.toLowerCase().startsWith("codex")
    ? "codex"
    : "claude";
  let windows = account.windows;
  if (!Array.isArray(windows)) {
    windows = [];
    if (account.five_hour) {
      windows.push({
        id: "five-hour",
        label: "5h",
        duration_minutes: 300,
        utilization: account.five_hour.utilization,
        resets_at: account.five_hour.resets_at,
      });
    }
    if (account.seven_day) {
      windows.push({
        id: "seven-day",
        label: "7d",
        duration_minutes: 10_080,
        utilization: account.seven_day.utilization,
        resets_at: account.seven_day.resets_at,
      });
    }
  }
  const observation = parseObservation({
    schema: 3,
    observation_id: randomUUID(),
    sequence: index,
    provider,
    edge_id: "legacy-import",
    profile_id: account.id,
    profile_label: account.label,
    pool_label: account.label,
    session_id: null,
    source_host: account.source_host,
    collector_version: "legacy-import",
    provider_client_version: null,
    observed_at: account.as_of,
    sampled_at: account.as_of,
    sample_time_quality: "unknown",
    status: account.status,
    provider_subject: null,
    identity_evidence: "unknown",
    windows,
  });
  const receivedAt = entry.received_at === undefined
    ? observation.observed_at
    : parseTimestamp(entry.received_at, `legacy usage entry ${index}.received_at`);
  return { observation, receivedAt };
}

async function importLegacyState(
  store: UsageStore,
  path: string,
  requireLegacyImport: boolean,
): Promise<void> {
  if (store.legacyImportComplete()) {
    // A crash after the committed marker but before unlink is harmless; finish
    // removing the importer input without ever replaying it.
    try {
      await unlink(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return;
  }

  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      if (requireLegacyImport) {
        throw new Error(
          "legacy import is required but usage.json is missing and no completed migration marker exists",
        );
      }
      return;
    }
    throw error;
  }

  let values: unknown;
  try {
    values = JSON.parse(raw);
  } catch (error) {
    throw new Error(`legacy usage state is corrupt and was not imported: ${String(error)}`);
  }
  if (!Array.isArray(values)) {
    throw new Error("legacy usage state is corrupt: top level must be an array");
  }

  // Validate the complete source before the first projection mutation. Each
  // item is then its own acceptance transaction, and the input is deleted only
  // after every item succeeds.
  const parsed = values.map((value, index) => legacyObservation(value, index));
  store.importLegacy(parsed);
  await unlink(path);
}

export async function openStore(
  dataDir: string,
  options: StoreOptions = DEFAULT_STORE_OPTIONS,
  openOptions: StoreOpenOptions = {},
): Promise<UsageStore> {
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await chmod(dataDir, 0o700);
  const databasePath = join(dataDir, "usage-v3.sqlite");
  // SQLite creates the main database, WAL, and shared-memory files while
  // opening/initialising it. Apply a private umask before that first byte
  // exists, then restore the process's prior setting immediately.
  const previousUmask = process.umask(0o077);
  let store: UsageStore;
  try {
    store = new UsageStore(databasePath, options);
  } finally {
    process.umask(previousUmask);
  }
  try {
    for (const path of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
      try {
        await chmod(path, 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    await importLegacyState(
      store,
      join(dataDir, "usage.json"),
      openOptions.requireLegacyImport ?? false,
    );
    return store;
  } catch (error) {
    store.close();
    throw error;
  }
}

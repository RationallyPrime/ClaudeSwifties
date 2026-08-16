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

export interface DoctorProfile {
  profile_id: string;
  observer_instance_id: string | null;
  edge_id: string | null;
  provider: string | null;
  first_seen_at: string | null;
  last_received_at: string | null;
  last_sampled_at: string | null;
  last_sequence: number | null;
  last_outcome: string | null;
  pool_id: string | null;
  binding_confidence: string | null;
  identity_evidence: string | null;
  identity_key_id: string | null;
  freshness: "current" | "recent" | "stale" | "never";
  last_conflict: { kind: string; at: string } | null;
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

  /** A rejected wrong-namespace observation is loud, durable evidence.
   *
   * Evidence lands in BOTH places: the global counter/record for the fleet
   * view, and a per-profile conflicts row so the per-profile doctor names
   * the affected collector — a mismatch never reaches `ingest`, so without
   * this row the profile would keep projecting its last good observation
   * while being 100% rejected.
   */
  recordIdentityKeyMismatch(
    observationId: string,
    profileId: string,
    edgeId: string,
    presentedKeyId: string,
    expectedKeyId: string,
    at: string,
  ): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.query(`
        INSERT INTO conflicts (
          observation_id, profile_id, kind, hinted_pool_id,
          matched_pool_id, created_at, evidence_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        observationId,
        profileId,
        "identity_key_mismatch",
        null,
        null,
        at,
        JSON.stringify({
          edge_id: edgeId,
          presented_key_id: presentedKeyId,
          expected_key_id: expectedKeyId,
        }),
      );
      const current = Number(
        this.db.query<{ value: string }, [string]>(
          "SELECT value FROM metadata WHERE key = ?",
        ).get("identity_key_mismatch_count")?.value ?? "0",
      );
      this.db.query("INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)")
        .run("identity_key_mismatch_count", String(current + 1));
      this.db.query("INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)")
        .run(
          "last_identity_key_mismatch",
          JSON.stringify({
            profile_id: profileId,
            edge_id: edgeId,
            presented_key_id: presentedKeyId,
            at,
          }),
        );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  identityKeyMismatchCount(): number {
    return Number(
      this.db.query<{ value: string }, [string]>(
        "SELECT value FROM metadata WHERE key = ?",
      ).get("identity_key_mismatch_count")?.value ?? "0",
    );
  }

  lastIdentityKeyMismatch(): Record<string, unknown> | null {
    const raw = this.db.query<{ value: string }, [string]>(
      "SELECT value FROM metadata WHERE key = ?",
    ).get("last_identity_key_mismatch")?.value;
    if (raw === undefined) return null;
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  /**
   * A verified claim rejection (403) for an authenticated edge. Keyed on the
   * CREDENTIAL's edge id — never on payload fields, which are
   * attacker-controlled within an authenticated edge and would make this an
   * unbounded write. Bounded by the configured credential set.
   */
  recordEdgeForbidden(edgeId: string, observationId: string, at: string): void {
    this.db.query(`
      INSERT INTO edge_rejections (edge_id, count, last_at, last_observation_id)
      VALUES (?, 1, ?, ?)
      ON CONFLICT(edge_id) DO UPDATE SET
        count = count + 1, last_at = excluded.last_at,
        last_observation_id = excluded.last_observation_id
    `).run(edgeId, at, observationId);
  }

  /** Per-edge claim-rejection evidence for the authenticated doctor. */
  doctorEdges(): Array<Record<string, unknown>> {
    return this.db.query<
      { edge_id: string; count: number; last_at: string; last_observation_id: string },
      []
    >(`
      SELECT edge_id, count, last_at, last_observation_id
      FROM edge_rejections ORDER BY edge_id
    `).all().map((row) => ({
      edge_id: row.edge_id,
      forbidden_count: row.count,
      last_forbidden_at: row.last_at,
      last_forbidden_observation_id: row.last_observation_id,
    }));
  }

  /**
   * Per-profile operational projection for the authenticated doctor. No
   * credentials, no raw payloads, no provider subjects — only the evidence an
   * operator needs to answer "which collector stopped, and why".
   */
  doctorProfiles(generatedAt: string): DoctorProfile[] {
    const generatedMs = Date.parse(new Date(generatedAt).toISOString());
    const sequences = this.db.query<
      {
        profile_id: string;
        edge_id: string;
        last_sequence: number;
        observer_instance_id: string | null;
        updated_at: string | null;
      },
      []
    >(`
      SELECT profile_id, edge_id, last_sequence, observer_instance_id, updated_at
      FROM profile_sequences
    `).all();

    const receipts = this.db.query<
      {
        profile_id: string;
        first_seen_at: string;
        last_received_at: string;
      },
      []
    >(`
      SELECT profile_id,
             MIN(received_at) AS first_seen_at,
             MAX(received_at) AS last_received_at
      FROM observations
      GROUP BY profile_id
    `).all();
    const receiptByProfile = new Map(receipts.map((row) => [row.profile_id, row]));

    const latest = this.db.query<
      {
        profile_id: string;
        sampled_at: string;
        outcome: string;
        payload_json: string;
      },
      []
    >(`
      SELECT o.profile_id, o.sampled_at, o.outcome, o.payload_json
      FROM observations o
      JOIN (
        SELECT profile_id, MAX(rowid) AS rowid
        FROM observations
        WHERE (profile_id, received_at) IN (
          SELECT profile_id, MAX(received_at)
          FROM observations
          GROUP BY profile_id
        )
        GROUP BY profile_id
      ) newest ON newest.rowid = o.rowid
    `).all();
    const latestByProfile = new Map(latest.map((row) => [row.profile_id, row]));

    const bindings = this.db.query<
      {
        profile_id: string;
        pool_id: string;
        binding_confidence: string;
        last_seen_at: string;
      },
      []
    >(`
      SELECT b.profile_id, b.pool_id, b.binding_confidence, b.last_seen_at
      FROM bindings b
      JOIN (
        SELECT profile_id, MAX(rowid) AS rowid
        FROM bindings
        WHERE (profile_id, last_seen_at) IN (
          SELECT profile_id, MAX(last_seen_at)
          FROM bindings
          GROUP BY profile_id
        )
        GROUP BY profile_id
      ) newest ON newest.rowid = b.rowid
    `).all();
    const bindingByProfile = new Map(bindings.map((row) => [row.profile_id, row]));

    const conflicts = this.db.query<
      { profile_id: string; kind: string; created_at: string },
      []
    >(`
      SELECT c.profile_id, c.kind, c.created_at
      FROM conflicts c
      JOIN (
        SELECT profile_id, MAX(id) AS id FROM conflicts GROUP BY profile_id
      ) newest ON newest.id = c.id
    `).all();
    const conflictByProfile = new Map(conflicts.map((row) => [row.profile_id, row]));

    const profileIds = new Set<string>([
      ...sequences.map((row) => row.profile_id),
      ...receipts.map((row) => row.profile_id),
      // A collector mis-provisioned from first boot is rejected BEFORE
      // ingest, so it has neither a sequence nor a receipt — its only
      // trace is the conflicts row. Without this, the evidence is written
      // and then dropped on the read side.
      ...conflicts.map((row) => row.profile_id),
    ]);

    return [...profileIds].sort().map((profileId): DoctorProfile => {
      const sequence = sequences.find((row) => row.profile_id === profileId) ?? null;
      const receipt = receiptByProfile.get(profileId) ?? null;
      const newest = latestByProfile.get(profileId) ?? null;
      const binding = bindingByProfile.get(profileId) ?? null;
      const conflict = conflictByProfile.get(profileId) ?? null;
      let provider: string | null = null;
      let identityEvidence: string | null = null;
      let identityKeyId: string | null = null;
      if (newest) {
        try {
          const payload = JSON.parse(newest.payload_json) as Record<string, unknown>;
          provider = typeof payload.provider === "string" ? payload.provider : null;
          identityEvidence = typeof payload.identity_evidence === "string"
            ? payload.identity_evidence
            : null;
          identityKeyId = typeof payload.identity_key_id === "string"
            ? payload.identity_key_id
            : null;
        } catch {
          // A corrupt stored payload degrades this row, never the doctor.
        }
      }
      const lastReceived = receipt?.last_received_at ?? null;
      const age = lastReceived === null
        ? null
        : Math.max(0, generatedMs - Date.parse(lastReceived));
      return {
        profile_id: profileId,
        observer_instance_id: sequence?.observer_instance_id ?? null,
        edge_id: sequence?.edge_id ?? null,
        provider,
        first_seen_at: receipt?.first_seen_at ?? null,
        last_received_at: lastReceived,
        last_sampled_at: newest?.sampled_at ?? null,
        last_sequence: sequence?.last_sequence ?? null,
        last_outcome: newest?.outcome ?? null,
        pool_id: binding?.pool_id ?? null,
        binding_confidence: binding?.binding_confidence ?? null,
        identity_evidence: identityEvidence,
        identity_key_id: identityKeyId,
        freshness: age === null
          ? "never"
          : age <= CURRENT_PROFILE_MS
            ? "current"
            : age <= RECENT_PROFILE_MS
              ? "recent"
              : "stale",
        last_conflict: conflict === null
          ? null
          : { kind: conflict.kind, at: conflict.created_at },
      };
    });
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
        this.ingestTransaction(observation, new Date(receivedAt).toISOString(), {
          consumeSequence: false,
        });
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
    const sequenceSchema = this.db.query<{ sql: string }, [string]>(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
    ).get("profile_sequences")?.sql;
    if (sequenceSchema && !sequenceSchema.includes("observer_instance_id")) {
      // Pre-instance rows keep a NULL instance: the next observation from any
      // instance replaces them without a concurrency conflict, which is the
      // correct rollout posture for the coordinated cutover.
      this.db.exec(`
        ALTER TABLE profile_sequences ADD COLUMN observer_instance_id TEXT;
        ALTER TABLE profile_sequences ADD COLUMN updated_at TEXT;
      `);
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
        last_sequence INTEGER NOT NULL,
        observer_instance_id TEXT,
        updated_at TEXT
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

      CREATE TABLE IF NOT EXISTS retired_observer_instances (
        profile_id TEXT NOT NULL,
        observer_instance_id TEXT NOT NULL,
        displaced_by TEXT NOT NULL,
        retired_at TEXT NOT NULL,
        PRIMARY KEY (profile_id, observer_instance_id)
      );

      CREATE TABLE IF NOT EXISTS edge_rejections (
        edge_id TEXT PRIMARY KEY,
        count INTEGER NOT NULL,
        last_at TEXT NOT NULL,
        last_observation_id TEXT NOT NULL
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
   * a CHECK constraint in place, so rebuild the pool and every dependent table
   * without losing order, bindings, latest-session state, or FK integrity.
   */
  private migrateStatusConstraint(): void {
    const hasLatestSessionObservations = Boolean(this.db.query<{ present: number }, [string]>(`
      SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?
    `).get("latest_session_observations"));
    this.db.exec("PRAGMA foreign_keys = OFF");
    try {
      this.db.exec("BEGIN IMMEDIATE");
      if (hasLatestSessionObservations) {
        this.db.exec(`
          ALTER TABLE latest_session_observations
          RENAME TO latest_session_observations_status_v3;
        `);
      }
      this.db.exec(`
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
      `);
      if (hasLatestSessionObservations) {
        this.db.exec(`
          CREATE TABLE latest_session_observations (
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
          INSERT INTO latest_session_observations
            SELECT * FROM latest_session_observations_status_v3;
          DROP TABLE latest_session_observations_status_v3;
        `);
      }
      this.db.exec(`
        DROP TABLE bindings_status_v3;
        DROP TABLE pools_status_v3;
        CREATE UNIQUE INDEX pools_by_subject
          ON pools(provider, subject_digest)
          WHERE subject_digest IS NOT NULL;
        CREATE INDEX bindings_by_pool ON bindings(pool_id);
      `);
      const violations = this.db.query<unknown, []>("PRAGMA foreign_key_check").all();
      if (violations.length > 0) {
        throw new Error("status migration left invalid foreign-key references");
      }
      this.db.exec("COMMIT");
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

  private ingestTransaction(
    original: UsageObservation,
    receivedAt: string,
    options: { consumeSequence?: boolean } = {},
  ): IngestResult {
    const consumeSequence = options.consumeSequence !== false;
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
    const sequence = this.db.query<
      {
        edge_id: string;
        last_sequence: number;
        observer_instance_id: string | null;
        updated_at: string | null;
      },
      [string]
    >(
      `SELECT edge_id, last_sequence, observer_instance_id, updated_at
       FROM profile_sequences WHERE profile_id = ?`,
    ).get(observation.profile_id);

    // The sequence high-water mark is scoped to one installation generation:
    // (observer_instance_id, sequence). A new, never-retired instance is a
    // legitimate reinstall/relocation whose counter starts over — never
    // silently ignored against the previous installation's mark. A known
    // displaced instance is retired below and cannot rotate back.
    const sameInstance =
      sequence?.observer_instance_id === observation.observer_instance_id;
    if (
      consumeSequence &&
      this.isRetiredObserverInstance(
        observation.profile_id,
        observation.observer_instance_id,
      )
    ) {
      // A known displaced generation cannot become current again. A delayed
      // or newly queued observation from the retired instance used to rotate
      // the active row (and its bindings) back onto the stale pool.
      this.recordConflict(observation, "retired_observer_instance", null, null, receivedAt, {
        retired_observer_instance_id: observation.observer_instance_id,
        current_observer_instance_id: sequence?.observer_instance_id ?? null,
        current_last_sequence: sequence?.last_sequence ?? null,
      });
      this.recordObservation(observation, receivedAt, "ignored", null, clockSkewed, sessionKey);
      return {
        observation_id: observation.observation_id,
        outcome: "ignored",
        clock_skewed: clockSkewed,
      };
    }
    if (
      consumeSequence &&
      sequence &&
      sameInstance &&
      observation.sequence <= sequence.last_sequence
    ) {
      // The duplicate check above already returned for a re-sent observation
      // id, so this is a NEW observation carrying a regressed counter — the
      // same-instance signature of a sequence file lost to an unclean
      // shutdown (the edge writes it sync=false by budgeted design). The
      // observation stays ignored, but silently stranding the collector for
      // however long the counter takes to climb back is not acceptable
      // evidence-wise: record the regression per-profile so the doctor names
      // it.
      this.recordConflict(observation, "sequence_regression", null, null, receivedAt, {
        observation_sequence: observation.sequence,
        last_sequence: sequence.last_sequence,
        observer_instance_id: observation.observer_instance_id,
      });
      this.recordObservation(observation, receivedAt, "ignored", null, clockSkewed, sessionKey);
      return {
        observation_id: observation.observation_id,
        outcome: "ignored",
        clock_skewed: clockSkewed,
      };
    }

    if (consumeSequence && sequence && !sameInstance) {
      // Two live installations of one profile competing for its sequence is
      // configuration evidence, not something to resolve silently. Preserve
      // it whenever the displaced instance reported recently.
      const displacedRecently =
        sequence.observer_instance_id !== null &&
        sequence.updated_at !== null &&
        Date.parse(receivedAt) - Date.parse(sequence.updated_at) <= CURRENT_PROFILE_MS;
      if (displacedRecently) {
        this.recordConflict(
          observation,
          "concurrent_observer_instances",
          null,
          null,
          receivedAt,
          {
            displaced_observer_instance_id: sequence.observer_instance_id,
            displaced_updated_at: sequence.updated_at,
            displaced_last_sequence: sequence.last_sequence,
            incoming_observer_instance_id: observation.observer_instance_id,
          },
        );
      }
      if (sequence.observer_instance_id !== null) {
        this.retireObserverInstance(
          observation.profile_id,
          sequence.observer_instance_id,
          observation.observer_instance_id,
          receivedAt,
        );
      }
    }

    if (consumeSequence) {
      this.db.query(`
        INSERT INTO profile_sequences (
          profile_id, edge_id, last_sequence, observer_instance_id, updated_at
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(profile_id) DO UPDATE SET
          edge_id = excluded.edge_id,
          last_sequence = excluded.last_sequence,
          observer_instance_id = excluded.observer_instance_id,
          updated_at = excluded.updated_at
      `).run(
        observation.profile_id,
        observation.edge_id,
        observation.sequence,
        observation.observer_instance_id,
        receivedAt,
      );
    }

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
    let carriedContinuityBinding = false;

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

    // Once a Claude session has been bound away from a contradictory subject
    // hint by exact window continuity, that session binding remains the safer
    // identity signal across the next legitimate quota reset. A reset changes
    // the tuple, so rediscovery cannot find the old pool; falling back to the
    // stale hint would overwrite the wrong subject with the bound pool's new
    // generation. Keep the bound pool authoritative and let `assess` either
    // accept the reset there or retain it as a conflict without mutating the
    // hinted pool.
    if (
      hintedPool &&
      observation.provider === "claude" &&
      existingBinding?.provider === "claude" &&
      existingBinding.binding_confidence === "window_continuity" &&
      existingBinding.pool_id !== hintedPool.id
    ) {
      const boundPool = this.poolById(existingBinding.pool_id);
      const hintedStillMatches = this.followsExactContinuity(hintedPool, observation);
      const boundStillMatches = boundPool
        ? this.followsExactContinuity(boundPool, observation)
        : false;
      // Yield to the subject hint only when its windows corroborate the hint
      // and no longer corroborate the established continuity binding. If both
      // pools happen to match, the new evidence is ambiguous rather than a
      // proven identity realignment.
      if (boundPool && (!hintedStillMatches || boundStillMatches)) {
        pool = boundPool;
        confidence = "window_continuity";
        carriedContinuityBinding = true;
        forcedConflict = true;
        this.markPoolConflict(hintedPool.id);
        this.recordConflict(
          observation,
          "identity_hint_conflict",
          hintedPool.id,
          boundPool.id,
          receivedAt,
          { reason: "existing window-continuity binding survived a reset transition" },
        );
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
    if (!carriedContinuityBinding && hintedPool && observation.provider === "claude" &&
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
    const incomingQuality = qualityRank(observation.sample_time_quality);
    const existingQuality = qualityRank(pool.sample_quality);
    if (incomingMs < existingMs) return "older";
    if (
      incomingMs === existingMs &&
      incomingQuality < existingQuality
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
      observation.status === pool.status &&
      incomingQuality === existingQuality
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

  private isRetiredObserverInstance(
    profileId: string,
    observerInstanceId: string,
  ): boolean {
    return this.db.query<{ present: number }, [string, string]>(`
      SELECT 1 AS present FROM retired_observer_instances
      WHERE profile_id = ? AND observer_instance_id = ?
    `).get(profileId, observerInstanceId) != null;
  }

  private retireObserverInstance(
    profileId: string,
    observerInstanceId: string,
    displacedBy: string,
    retiredAt: string,
  ): void {
    this.db.query(`
      INSERT INTO retired_observer_instances (
        profile_id, observer_instance_id, displaced_by, retired_at
      ) VALUES (?, ?, ?, ?)
      ON CONFLICT(profile_id, observer_instance_id) DO NOTHING
    `).run(profileId, observerInstanceId, displacedBy, retiredAt);
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

const LEGACY_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

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
  const legacyProfileId = account.id;
  if (typeof legacyProfileId !== "string" || !LEGACY_ID_PATTERN.test(legacyProfileId)) {
    throw new Error(
      `legacy usage entry ${index}.account.id must contain 1..64 letters, numbers, dot, underscore, or dash`,
    );
  }
  let provider: UsageProvider;
  if (account.provider === undefined) {
    provider = legacyProfileId.toLowerCase().startsWith("codex") ? "codex" : "claude";
  } else if (
    account.provider === "claude" ||
    account.provider === "codex" ||
    account.provider === "grok"
  ) {
    provider = account.provider;
  } else {
    throw new Error(
      `legacy usage entry ${index}.account.provider must be claude, codex, or grok when present`,
    );
  }
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
  const parsed = parseObservation({
    schema: 3,
    observation_id: randomUUID(),
    // Legacy state predates installation generations and key namespacing;
    // synthesize both (the import never consumes sequences, so the instance
    // only labels provenance).
    observer_instance_id: randomUUID(),
    identity_key_id: "legacy-import-00",
    sequence: index,
    provider,
    edge_id: "legacy-import",
    // Schema 2 allowed punctuation in the first position. Validate that old
    // grammar above, parse every other field through the strict schema-3
    // contract with a safe placeholder, then restore the exact legacy id.
    profile_id: "legacy-import-profile",
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
  const observation: UsageObservation = {
    ...parsed,
    profile_id: legacyProfileId,
  };
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

/**
 * Schema 3 is intentionally observation- and pool-centric. It has no schema-2
 * parser: the only old-format support lives in the one-shot store migration.
 *
 * The parser is strict at every object boundary. Besides catching producer
 * drift early, this is a credential-leak tripwire: a collector that
 * accidentally adds a token, email, or provider response cannot be silently
 * accepted and persisted.
 */

export type UsageProvider = "claude" | "codex" | "grok";
export type PoolStatus =
  | "ok"
  | "stale"
  | "auth_expired"
  | "billing_unavailable"
  | "error";
export type SampleTimeQuality =
  | "provider_time"
  | "transcript_mtime"
  | "sensor_time"
  | "unknown";
export type IdentityEvidence =
  | "org_email"
  | "org"
  | "email"
  | "account_id"
  | "workspace_id"
  | "principal_id"
  | "team_id"
  | "organization_id"
  | "unknown";
export type PoolIdentityState = "verified" | "provisional" | "conflict";
export type ProfileState = "current" | "recent" | "stale";
export type BindingConfidence =
  | "subject"
  | "window_continuity"
  | "profile_history"
  | "provisional";

export interface UsageWindow {
  id: string;
  label: string;
  duration_minutes: number | null;
  utilization: number;
  resets_at: string | null;
}

export interface UsageObservation {
  schema: 3;
  observation_id: string;
  observer_instance_id: string;
  identity_key_id: string;
  sequence: number;
  provider: UsageProvider;
  edge_id: string;
  profile_id: string;
  profile_label: string;
  pool_label: string;
  session_id: string | null;
  source_host: string;
  collector_version: string;
  provider_client_version: string | null;
  observed_at: string;
  sampled_at: string;
  sample_time_quality: SampleTimeQuality;
  status: PoolStatus;
  provider_subject: string | null;
  identity_evidence: IdentityEvidence;
  windows: UsageWindow[];
}

export interface PoolProfile {
  id: string;
  label: string;
  source_host: string;
  last_seen_at: string;
  state: ProfileState;
  binding_confidence: BindingConfidence;
}

export interface UsagePool {
  id: string;
  provider: UsageProvider;
  label: string;
  identity_state: PoolIdentityState;
  status: PoolStatus;
  sampled_at: string;
  received_at: string;
  windows: UsageWindow[];
  profiles: PoolProfile[];
}

export interface UsageSnapshot {
  schema: 3;
  generated_at: string;
  pools: UsagePool[];
}

const PROVIDERS: readonly UsageProvider[] = ["claude", "codex", "grok"];
const STATUSES: readonly PoolStatus[] = [
  "ok",
  "stale",
  "auth_expired",
  "billing_unavailable",
  "error",
];
const SAMPLE_QUALITIES: readonly SampleTimeQuality[] = [
  "provider_time",
  "transcript_mtime",
  "sensor_time",
  "unknown",
];
const IDENTITY_EVIDENCE: readonly IdentityEvidence[] = [
  "org_email",
  "org",
  "email",
  "account_id",
  "workspace_id",
  "principal_id",
  "team_id",
  "organization_id",
  "unknown",
];

const OBSERVATION_FIELDS = new Set([
  "schema",
  "observation_id",
  "observer_instance_id",
  "identity_key_id",
  "sequence",
  "provider",
  "edge_id",
  "profile_id",
  "profile_label",
  "pool_label",
  "session_id",
  "source_host",
  "collector_version",
  "provider_client_version",
  "observed_at",
  "sampled_at",
  "sample_time_quality",
  "status",
  "provider_subject",
  "identity_evidence",
  "windows",
]);
const WINDOW_FIELDS = new Set([
  "id",
  "label",
  "duration_minutes",
  "utilization",
  "resets_at",
]);

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SUBJECT_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
export const IDENTITY_KEY_ID_PATTERN = /^[A-Za-z0-9_-]{16}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

function requireObject(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ValidationError(`${field} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function rejectUnknownFields(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  field: string,
): void {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key)).sort();
  if (unknown.length > 0) {
    throw new ValidationError(`${field} contains unknown field(s): ${unknown.join(", ")}`);
  }
}

function requireString(value: unknown, field: string, max: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > max ||
    value.trim().length === 0
  ) {
    throw new ValidationError(`${field} must be a string of 1..${max} chars`);
  }
  if (CONTROL_CHARACTERS.test(value)) {
    throw new ValidationError(`${field} must not contain control characters`);
  }
  return value;
}

function requireOptionalString(value: unknown, field: string, max: number): string | null {
  if (value === null) return null;
  return requireString(value, field, max);
}

function requireIdentifier(value: unknown, field: string, max = 64): string {
  const result = requireString(value, field, max);
  if (!ID_PATTERN.test(result)) {
    throw new ValidationError(`${field} must contain only letters, numbers, dot, underscore, or dash`);
  }
  return result;
}

export function parseTimestamp(value: unknown, field: string): string {
  const raw = requireString(value, field, 64);
  if (!ISO_INSTANT.test(raw)) {
    throw new ValidationError(`${field} must be an ISO-8601 UTC instant`);
  }
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) {
    throw new ValidationError(`${field} is not a valid timestamp`);
  }
  const date = new Date(parsed);
  const components = [
    Number(raw.slice(0, 4)),
    Number(raw.slice(5, 7)) - 1,
    Number(raw.slice(8, 10)),
    Number(raw.slice(11, 13)),
    Number(raw.slice(14, 16)),
    Number(raw.slice(17, 19)),
  ];
  const normalized = [
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
    date.getUTCHours(),
    date.getUTCMinutes(),
    date.getUTCSeconds(),
  ];
  if (components.some((component, index) => component !== normalized[index])) {
    throw new ValidationError(`${field} is not a valid timestamp`);
  }
  return date.toISOString();
}

function requireEnum<T extends string>(
  value: unknown,
  field: string,
  allowed: readonly T[],
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new ValidationError(`${field} must be one of ${allowed.join(", ")}`);
  }
  return value as T;
}

function parseWindow(value: unknown, index: number): UsageWindow {
  const field = `windows[${index}]`;
  const record = requireObject(value, field);
  rejectUnknownFields(record, WINDOW_FIELDS, field);

  const duration = record.duration_minutes;
  if (
    duration !== null &&
    (!Number.isSafeInteger(duration) || (duration as number) < 1 || (duration as number) > 5_256_000)
  ) {
    throw new ValidationError(
      `${field}.duration_minutes must be null or an integer within 1..5256000`,
    );
  }

  const utilization = record.utilization;
  if (typeof utilization !== "number" || !Number.isFinite(utilization)) {
    throw new ValidationError(`${field}.utilization must be a finite number`);
  }
  if (utilization < 0 || utilization > 1) {
    throw new ValidationError(`${field}.utilization must be within 0..1`);
  }

  return {
    id: requireIdentifier(record.id, `${field}.id`, 64),
    label: requireString(record.label, `${field}.label`, 32),
    duration_minutes: duration as number | null,
    utilization,
    resets_at: record.resets_at === null
      ? null
      : parseTimestamp(record.resets_at, `${field}.resets_at`),
  };
}

export function parseObservation(input: unknown): UsageObservation {
  const record = requireObject(input, "body");
  rejectUnknownFields(record, OBSERVATION_FIELDS, "body");

  if (record.schema !== 3) {
    throw new ValidationError("schema must be 3");
  }

  const observationId = requireString(record.observation_id, "observation_id", 36);
  if (!UUID_PATTERN.test(observationId)) {
    throw new ValidationError("observation_id must be an RFC-4122 UUID");
  }

  const observerInstanceId = requireString(
    record.observer_instance_id,
    "observer_instance_id",
    36,
  );
  if (!UUID_PATTERN.test(observerInstanceId)) {
    throw new ValidationError("observer_instance_id must be an RFC-4122 UUID");
  }

  const identityKeyId = requireString(record.identity_key_id, "identity_key_id", 16);
  if (!IDENTITY_KEY_ID_PATTERN.test(identityKeyId)) {
    throw new ValidationError(
      "identity_key_id must be a 16 character base64url identifier",
    );
  }

  if (!Number.isSafeInteger(record.sequence) || (record.sequence as number) < 0) {
    throw new ValidationError("sequence must be a non-negative safe integer");
  }

  if (!Array.isArray(record.windows) || record.windows.length > 16) {
    throw new ValidationError("windows must be an array with at most 16 entries");
  }
  const windows = record.windows.map(parseWindow);
  if (new Set(windows.map((window) => window.id)).size !== windows.length) {
    throw new ValidationError("window ids must be unique within an observation");
  }

  const providerSubject = record.provider_subject === null
    ? null
    : requireString(record.provider_subject, "provider_subject", 128);
  if (providerSubject !== null && !SUBJECT_PATTERN.test(providerSubject)) {
    throw new ValidationError("provider_subject must be a 16..128 char opaque base64url digest");
  }
  const identityEvidence = requireEnum(
    record.identity_evidence,
    "identity_evidence",
    IDENTITY_EVIDENCE,
  );
  if (providerSubject === null && identityEvidence !== "unknown") {
    throw new ValidationError("identity_evidence must be unknown without provider_subject");
  }

  return {
    schema: 3,
    observation_id: observationId.toLowerCase(),
    observer_instance_id: observerInstanceId.toLowerCase(),
    identity_key_id: identityKeyId,
    sequence: record.sequence as number,
    provider: requireEnum(record.provider, "provider", PROVIDERS),
    edge_id: requireIdentifier(record.edge_id, "edge_id"),
    profile_id: requireIdentifier(record.profile_id, "profile_id"),
    profile_label: requireString(record.profile_label, "profile_label", 128),
    pool_label: requireString(record.pool_label, "pool_label", 128),
    session_id: record.session_id === null
      ? null
      : requireIdentifier(record.session_id, "session_id", 128),
    source_host: requireString(record.source_host, "source_host", 128),
    collector_version: requireString(record.collector_version, "collector_version", 64),
    provider_client_version: requireOptionalString(
      record.provider_client_version,
      "provider_client_version",
      64,
    ),
    observed_at: parseTimestamp(record.observed_at, "observed_at"),
    sampled_at: parseTimestamp(record.sampled_at, "sampled_at"),
    sample_time_quality: requireEnum(
      record.sample_time_quality,
      "sample_time_quality",
      SAMPLE_QUALITIES,
    ),
    status: requireEnum(record.status, "status", STATUSES),
    provider_subject: providerSubject,
    identity_evidence: identityEvidence,
    windows,
  };
}

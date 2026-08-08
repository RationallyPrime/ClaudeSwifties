/**
 * The wire contract, mirrored from UsageKit's Swift types. This service is
 * internet-facing once Coolify assigns it a domain, so everything crossing the
 * boundary is validated rather than trusted — edges are three different
 * runtimes and a malformed push must not be able to corrupt stored state.
 */

export type AccountStatus = "ok" | "stale" | "auth_expired" | "error";

const STATUSES: readonly AccountStatus[] = ["ok", "stale", "auth_expired", "error"];

export interface UsageWindow {
  utilization: number;
  resets_at: string;
}

export interface AccountUsage {
  id: string;
  label: string;
  source_host: string;
  as_of: string;
  status: AccountStatus;
  five_hour: UsageWindow | null;
  seven_day: UsageWindow | null;
}

export interface UsageSnapshot {
  schema: 1;
  generated_at: string;
  accounts: AccountUsage[];
}

const MAX_STRING = 128;
/** Anything longer is a bug or an attack, never a real account identifier. */
const ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

export class ValidationError extends Error {}

function requireString(value: unknown, field: string, max = MAX_STRING): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw new ValidationError(`${field} must be a string of 1..${max} chars`);
  }
  return value;
}

function requireTimestamp(value: unknown, field: string): string {
  const raw = requireString(value, field, 64);
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) throw new ValidationError(`${field} is not a valid timestamp`);
  // Normalise so that mixed fractional/plain ISO-8601 from different edges is
  // stored one way and served one way.
  return new Date(parsed).toISOString();
}

function parseWindow(value: unknown, field: string): UsageWindow | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object") throw new ValidationError(`${field} must be an object or null`);

  const record = value as Record<string, unknown>;
  const utilization = record.utilization;
  if (typeof utilization !== "number" || !Number.isFinite(utilization)) {
    throw new ValidationError(`${field}.utilization must be a finite number`);
  }
  if (utilization < 0 || utilization > 1) {
    // The shim divides the statusline's 0-100 percentage; a value outside 0..1
    // means an edge is sending percentages raw and would render as 100%.
    throw new ValidationError(`${field}.utilization must be within 0..1, got ${utilization}`);
  }

  return { utilization, resets_at: requireTimestamp(record.resets_at, `${field}.resets_at`) };
}

export function parseAccount(input: unknown): AccountUsage {
  if (typeof input !== "object" || input === null) {
    throw new ValidationError("body must be a JSON object");
  }
  const record = input as Record<string, unknown>;

  const id = requireString(record.id, "id", 64);
  if (!ID_PATTERN.test(id)) throw new ValidationError("id must match [A-Za-z0-9._-]{1,64}");

  const status = record.status;
  if (typeof status !== "string" || !STATUSES.includes(status as AccountStatus)) {
    throw new ValidationError(`status must be one of ${STATUSES.join(", ")}`);
  }

  return {
    id,
    label: requireString(record.label, "label"),
    source_host: requireString(record.source_host, "source_host"),
    as_of: requireTimestamp(record.as_of, "as_of"),
    status: status as AccountStatus,
    five_hour: parseWindow(record.five_hour, "five_hour"),
    seven_day: parseWindow(record.seven_day, "seven_day"),
  };
}

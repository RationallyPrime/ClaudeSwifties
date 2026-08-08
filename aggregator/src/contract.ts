/**
 * Provider-neutral wire contract. Schema 2 adds provider identity and generic
 * quota windows; five_hour/seven_day remain on responses so an older app can
 * keep working during rollout.
 */

export type AccountStatus = "ok" | "stale" | "auth_expired" | "error";
export type UsageProvider = "claude" | "codex" | "unknown";

const STATUSES: readonly AccountStatus[] = ["ok", "stale", "auth_expired", "error"];
const PROVIDERS: readonly UsageProvider[] = ["claude", "codex", "unknown"];

export interface UsageWindow {
  id: string;
  label: string;
  duration_minutes: number | null;
  utilization: number;
  resets_at: string | null;
}

export interface LegacyUsageWindow {
  utilization: number;
  resets_at: string;
}

export interface AccountUsage {
  id: string;
  label: string;
  provider: UsageProvider;
  source_host: string;
  as_of: string;
  status: AccountStatus;
  windows: UsageWindow[];
  five_hour: LegacyUsageWindow | null;
  seven_day: LegacyUsageWindow | null;
}

export interface UsageSnapshot {
  schema: 2;
  generated_at: string;
  accounts: AccountUsage[];
}

const MAX_STRING = 128;
const ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;
const WINDOW_ID_PATTERN = /^[A-Za-z0-9._-]{1,32}$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

export class ValidationError extends Error {}

function requireString(value: unknown, field: string, max = MAX_STRING): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw new ValidationError(`${field} must be a string of 1..${max} chars`);
  }
  return value;
}

function requireTimestamp(value: unknown, field: string): string {
  const raw = requireString(value, field, 64);
  if (!ISO_INSTANT.test(raw)) {
    throw new ValidationError(`${field} must be an ISO-8601 UTC instant`);
  }
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) throw new ValidationError(`${field} is not a valid timestamp`);
  return new Date(parsed).toISOString();
}

function parseUtilization(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ValidationError(`${field} must be a finite number`);
  }
  if (value < 0 || value > 1) {
    throw new ValidationError(`${field} must be within 0..1, got ${value}`);
  }
  return value;
}

function parseLegacyWindow(
  value: unknown,
  field: string,
  id: string,
  label: string,
  durationMinutes: number,
): UsageWindow | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object") throw new ValidationError(`${field} must be an object or null`);

  const record = value as Record<string, unknown>;
  return {
    id,
    label,
    duration_minutes: durationMinutes,
    utilization: parseUtilization(record.utilization, `${field}.utilization`),
    resets_at: requireTimestamp(record.resets_at, `${field}.resets_at`),
  };
}

function parseWindow(value: unknown, index: number): UsageWindow {
  const field = `windows[${index}]`;
  if (typeof value !== "object" || value === null) {
    throw new ValidationError(`${field} must be an object`);
  }
  const record = value as Record<string, unknown>;
  const id = requireString(record.id, `${field}.id`, 32);
  if (!WINDOW_ID_PATTERN.test(id)) {
    throw new ValidationError(`${field}.id must match [A-Za-z0-9._-]{1,32}`);
  }

  const duration = record.duration_minutes;
  if (duration !== null && duration !== undefined &&
      (!Number.isInteger(duration) || (duration as number) < 1 || (duration as number) > 525_600)) {
    throw new ValidationError(`${field}.duration_minutes must be null or an integer within 1..525600`);
  }

  const resetsAt = record.resets_at;
  return {
    id,
    label: requireString(record.label, `${field}.label`, 16),
    duration_minutes: duration == null ? null : duration as number,
    utilization: parseUtilization(record.utilization, `${field}.utilization`),
    resets_at: resetsAt == null ? null : requireTimestamp(resetsAt, `${field}.resets_at`),
  };
}

function legacyShape(window: UsageWindow | undefined): LegacyUsageWindow | null {
  if (!window?.resets_at) return null;
  return { utilization: window.utilization, resets_at: window.resets_at };
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

  const providerValue = record.provider ?? (id.toLowerCase().startsWith("codex") ? "codex" : "claude");
  if (typeof providerValue !== "string" || !PROVIDERS.includes(providerValue as UsageProvider)) {
    throw new ValidationError(`provider must be one of ${PROVIDERS.join(", ")}`);
  }

  let windows: UsageWindow[];
  if (record.windows !== undefined) {
    if (!Array.isArray(record.windows) || record.windows.length > 4) {
      throw new ValidationError("windows must be an array with at most 4 entries");
    }
    windows = record.windows.map(parseWindow);
  } else {
    windows = [
      parseLegacyWindow(record.five_hour, "five_hour", "five-hour", "5h", 300),
      parseLegacyWindow(record.seven_day, "seven_day", "seven-day", "7d", 10_080),
    ].filter((window): window is UsageWindow => window !== null);
  }

  if (new Set(windows.map((window) => window.id)).size !== windows.length) {
    throw new ValidationError("window ids must be unique within an account");
  }

  const fiveHour = windows.find((window) => window.duration_minutes === 300 || window.id === "five-hour");
  const sevenDay = windows.find((window) => window.duration_minutes === 10_080 || window.id === "seven-day");

  return {
    id,
    label: requireString(record.label, "label"),
    provider: providerValue as UsageProvider,
    source_host: requireString(record.source_host, "source_host"),
    as_of: requireTimestamp(record.as_of, "as_of"),
    status: status as AccountStatus,
    windows,
    five_hour: legacyShape(fiveHour),
    seven_day: legacyShape(sevenDay),
  };
}

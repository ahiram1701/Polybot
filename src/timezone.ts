/**
 * Configurable-timezone helpers, shared by backend and UI client (like pnl.ts). The user picks an IANA
 * timezone (or "auto" = system default) in Settings and it drives EVERY hour/day derivation: date
 * display, chart bucketing, fiscal calendar days, and the daily risk cutoff (spend limit / circuit
 * breaker). All helpers accept `timeZone?: string` where undefined/"auto"/invalid falls back to the
 * system timezone, so callers can pass the raw setting straight through.
 */

export const AUTO_TIMEZONE = "auto";

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** Raw setting → IANA name usable in Intl options, or undefined for "use the system timezone". */
export function resolveTimeZone(timeZone?: string): string | undefined {
  if (timeZone === undefined || timeZone === "" || timeZone === AUTO_TIMEZONE) {
    return undefined;
  }
  return isValidTimeZone(timeZone) ? timeZone : undefined;
}

/** Local calendar day "YYYY-MM-DD" in the configured timezone (en-CA renders ISO order). */
export function dayKeyInTimeZone(timestampMs: number, timeZone?: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: resolveTimeZone(timeZone),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(timestampMs));
}

/** Hour of day 0-23 in the configured timezone. */
export function hourInTimeZone(timestampMs: number, timeZone?: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: resolveTimeZone(timeZone),
    hour: "numeric",
    hour12: false,
  }).formatToParts(new Date(timestampMs));
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0");
  // Some ICU versions render midnight as "24" with hour12:false.
  return hour === 24 ? 0 : hour;
}

/** Year (e.g. for the default fiscal year) in the configured timezone. */
export function yearInTimeZone(timestampMs: number, timeZone?: string): number {
  return Number(dayKeyInTimeZone(timestampMs, timeZone).slice(0, 4));
}

export function formatDateTimeInTimeZone(timestampMs: number, timeZone?: string): string {
  return new Date(timestampMs).toLocaleString(undefined, { timeZone: resolveTimeZone(timeZone) });
}

export function formatTimeInTimeZone(timestampMs: number, timeZone?: string): string {
  return new Date(timestampMs).toLocaleTimeString(undefined, { timeZone: resolveTimeZone(timeZone) });
}

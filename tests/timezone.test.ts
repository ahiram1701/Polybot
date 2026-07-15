import { describe, expect, it } from "vitest";

import {
  dayKeyInTimeZone,
  formatTimeInTimeZone,
  hourInTimeZone,
  isValidTimeZone,
  resolveTimeZone,
  yearInTimeZone,
} from "../src/timezone.js";
import { dailySpendKey } from "../src/time.js";

// 2026-07-14 04:30:00 UTC — still 2026-07-13 in Mexico City (UTC-6).
const CROSSING_MS = Date.UTC(2026, 6, 14, 4, 30, 0);

describe("timezone helpers", () => {
  it("validates IANA names and resolves auto/invalid to the system zone", () => {
    expect(isValidTimeZone("America/Mexico_City")).toBe(true);
    expect(isValidTimeZone("Not/AZone")).toBe(false);
    expect(resolveTimeZone("auto")).toBeUndefined();
    expect(resolveTimeZone("")).toBeUndefined();
    expect(resolveTimeZone(undefined)).toBeUndefined();
    expect(resolveTimeZone("Not/AZone")).toBeUndefined();
    expect(resolveTimeZone("UTC")).toBe("UTC");
  });

  it("computes the day key across midnight boundaries", () => {
    expect(dayKeyInTimeZone(CROSSING_MS, "UTC")).toBe("2026-07-14");
    expect(dayKeyInTimeZone(CROSSING_MS, "America/Mexico_City")).toBe("2026-07-13");
  });

  it("computes the hour of day per zone (including midnight as 0)", () => {
    expect(hourInTimeZone(CROSSING_MS, "UTC")).toBe(4);
    expect(hourInTimeZone(CROSSING_MS, "America/Mexico_City")).toBe(22);
    const midnightUtc = Date.UTC(2026, 6, 14, 0, 0, 0);
    expect(hourInTimeZone(midnightUtc, "UTC")).toBe(0);
  });

  it("derives the year in the configured zone", () => {
    const newYearEveUtc = Date.UTC(2027, 0, 1, 3, 0, 0); // still 2026 in Mexico City
    expect(yearInTimeZone(newYearEveUtc, "UTC")).toBe(2027);
    expect(yearInTimeZone(newYearEveUtc, "America/Mexico_City")).toBe(2026);
  });

  it("formats times in the requested zone", () => {
    expect(formatTimeInTimeZone(CROSSING_MS, "UTC")).toMatch(/4:30|04:30/);
  });

  it("dailySpendKey keeps the legacy UTC cut without a zone and follows the configured zone with one", () => {
    expect(dailySpendKey(CROSSING_MS)).toBe("2026-07-14"); // legacy UTC
    expect(dailySpendKey(CROSSING_MS, "America/Mexico_City")).toBe("2026-07-13");
    expect(dailySpendKey(CROSSING_MS, "UTC")).toBe("2026-07-14");
  });
});

import { describe, expect, it } from "vitest";

import { formatDailyReport, shouldSendDailyReport } from "../src/dailyReport.js";

describe("dailyReport helpers", () => {
  it("fires once per day after crossing the configured hour (timezone-aware)", () => {
    // 2026-07-16 20:30 UTC — before the 21h target in UTC.
    const before = Date.UTC(2026, 6, 16, 20, 30);
    expect(shouldSendDailyReport({ nowMs: before, hour: 21, timeZone: "UTC" }).send).toBe(false);

    const after = Date.UTC(2026, 6, 16, 21, 10);
    const first = shouldSendDailyReport({ nowMs: after, hour: 21, timeZone: "UTC" });
    expect(first.send).toBe(true);
    expect(first.dayKey).toBe("2026-07-16");

    // Same day, later check: already sent.
    const again = shouldSendDailyReport({ nowMs: after + 60 * 60_000, hour: 21, timeZone: "UTC", lastSentDayKey: first.dayKey });
    expect(again.send).toBe(false);

    // Next day it fires again.
    const nextDay = shouldSendDailyReport({ nowMs: after + 24 * 60 * 60_000, hour: 21, timeZone: "UTC", lastSentDayKey: first.dayKey });
    expect(nextDay.send).toBe(true);

    // In Mexico City 21:10 UTC is 15:10 — the same instant does NOT fire there.
    expect(shouldSendDailyReport({ nowMs: after, hour: 21, timeZone: "America/Mexico_City" }).send).toBe(false);
  });

  it("formats a compact report with variance context and suggestions", () => {
    const report = formatDailyReport({
      dayKey: "2026-07-16",
      mode: "live",
      running: true,
      todayNetUsd: -3.2,
      todayTrades: 8,
      todayWins: 4,
      postResetNetUsd: -13.66,
      postResetTrades: 38,
      validationTarget: 50,
      varianceBandUsd: 86,
      withinBand: true,
      riskHalt: { tripped: true, reason: "consecutive_losses" },
      autoAdjust: [
        { market: "BTC", state: "aplicable (manual)" },
        { market: "DOGE", state: "esperando datos" },
      ],
      capTuner: [
        { market: "ETH", current: 0.65, target: 0.55 },
        { market: "BTC", current: 0.65, target: 0.65 }, // sin cambio -> no aparece
      ],
      memoryRssMb: 900,
    });
    expect(report.title).toContain("2026-07-16");
    expect(report.body).toContain("-$3.20 en 8 trades (4W/4L)");
    expect(report.body).toContain("38/50 trades del plan");
    expect(report.body).toContain("dentro de la banda de varianza (±$86)");
    expect(report.body).toContain("FRENO activo (consecutive_losses)");
    expect(report.body).toContain("BTC aplicable (manual)");
    expect(report.body).toContain("ETH 0.65->0.55");
    expect(report.body).not.toContain("BTC 0.65->0.65");
    expect(report.body).toContain("RSS 900MB");
  });
});

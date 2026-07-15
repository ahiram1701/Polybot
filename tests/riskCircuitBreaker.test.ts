import { describe, expect, it } from "vitest";

import { evaluateRiskCircuitBreaker } from "../src/riskCircuitBreaker.js";
import type { Mode, Outcome, TradeAttempt } from "../src/types.js";

const NOW = Date.UTC(2026, 6, 1, 15, 0, 0); // 2026-07-01
const YESTERDAY = Date.UTC(2026, 5, 30, 15, 0, 0);

function trade(args: {
  id: string;
  mode?: Mode;
  won?: boolean;
  resolvedAtMs?: number;
  amountUsd?: number;
  ask?: number;
  resolved?: boolean;
}): TradeAttempt {
  const ask = args.ask ?? 0.5;
  const base: TradeAttempt = {
    id: args.id,
    slug: args.id,
    mode: args.mode ?? "sim",
    outcome: "UP" as Outcome,
    tokenId: "token",
    amountUsd: args.amountUsd ?? 10,
    maxAskPrice: 0.98,
    bestAsk: ask,
    estimatedShares: (args.amountUsd ?? 10) / ask,
    filledShares: (args.amountUsd ?? 10) / ask,
    filledAmountUsd: args.amountUsd ?? 10,
    openingPrice: 100,
    entryPrice: 110,
    distanceUsd: 10,
    entryWindowSeconds: 30,
    windowStartMs: 1,
    endMs: 2,
    createdAtMs: (args.resolvedAtMs ?? NOW) - 60_000,
  };
  if (args.resolved === false) {
    return base;
  }
  return {
    ...base,
    resolved: {
      resolvedAtMs: args.resolvedAtMs ?? NOW,
      finalPrice: args.won ? 130 : 90,
      finalTickTimestampMs: args.resolvedAtMs ?? NOW,
      winningOutcome: (args.won ? "UP" : "DOWN") as Outcome,
      won: args.won ?? false,
    },
  };
}

describe("evaluateRiskCircuitBreaker", () => {
  it("scopes the metrics day to the configured timezone", () => {
    // Loss resolved 2026-07-14 04:30 UTC; evaluated at 12:00 UTC the same day.
    const lossMs = Date.UTC(2026, 6, 14, 4, 30);
    const nowMs = Date.UTC(2026, 6, 14, 12, 0);
    const trades = [trade({ id: "l", won: false, resolvedAtMs: lossMs })];
    const limits = { maxDailyLossUsd: 1, maxConsecutiveLosses: 0 };
    // Same UTC day -> counted -> trips.
    expect(evaluateRiskCircuitBreaker(trades, "sim", limits, nowMs).tripped).toBe(true);
    // In Mexico City the loss belongs to Jul 13 while "now" is Jul 14 -> clean day, no trip.
    expect(
      evaluateRiskCircuitBreaker(trades, "sim", { ...limits, timeZone: "America/Mexico_City" }, nowMs).tripped,
    ).toBe(false);
  });

  it("does not trip when both limits are disabled (0)", () => {
    const trades = [trade({ id: "a", won: false }), trade({ id: "b", won: false })];
    const status = evaluateRiskCircuitBreaker(trades, "sim", { maxDailyLossUsd: 0, maxConsecutiveLosses: 0 }, NOW);
    expect(status.tripped).toBe(false);
    expect(status.dailyLossUsd).toBeGreaterThan(0);
  });

  it("trips on the daily loss limit from losses realized today", () => {
    // 3 losses of $10 stake each today => ~$30 daily loss.
    const trades = [
      trade({ id: "a", won: false }),
      trade({ id: "b", won: false }),
      trade({ id: "c", won: false }),
    ];
    const status = evaluateRiskCircuitBreaker(trades, "sim", { maxDailyLossUsd: 25 }, NOW);
    expect(status.tripped).toBe(true);
    expect(status.reason).toBe("daily_loss_limit");
    expect(status.dailyLossUsd).toBeGreaterThanOrEqual(25);
  });

  it("trips on consecutive losses (most recent trades)", () => {
    const trades = [
      trade({ id: "win", won: true, resolvedAtMs: NOW - 4000 }),
      trade({ id: "l1", won: false, resolvedAtMs: NOW - 3000 }),
      trade({ id: "l2", won: false, resolvedAtMs: NOW - 2000 }),
      trade({ id: "l3", won: false, resolvedAtMs: NOW - 1000 }),
    ];
    const status = evaluateRiskCircuitBreaker(trades, "sim", { maxConsecutiveLosses: 3 }, NOW);
    expect(status.consecutiveLosses).toBe(3);
    expect(status.tripped).toBe(true);
    expect(status.reason).toBe("consecutive_losses");
  });

  it("resets the next UTC day: yesterday's losses do not count today", () => {
    const trades = [
      trade({ id: "y1", won: false, resolvedAtMs: YESTERDAY }),
      trade({ id: "y2", won: false, resolvedAtMs: YESTERDAY }),
      trade({ id: "y3", won: false, resolvedAtMs: YESTERDAY }),
    ];
    const status = evaluateRiskCircuitBreaker(trades, "sim", { maxDailyLossUsd: 25, maxConsecutiveLosses: 2 }, NOW);
    expect(status.tripped).toBe(false);
    expect(status.dailyLossUsd).toBe(0);
    expect(status.consecutiveLosses).toBe(0);
  });

  it("ignores trades from the other mode and pending trades", () => {
    const trades = [
      trade({ id: "live-loss", mode: "live", won: false }),
      trade({ id: "pending", resolved: false }),
    ];
    const status = evaluateRiskCircuitBreaker(trades, "sim", { maxDailyLossUsd: 5, maxConsecutiveLosses: 1 }, NOW);
    expect(status.tripped).toBe(false);
    expect(status.dailyLossUsd).toBe(0);
  });

  it("with a cooldown, stays tripped until the cooldown elapses and reports when it resumes", () => {
    const tripAt = NOW - 30 * 60_000; // tripped 30 minutes ago
    const trades = [
      trade({ id: "l1", won: false, resolvedAtMs: tripAt - 2000 }),
      trade({ id: "l2", won: false, resolvedAtMs: tripAt - 1000 }),
      trade({ id: "l3", won: false, resolvedAtMs: tripAt }),
    ];
    const status = evaluateRiskCircuitBreaker(trades, "sim", { maxDailyLossUsd: 25, cooldownHours: 2 }, NOW);
    expect(status.tripped).toBe(true);
    expect(status.resumeAtMs).toBe(tripAt + 2 * 3_600_000);
  });

  it("with a cooldown, auto re-arms after it elapses with a clean slate", () => {
    const tripAt = NOW - 3 * 3_600_000; // tripped 3h ago, cooldown 2h -> re-armed 1h ago
    const trades = [
      trade({ id: "l1", won: false, resolvedAtMs: tripAt - 2000 }),
      trade({ id: "l2", won: false, resolvedAtMs: tripAt - 1000 }),
      trade({ id: "l3", won: false, resolvedAtMs: tripAt }),
    ];
    const status = evaluateRiskCircuitBreaker(trades, "sim", { maxDailyLossUsd: 25, cooldownHours: 2 }, NOW);
    expect(status.tripped).toBe(false);
    // Pre-trip losses no longer count against the re-armed window.
    expect(status.dailyLossUsd).toBe(0);
  });

  it("with a cooldown, re-trips on NEW losses after the auto re-arm", () => {
    const tripAt = NOW - 3 * 3_600_000;
    const trades = [
      trade({ id: "l1", won: false, resolvedAtMs: tripAt - 2000 }),
      trade({ id: "l2", won: false, resolvedAtMs: tripAt - 1000 }),
      trade({ id: "l3", won: false, resolvedAtMs: tripAt }),
      // After the 2h cooldown re-arm, three fresh losses cross the limit again.
      trade({ id: "n1", won: false, resolvedAtMs: NOW - 3000 }),
      trade({ id: "n2", won: false, resolvedAtMs: NOW - 2000 }),
      trade({ id: "n3", won: false, resolvedAtMs: NOW - 1000 }),
    ];
    const status = evaluateRiskCircuitBreaker(trades, "sim", { maxDailyLossUsd: 25, cooldownHours: 2 }, NOW);
    expect(status.tripped).toBe(true);
    expect(status.reason).toBe("daily_loss_limit");
    expect(status.resumeAtMs).toBe(NOW - 1000 + 2 * 3_600_000);
  });

  it("re-arms when the breaker is reset: losses before the reset are ignored", () => {
    const trades = [
      trade({ id: "l1", won: false, resolvedAtMs: NOW - 3000 }),
      trade({ id: "l2", won: false, resolvedAtMs: NOW - 2000 }),
      trade({ id: "l3", won: false, resolvedAtMs: NOW - 1000 }),
    ];
    // Without a reset: 3 consecutive losses trip the breaker.
    expect(evaluateRiskCircuitBreaker(trades, "sim", { maxConsecutiveLosses: 3 }, NOW).tripped).toBe(true);
    // Reset at NOW-1500 ignores l1/l2 (and l3 is at NOW-1000 > reset, so 1 loss remains): not tripped.
    const afterReset = evaluateRiskCircuitBreaker(trades, "sim", { maxConsecutiveLosses: 3 }, NOW, NOW - 1500);
    expect(afterReset.consecutiveLosses).toBe(1);
    expect(afterReset.tripped).toBe(false);
    // Reset at NOW ignores all past losses: clean slate.
    const fullReset = evaluateRiskCircuitBreaker(trades, "sim", { maxConsecutiveLosses: 3 }, NOW, NOW);
    expect(fullReset.consecutiveLosses).toBe(0);
    expect(fullReset.tripped).toBe(false);
  });
});

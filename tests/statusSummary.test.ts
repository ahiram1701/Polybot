import { describe, expect, it } from "vitest";

import { summarizeStatus } from "../src/agent/statusSummary.js";
import type { UiStatus } from "../src/ui/shared.js";

function buildStatus(overrides: Partial<UiStatus> = {}): UiStatus {
  const pnl = {
    realizedUsd: 5.5,
    realizedStakeUsd: 100,
    payoutUsd: 105.5,
    pendingStakeUsd: 0,
    totalStakeUsd: 100,
    resolvedCount: 10,
    pendingCount: 0,
    wonCount: 7,
    lostCount: 3,
    roiPct: 0.055,
  };
  return {
    running: true,
    mode: "sim",
    startedAtMs: 1000,
    liveReadiness: { ready: false, hasPrivateKey: false, hasFunderAddress: false, hasSignatureType: false },
    config: { dailySpendLimitUsd: 50 },
    settings: {},
    dailySpendUsd: 12.3456,
    markets: [
      {
        marketSymbol: "BTC",
        tick: { market: "BTC", symbol: "btc/usd", value: 58000, timestampMs: 1, receivedAtMs: 1 },
        quotes: { UP: { tokenId: "x", bestAsk: 0.8 } },
        opening: { slug: "s", windowStartMs: 0, openingPrice: 57000, openingTickTimestampMs: 0, capturedAtMs: 0 },
        signal: {
          reason: "btc_distance_below_threshold",
          inEntryWindow: false,
          secondsToEnd: 30.5,
          outcome: "UP",
          distanceUsd: 12.345,
        },
      },
    ],
    signal: { reason: "btc_distance_below_threshold", inEntryWindow: false },
    pnl,
    pnlByMode: { sim: pnl, live: { ...pnl, realizedUsd: 0, resolvedCount: 0, wonCount: 0, lostCount: 0, roiPct: undefined } },
    pnlHistoricalByMode: {
      sim: { ...pnl, realizedUsd: 5, resolvedCount: 20, wonCount: 12, lostCount: 8 },
      live: { ...pnl, realizedUsd: 0, resolvedCount: 0, wonCount: 0, lostCount: 0, roiPct: undefined },
    },
    pnlResetAtMs: { sim: 1_700_000_000_000 },
    logs: [
      { at: "t3", level: "info", message: "Skipped trade.", meta: { reason: "no_ask_liquidity_under_cap" } },
      { at: "t2", level: "info", message: "Skipped trade.", meta: { reason: "no_ask_liquidity_under_cap" } },
      { at: "t1", level: "info", message: "Skipped trade.", meta: { reason: "btc_distance_below_threshold" } },
      { at: "t0", level: "info", message: "Tracking market.", meta: { market: "BTC" } },
    ],
    ...overrides,
  } as unknown as UiStatus;
}

describe("summarizeStatus", () => {
  it("projects a compact, decision-relevant snapshot", () => {
    const compact = summarizeStatus(buildStatus(), { nowMs: 4000 });

    expect(compact.running).toBe(true);
    expect(compact.mode).toBe("sim");
    expect(compact.uptimeSeconds).toBe(3);
    expect(compact.dailySpendUsd).toBe(12.35);
    expect(compact.dailySpendLimitUsd).toBe(50);
    expect(compact.markets[0]).toEqual({
      marketSymbol: "BTC",
      reason: "btc_distance_below_threshold",
      inEntryWindow: false,
      secondsToEnd: 30.5,
      outcome: "UP",
      distanceUsd: 12.35,
      tickValue: 58000,
    });
    expect(compact.pnlByMode.sim).toEqual({
      realizedUsd: 5.5,
      roiPct: 0.055,
      resolvedCount: 10,
      wonCount: 7,
      lostCount: 3,
      pendingCount: 0,
    });
  });

  it("exposes lifetime (historical) PnL and reset markers alongside post-reset PnL", () => {
    const compact = summarizeStatus(buildStatus(), { nowMs: 4000 });
    expect(compact.pnlHistoricalByMode.sim).toMatchObject({
      realizedUsd: 5,
      resolvedCount: 20,
      wonCount: 12,
      lostCount: 8,
    });
    // Post-reset figures remain distinct from lifetime figures.
    expect(compact.pnlByMode.sim.resolvedCount).toBe(10);
    expect(compact.pnlResetAtMs).toEqual({ sim: 1_700_000_000_000 });
  });

  it("folds recent skip reasons into a structured summary", () => {
    const compact = summarizeStatus(buildStatus());
    expect(compact.recentActivity.skipReasonCounts).toEqual({
      no_ask_liquidity_under_cap: 2,
      btc_distance_below_threshold: 1,
    });
    expect(compact.recentActivity.otherMessageCounts).toEqual({ "Tracking market.": 1 });
    expect(compact.recentActivity.sampleSize).toBe(4);
  });

  it("drops the raw logs, ticks and quotes so the payload stays small", () => {
    const compact = summarizeStatus(buildStatus());
    const serialized = JSON.stringify(compact);
    expect(serialized).not.toContain("receivedAtMs");
    expect(serialized).not.toContain("bestAsk");
    expect(serialized).not.toContain("openingPrice");
    expect("logs" in (compact as unknown as Record<string, unknown>)).toBe(false);
    expect(serialized.length).toBeLessThan(2000);
  });
});

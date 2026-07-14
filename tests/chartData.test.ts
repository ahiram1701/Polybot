import { describe, expect, it } from "vitest";

import {
  buildEquitySeries,
  calibrationBuckets,
  cumulativeRoi,
  netDistribution,
  perMarketSide,
  resolvedTradesForCharts,
  rollingWinRate,
} from "../src/ui/client/chartData.js";
import type { MarketSymbol, Outcome, TradeAttempt } from "../src/types.js";

function trade(args: {
  id: string;
  won: boolean;
  ask?: number;
  predicted?: number;
  asset?: MarketSymbol;
  outcome?: Outcome;
  resolvedAtMs?: number;
  mode?: TradeAttempt["mode"];
  createdAtMs?: number;
  kind?: "arb";
}): TradeAttempt {
  const ask = args.ask ?? 0.5;
  return {
    id: args.id,
    slug: `eth-updown-5m-${args.id}`,
    // Default sim so fee estimation never muddies the pure-math assertions; filtering tests pass live.
    mode: args.mode ?? "sim",
    outcome: args.outcome ?? "UP",
    asset: args.asset ?? "ETH",
    tokenId: "token",
    amountUsd: 5,
    maxAskPrice: 0.85,
    bestAsk: ask,
    estimatedShares: 5 / ask,
    fillDetected: true,
    filledAmountUsd: 5,
    filledShares: 5 / ask,
    feeUsd: 0,
    openingPrice: 100,
    entryPrice: 101,
    distanceUsd: 1,
    windowStartMs: 1,
    endMs: 2,
    createdAtMs: args.createdAtMs ?? 100,
    kind: args.kind,
    expectedValue: args.predicted !== undefined ? ({ adjustedWinProbability: args.predicted } as TradeAttempt["expectedValue"]) : undefined,
    resolved: {
      resolvedAtMs: args.resolvedAtMs ?? 200,
      finalPrice: args.won ? 110 : 90,
      finalTickTimestampMs: args.resolvedAtMs ?? 200,
      winningOutcome: args.won ? "UP" : "DOWN",
      won: args.won,
    },
  };
}

describe("chart data helpers", () => {
  it("filters resolved trades of a mode post-reset and sorts by resolution time", () => {
    const trades = [
      trade({ id: "b", won: true, mode: "live", resolvedAtMs: 300, createdAtMs: 250 }),
      trade({ id: "a", won: false, mode: "live", resolvedAtMs: 200, createdAtMs: 150 }),
      trade({ id: "old", won: true, mode: "live", resolvedAtMs: 120, createdAtMs: 10 }),
      trade({ id: "sim", won: true, mode: "sim", createdAtMs: 250 }),
    ];
    const out = resolvedTradesForCharts(trades, "live", { live: 100 });
    expect(out.map((t) => t.id)).toEqual(["a", "b"]); // "old" pre-reset, "sim" other mode
  });

  it("excludes arb pairs when asked", () => {
    const trades = [
      trade({ id: "m", won: true, mode: "live" }),
      trade({ id: "arb", won: false, mode: "live", kind: "arb" }),
    ];
    expect(resolvedTradesForCharts(trades, "live", {}, { excludeArb: true }).map((t) => t.id)).toEqual(["m"]);
  });

  it("builds a cumulative equity series with a drawdown envelope", () => {
    // +$5 win at 0.5 (10 shares - 5), then -$5 loss.
    const series = buildEquitySeries([trade({ id: "w", won: true }), trade({ id: "l", won: false })]);
    expect(series[0].cumulativeUsd).toBeCloseTo(5);
    expect(series[0].drawdownUsd).toBeCloseTo(0);
    expect(series[1].cumulativeUsd).toBeCloseTo(0);
    expect(series[1].drawdownUsd).toBeCloseTo(-5); // fell $5 from the $5 peak
  });

  it("computes a rolling win rate", () => {
    const trades = [trade({ id: "1", won: true }), trade({ id: "2", won: false }), trade({ id: "3", won: true })];
    expect(rollingWinRate(trades, 2)).toEqual([1, 0.5, 0.5]);
  });

  it("computes cumulative ROI", () => {
    const roi = cumulativeRoi([trade({ id: "w", won: true }), trade({ id: "l", won: false })]);
    expect(roi[0]).toBeCloseTo(1); // +5 on 5 stake
    expect(roi[1]).toBeCloseTo(0); // net 0 on 10 stake
  });

  it("buckets calibration by predicted probability vs realized win", () => {
    const trades = [
      trade({ id: "a", won: false, predicted: 0.92 }),
      trade({ id: "b", won: false, predicted: 0.91 }),
      trade({ id: "c", won: true, predicted: 0.93 }),
    ];
    const buckets = calibrationBuckets(trades);
    const high = buckets.find((b) => b.label === "0.9–1.0");
    expect(high?.count).toBe(3);
    expect(high?.value).toBeCloseTo(1 / 3); // predicted ~0.92 but only 33% real -> overconfidence
    expect(high?.reference).toBeCloseTo(0.92, 1);
  });

  it("bins the net$ distribution", () => {
    const dist = netDistribution([trade({ id: "w", won: true }), trade({ id: "l", won: false })]);
    expect(dist.find((b) => b.label === "2.5..5")?.value).toBe(1); // +5 win
    expect(dist.find((b) => b.label === "≤−5")?.value).toBe(1); // -5 loss lands at the boundary bucket
  });

  it("groups net and win rate by market and side", () => {
    const trades = [
      trade({ id: "btc", won: true, asset: "BTC", outcome: "UP" }),
      trade({ id: "eth", won: false, asset: "ETH", outcome: "DOWN" }),
    ];
    const { markets, sides } = perMarketSide(trades);
    expect(markets.find((m) => m.label === "BTC")?.value).toBeCloseTo(5);
    expect(markets.find((m) => m.label === "ETH")?.value).toBeCloseTo(-5);
    expect(sides.find((s) => s.label === "UP")?.reference).toBeCloseTo(1);
    expect(sides.find((s) => s.label === "DOWN")?.reference).toBeCloseTo(0);
  });
});

import { describe, expect, it } from "vitest";

import {
  buildEquitySeries,
  calibrationBuckets,
  cumulativeRoi,
  hourOfDayHistogram,
  netDistribution,
  perMarketSide,
  projectionEstimates,
  resolvedTradesForCharts,
  rollingWinRate,
  tradesPerDaySeries,
  validationProgress,
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

  it("buckets the hour histogram and day series in an explicit timezone", () => {
    // 2026-07-14 04:30 UTC = 22:30 of 2026-07-13 in Mexico City.
    const crossing = Date.UTC(2026, 6, 14, 4, 30);
    const trades = [trade({ id: "x", won: true, createdAtMs: crossing })];
    expect(hourOfDayHistogram(trades, "UTC")[0].label).toBe("04h");
    expect(hourOfDayHistogram(trades, "America/Mexico_City")[0].label).toBe("22h");
    const two = [
      trade({ id: "a", won: true, createdAtMs: crossing }),
      trade({ id: "b", won: true, createdAtMs: crossing + 3 * 3_600_000 }), // 07:30 UTC = 01:30 MX of Jul 14
    ];
    expect(tradesPerDaySeries(two, "UTC")).toEqual([2]);
    expect(tradesPerDaySeries(two, "America/Mexico_City")).toEqual([1, 1]);
  });

  it("builds an hour-of-day histogram with wins as reference, skipping empty hours", () => {
    // Local-time constructors keep the test timezone-safe.
    const at = (hour: number, minute: number) => new Date(2026, 6, 10, hour, minute).getTime();
    const buckets = hourOfDayHistogram([
      trade({ id: "a", won: true, createdAtMs: at(14, 5) }),
      trade({ id: "b", won: false, createdAtMs: at(14, 40) }),
      trade({ id: "c", won: true, createdAtMs: at(3, 15) }),
    ]);
    expect(buckets.map((b) => b.label)).toEqual(["03h", "14h"]);
    const h14 = buckets.find((b) => b.label === "14h");
    expect(h14?.value).toBe(2);
    expect(h14?.reference).toBe(1); // one win of the two
  });

  it("builds the trades-per-day series including zero-gap days", () => {
    const onDay = (day: number) => new Date(2026, 6, day, 12, 0).getTime();
    const series = tradesPerDaySeries([
      trade({ id: "a", won: true, createdAtMs: onDay(10) }),
      trade({ id: "b", won: true, createdAtMs: onDay(10) }),
      trade({ id: "c", won: false, createdAtMs: onDay(12) }),
    ]);
    expect(series).toEqual([2, 0, 1]); // day 11 present at zero
  });

  it("projects weekly/monthly/yearly estimates from the resolved pace", () => {
    const dayMs = 86_400_000;
    const base = new Date(2026, 6, 10, 12, 0).getTime();
    // 5 trades over exactly 2 days: net +5 -5 +5 -5 +5 = +5, stake 25.
    const trades = [0, 0.5, 1, 1.5, 2].map((offsetDays, index) =>
      trade({
        id: `p${index}`,
        won: index % 2 === 0,
        createdAtMs: base + offsetDays * dayMs,
        resolvedAtMs: base + offsetDays * dayMs + 60_000,
      }),
    );
    const projection = projectionEstimates(trades);
    expect(projection).toBeDefined();
    expect(projection!.spanDays).toBeCloseTo(2, 1);
    expect(projection!.netPerDayUsd).toBeCloseTo(2.5, 1); // +5 over 2 days
    expect(projection!.tradesPerDay).toBeCloseTo(2.5, 1);
    const week = projection!.periods.find((p) => p.label === "Semana");
    expect(week?.netUsd).toBeCloseTo(17.5, 0); // 2.5/day * 7
    expect(week?.trades).toBe(18); // round(2.5/day * 7 = 17.5)
    expect(projection!.roiPct).toBeCloseTo(20, 0); // 5/25

    // Thin bases refuse to project.
    expect(projectionEstimates(trades.slice(0, 4))).toBeUndefined(); // <5 trades
    const burst = [0, 1, 2, 3, 4].map((minutes, index) =>
      trade({ id: `b${index}`, won: true, createdAtMs: base, resolvedAtMs: base + minutes * 60_000 }),
    );
    expect(projectionEstimates(burst)).toBeUndefined(); // <6h span
  });

  it("reports validation progress with a variance band", () => {
    // Alternating ±5 nets: mean 0, cumulative 0 -> squarely inside the luck band.
    const balanced = [0, 1, 2, 3].map((i) => trade({ id: `v${i}`, won: i % 2 === 0 }));
    const progress = validationProgress(balanced, 50);
    expect(progress.resolvedCount).toBe(4);
    expect(progress.target).toBe(50);
    expect(progress.netUsd).toBeCloseTo(0);
    expect(progress.varianceBandUsd).toBeGreaterThan(0);
    expect(progress.withinBand).toBe(true);

    // All wins: cumulative +20 with zero spread -> band 0, clearly signal.
    const streak = [0, 1, 2, 3].map((i) => trade({ id: `w${i}`, won: true }));
    expect(validationProgress(streak, 50).withinBand).toBe(false);
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

import { describe, expect, it } from "vitest";

import { buildStrategyAnalysis, type StrategyAnalysisSettings } from "../src/strategyAnalysisEngine.js";
import type { AnalyticsSample, MarketSymbol, Outcome } from "../src/types.js";

describe("StrategyAnalysisEngine", () => {
  it("calculates EV from wins and losses per dollar risked", () => {
    const response = buildStrategyAnalysis(
      [
        sample({ slug: "btc-1", distanceUsd: 12, ask: 0.4, winningOutcome: "UP" }),
        sample({ slug: "btc-2", distanceUsd: 12, ask: 0.4, winningOutcome: "DOWN" }),
      ],
      settings(),
    );

    const current = response.currentStrategies.find((strategy) => strategy.market === "BTC" && strategy.outcome === "UP");
    expect(response.summary.firstSampleAtMs).toBe(Date.UTC(2026, 4, 8, 12, 5));
    expect(response.summary.lastSampleAtMs).toBe(Date.UTC(2026, 4, 8, 12, 5));
    expect(current?.metrics.tradeCount).toBe(2);
    expect(current?.metrics.winCount).toBe(1);
    expect(current?.metrics.lossCount).toBe(1);
    expect(current?.metrics.realWinProbability).toBeCloseTo(0.5);
    // Prior anchored to the market (avg ask 0.4): adjusted = (1 + 2*0.4) / (2 + 2) = 0.45.
    expect(current?.metrics.adjustedWinProbability).toBeCloseTo(0.45);
    expect(current?.metrics.edge).toBeCloseTo(0.05);
    expect(current?.metrics.evRoi).toBeCloseTo(0.125);
    expect(current?.metrics.historicalRoi).toBeCloseTo(0.25);
    expect(current?.metrics.expectedValueUsd).toBeCloseTo(0.125);
    expect(current?.metrics.winProfitUsd).toBeCloseTo(1.5);
    expect(current?.metrics.lossUsd).toBe(-1);
    expect(current?.metrics.breakEvenProbability).toBeCloseTo(0.4);
    expect(current?.metrics.passesRecommendedEntry).toBe(true);
  });

  it("evaluates UP and DOWN signals with side-specific distance", () => {
    const response = buildStrategyAnalysis(
      [sample({ slug: "btc-down", distanceUsd: -12, ask: 0.5, winningOutcome: "DOWN" })],
      settings(),
    );

    const up = response.currentStrategies.find((strategy) => strategy.market === "BTC" && strategy.outcome === "UP");
    const down = response.currentStrategies.find((strategy) => strategy.market === "BTC" && strategy.outcome === "DOWN");
    expect(up?.metrics.signalCount).toBe(0);
    expect(down?.metrics.signalCount).toBe(1);
    expect(down?.metrics.tradeCount).toBe(1);
    expect(down?.metrics.realWinProbability).toBeCloseTo(1);
    expect(down?.metrics.adjustedWinProbability).toBeCloseTo(2 / 3);
    expect(down?.metrics.evRoi).toBeCloseTo(1 / 3);
    expect(down?.metrics.historicalRoi).toBeCloseTo(1);
  });

  it("counts signals without trades when quotes are missing or above ask cap", () => {
    const response = buildStrategyAnalysis(
      [
        sample({ slug: "btc-no-quote", distanceUsd: 12, ask: undefined, winningOutcome: "UP" }),
        sample({ slug: "btc-expensive", distanceUsd: 12, ask: 0.99, winningOutcome: "UP" }),
      ],
      settings({ maxAskPrice: 0.9 }),
    );

    const current = response.currentStrategies.find((strategy) => strategy.market === "BTC" && strategy.outcome === "UP");
    expect(current?.metrics.signalCount).toBe(2);
    expect(current?.metrics.tradeCount).toBe(0);
    expect(current?.metrics.evRoi).toBeUndefined();
    expect(current?.confidence).toBe("low");
    expect(current?.riskFlags).toEqual(expect.arrayContaining(["no_trades", "low_quote_coverage"]));
  });

  it("marks reliable strategies and compares EV against the current strategy", () => {
    const response = buildStrategyAnalysis(
      Array.from({ length: 5 }, (_value, index) =>
        sample({ slug: `btc-reliable-${index}`, distanceUsd: 12, ask: 0.5, winningOutcome: "UP" }),
      ),
      settings(),
    );

    const current = response.currentStrategies.find((strategy) => strategy.market === "BTC" && strategy.outcome === "UP");
    expect(current?.confidence).toBe("medium");
    expect(current?.riskFlags).toEqual([]);
    expect(current?.qualityScore).toBeGreaterThan(0);
    expect(current?.evDeltaVsCurrent).toBeCloseTo(0);
    expect(response.summary.reliableStrategyCount).toBeGreaterThan(0);
    expect(response.summary.bestReliableEvRoi).toBeGreaterThan(0);
    expect(response.summary.bestReliableTradeCount).toBeGreaterThanOrEqual(5);
  });

  it("ranks EV strategies and marks the current strategy", () => {
    const response = buildStrategyAnalysis(
      [
        sample({ slug: "btc-1", distanceUsd: 12, ask: 0.5, winningOutcome: "UP" }),
        sample({ slug: "btc-2", distanceUsd: 16, ask: 0.5, winningOutcome: "UP" }),
      ],
      settings(),
    );

    expect(response.strategies.length).toBeGreaterThan(1);
    expect(response.strategies[0].metrics.evRoi).toBeGreaterThanOrEqual(response.strategies[1].metrics.evRoi ?? -Infinity);
    expect(response.currentStrategies.find((strategy) => strategy.market === "BTC" && strategy.outcome === "UP")?.isCurrent).toBe(true);
  });

  it("marks 0.98 asks as non-entry under the safety-margin rule", () => {
    const response = buildStrategyAnalysis(
      Array.from({ length: 10 }, (_value, index) =>
        sample({ slug: `btc-expensive-${index}`, distanceUsd: 12, ask: 0.98, winningOutcome: "UP" }),
      ),
      settings({ maxAskPrice: 0.98 }),
    );

    const current = response.currentStrategies.find((strategy) => strategy.market === "BTC" && strategy.outcome === "UP");
    expect(current?.metrics.askGuidance).toBe("avoid_098");
    expect(current?.metrics.passesRecommendedEntry).toBe(false);
    expect(current?.metrics.evDecisionReason).toBe("avoid_098");
    expect(current?.riskFlags).toEqual(expect.arrayContaining(["avoid_ask", "unsafe_edge"]));
  });
});

function settings(overrides: Partial<StrategyAnalysisSettings> = {}): StrategyAnalysisSettings {
  return {
    minDistanceUsdByMarket: { BTC: 10, ETH: 5, DOGE: 0.0005 },
    minDistanceUsdByMarketOutcome: {
      BTC: { UP: 10, DOWN: 10 },
      ETH: { UP: 5, DOWN: 5 },
      DOGE: { UP: 0.0005, DOWN: 0.0005 },
    },
    entryWindowSeconds: 20,
    entryWindowSecondsByMarket: { BTC: 20, ETH: 20, DOGE: 20 },
    entryWindowSecondsByMarketOutcome: {
      BTC: { UP: 20, DOWN: 20 },
      ETH: { UP: 20, DOWN: 20 },
      DOGE: { UP: 20, DOWN: 20 },
    },
    maxAskPrice: 0.98,
    maxAskPriceByMarketOutcome: {
      BTC: { UP: 0.98, DOWN: 0.98 },
      ETH: { UP: 0.98, DOWN: 0.98 },
      DOGE: { UP: 0.98, DOWN: 0.98 },
    },
    ...overrides,
  };
}

function sample(args: {
  slug: string;
  market?: MarketSymbol;
  outcome?: Outcome;
  distanceUsd: number;
  ask?: number;
  winningOutcome: Outcome;
}): AnalyticsSample {
  const market = args.market ?? "BTC";
  const outcome = args.outcome ?? (args.distanceUsd >= 0 ? "UP" : "DOWN");
  const windowStartMs = Date.UTC(2026, 4, 8, 12);
  const endMs = windowStartMs + 300_000;
  const timestampMs = endMs - 10_000;
  return {
    version: 1,
    market,
    slug: args.slug,
    windowStartMs,
    endMs,
    openingPrice: 100,
    openingTickTimestampMs: windowStartMs,
    ticks: [
      {
        timestampMs,
        secondsToEnd: 10,
        price: 100 + args.distanceUsd,
        distanceUsd: args.distanceUsd,
      },
    ],
    quotes: args.ask === undefined
      ? []
      : [
          {
            timestampMs,
            secondsToEnd: 10,
            upBestAsk: outcome === "UP" ? args.ask : undefined,
            downBestAsk: outcome === "DOWN" ? args.ask : undefined,
          },
        ],
    finalPrice: args.winningOutcome === "UP" ? 120 : 80,
    finalTickTimestampMs: endMs,
    winningOutcome: args.winningOutcome,
    resolvedAtMs: endMs,
  };
}

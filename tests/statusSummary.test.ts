import { describe, expect, it } from "vitest";

import {
  splitCompactPnlByKind,
  summarizeStatus,
  summarizeStrategyAnalysis,
  summarizeTrade,
} from "../src/agent/statusSummary.js";
import { splitPnlByKind } from "../src/ui/client/App.js";
import type { StrategyAnalysisResponse, StrategyCandidate, TradeAttempt } from "../src/types.js";
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

describe("summarizeTrade", () => {
  const trade = {
    id: "btc-x-sim-DOWN-1",
    asset: "BTC",
    slug: "btc-updown-5m-1",
    mode: "sim",
    conditionId: "0xVERYLONGCONDITIONID",
    outcome: "DOWN",
    tokenId: "1234567890123456789012345678901234567890",
    amountUsd: 10,
    bestAsk: 0.7,
    estimatedShares: 14.28,
    openingPrice: 60785,
    entryPrice: 60750,
    distanceUsd: 35.375,
    entryWindowSeconds: 52,
    windowStartMs: 1,
    endMs: 2,
    createdAtMs: 3,
    expectedValue: {
      capitalUsd: 10,
      askPrice: 0.7,
      winCount: 123,
      tradeCount: 136,
      realWinProbability: 0.904,
      adjustedWinProbability: 0.8985,
      breakEvenProbability: 0.7,
      edge: 0.1985,
      expectedRoi: 0.2836,
      expectedValueUsd: 2.83,
      winProfitUsd: 4.28,
      lossUsd: -10,
      safetyMargin: 0.03,
      minExpectedRoi: 0.031,
      minExpectedValueUsd: 0.31,
      askGuidance: "cheap",
      passesBasicEntry: true,
      passesSafetyMargin: true,
      passesExpectedValue: true,
      passesRecommendedEntry: true,
      decisionReason: "passes",
    },
    resolved: { resolvedAtMs: 4, finalPrice: 60789, finalTickTimestampMs: 2, winningOutcome: "UP", won: false },
  } as unknown as TradeAttempt;

  it("keeps decision-relevant fields and drops token/condition ids and the full EV snapshot", () => {
    const compact = summarizeTrade(trade);
    const serialized = JSON.stringify(compact);
    expect(compact.market).toBe("BTC");
    expect(compact.outcome).toBe("DOWN");
    expect(compact.resolved).toEqual({ won: false, winningOutcome: "UP" });
    expect(compact.ev).toEqual({ edge: 0.2, expectedRoi: 0.28, adjustedWinProbability: 0.9, tradeCount: 136 });
    expect(typeof compact.netUsd).toBe("number");
    // Heavy/irrelevant fields are gone.
    expect(serialized).not.toContain("conditionId");
    expect(serialized).not.toContain(trade.tokenId);
    expect(serialized).not.toContain("breakEvenProbability");
  });
});

describe("summarizeStrategyAnalysis", () => {
  function candidate(overrides: Partial<StrategyCandidate> = {}): StrategyCandidate {
    return {
      market: "BTC",
      outcome: "UP",
      entryWindowSeconds: 60,
      minDistanceUsd: 31,
      maxAskPrice: 0.9,
      isCurrent: false,
      confidence: "high",
      riskFlags: [],
      qualityScore: 0.82,
      metrics: {
        sampleCount: 5000,
        signalCount: 600,
        tradeCount: 62,
        winCount: 55,
        lossCount: 7,
        quoteCoverage: 0.1,
        winRate: 0.887,
        evRoi: 0.15,
        edge: 0.12,
        passesRecommendedEntry: true,
        maxDrawdown: 3,
      },
      ...overrides,
    } as unknown as StrategyCandidate;
  }

  it("limits the ranked list and projects strategies to key fields", () => {
    const response = {
      generatedAtMs: 1000,
      summary: { sampleCount: 15208, analyzedSampleCount: 900, strategyCount: 200, currentStrategyCount: 6, reliableStrategyCount: 4 },
      strategies: Array.from({ length: 40 }, () => candidate()),
      currentStrategies: [candidate({ isCurrent: true })],
    } as unknown as StrategyAnalysisResponse;

    const compact = summarizeStrategyAnalysis(response, 12);
    expect(compact.topStrategies).toHaveLength(12);
    expect(compact.currentStrategies).toHaveLength(1);
    expect(compact.summary.sampleCount).toBe(15208);
    expect(compact.topStrategies[0]).toMatchObject({ market: "BTC", outcome: "UP", evRoi: 0.15, tradeCount: 62 });
    // The heavy per-strategy metrics blob is not carried through verbatim.
    expect(JSON.stringify(compact.topStrategies[0])).not.toContain("maxDrawdown");
  });
});

/**
 * El desglose ARB/DIR vive dos veces: la UI web lo calcula sobre trades completos y la TUI / los
 * agentes sobre la forma compacta. La regla de clasificacion es unica (`isCompleteArbPair`), pero el
 * bucle no, asi que esto comprueba que las dos dan lo MISMO. Un desacuerdo aqui significaria que una
 * superficie te dice que el arbitraje gana y la otra que pierde.
 */
describe("splitCompactPnlByKind", () => {
  function tradeConResultado(overrides: Partial<TradeAttempt>): TradeAttempt {
    return {
      id: "x",
      asset: "ETH",
      slug: "eth-1",
      mode: "sim",
      outcome: "UP",
      tokenId: "t",
      amountUsd: 10,
      maxAskPrice: 0.9,
      bestAsk: 0.5,
      estimatedShares: 20,
      filledShares: 20,
      filledAmountUsd: 10,
      openingPrice: 100,
      entryPrice: 101,
      distanceUsd: 1,
      windowStartMs: 1_000,
      endMs: 301_000,
      createdAtMs: 2_000,
      resolved: {
        resolvedAtMs: 301_000,
        finalPrice: 101,
        finalTickTimestampMs: 301_000,
        winningOutcome: "UP",
        won: true,
      },
      ...overrides,
    } as TradeAttempt;
  }

  it("separa el par completo del direccional", () => {
    const trades = [
      tradeConResultado({ id: "arb", kind: "arb", arbPairComplete: true }),
      tradeConResultado({ id: "dir" }),
    ];
    const split = splitCompactPnlByKind(trades.map(summarizeTrade), "sim");
    expect(split.arb.count).toBe(1);
    expect(split.dir.count).toBe(1);
  });

  it("una pata suelta cuenta como DIRECCIONAL: ahi es donde esta el riesgo", () => {
    const naked = summarizeTrade(tradeConResultado({ id: "naked", kind: "arb", arbPairComplete: false }));
    const split = splitCompactPnlByKind([naked], "sim");
    expect(split.arb.count).toBe(0);
    expect(split.dir.count).toBe(1);
  });

  it("respeta el reset de P&L y el modo", () => {
    const trades = [
      summarizeTrade(tradeConResultado({ id: "viejo", createdAtMs: 1_000 })),
      summarizeTrade(tradeConResultado({ id: "nuevo", createdAtMs: 9_000 })),
      summarizeTrade(tradeConResultado({ id: "otroModo", mode: "live", createdAtMs: 9_000 })),
    ];
    const split = splitCompactPnlByKind(trades, "sim", { sim: 5_000 });
    expect(split.dir.count).toBe(1);
  });

  it("coincide con el calculo de la UI web sobre los mismos trades", () => {
    const trades = [
      tradeConResultado({ id: "a", kind: "arb", arbPairComplete: true }),
      tradeConResultado({ id: "b", resolved: undefined }),
      tradeConResultado({ id: "c", kind: "arb", arbPairComplete: false }),
      tradeConResultado({ id: "d" }),
    ];
    const compacto = splitCompactPnlByKind(trades.map(summarizeTrade), "sim");
    const web = splitPnlByKind(trades, "sim");
    expect(compacto.arb.count).toBe(web.arb.count);
    expect(compacto.dir.count).toBe(web.dir.count);
    expect(compacto.arb.netUsd).toBeCloseTo(web.arb.netUsd, 6);
    expect(compacto.dir.netUsd).toBeCloseTo(web.dir.netUsd, 6);
  });
});

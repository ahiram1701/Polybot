import { describe, expect, it } from "vitest";

import {
  buildRecommendations,
  LIVE_AUTO_APPLY_THRESHOLDS,
  passesRobustnessGuard,
  SIM_AUTO_APPLY_THRESHOLDS,
} from "../src/recommendationEngine.js";
import type { AnalyticsSample, MarketSymbol, Outcome } from "../src/types.js";

describe("passesRobustnessGuard (anti-overfit auto-apply)", () => {
  it("allows any validated change when the current config is dead (0 trades)", () => {
    expect(passesRobustnessGuard({ tradeCount: 0, lowerBoundRoi: -1 }, { tradeCount: 5, lowerBoundRoi: 0.1 })).toBe(true);
  });

  it("allows moving to an equally- or better-sampled setup", () => {
    expect(passesRobustnessGuard({ tradeCount: 12, lowerBoundRoi: 0.1 }, { tradeCount: 12, lowerBoundRoi: 0.05 })).toBe(true);
    expect(passesRobustnessGuard({ tradeCount: 12, lowerBoundRoi: 0.1 }, { tradeCount: 20, lowerBoundRoi: 0.02 })).toBe(true);
  });

  it("blocks downgrading to a thinner setup that isn't clearly better out-of-sample", () => {
    // BTC's real case: 28→35 dropped from 12 to 7 trades without a clearly higher lower bound.
    expect(passesRobustnessGuard({ tradeCount: 12, lowerBoundRoi: 0.1 }, { tradeCount: 7, lowerBoundRoi: 0.12 })).toBe(false);
  });

  it("permits a thinner setup only when its lower bound clears the margin", () => {
    expect(passesRobustnessGuard({ tradeCount: 12, lowerBoundRoi: 0.1 }, { tradeCount: 7, lowerBoundRoi: 0.2 })).toBe(true);
  });
});

describe("RecommendationEngine", () => {
  it("chooses a predictive window and distance using walk-forward validation", async () => {
    const samples = Array.from({ length: 45 }, (_value, index) => predictiveSample("BTC", index, "UP", true));
    const response = (await buildRecommendations(samples, settings()));
    const btc = response.recommendations.find((recommendation) => recommendation.market === "BTC");

    expect(btc?.recommended?.entryWindowSeconds).toBeGreaterThanOrEqual(22);
    expect(btc?.recommended?.entryWindowSeconds).toBeLessThanOrEqual(25);
    expect(btc?.recommended?.minDistanceUsd).toBeGreaterThanOrEqual(17);
    expect(btc?.recommended?.minDistanceUsd).toBeLessThanOrEqual(18);
    expect(btc?.confidence).toBe("high");
    expect(btc?.canAutoApply).toBe(true);
    expect(btc?.recommended?.metrics.expectedRoi).toBeGreaterThan(0);
    expect(btc?.recommended?.metrics.walkForwardRoi).toBeGreaterThan(0);
    expect(btc?.recommended?.metrics.overfitRisk).toBeLessThanOrEqual(0.45);
  });

  it("uses one unified threshold set so sim and live decide identically", async () => {
    // Sim must predict live: both modes share ONE threshold set. A change (current 10s -> predictive
    // ~22s optimum) must resolve to the SAME auto-apply decision in both modes, not a stricter one
    // for live — otherwise a sim dry run wouldn't tell you what live will do.
    expect(LIVE_AUTO_APPLY_THRESHOLDS).toEqual(SIM_AUTO_APPLY_THRESHOLDS);
    expect(LIVE_AUTO_APPLY_THRESHOLDS.autoApplyCooldownMs).toBe(0);

    const samples = Array.from({ length: 45 }, (_value, index) => predictiveSample("BTC", index, "UP", true));
    const farSettings = {
      ...settings(),
      entryWindowSeconds: 10,
      entryWindowSecondsByMarket: { BTC: 10, ETH: 10, DOGE: 10 },
    };

    const sim = (await buildRecommendations(samples, farSettings, undefined, undefined, SIM_AUTO_APPLY_THRESHOLDS)).recommendations.find(
      (recommendation) => recommendation.market === "BTC",
    );
    const live = (await buildRecommendations(samples, farSettings, undefined, undefined, LIVE_AUTO_APPLY_THRESHOLDS)).recommendations.find(
      (recommendation) => recommendation.market === "BTC",
    );

    expect(sim?.canAutoApply).toBe(true);
    expect(live?.canAutoApply).toBe(sim?.canAutoApply);
    expect(live?.canApply).toBe(sim?.canApply);
  });

  it("keeps low-sample markets exploratory", async () => {
    const response = (await buildRecommendations(
      Array.from({ length: 9 }, (_value, index) => predictiveSample("ETH", index, "UP", true)),
      settings(),
    ));
    const eth = response.recommendations.find((recommendation) => recommendation.market === "ETH");

    expect(eth?.status).toBe("insufficient_data");
    expect(eth?.confidence).toBe("low");
    expect(eth?.canApply).toBe(false);
    expect(eth?.canAutoApply).toBe(false);
  });

  it("rejects auto-apply when quote coverage is below the configured minimum", async () => {
    const samples = Array.from({ length: 45 }, (_value, index) => predictiveSample("BTC", index, "UP", index < 20));
    // Production ships a relaxed 0.02 coverage gate (thin real liquidity); pass a strict one here to
    // exercise the coverage gate mechanism.
    const strictCoverage = { ...SIM_AUTO_APPLY_THRESHOLDS, minQuoteCoverage: 0.8 };
    const response = (await buildRecommendations(samples, settings(), undefined, undefined, strictCoverage));
    const btc = response.recommendations.find((recommendation) => recommendation.market === "BTC");

    expect((btc?.recommended ?? btc?.current)?.metrics.quoteCoverage).toBeLessThan(0.8);
    expect(btc?.canAutoApply).toBe(false);
  });

  it("blocks auto-apply while a configured recommendation cooldown is active", async () => {
    // Production ships with a 0 cooldown (see unified-thresholds test), but the cooldown mechanism
    // itself must still gate when a non-zero cooldown is configured.
    const nowMs = Date.UTC(2026, 4, 8, 18);
    const withCooldown = { ...SIM_AUTO_APPLY_THRESHOLDS, autoApplyCooldownMs: 30 * 60_000 };
    const response = (await buildRecommendations(
      Array.from({ length: 45 }, (_value, index) => predictiveSample("BTC", index, "UP", true)),
      { ...settings(), aiLastAppliedAtMs: nowMs - 10 * 60_000 },
      nowMs,
      undefined,
      withCooldown,
    ));
    const btc = response.recommendations.find((recommendation) => recommendation.market === "BTC");

    expect(btc?.canApply).toBe(true);
    expect(btc?.canAutoApply).toBe(false);
    expect(btc?.reason).toContain("cooldown");
  });

  it("has no time cooldown in production: re-applies the best config right after a previous apply", async () => {
    const nowMs = Date.UTC(2026, 4, 8, 18);
    // Just applied 1 minute ago. With the unified (cooldown 0) thresholds, neither mode is time-locked
    // — the minYieldImprovement margin is the only anti-thrash guard.
    const btc = (await buildRecommendations(
      Array.from({ length: 45 }, (_value, index) => predictiveSample("BTC", index, "UP", true)),
      { ...settings(), entryWindowSecondsByMarket: { BTC: 10, ETH: 10, DOGE: 10 }, aiLastAppliedAtMs: nowMs - 60_000 },
      nowMs,
      undefined,
      LIVE_AUTO_APPLY_THRESHOLDS,
    )).recommendations.find((recommendation) => recommendation.market === "BTC");

    expect(btc?.canAutoApply).toBe(true);
    expect(btc?.reason).not.toContain("cooldown");
  });

  it("escape valve: a DEAD config (0 trades) may auto-apply a jump beyond the max-change guard", async () => {
    const samples = Array.from({ length: 45 }, (_value, index) => predictiveSample("BTC", index, "UP", true));
    // Current distance is absurdly high: zero signals ever fire, so the config is dead. The good
    // config (~17-18 distance) is a ~29x distance change — far beyond maxDistanceChangeRatio (10).
    const deadSettings = {
      ...settings(),
      minDistanceUsdByMarket: { BTC: 500, ETH: 5, DOGE: 0.0005 },
    };
    const btc = (await buildRecommendations(samples, deadSettings)).recommendations.find(
      (recommendation) => recommendation.market === "BTC",
    );

    expect(btc?.current.metrics.tradeCount).toBe(0);
    expect(btc?.recommended?.minDistanceUsd).toBeLessThan(30);
    // Nothing to protect: the validated jump is allowed even though it exceeds the change guard.
    expect(btc?.canAutoApply).toBe(true);
  });

  it("does not trust an in-sample pattern that fails later out of sample", async () => {
    const samples = Array.from({ length: 45 }, (_value, index) =>
      overfitSample("BTC", index, index < 20 ? "UP" : "DOWN"),
    );
    const response = (await buildRecommendations(samples, settings()));
    const btc = response.recommendations.find((recommendation) => recommendation.market === "BTC");

    expect(btc?.canAutoApply).toBe(false);
    expect(btc?.confidence).not.toBe("high");
  });

  it("never recommends an entry window below the 25s floor", async () => {
    // Signals that would ideally fire in a 10s window: the floor must push the pick to >= 25s.
    const samples = Array.from({ length: 45 }, (_value, index) => lateSignalSample("BTC", index));
    const response = (await buildRecommendations(samples, settings()));
    const btc = response.recommendations.find((recommendation) => recommendation.market === "BTC");

    expect((btc?.recommended ?? btc?.current)?.entryWindowSeconds).toBeGreaterThanOrEqual(25);
    expect(btc?.recommended?.entryWindowSeconds ?? 60).toBeLessThanOrEqual(60);
  });

  it("prefers a frequent moderate-edge config over a rare high-edge one (yield objective)", async () => {
    // Two disjoint setups on BTC:
    //  - a FREQUENT one at ~$18 distance (fires most windows) with a solid but not huge edge,
    //  - a RARE one at ~$60 distance (fires seldom) with a near-certain edge.
    // Per-trade ROI favours the rare one; realized yield-per-window favours the frequent one, which
    // is what the redesigned objective must pick.
    const samples = Array.from({ length: 80 }, (_value, index) => frequencySample("BTC", index));
    // Current config sits on the RARE $60 setup; a greedy per-trade objective would keep it there.
    const rareCurrent = { ...settings(), minDistanceUsdByMarket: { ...settings().minDistanceUsdByMarket, BTC: 60 } };
    const response = (await buildRecommendations(samples, rareCurrent));
    const btc = response.recommendations.find((recommendation) => recommendation.market === "BTC");

    const chosen = btc?.recommended ?? btc?.current;
    expect(chosen?.minDistanceUsd).toBeLessThan(40);
    expect((chosen?.metrics.yieldPerWindow ?? 0)).toBeGreaterThan(0);
  });

  it("does not auto-apply in sim on too few executable trades", async () => {
    // 14 windows produce an executable trade — below SIM minAutoTrades (15).
    const samples = Array.from({ length: 45 }, (_value, index) =>
      predictiveSample("BTC", index, "UP", index < 14),
    );
    const btc = (await buildRecommendations(samples, settings(), undefined, undefined, SIM_AUTO_APPLY_THRESHOLDS)).recommendations.find(
      (recommendation) => recommendation.market === "BTC",
    );

    expect((btc?.recommended ?? btc?.current)?.metrics.tradeCount).toBeLessThan(15);
    expect(btc?.canAutoApply).toBe(false);
  });

  it("never recommends a distance below the per-market floor", async () => {
    // Regression for the phantom auto-apply: the applier clamps recommended distances up to the
    // floor, so the engine must not propose anything below it (or it would "apply" a no-op forever).
    const samples = Array.from({ length: 45 }, (_value, index) => predictiveSample("BTC", index, "UP", true));

    // Unfloored: the engine is free to pick the data optimum (near the ~$18-20 signal band).
    const unfloored = (await buildRecommendations(samples, settings())).recommendations.find(
      (recommendation) => recommendation.market === "BTC",
    );
    const unflooredPick = unfloored?.recommended?.minDistanceUsd ?? unfloored?.current?.minDistanceUsd ?? 0;

    // Set the floor above that pick: whatever it now proposes must sit at or above the floor.
    const floor = unflooredPick + 2;
    const floored = (await buildRecommendations(samples, {
      ...settings(),
      minDistanceFloorUsdByMarket: { BTC: floor },
    })).recommendations.find((recommendation) => recommendation.market === "BTC");

    if (floored?.recommended) {
      expect(floored.recommended.minDistanceUsd).toBeGreaterThanOrEqual(floor);
    }
    // It must not resurface the old sub-floor optimum as an applicable change.
    expect(floored?.recommended?.minDistanceUsd ?? floor).toBeGreaterThanOrEqual(floor);
  });
});

function settings() {
  return {
    minDistanceUsdByMarket: { BTC: 20, ETH: 5, DOGE: 0.0005 },
    entryWindowSeconds: 20,
    entryWindowSecondsByMarket: { BTC: 20, ETH: 20, DOGE: 20 },
    maxAskPrice: 0.99,
  };
}

function predictiveSample(
  market: MarketSymbol,
  index: number,
  winningOutcome: Outcome,
  includeQuotes: boolean,
): AnalyticsSample {
  const windowStartMs = Date.UTC(2026, 4, 8, 12, index * 5, 0);
  const endMs = windowStartMs + 300_000;
  const earlyLosingMs = endMs - 24_000;
  const predictiveMs = endMs - 22_000;
  const currentMs = endMs - 18_000;
  const winsUp = winningOutcome === "UP";
  return {
    version: 1,
    market,
    slug: `${market.toLowerCase()}-updown-5m-${Math.floor(windowStartMs / 1000)}`,
    windowStartMs,
    endMs,
    openingPrice: 100,
    openingTickTimestampMs: windowStartMs,
    ticks: [
      { timestampMs: earlyLosingMs, secondsToEnd: 24, price: winsUp ? 84 : 116, distanceUsd: winsUp ? -16 : 16 },
      { timestampMs: predictiveMs, secondsToEnd: 22, price: winsUp ? 118 : 82, distanceUsd: winsUp ? 18 : -18 },
      { timestampMs: currentMs, secondsToEnd: 18, price: winsUp ? 80 : 120, distanceUsd: winsUp ? -20 : 20 },
    ],
    quotes: includeQuotes
      ? [
          quote(earlyLosingMs, 24),
          quote(predictiveMs, 22),
          quote(currentMs, 18),
        ]
      : [],
    finalPrice: winsUp ? 120 : 80,
    finalTickTimestampMs: endMs,
    winningOutcome,
    resolvedAtMs: endMs,
  };
}

function quote(timestampMs: number, secondsToEnd: number) {
  return {
    timestampMs,
    secondsToEnd,
    upBestAsk: 0.5,
    upBestBid: 0.48,
    downBestAsk: 0.5,
    downBestBid: 0.48,
  };
}

function lateSignalSample(market: MarketSymbol, index: number): AnalyticsSample {
  const windowStartMs = Date.UTC(2026, 4, 8, 12, index * 5, 0);
  const endMs = windowStartMs + 300_000;
  const signalMs = endMs - 8_000; // secondsToEnd 8 — only a very short window would target this
  return {
    version: 1,
    market,
    slug: `${market.toLowerCase()}-updown-5m-${Math.floor(windowStartMs / 1000)}`,
    windowStartMs,
    endMs,
    openingPrice: 100,
    openingTickTimestampMs: windowStartMs,
    ticks: [{ timestampMs: signalMs, secondsToEnd: 8, price: 118, distanceUsd: 18 }],
    quotes: [quote(signalMs, 8)],
    finalPrice: 120,
    finalTickTimestampMs: endMs,
    winningOutcome: "UP",
    resolvedAtMs: endMs,
  };
}

function frequencySample(market: MarketSymbol, index: number): AnalyticsSample {
  const windowStartMs = Date.UTC(2026, 4, 8, 12, index * 5, 0);
  const endMs = windowStartMs + 300_000;
  const midMs = endMs - 20_000; // secondsToEnd 20 -> distance +18 (the FREQUENT setup, fires every window)
  const lateMs = endMs - 15_000; // secondsToEnd 15 -> distance +60 (the RARE setup, 1 in 5 windows)
  const hasRare = index % 5 === 0;
  const winsUp = hasRare || index % 5 !== 1; // rare windows always win; ~80% overall for the $18 setup
  const ticks = [{ timestampMs: midMs, secondsToEnd: 20, price: 118, distanceUsd: 18 }];
  const quotes = [quote(midMs, 20)];
  if (hasRare) {
    ticks.push({ timestampMs: lateMs, secondsToEnd: 15, price: 160, distanceUsd: 60 });
    quotes.push(quote(lateMs, 15));
  }
  return {
    version: 1,
    market,
    slug: `${market.toLowerCase()}-updown-5m-${Math.floor(windowStartMs / 1000)}`,
    windowStartMs,
    endMs,
    openingPrice: 100,
    openingTickTimestampMs: windowStartMs,
    ticks,
    quotes,
    finalPrice: winsUp ? 160 : 80,
    finalTickTimestampMs: endMs,
    winningOutcome: winsUp ? "UP" : "DOWN",
    resolvedAtMs: endMs,
  };
}

function overfitSample(market: MarketSymbol, index: number, winningOutcome: Outcome): AnalyticsSample {
  const sample = predictiveSample(market, index, "UP", true);
  return {
    ...sample,
    finalPrice: winningOutcome === "UP" ? 120 : 80,
    winningOutcome,
  };
}

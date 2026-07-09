import { describe, expect, it } from "vitest";

import { estimateWinProbabilityBySimilarity, type SimilarityObservation } from "../src/similarityGate.js";

describe("estimateWinProbabilityBySimilarity", () => {
  it("returns the neutral prior with no history", () => {
    const estimate = estimateWinProbabilityBySimilarity([], { secondsToEnd: 40, favorableDistanceUsd: 20, ask: 0.7 });
    expect(estimate.winProbability).toBeCloseTo(0.5);
    expect(estimate.effectiveSampleSize).toBe(0);
    expect(estimate.neighborCount).toBe(0);
  });

  it("weights nearby setups: high win rate near the query lifts the probability", () => {
    const pool: SimilarityObservation[] = [
      // Near the query (secondsToEnd ~40, distance ~20, ask ~0.7): mostly winners.
      ...Array.from({ length: 15 }, () => ({ secondsToEnd: 40, favorableDistanceUsd: 20, ask: 0.7, won: true })),
      { secondsToEnd: 41, favorableDistanceUsd: 19, ask: 0.71, won: false },
      // Far away (tiny distance, late, cheap): losers — should barely count.
      ...Array.from({ length: 15 }, () => ({ secondsToEnd: 5, favorableDistanceUsd: 1, ask: 0.4, won: false })),
    ];
    const estimate = estimateWinProbabilityBySimilarity(pool, { secondsToEnd: 40, favorableDistanceUsd: 20, ask: 0.7 });
    expect(estimate.winProbability).toBeGreaterThan(0.7);
    expect(estimate.effectiveSampleSize).toBeGreaterThan(1);
  });

  it("stays conservative when nearby setups lose", () => {
    const pool: SimilarityObservation[] = Array.from({ length: 20 }, () => ({
      secondsToEnd: 40,
      favorableDistanceUsd: 20,
      ask: 0.7,
      won: false,
    }));
    const estimate = estimateWinProbabilityBySimilarity(pool, { secondsToEnd: 40, favorableDistanceUsd: 20, ask: 0.7 });
    expect(estimate.winProbability).toBeLessThan(0.3);
  });
});

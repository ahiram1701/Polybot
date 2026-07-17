import { describe, expect, it } from "vitest";

import { knnEstimate, knnFeatureDistance, type KnnObservation } from "../src/knnCore.js";

const DAY_MS = 86_400_000;

function obs(over: Partial<KnnObservation> & { won: boolean }): KnnObservation {
  return { secondsToEnd: 30, absDistanceUsd: 2, ask: 0.5, ...over };
}

describe("knnCore", () => {
  it("skips optional features missing on either side (old samples stay comparable)", () => {
    const base = { secondsToEnd: 30, absDistanceUsd: 2, ask: 0.5 };
    const withExtras = { ...base, velocityUsdPerSecond: 1, spread: 0.05, quoteSkew: 0.1 };
    // Identical core features: distance must be 0 whether extras are missing on one side...
    expect(knnFeatureDistance(base, withExtras)).toBe(0);
    // ...and count when present on both.
    expect(knnFeatureDistance(withExtras, { ...withExtras, spread: 0.8 })).toBeCloseTo(0.75 / 0.75);
  });

  it("penalizes a different outcome only when both declare one", () => {
    const up = { secondsToEnd: 30, absDistanceUsd: 2, ask: 0.5, outcome: "UP" as const };
    const down = { ...up, outcome: "DOWN" as const };
    expect(knnFeatureDistance(up, down)).toBeCloseTo(0.2);
    expect(knnFeatureDistance(up, { ...down, outcome: undefined })).toBe(0);
  });

  it("estimates from nearest neighbours with a configurable prior", () => {
    const pool = [
      ...Array.from({ length: 10 }, (_v, i) => obs({ won: true, atMs: i })),
      ...Array.from({ length: 10 }, (_v, i) => obs({ won: false, ask: 0.9, secondsToEnd: 5, absDistanceUsd: 40, atMs: i })),
    ];
    const near = knnEstimate(pool, { secondsToEnd: 30, absDistanceUsd: 2, ask: 0.5 }, { kMin: 5, kMax: 10 });
    expect(near.winProbability).toBeGreaterThan(0.7); // matches the winning cluster
    expect(near.neighborCount).toBe(9); // round(sqrt(20)*2)
    expect(near.effectiveSampleSize).toBeGreaterThan(5);

    // Market-anchored prior pulls an empty pool to the ask.
    const empty = knnEstimate([], { secondsToEnd: 30, absDistanceUsd: 2, ask: 0.3 }, { priorProbability: 0.3 });
    expect(empty.winProbability).toBeCloseTo(0.3);
  });

  it("downweights old observations with recency half-life", () => {
    const nowMs = 100 * DAY_MS;
    // 5 ancient wins vs 5 fresh losses, all equally similar.
    const pool = [
      ...Array.from({ length: 5 }, () => obs({ won: true, atMs: nowMs - 50 * DAY_MS })),
      ...Array.from({ length: 5 }, () => obs({ won: false, atMs: nowMs - 1 * DAY_MS })),
    ];
    const query = { secondsToEnd: 30, absDistanceUsd: 2, ask: 0.5 };
    // Force k to cover the whole pool so the win/loss split is exactly 5/5.
    const flat = knnEstimate(pool, query, { nowMs, kMin: 10, kMax: 10 });
    const decayed = knnEstimate(pool, query, { nowMs, recencyHalfLifeDays: 3, kMin: 10, kMax: 10 });
    expect(flat.winProbability).toBeCloseTo(0.5, 1); // even split without decay
    expect(decayed.winProbability).toBeLessThan(0.25); // fresh losses dominate
    expect(decayed.effectiveSampleSize).toBeLessThan(flat.effectiveSampleSize);
  });
});

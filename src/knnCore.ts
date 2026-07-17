import type { Outcome } from "./types.js";

/**
 * Shared k-NN core for every win-probability estimator (live gate, strategy analysis, recommendation
 * engine). One feature space, one weighting scheme, one prior — so an improvement validated in the
 * backtest applies everywhere at once.
 *
 * Features (each term ~[0,1] for typical inputs; missing optional features are skipped on either side
 * so old samples without quotes/velocity still compare fairly):
 *  - secondsToEnd/55, |distance| on a relative scale (scale-free across BTC/ETH/DOGE),
 *  - velocity (relative), ask/0.75, spread/0.75, quoteSkew/0.75, and a 0.2 penalty for a different side.
 */

export interface KnnPoint {
  secondsToEnd: number;
  /** Magnitude of the favourable move at entry (absolute USD). */
  absDistanceUsd: number;
  /** Ask paid/payable for the chosen outcome. */
  ask: number;
  velocityUsdPerSecond?: number;
  spread?: number;
  quoteSkew?: number;
  outcome?: Outcome;
  /** Timestamp of the observation (enables recency weighting). */
  atMs?: number;
}

export interface KnnObservation extends KnnPoint {
  won: boolean;
}

export interface KnnOptions {
  /** Neighbor count bounds; k = clamp(round(√n·2), min, max). */
  kMin?: number;
  kMax?: number;
  /** Pseudo-count of the prior (default 2). */
  priorWeight?: number;
  /** Prior probability (default 0.5; pass the ask for a market-anchored prior). */
  priorProbability?: number;
  /** Half-life in days for recency decay of neighbor weights; undefined = no decay. */
  recencyHalfLifeDays?: number;
  /** Reference "now" for recency (defaults to Date.now()). */
  nowMs?: number;
}

export interface KnnEstimate {
  winProbability: number;
  /** Effective sample size of the weighted neighbours: (Σw)²/Σw² (decay-aware when recency is on). */
  effectiveSampleSize: number;
  neighborCount: number;
}

const DAY_MS = 86_400_000;

export function knnFeatureDistance(left: KnnPoint, right: KnnPoint): number {
  const distanceScale = Math.max(left.absDistanceUsd, right.absDistanceUsd, 1e-9);
  let total =
    Math.abs(left.secondsToEnd - right.secondsToEnd) / 55 +
    Math.abs(left.absDistanceUsd - right.absDistanceUsd) / distanceScale +
    Math.abs(left.ask - right.ask) / 0.75;

  if (left.velocityUsdPerSecond !== undefined && right.velocityUsdPerSecond !== undefined) {
    const velocityScale = Math.max(Math.abs(left.velocityUsdPerSecond), Math.abs(right.velocityUsdPerSecond), 0.1);
    total += Math.abs(left.velocityUsdPerSecond - right.velocityUsdPerSecond) / velocityScale;
  }
  if (left.spread !== undefined && right.spread !== undefined) {
    total += Math.abs(left.spread - right.spread) / 0.75;
  }
  if (left.quoteSkew !== undefined && right.quoteSkew !== undefined) {
    total += Math.abs(left.quoteSkew - right.quoteSkew) / 0.75;
  }
  if (left.outcome !== undefined && right.outcome !== undefined && left.outcome !== right.outcome) {
    total += 0.2;
  }
  return total;
}

export function knnEstimate(pool: KnnObservation[], query: KnnPoint, options: KnnOptions = {}): KnnEstimate {
  const priorWeight = options.priorWeight ?? 2;
  const priorProbability = clamp(options.priorProbability ?? 0.5, 0.05, 0.95);
  if (pool.length === 0) {
    return { winProbability: priorProbability, effectiveSampleSize: 0, neighborCount: 0 };
  }
  const kMin = options.kMin ?? 8;
  const kMax = options.kMax ?? 60;
  const k = Math.min(kMax, Math.max(kMin, Math.round(Math.sqrt(pool.length) * 2)));
  const nowMs = options.nowMs ?? Date.now();
  const halfLife = options.recencyHalfLifeDays;

  const neighbors = pool
    .map((observation) => ({ observation, distance: knnFeatureDistance(query, observation) }))
    .sort((left, right) => left.distance - right.distance)
    .slice(0, k);

  let weightSum = 0;
  let weightSquareSum = 0;
  let weightedWins = 0;
  for (const neighbor of neighbors) {
    let weight = 1 / (0.25 + neighbor.distance);
    if (halfLife !== undefined && halfLife > 0 && neighbor.observation.atMs !== undefined) {
      const ageDays = Math.max(0, (nowMs - neighbor.observation.atMs) / DAY_MS);
      weight *= Math.pow(0.5, ageDays / halfLife);
    }
    weightSum += weight;
    weightSquareSum += weight * weight;
    weightedWins += neighbor.observation.won ? weight : 0;
  }
  const winProbability = (weightedWins + priorWeight * priorProbability) / (weightSum + priorWeight);
  return {
    winProbability: clamp(winProbability, 0.05, 0.95),
    effectiveSampleSize: weightSquareSum > 0 ? (weightSum * weightSum) / weightSquareSum : 0,
    neighborCount: neighbors.length,
  };
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(Math.max(value, lo), hi);
}

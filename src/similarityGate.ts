import { knnEstimate, type KnnObservation, type KnnOptions, type KnnPoint } from "./knnCore.js";

/**
 * Similarity ("k-NN") win-probability estimator for the LIVE entry gate.
 *
 * Instead of requiring N trades at the EXACT (window, distance) config, this compares the current live
 * setup against ALL historical setups and estimates the win probability from the nearest ones — so a
 * setup with real edge but few exact analogues can still be recognised. Delegates to the shared
 * knnCore (same feature space and weighting as the recommendation engine): time, |distance| (relative,
 * scale-free across markets), ask, and — when available — velocity, spread and quote skew, with
 * optional recency decay and a configurable prior.
 */

export interface SimilarityObservation {
  // Seconds to window end at the entry moment.
  secondsToEnd: number;
  // Price move toward the chosen outcome at the entry moment (signed; positive = favourable).
  favorableDistanceUsd: number;
  // Ask paid for the chosen outcome.
  ask: number;
  // Did the chosen outcome win?
  won: boolean;
  // Rich optional features (old samples without quotes simply omit them).
  velocityUsdPerSecond?: number;
  spread?: number;
  quoteSkew?: number;
  // Observation timestamp — enables recency weighting.
  atMs?: number;
}

export type SimilarityQuery = Omit<SimilarityObservation, "won">;

export interface SimilarityEstimate {
  winProbability: number;
  // Effective sample size of the weighted neighbours: (Σw)² / Σw² (decay-aware when recency is on).
  effectiveSampleSize: number;
  neighborCount: number;
}

export type SimilarityOptions = Pick<KnnOptions, "priorProbability" | "recencyHalfLifeDays" | "nowMs">;

/**
 * Gate defaults. Deliberately conservative until the walk-forward backtest validates richer settings:
 * prior 0.5 (the EV gate re-anchors to the ask separately) and no recency decay.
 */
export const DEFAULT_SIMILARITY_OPTIONS: SimilarityOptions = {};

function toKnnPoint(value: SimilarityQuery): KnnPoint {
  return {
    secondsToEnd: value.secondsToEnd,
    absDistanceUsd: Math.abs(value.favorableDistanceUsd),
    ask: value.ask,
    velocityUsdPerSecond: value.velocityUsdPerSecond,
    spread: value.spread,
    quoteSkew: value.quoteSkew,
    atMs: value.atMs,
  };
}

export function estimateWinProbabilityBySimilarity(
  pool: SimilarityObservation[],
  query: SimilarityQuery,
  options: SimilarityOptions = DEFAULT_SIMILARITY_OPTIONS,
): SimilarityEstimate {
  const observations: KnnObservation[] = pool.map((observation) => ({
    ...toKnnPoint(observation),
    won: observation.won,
  }));
  return knnEstimate(observations, toKnnPoint(query), {
    kMin: 8,
    kMax: 60,
    priorWeight: 2,
    priorProbability: options.priorProbability ?? 0.5,
    recencyHalfLifeDays: options.recencyHalfLifeDays,
    nowMs: options.nowMs,
  });
}

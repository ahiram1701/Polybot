/**
 * Similarity ("k-NN") win-probability estimator for the LIVE entry gate.
 *
 * Instead of requiring N trades at the EXACT (window, distance) config, this compares the current live
 * setup against ALL historical setups and estimates the win probability from the nearest ones — so a
 * setup with real edge but few exact analogues can still be recognised. Feature space is scale-free
 * (relative distance) so it works across BTC/ETH/DOGE.
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
}

export type SimilarityQuery = Omit<SimilarityObservation, "won">;

export interface SimilarityEstimate {
  winProbability: number;
  // Recency-agnostic effective sample size of the weighted neighbours: (Σw)² / Σw².
  effectiveSampleSize: number;
  neighborCount: number;
}

// Prior pseudo-count toward 0.5 keeps a thin match from being over-confident (the EV gate re-anchors
// the prior to the market ask separately).
const PRIOR_WEIGHT = 2;
const PRIOR_PROBABILITY = 0.5;

function featureDistance(query: SimilarityQuery, observation: SimilarityObservation): number {
  const distanceScale = Math.max(Math.abs(query.favorableDistanceUsd), Math.abs(observation.favorableDistanceUsd), 1e-9);
  return (
    Math.abs(query.secondsToEnd - observation.secondsToEnd) / 55 +
    Math.abs(query.favorableDistanceUsd - observation.favorableDistanceUsd) / distanceScale +
    Math.abs(query.ask - observation.ask) / 0.75
  );
}

export function estimateWinProbabilityBySimilarity(
  pool: SimilarityObservation[],
  query: SimilarityQuery,
): SimilarityEstimate {
  if (pool.length === 0) {
    return { winProbability: PRIOR_PROBABILITY, effectiveSampleSize: 0, neighborCount: 0 };
  }
  const k = Math.min(60, Math.max(8, Math.round(Math.sqrt(pool.length) * 2)));
  const neighbors = pool
    .map((observation) => ({ observation, distance: featureDistance(query, observation) }))
    .sort((left, right) => left.distance - right.distance)
    .slice(0, k);

  let weightSum = 0;
  let weightSquareSum = 0;
  let weightedWins = 0;
  for (const neighbor of neighbors) {
    const weight = 1 / (0.25 + neighbor.distance);
    weightSum += weight;
    weightSquareSum += weight * weight;
    weightedWins += neighbor.observation.won ? weight : 0;
  }
  const winProbability = (weightedWins + PRIOR_WEIGHT * PRIOR_PROBABILITY) / (weightSum + PRIOR_WEIGHT);
  const effectiveSampleSize = weightSquareSum > 0 ? (weightSum * weightSum) / weightSquareSum : 0;
  return {
    winProbability: Math.min(Math.max(winProbability, 0.05), 0.95),
    effectiveSampleSize,
    neighborCount: neighbors.length,
  };
}

import { join } from "node:path";

import { readAnalyticsSamples } from "./analyticsRecorder.js";
import { getMinDistanceUsd, SUPPORTED_MARKETS } from "./markets.js";
import type {
  AiRecommendation,
  AiRecommendationsResponse,
  AnalyticsQuotePoint,
  AnalyticsSample,
  AnalyticsTickPoint,
  MarketDistanceSettings,
  MarketEntryWindowSettings,
  MarketSymbol,
  Mode,
  Outcome,
  RecommendationCandidate,
  RecommendationMetrics,
} from "./types.js";

const MIN_READY_SAMPLES = 10;
const MIN_AUTO_TRADES = 20;

export interface AutoApplyThresholds {
  minAutoSamples: number;
  minAutoTrades: number;
  minQuoteCoverage: number;
  // Minimum improvement in realized yield-per-window (edge × execution rate) required to auto-apply.
  minYieldImprovement: number;
  maxOverfitRisk: number;
  // How far a single auto-apply may move from the current settings. In live this is a tight rail
  // (only fine-tune in small steps); in sim it is loose enough to converge to the optimum.
  maxWindowChangeSeconds: number;
  maxDistanceChangeRatio: number;
}

// Live moves real money: keep strict gates (many executable trades + high quote coverage required)
// and only allow small fine-tuning steps per apply.
export const LIVE_AUTO_APPLY_THRESHOLDS: AutoApplyThresholds = {
  minAutoSamples: 40,
  minAutoTrades: 20,
  minQuoteCoverage: 0.8,
  minYieldImprovement: 0.002,
  maxOverfitRisk: 0.45,
  maxWindowChangeSeconds: 5,
  maxDistanceChangeRatio: 0.15,
};

// Sim is paper money: relax the volume/coverage gates to match the thin real liquidity of these
// 5-minute markets (~1-3% of windows executable), so the autoajuste can actually act, and allow
// it to converge to the recommended optimum. The quality gates (out-of-sample ROI > 0, overfit
// <= max, ROI improvement) still guard against bad strategies.
export const SIM_AUTO_APPLY_THRESHOLDS: AutoApplyThresholds = {
  minAutoSamples: 40,
  minAutoTrades: 15,
  minQuoteCoverage: 0.02,
  minYieldImprovement: 0.0008,
  maxOverfitRisk: 0.45,
  maxWindowChangeSeconds: 60,
  maxDistanceChangeRatio: 10,
};

export function autoApplyThresholdsForMode(mode: Mode): AutoApplyThresholds {
  return mode === "live" ? LIVE_AUTO_APPLY_THRESHOLDS : SIM_AUTO_APPLY_THRESHOLDS;
}
const AUTO_APPLY_COOLDOWN_MS = 30 * 60_000;
const QUOTE_MATCH_WINDOW_MS = 6_000;
const WALK_FORWARD_MIN_TRAINING_TRADES = 5;
// k-NN walk-forward only considers the most recent observations as neighbours. This keeps the
// per-candidate cost linear (O(obs * window)) instead of O(obs^2), so we can feed in much more
// history (for trade-count significance) without the grid search blowing up the event loop.
// Recent neighbours are also more relevant to the current regime.
const WALK_FORWARD_TRAINING_WINDOW = 300;
// Per-market history fed into the grid search. With the bounded k-NN above the cost scales
// ~linearly, so we keep enough executable trades to reach statistical significance.
const MAX_RECOMMENDATION_SAMPLES_PER_MARKET = 300;
// Entry-window candidates floored at 25s: below ~25s the quote coverage collapses to <=3% (measured
// on real samples), so those configs almost never execute. Flooring here stops the autoajuste from
// converging on degenerate 5-7s windows that barely trade.
const MIN_CANDIDATE_WINDOW_SECONDS = 25;
const CANDIDATE_WINDOWS = Array.from({ length: 61 - MIN_CANDIDATE_WINDOW_SECONDS }, (_value, index) => MIN_CANDIDATE_WINDOW_SECONDS + index);
const DISTANCE_STEPS: Record<MarketSymbol, number> = {
  BTC: 1,
  ETH: 0.25,
  DOGE: 0.00005,
};

export interface RecommendationSettings {
  minDistanceUsdByMarket: MarketDistanceSettings;
  entryWindowSecondsByMarket: MarketEntryWindowSettings;
  entryWindowSeconds: number;
  maxAskPrice: number;
  aiLastAppliedAtMs?: number;
}

interface CandidateObservation {
  sample: AnalyticsSample;
  timestampMs: number;
  outcome: Outcome;
  secondsToEnd: number;
  distanceUsd: number;
  absDistanceUsd: number;
  velocityUsdPerSecond: number;
  ask: number;
  bestBid?: number;
  spread?: number;
  quoteSkew?: number;
  won: boolean;
  returnRoi: number;
}

interface CandidateSimulation {
  signalCount: number;
  observations: CandidateObservation[];
}

interface WalkForwardPrediction {
  predictedWinProbability: number;
  predictedReturnRoi: number;
  actualReturnRoi: number;
  won: boolean;
}

export class RecommendationEngine {
  constructor(private readonly dataDir: string) {}

  async recommend(
    settings: RecommendationSettings,
    nowMs = Date.now(),
    thresholds: AutoApplyThresholds = LIVE_AUTO_APPLY_THRESHOLDS,
  ): Promise<AiRecommendationsResponse> {
    const samples = await readAnalyticsSamples(join(this.dataDir, "analytics.jsonl"));
    return buildRecommendations(samples, settings, nowMs, MAX_RECOMMENDATION_SAMPLES_PER_MARKET, thresholds);
  }
}

export function buildRecommendations(
  samples: AnalyticsSample[],
  settings: RecommendationSettings,
  nowMs = Date.now(),
  maxSamplesPerMarket = MAX_RECOMMENDATION_SAMPLES_PER_MARKET,
  thresholds: AutoApplyThresholds = LIVE_AUTO_APPLY_THRESHOLDS,
): AiRecommendationsResponse {
  return {
    generatedAtMs: nowMs,
    recommendations: SUPPORTED_MARKETS.map((market) =>
      buildMarketRecommendation(market, recentMarketSamples(samples, market, maxSamplesPerMarket), settings, nowMs, thresholds),
    ),
  };
}

function recentMarketSamples(samples: AnalyticsSample[], market: MarketSymbol, limit: number): AnalyticsSample[] {
  const marketSamples = samples.filter((sample) => sample.market === market);
  if (marketSamples.length <= limit) {
    return marketSamples;
  }
  return marketSamples
    .slice()
    .sort((left, right) => left.windowStartMs - right.windowStartMs)
    .slice(-limit);
}

function buildMarketRecommendation(
  market: MarketSymbol,
  samples: AnalyticsSample[],
  settings: RecommendationSettings,
  nowMs: number,
  thresholds: AutoApplyThresholds,
): AiRecommendation {
  const currentWindow = settings.entryWindowSecondsByMarket[market] ?? settings.entryWindowSeconds;
  const currentDistance = getMinDistanceUsd(settings.minDistanceUsdByMarket, market);
  const current = buildCandidate(market, samples, currentWindow, currentDistance, settings.maxAskPrice);
  const candidates = buildCandidateGrid(market, samples, currentDistance)
    .map((candidate) =>
      buildCandidate(market, samples, candidate.entryWindowSeconds, candidate.minDistanceUsd, settings.maxAskPrice),
    )
    .filter((candidate) => candidate.metrics.adjustedRoi !== undefined);
  const best = selectBestCandidate(candidates, current) ?? current;
  const improvementAdjustedRoi =
    best.metrics.adjustedRoi !== undefined && current.metrics.adjustedRoi !== undefined
      ? best.metrics.adjustedRoi - current.metrics.adjustedRoi
      : best.metrics.adjustedRoi;
  // Auto-apply is driven by the gain in realized yield-per-window (edge × frequency), not per-trade ROI.
  const improvementYield =
    best.metrics.yieldPerWindow !== undefined && current.metrics.yieldPerWindow !== undefined
      ? best.metrics.yieldPerWindow - current.metrics.yieldPerWindow
      : best.metrics.yieldPerWindow;
  const status = samples.length >= MIN_READY_SAMPLES ? "ready" : "insufficient_data";
  const confidence = getConfidence(samples.length, best.metrics, improvementYield, thresholds);
  const changed =
    best.entryWindowSeconds !== current.entryWindowSeconds ||
    best.minDistanceUsd !== current.minDistanceUsd;
  const canApply =
    status === "ready" &&
    changed &&
    best.metrics.tradeCount > 0 &&
    improvementYield !== undefined &&
    improvementYield > 0;
  const cooldownActive = isAutoApplyCooldownActive(settings.aiLastAppliedAtMs, nowMs);
  const canAutoApply =
    canApply &&
    !cooldownActive &&
    confidence === "high" &&
    best.metrics.tradeCount >= thresholds.minAutoTrades &&
    best.metrics.quoteCoverage >= thresholds.minQuoteCoverage &&
    // Gate on the honest out-of-sample lower bound, not the k-NN's self-predicted expectedRoi (which
    // is often miscalibrated — it can be negative while realized OOS returns are strongly positive).
    best.metrics.lowerBoundRoi !== undefined &&
    best.metrics.lowerBoundRoi > 0 &&
    best.metrics.walkForwardRoi !== undefined &&
    best.metrics.walkForwardRoi > 0 &&
    improvementYield !== undefined &&
    improvementYield >= thresholds.minYieldImprovement &&
    isWithinAutoApplyChange(current, best, thresholds);

  return {
    market,
    status,
    confidence,
    generatedAtMs: nowMs,
    current,
    recommended: canApply ? best : undefined,
    improvementAdjustedRoi,
    improvementYield,
    sampleCount: samples.length,
    reason: recommendationReason({
      status,
      confidence,
      sampleCount: samples.length,
      metrics: best.metrics,
      improvementYield,
      canAutoApply,
      cooldownActive,
    }),
    canApply,
    canAutoApply,
  };
}

function buildCandidateGrid(
  market: MarketSymbol,
  samples: AnalyticsSample[],
  currentDistance: number,
): Array<Pick<RecommendationCandidate, "entryWindowSeconds" | "minDistanceUsd">> {
  const distances = buildDistanceCandidates(market, samples, currentDistance);
  return CANDIDATE_WINDOWS.flatMap((entryWindowSeconds) =>
    distances.map((minDistanceUsd) => ({ entryWindowSeconds, minDistanceUsd })),
  );
}

function buildDistanceCandidates(
  market: MarketSymbol,
  samples: AnalyticsSample[],
  currentDistance: number,
): number[] {
  const step = DISTANCE_STEPS[market];
  const distances = new Set<number>();
  const add = (value: number) => {
    const rounded = roundToStep(market, value, step);
    if (rounded > 0) {
      distances.add(rounded);
    }
  };

  for (let offset = -10; offset <= 10; offset += 1) {
    add(currentDistance + offset * step);
  }
  for (const factor of [0.5, 0.65, 0.75, 0.85, 1, 1.15, 1.25, 1.4, 1.5]) {
    add(currentDistance * factor);
  }

  const historicalDistances = samples
    .flatMap((sample) => sample.ticks)
    .filter((tick) => tick.secondsToEnd > 0 && tick.secondsToEnd <= 60)
    .map((tick) => Math.abs(tick.distanceUsd))
    .filter((value) => Number.isFinite(value) && value > 0)
    .sort((left, right) => left - right);

  for (const percentile of [0.25, 0.35, 0.45, 0.55, 0.65, 0.75, 0.85, 0.95]) {
    const value = quantile(historicalDistances, percentile);
    if (value !== undefined) {
      add(value - step);
      add(value);
      add(value + step);
    }
  }

  return [...distances].sort((left, right) => left - right);
}

function buildCandidate(
  market: MarketSymbol,
  samples: AnalyticsSample[],
  entryWindowSeconds: number,
  minDistanceUsd: number,
  maxAskPrice: number,
): RecommendationCandidate {
  return {
    entryWindowSeconds,
    minDistanceUsd,
    metrics: simulateCandidate(samples, entryWindowSeconds, minDistanceUsd, maxAskPrice),
  };
}

function simulateCandidate(
  samples: AnalyticsSample[],
  entryWindowSeconds: number,
  minDistanceUsd: number,
  maxAskPrice: number,
): RecommendationMetrics {
  const simulation = buildCandidateObservations(samples, entryWindowSeconds, minDistanceUsd, maxAskPrice);
  const returns = simulation.observations.map((observation) => observation.returnRoi);
  const walkForward = buildWalkForwardPredictions(simulation.observations);
  const walkForwardReturns = walkForward.map((prediction) => prediction.actualReturnRoi);
  const expectedReturns = walkForward.map((prediction) => prediction.predictedReturnRoi);
  const averageRoi = returns.length > 0 ? mean(returns) : undefined;
  const walkForwardRoi = walkForwardReturns.length > 0 ? mean(walkForwardReturns) : undefined;
  const expectedRoi = expectedReturns.length > 0 ? mean(expectedReturns) : undefined;
  const lowerBoundRoi =
    walkForwardReturns.length > 0
      ? lowerConfidenceBound(walkForwardReturns)
      : averageRoi !== undefined
        ? lowerConfidenceBound(returns)
        : undefined;
  const overfitRisk = calculateOverfitRisk(averageRoi, walkForwardRoi, returns.length, walkForwardReturns.length);
  const adjustedRoi =
    lowerBoundRoi !== undefined
      ? lowerBoundRoi -
        smallSamplePenalty(walkForwardReturns.length || returns.length) -
        quoteCoveragePenalty(simulation.signalCount, returns.length) -
        drawdownPenalty(maxDrawdown(returns)) -
        overfitRisk * 0.05
      : undefined;
  // Selection objective: expected realized yield per OBSERVED window = per-trade edge × how often the
  // config actually executes. A rare high-edge config and a frequent moderate-edge config are compared
  // on total expected yield, so the optimizer stops preferring 5-7s windows that barely trade.
  const executionRate = samples.length > 0 ? returns.length / samples.length : 0;
  const yieldPerWindow = adjustedRoi !== undefined ? adjustedRoi * executionRate : undefined;

  return {
    sampleCount: samples.length,
    signalCount: simulation.signalCount,
    tradeCount: returns.length,
    winCount: simulation.observations.filter((observation) => observation.won).length,
    lossCount: simulation.observations.filter((observation) => !observation.won).length,
    quoteCoverage: simulation.signalCount > 0 ? returns.length / simulation.signalCount : 0,
    averageRoi,
    adjustedRoi,
    yieldPerWindow,
    expectedRoi,
    walkForwardRoi,
    lowerBoundRoi,
    overfitRisk,
    predictedWinProbability:
      walkForward.length > 0 ? mean(walkForward.map((prediction) => prediction.predictedWinProbability)) : undefined,
    calibrationError:
      walkForward.length > 0
        ? mean(walkForward.map((prediction) => Math.abs(prediction.predictedWinProbability - (prediction.won ? 1 : 0))))
        : undefined,
    maxDrawdown: maxDrawdown(returns),
  };
}

function buildCandidateObservations(
  samples: AnalyticsSample[],
  entryWindowSeconds: number,
  minDistanceUsd: number,
  maxAskPrice: number,
): CandidateSimulation {
  const observations: CandidateObservation[] = [];
  let signalCount = 0;

  for (const sample of samples) {
    const signalTick = findSignalTick(sample, entryWindowSeconds, minDistanceUsd);
    if (!signalTick) {
      continue;
    }
    signalCount += 1;

    const outcome: Outcome = signalTick.distanceUsd >= 0 ? "UP" : "DOWN";
    const quote = findClosestQuote(sample.quotes, signalTick.timestampMs);
    const ask = quote ? getAsk(quote, outcome) : undefined;
    if (!isPositiveFinite(ask) || ask > maxAskPrice || !sample.winningOutcome) {
      continue;
    }

    const won = sample.winningOutcome === outcome;
    const bestBid = quote ? getBid(quote, outcome) : undefined;
    const oppositeAsk = quote ? getAsk(quote, outcome === "UP" ? "DOWN" : "UP") : undefined;
    observations.push({
      sample,
      timestampMs: signalTick.timestampMs,
      outcome,
      secondsToEnd: signalTick.secondsToEnd,
      distanceUsd: signalTick.distanceUsd,
      absDistanceUsd: Math.abs(signalTick.distanceUsd),
      velocityUsdPerSecond: getRecentVelocity(sample.ticks, signalTick),
      ask,
      bestBid,
      spread: isPositiveFinite(bestBid) ? ask - bestBid : undefined,
      quoteSkew: isPositiveFinite(oppositeAsk) ? oppositeAsk - ask : undefined,
      won,
      returnRoi: won ? 1 / ask - 1 : -1,
    });
  }

  return {
    signalCount,
    observations: observations.sort((left, right) => left.sample.windowStartMs - right.sample.windowStartMs),
  };
}

function buildWalkForwardPredictions(observations: CandidateObservation[]): WalkForwardPrediction[] {
  const predictions: WalkForwardPrediction[] = [];
  for (let index = 0; index < observations.length; index += 1) {
    if (index < WALK_FORWARD_MIN_TRAINING_TRADES) {
      continue;
    }
    const training = observations.slice(Math.max(0, index - WALK_FORWARD_TRAINING_WINDOW), index);
    const observation = observations[index];
    const predictedWinProbability = predictWinProbability(training, observation);
    predictions.push({
      predictedWinProbability,
      predictedReturnRoi: predictedWinProbability / observation.ask - 1,
      actualReturnRoi: observation.returnRoi,
      won: observation.won,
    });
  }
  return predictions;
}

function predictWinProbability(training: CandidateObservation[], observation: CandidateObservation): number {
  const neighbors = training
    .map((candidate) => ({
      candidate,
      distance: featureDistance(candidate, observation),
    }))
    .sort((left, right) => left.distance - right.distance)
    .slice(0, Math.min(12, Math.max(5, Math.round(Math.sqrt(training.length) * 2))));

  let weightedWins = 1;
  let totalWeight = 2;
  for (const neighbor of neighbors) {
    const weight = 1 / (0.25 + neighbor.distance);
    weightedWins += neighbor.candidate.won ? weight : 0;
    totalWeight += weight;
  }
  return clamp(weightedWins / totalWeight, 0.05, 0.95);
}

function featureDistance(left: CandidateObservation, right: CandidateObservation): number {
  const distanceScale = Math.max(right.absDistanceUsd, left.absDistanceUsd, 1);
  const velocityScale = Math.max(Math.abs(right.velocityUsdPerSecond), Math.abs(left.velocityUsdPerSecond), 0.1);
  return (
    Math.abs(left.secondsToEnd - right.secondsToEnd) / 55 +
    Math.abs(left.absDistanceUsd - right.absDistanceUsd) / distanceScale +
    Math.abs(left.velocityUsdPerSecond - right.velocityUsdPerSecond) / velocityScale +
    Math.abs(left.ask - right.ask) / 0.75 +
    Math.abs((left.spread ?? 0) - (right.spread ?? 0)) / 0.75 +
    Math.abs((left.quoteSkew ?? 0) - (right.quoteSkew ?? 0)) / 0.75 +
    (left.outcome === right.outcome ? 0 : 0.2)
  );
}

function findSignalTick(
  sample: AnalyticsSample,
  entryWindowSeconds: number,
  minDistanceUsd: number,
): AnalyticsTickPoint | undefined {
  return sample.ticks
    .filter((tick) => tick.secondsToEnd > 0 && tick.secondsToEnd <= entryWindowSeconds)
    .sort((left, right) => left.timestampMs - right.timestampMs)
    .find((tick) => Math.abs(tick.distanceUsd) >= minDistanceUsd);
}

function findClosestQuote(quotes: AnalyticsQuotePoint[], timestampMs: number): AnalyticsQuotePoint | undefined {
  return quotes
    .map((quote) => ({ quote, distanceMs: Math.abs(quote.timestampMs - timestampMs) }))
    .filter((item) => item.distanceMs <= QUOTE_MATCH_WINDOW_MS)
    .sort((left, right) => left.distanceMs - right.distanceMs)[0]?.quote;
}

function getAsk(quote: AnalyticsQuotePoint, outcome: Outcome): number | undefined {
  return outcome === "UP" ? quote.upBestAsk : quote.downBestAsk;
}

function getBid(quote: AnalyticsQuotePoint, outcome: Outcome): number | undefined {
  return outcome === "UP" ? quote.upBestBid : quote.downBestBid;
}

function getRecentVelocity(ticks: AnalyticsTickPoint[], tick: AnalyticsTickPoint): number {
  const previous = ticks
    .filter((candidate) => candidate.timestampMs < tick.timestampMs)
    .sort((left, right) => right.timestampMs - left.timestampMs)[0];
  if (!previous) {
    return 0;
  }
  const elapsedSeconds = (tick.timestampMs - previous.timestampMs) / 1000;
  return elapsedSeconds > 0 ? (tick.distanceUsd - previous.distanceUsd) / elapsedSeconds : 0;
}

function selectBestCandidate(
  candidates: RecommendationCandidate[],
  current: RecommendationCandidate,
): RecommendationCandidate | undefined {
  return candidates
    .filter((candidate) => candidate.metrics.adjustedRoi !== undefined)
    .sort((left, right) => {
      // Primary objective: realized yield per window (edge × execution rate).
      const yieldDelta = (right.metrics.yieldPerWindow ?? -Infinity) - (left.metrics.yieldPerWindow ?? -Infinity);
      if (Math.abs(yieldDelta) > 0.00001) {
        return yieldDelta;
      }
      const adjustedDelta = (right.metrics.adjustedRoi ?? -Infinity) - (left.metrics.adjustedRoi ?? -Infinity);
      if (Math.abs(adjustedDelta) > 0.0001) {
        return adjustedDelta;
      }
      const lowerBoundDelta = (right.metrics.lowerBoundRoi ?? -Infinity) - (left.metrics.lowerBoundRoi ?? -Infinity);
      if (Math.abs(lowerBoundDelta) > 0.0001) {
        return lowerBoundDelta;
      }
      const stabilityDelta = candidateChangeMagnitude(left, current) - candidateChangeMagnitude(right, current);
      if (Math.abs(stabilityDelta) > 0.0001) {
        return stabilityDelta;
      }
      return right.metrics.tradeCount - left.metrics.tradeCount;
    })[0];
}

function candidateChangeMagnitude(candidate: RecommendationCandidate, current: RecommendationCandidate): number {
  const windowChange = Math.abs(candidate.entryWindowSeconds - current.entryWindowSeconds) / 60;
  const distanceChange =
    current.minDistanceUsd > 0
      ? Math.abs(candidate.minDistanceUsd - current.minDistanceUsd) / current.minDistanceUsd
      : 1;
  return windowChange + distanceChange;
}

function getConfidence(
  sampleCount: number,
  metrics: RecommendationMetrics,
  improvementYield: number | undefined,
  thresholds: AutoApplyThresholds,
): "low" | "medium" | "high" {
  if (
    sampleCount >= thresholds.minAutoSamples &&
    metrics.tradeCount >= thresholds.minAutoTrades &&
    metrics.quoteCoverage >= thresholds.minQuoteCoverage &&
    metrics.lowerBoundRoi !== undefined &&
    metrics.lowerBoundRoi > 0 &&
    metrics.walkForwardRoi !== undefined &&
    metrics.walkForwardRoi > 0 &&
    metrics.overfitRisk <= thresholds.maxOverfitRisk &&
    improvementYield !== undefined &&
    improvementYield >= thresholds.minYieldImprovement
  ) {
    return "high";
  }
  if (sampleCount >= MIN_READY_SAMPLES && metrics.tradeCount > 0) {
    return "medium";
  }
  return "low";
}

function recommendationReason(args: {
  status: "insufficient_data" | "ready";
  confidence: "low" | "medium" | "high";
  sampleCount: number;
  metrics: RecommendationMetrics;
  improvementYield: number | undefined;
  canAutoApply: boolean;
  cooldownActive: boolean;
}): string {
  if (args.status === "insufficient_data") {
    return `Datos insuficientes: ${args.sampleCount}/${MIN_READY_SAMPLES} ventanas resueltas.`;
  }
  if (args.metrics.tradeCount === 0) {
    return "Sin oportunidades ejecutables con quotes dentro del cap actual.";
  }
  if (args.cooldownActive) {
    return "Recomendacion predictiva lista, pero el autoajuste esta en cooldown.";
  }
  if (args.canAutoApply) {
    return "Alta confianza: mejora validada fuera de muestra y dentro de guardas.";
  }
  if (args.metrics.overfitRisk > 0.55) {
    return "Mejora exploratoria con riesgo de sobreajuste; requiere mas datos.";
  }
  if (args.improvementYield !== undefined && args.improvementYield > 0) {
    return "Mejora predictiva exploratoria validada con walk-forward.";
  }
  return "La combinacion actual sigue siendo competitiva con los datos disponibles.";
}

function isAutoApplyCooldownActive(lastAppliedAtMs: number | undefined, nowMs: number): boolean {
  return lastAppliedAtMs !== undefined && nowMs - lastAppliedAtMs < AUTO_APPLY_COOLDOWN_MS;
}

function isWithinAutoApplyChange(
  current: RecommendationCandidate,
  recommended: RecommendationCandidate,
  thresholds: AutoApplyThresholds,
): boolean {
  const windowChange = Math.abs(recommended.entryWindowSeconds - current.entryWindowSeconds);
  const distanceChangeRatio =
    current.minDistanceUsd > 0
      ? Math.abs(recommended.minDistanceUsd - current.minDistanceUsd) / current.minDistanceUsd
      : Infinity;
  return windowChange <= thresholds.maxWindowChangeSeconds && distanceChangeRatio <= thresholds.maxDistanceChangeRatio;
}

function smallSamplePenalty(tradeCount: number): number {
  return Math.max(0, MIN_AUTO_TRADES - tradeCount) * 0.006;
}

function quoteCoveragePenalty(signalCount: number, tradeCount: number): number {
  if (signalCount === 0) {
    return 0.08;
  }
  return (1 - tradeCount / signalCount) * 0.1;
}

function drawdownPenalty(drawdown: number): number {
  return Math.min(drawdown, 5) * 0.02;
}

function calculateOverfitRisk(
  averageRoi: number | undefined,
  walkForwardRoi: number | undefined,
  tradeCount: number,
  walkForwardTradeCount: number,
): number {
  const sampleRisk = tradeCount > 0 ? clamp((MIN_AUTO_TRADES - walkForwardTradeCount) / MIN_AUTO_TRADES, 0, 1) : 1;
  if (averageRoi === undefined || walkForwardRoi === undefined) {
    return sampleRisk;
  }
  const gapRisk = clamp((averageRoi - walkForwardRoi) / 0.35, 0, 1);
  return clamp(sampleRisk * 0.45 + gapRisk * 0.55, 0, 1);
}

function lowerConfidenceBound(values: number[]): number | undefined {
  if (values.length === 0) {
    return undefined;
  }
  if (values.length === 1) {
    return values[0] - 0.25;
  }
  return mean(values) - (1.64 * standardDeviation(values)) / Math.sqrt(values.length);
}

function maxDrawdown(values: number[]): number {
  let equity = 0;
  let peak = 0;
  let drawdown = 0;
  for (const value of values) {
    equity += value;
    peak = Math.max(peak, equity);
    drawdown = Math.max(drawdown, peak - equity);
  }
  return drawdown;
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function standardDeviation(values: number[]): number {
  if (values.length <= 1) {
    return 0;
  }
  const average = mean(values);
  const variance = mean(values.map((value) => (value - average) ** 2));
  return Math.sqrt(variance);
}

function quantile(values: number[], percentile: number): number | undefined {
  if (values.length === 0) {
    return undefined;
  }
  const index = Math.min(values.length - 1, Math.max(0, Math.round((values.length - 1) * percentile)));
  return values[index];
}

function roundToStep(market: MarketSymbol, value: number, step: number): number {
  const decimals = market === "DOGE" ? 6 : 2;
  return Number((Math.round(value / step) * step).toFixed(decimals));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function isPositiveFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

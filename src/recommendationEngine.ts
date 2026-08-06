import { join } from "node:path";

import { QUOTE_MATCH_WINDOW_MS, readAnalyticsSamples } from "./analyticsRecorder.js";
import { scoringOutcome } from "./analyticsTruth.js";
import { knnEstimate, type KnnObservation, type KnnOptions, type KnnPoint } from "./knnCore.js";
import { DEFAULT_MIN_SECONDS_TO_END, getMinDistanceUsd, SUPPORTED_MARKETS } from "./markets.js";
import { passesRealizedGuard, realizedForCandidate } from "./realizedGuard.js";
import type {
  AiRecommendation,
  AiRecommendationsResponse,
  AnalyticsQuotePoint,
  AnalyticsSample,
  AnalyticsTickPoint,
  AutoApplyThresholds,
  MarketDistanceSettings,
  MarketEntryWindowSettings,
  MarketSymbol,
  Mode,
  Outcome,
  RecommendationCandidate,
  RecommendationMetrics,
  TradeAttempt,
} from "./types.js";

export type { AutoApplyThresholds } from "./types.js";

const MIN_READY_SAMPLES = 10;
const MIN_AUTO_TRADES = 20;

// ONE set of thresholds for BOTH sim and live, so a sim run faithfully predicts live — if the
// autoajuste behaved differently per mode, sim would be worthless as a dry run. No time lock: apply
// the best data-supported config every evaluation (~60s) so the bot runs the best strategy per
// window; the minYieldImprovement margin (not a timer) is the anti-thrash guard. Coverage/trade
// gates are relaxed to the thin real liquidity of these 5-min markets so the autoajuste can act,
// and the quality gates (out-of-sample ROI > 0, overfit <= max, yield improvement) still protect.
export const AUTO_APPLY_THRESHOLDS: AutoApplyThresholds = {
  minAutoSamples: 40,
  minAutoTrades: 15,
  minQuoteCoverage: 0.02,
  minYieldImprovement: 0.0008,
  maxOverfitRisk: 0.45,
  maxWindowChangeSeconds: 60,
  maxDistanceChangeRatio: 10,
  autoApplyCooldownMs: 0,
};

// Kept as aliases for compatibility: both modes now use the same thresholds.
export const LIVE_AUTO_APPLY_THRESHOLDS = AUTO_APPLY_THRESHOLDS;
export const SIM_AUTO_APPLY_THRESHOLDS = AUTO_APPLY_THRESHOLDS;

// How much better a thinner-sampled setup's out-of-sample lower bound must be to justify downgrading
// sample robustness (see passesRobustnessGuard).
export const ROBUST_DOWNGRADE_MARGIN = 0.05;

/**
 * Anti-overfit guard for auto-apply: never DOWNGRADE onto a setup backed by fewer trades than the one
 * running now (the classic overfit trap — the engine kept recommending a 7-trade BTC window over a
 * 12-trade one). A thinner setup is only accepted if its conservative out-of-sample lower bound
 * clearly beats the current one's. A dead current config (0 trades) has nothing to protect, so any
 * validated change is allowed — that escape valve is what bootstraps a market that never traded.
 */
export function passesRobustnessGuard(
  current: { tradeCount: number; lowerBoundRoi?: number },
  best: { tradeCount: number; lowerBoundRoi?: number },
  margin = ROBUST_DOWNGRADE_MARGIN,
): boolean {
  if (current.tradeCount === 0 || best.tradeCount >= current.tradeCount) {
    return true;
  }
  return (best.lowerBoundRoi ?? Number.NEGATIVE_INFINITY) > (current.lowerBoundRoi ?? Number.NEGATIVE_INFINITY) + margin;
}

export function autoApplyThresholdsForMode(_mode: Mode): AutoApplyThresholds {
  return AUTO_APPLY_THRESHOLDS;
}
const WALK_FORWARD_MIN_TRAINING_TRADES = 5;
// k-NN walk-forward only considers the most recent observations as neighbours. This keeps the
// per-candidate cost linear (O(obs * window)) instead of O(obs^2), so we can feed in much more
// history (for trade-count significance) without the grid search blowing up the event loop.
// Recent neighbours are also more relevant to the current regime.
const WALK_FORWARD_TRAINING_WINDOW = 300;
/**
 * Historia por mercado que alimenta la rejilla.
 *
 * Estuvo en 900 y ESE era el motivo real de que el autoajuste nunca actuara. Con 900 ventanas ningun
 * candidato de la rejilla llegaba a los 15 trades ejecutables que exige minAutoTrades, asi que
 * canAutoApply salia false SIEMPRE: no por falta de robustez ni por un mal objetivo, sino porque el
 * motor solo miraba el 13% de las 6.673 ventanas que hay por mercado.
 *
 * Medido sobre el historico real (ask cap 0.6), trades del candidato elegido:
 *   cap   900 ->  BTC   6 (bloq)  ETH   6 (bloq)   7.8s por pasada
 *   cap  2500 ->  BTC   6 (bloq)  ETH  62 (APLICA) 24s
 *   cap  6000 ->  BTC  73 (APLICA) ETH 143 (APLICA) 57s
 *   cap 20000 ->  BTC  63 (bloq)  ETH 155 (APLICA) 65s
 *
 * A 20.000 BTC vuelve a bloquearse: la historia vieja diluye el edge, asi que "mas" no es
 * monotonamente mejor. 6.000 es el mejor de los cuatro puntos probados — no un optimo demostrado.
 * El coste sube a ~57s por pasada, compensado alargando el intervalo de evaluacion (ver
 * AI_AUTO_APPLY_POLL_MS): la config de estrategia deriva en horas, no en minutos.
 */
const MAX_RECOMMENDATION_SAMPLES_PER_MARKET = 6_000;
// Entry-window candidates floored at 25s: below ~25s the quote coverage collapses to <=3% (measured
// on real samples), so those configs almost never execute. Flooring here stops the autoajuste from
// converging on degenerate 5-7s windows that barely trade.
const MIN_CANDIDATE_WINDOW_SECONDS = 25;
// Dense 25..60s (1s steps) plus coarse 65..120s (5s steps): lets the engine explore EARLIER entries
// (where the favourite is cheaper → more executable coverage) once 120s samples exist, without
// exploding the grid cost. The >60s candidates simply produce no trades until 120s data accumulates.
const CANDIDATE_WINDOWS = [
  ...Array.from({ length: 61 - MIN_CANDIDATE_WINDOW_SECONDS }, (_value, index) => MIN_CANDIDATE_WINDOW_SECONDS + index),
  ...Array.from({ length: 12 }, (_value, index) => 65 + index * 5),
];
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
  // Per-market distance floor: the engine must never recommend a distance below this, because the
  // applier clamps to it. Without this the engine "recommends" sub-floor configs that get clamped
  // away, producing phantom auto-applies that never change anything.
  minDistanceFloorUsdByMarket?: Partial<Record<MarketSymbol, number>>;
  // La guardia de cierre que aplica produccion. El motor debe simular con ella puesta o recomendara
  // ventanas cortas que en la practica pierden sus primeros segundos utiles.
  minSecondsToEndForEntry?: number;
  // Operaciones ya ejecutadas y resueltas. Solo alimentan el VETO por rendimiento realizado: el motor
  // mide sobre quotes sin profundidad y sobrevalora las ventanas tardias, asi que el ledger es lo
  // unico que sabe lo que de verdad se cobra. Vacio o ausente = el veto se abstiene.
  resolvedTrades?: TradeAttempt[];
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
    return await buildRecommendations(samples, settings, nowMs, MAX_RECOMMENDATION_SAMPLES_PER_MARKET, thresholds);
  }
}

// The grid search is CPU-heavy; yield to the event loop every few candidates so the recommendation
// tick never freezes the bot's trading/polling loop (see buildMarketRecommendation).

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

/**
 * Cede el control si se lleva mas de `YIELD_BUDGET_MS` sin hacerlo.
 *
 * Ceder cada N CANDIDATOS (antes: 40) no acota nada: lo que importa es cuanto se tarda entre cesiones,
 * y eso depende de la maquina y del tamaño del dataset. Medido en el equipo del usuario (i7-4770, 20k
 * muestras): un candidato costaba ~47ms, asi que 40 candidatos eran ~1.9s de bucle bloqueado de
 * mediana y hasta 9.6s en los picos — con 66 de 86 latidos retrasados mas de un segundo durante una
 * pasada de 242s.
 *
 * Eso no solo hace perder ventanas de entrada: se disfraza de fallo de RED. Con el bucle parado, la
 * continuacion del `fetch` no puede ejecutarse y el `AbortSignal.timeout(5s)` acaba disparando, asi
 * que el sintoma visible era "The operation was aborted due to timeout" contra una red perfectamente
 * sana.
 *
 * Por tiempo el limite se respeta en cualquier maquina: en una mas lenta simplemente se cede mas a
 * menudo, en vez de degradarse en silencio.
 */
const YIELD_BUDGET_MS = 15;

class EventLoopBudget {
  private lastYieldAtMs = Date.now();

  async yieldIfNeeded(nowMs = Date.now()): Promise<void> {
    if (nowMs - this.lastYieldAtMs < YIELD_BUDGET_MS) {
      return;
    }
    await yieldToEventLoop();
    this.lastYieldAtMs = Date.now();
  }
}

export async function buildRecommendations(
  samples: AnalyticsSample[],
  settings: RecommendationSettings,
  nowMs = Date.now(),
  maxSamplesPerMarket = MAX_RECOMMENDATION_SAMPLES_PER_MARKET,
  thresholds: AutoApplyThresholds = LIVE_AUTO_APPLY_THRESHOLDS,
): Promise<AiRecommendationsResponse> {
  const recommendations: AiRecommendation[] = [];
  for (const market of SUPPORTED_MARKETS) {
    recommendations.push(
      await buildMarketRecommendation(market, recentMarketSamples(samples, market, maxSamplesPerMarket), settings, nowMs, thresholds),
    );
  }
  return { generatedAtMs: nowMs, recommendations, totalSamples: samples.length };
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

async function buildMarketRecommendation(
  market: MarketSymbol,
  samples: AnalyticsSample[],
  settings: RecommendationSettings,
  nowMs: number,
  thresholds: AutoApplyThresholds,
): Promise<AiRecommendation> {
  const currentWindow = settings.entryWindowSecondsByMarket[market] ?? settings.entryWindowSeconds;
  const currentDistance = getMinDistanceUsd(settings.minDistanceUsdByMarket, market);
  const distanceFloor = Math.max(settings.minDistanceFloorUsdByMarket?.[market] ?? 0, 0);
  const minSecondsToEnd = settings.minSecondsToEndForEntry ?? DEFAULT_MIN_SECONDS_TO_END;
  const current = buildCandidate(market, samples, currentWindow, currentDistance, settings.maxAskPrice, undefined, minSecondsToEnd);
  const grid = buildCandidateGrid(market, samples, currentDistance, distanceFloor);
  const candidates: RecommendationCandidate[] = [];
  const budget = new EventLoopBudget();
  for (let index = 0; index < grid.length; index += 1) {
    const built = buildCandidate(
      market,
      samples,
      grid[index].entryWindowSeconds,
      grid[index].minDistanceUsd,
      settings.maxAskPrice,
      undefined,
      minSecondsToEnd,
    );
    if (built.metrics.adjustedRoi !== undefined) {
      candidates.push(built);
    }
    // Por TIEMPO, no por conteo: es lo unico que acota el retraso del bucle en cualquier maquina.
    await budget.yieldIfNeeded();
  }
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
    // Never adjust into a losing config: the recommended must have POSITIVE out-of-sample ROI in
    // absolute terms, not merely be "less negative" than the current one. (Auto-apply additionally
    // requires a positive conservative lower bound — see canAutoApply.)
    best.metrics.walkForwardRoi !== undefined &&
    best.metrics.walkForwardRoi > 0 &&
    improvementYield !== undefined &&
    improvementYield > 0;
  const cooldownActive = isAutoApplyCooldownActive(settings.aiLastAppliedAtMs, nowMs, thresholds.autoApplyCooldownMs);
  const realizedRegion = realizedForCandidate(settings.resolvedTrades ?? [], market, best);
  const realizedGuard = { region: realizedRegion, passes: passesRealizedGuard(realizedRegion) };
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
    // Anti-overfit: don't auto-downgrade onto a thinner-sampled setup unless its OOS lower bound is
    // clearly better (keeps the engine from chasing few-trade flukes over robust configs).
    passesRobustnessGuard(current.metrics, best.metrics) &&
    // Veto por rendimiento REALIZADO: nunca mudarse a una region que el ledger de ejecuciones muestra
    // perdedora, por bien que la puntue la simulacion sobre quotes. Es lo que faltaba cuando el motor
    // mando ETH a 26s, donde 127 operaciones reales habian perdido $41.22.
    realizedGuard.passes &&
    // Escape valve: the max-change guard protects a WORKING config from destabilizing jumps, but a
    // config with zero trades has nothing to protect — and gradual steps can never bootstrap it,
    // because intermediate configs lack the data to validate each step (DOGE sat dead for weeks at a
    // 45s window while the engine knew 120s was 23-1). Dead config = any validated jump is allowed.
    (current.metrics.tradeCount === 0 || isWithinAutoApplyChange(current, best, thresholds));

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

export function buildCandidateGrid(
  market: MarketSymbol,
  samples: AnalyticsSample[],
  currentDistance: number,
  distanceFloor = 0,
): Array<Pick<RecommendationCandidate, "entryWindowSeconds" | "minDistanceUsd">> {
  const distances = buildDistanceCandidates(market, samples, currentDistance, distanceFloor);
  return CANDIDATE_WINDOWS.flatMap((entryWindowSeconds) =>
    distances.map((minDistanceUsd) => ({ entryWindowSeconds, minDistanceUsd })),
  );
}

function buildDistanceCandidates(
  market: MarketSymbol,
  samples: AnalyticsSample[],
  currentDistance: number,
  distanceFloor = 0,
): number[] {
  const step = DISTANCE_STEPS[market];
  const distances = new Set<number>();
  const add = (value: number) => {
    const rounded = roundToStep(market, value, step);
    // Never propose a distance below the market's edge floor: the applier clamps to it, so anything
    // below would be a phantom change that never takes effect.
    if (rounded > 0 && rounded >= distanceFloor) {
      distances.add(rounded);
    }
  };

  // Always keep the floor itself available so the engine can evaluate moving up to it.
  if (distanceFloor > 0) {
    distances.add(roundToStep(market, Math.ceil(distanceFloor / step) * step, step));
  }

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

export function buildCandidate(
  market: MarketSymbol,
  samples: AnalyticsSample[],
  entryWindowSeconds: number,
  minDistanceUsd: number,
  maxAskPrice: number,
  outcome?: Outcome,
  // Por defecto la guardia de cierre REAL, no cero: un simulador que la ignora sobreestima las
  // ventanas cortas y termina recomendandolas.
  minSecondsToEnd: number = DEFAULT_MIN_SECONDS_TO_END,
): RecommendationCandidate {
  return {
    entryWindowSeconds,
    minDistanceUsd,
    metrics: simulateCandidate(samples, entryWindowSeconds, minDistanceUsd, maxAskPrice, outcome, minSecondsToEnd),
  };
}

function simulateCandidate(
  samples: AnalyticsSample[],
  entryWindowSeconds: number,
  minDistanceUsd: number,
  maxAskPrice: number,
  outcome: Outcome | undefined,
  minSecondsToEnd: number,
): RecommendationMetrics {
  const simulation = buildCandidateObservations(samples, entryWindowSeconds, minDistanceUsd, maxAskPrice, outcome, minSecondsToEnd);
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
  outcomeFilter: Outcome | undefined,
  minSecondsToEnd: number,
): CandidateSimulation {
  const observations: CandidateObservation[] = [];
  let signalCount = 0;

  for (const sample of samples) {
    const signalTick = findSignalTick(sample, entryWindowSeconds, minDistanceUsd, minSecondsToEnd);
    if (!signalTick) {
      continue;
    }
    const outcome: Outcome = signalTick.distanceUsd >= 0 ? "UP" : "DOWN";
    // Per-side simulation: only signals in the filtered direction exist for this candidate, so they
    // alone feed signalCount/coverage — each side's funnel is measured independently.
    if (outcomeFilter !== undefined && outcome !== outcomeFilter) {
      continue;
    }
    signalCount += 1;

    const quote = findClosestQuote(sample.quotes, signalTick.timestampMs);
    const ask = quote ? getAsk(quote, outcome) : undefined;
    const truth = scoringOutcome(sample);
    if (!isPositiveFinite(ask) || ask > maxAskPrice || !truth) {
      continue;
    }

    const won = truth === outcome;
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

/**
 * Engine k-NN options. Recency/prior stay at parity with the historical behavior; the walk-forward
 * sweep decides whether richer settings become defaults (see smoke/evGateBacktest.ts).
 */
export const ENGINE_KNN_OPTIONS: Pick<KnnOptions, "priorProbability" | "recencyHalfLifeDays"> = {};

function toKnnPoint(observation: CandidateObservation): KnnPoint {
  return {
    secondsToEnd: observation.secondsToEnd,
    absDistanceUsd: observation.absDistanceUsd,
    ask: observation.ask,
    velocityUsdPerSecond: observation.velocityUsdPerSecond,
    spread: observation.spread,
    quoteSkew: observation.quoteSkew,
    outcome: observation.outcome,
    atMs: observation.timestampMs,
  };
}

function predictWinProbability(training: CandidateObservation[], observation: CandidateObservation): number {
  const pool: KnnObservation[] = training.map((candidate) => ({ ...toKnnPoint(candidate), won: candidate.won }));
  return knnEstimate(pool, toKnnPoint(observation), {
    kMin: 5,
    kMax: 12,
    priorWeight: 2,
    nowMs: observation.timestampMs,
    ...ENGINE_KNN_OPTIONS,
  }).winProbability;
}

function findSignalTick(
  sample: AnalyticsSample,
  entryWindowSeconds: number,
  minDistanceUsd: number,
  minSecondsToEnd: number,
): AnalyticsTickPoint | undefined {
  return sample.ticks
    // El limite inferior replica la guardia de cierre de botRunner (rechaza secondsToEnd < min, luego
    // el igual SI entra). Sin el, el simulador contaba oportunidades que produccion nunca toma.
    .filter((tick) => tick.secondsToEnd > 0 && tick.secondsToEnd >= minSecondsToEnd && tick.secondsToEnd <= entryWindowSeconds)
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

export function selectBestCandidate(
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

function isAutoApplyCooldownActive(lastAppliedAtMs: number | undefined, nowMs: number, cooldownMs: number): boolean {
  return cooldownMs > 0 && lastAppliedAtMs !== undefined && nowMs - lastAppliedAtMs < cooldownMs;
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

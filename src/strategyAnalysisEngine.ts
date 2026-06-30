import { stat } from "node:fs/promises";
import { join } from "node:path";

import { readAnalyticsSamples } from "./analyticsRecorder.js";
import { calculateExpectedValue } from "./expectedValue.js";
import {
  getEntryWindowSeconds,
  getMarketOutcomeNumber,
  getMinDistanceUsd,
  OUTCOMES,
  SUPPORTED_MARKETS,
} from "./markets.js";
import type {
  AnalyticsQuotePoint,
  AnalyticsSample,
  AnalyticsTickPoint,
  MarketDistanceSettings,
  MarketEntryWindowSettings,
  MarketOutcomeNumberSettings,
  MarketSymbol,
  Outcome,
  StrategyAnalysisResponse,
  StrategyCandidate,
  StrategyConfidence,
  StrategyMetrics,
  StrategyRiskFlag,
} from "./types.js";

const QUOTE_MATCH_WINDOW_MS = 6_000;
const CANDIDATE_WINDOWS = Array.from({ length: 56 }, (_value, index) => 5 + index);
const ASK_CAP_CANDIDATES = [0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 0.98];
const TOP_STRATEGY_LIMIT = 100;
// Bound the per-market history fed into the strategy grid so a single analyze() pass stays fast
// and never blocks the event loop. Recent windows best reflect the current market regime.
const MAX_STRATEGY_SAMPLES_PER_MARKET = 300;
const MIN_RELIABLE_TRADES = 5;
const MIN_RELIABLE_QUOTE_COVERAGE = 0.2;
const MIN_HIGH_CONFIDENCE_TRADES = 20;
const MIN_HIGH_CONFIDENCE_QUOTE_COVERAGE = 0.5;
const DISTANCE_STEPS: Record<MarketSymbol, number> = {
  BTC: 1,
  ETH: 0.25,
  DOGE: 0.00005,
};

export interface StrategyAnalysisSettings {
  minDistanceUsdByMarket: MarketDistanceSettings;
  minDistanceUsdByMarketOutcome?: MarketOutcomeNumberSettings;
  entryWindowSeconds: number;
  entryWindowSecondsByMarket: MarketEntryWindowSettings;
  entryWindowSecondsByMarketOutcome?: MarketOutcomeNumberSettings;
  maxAskPrice: number;
  maxAskPriceByMarketOutcome?: MarketOutcomeNumberSettings;
  liveTradeAmountUsd?: number;
  liveTradeAmountUsdByMarketOutcome?: MarketOutcomeNumberSettings;
}

interface CandidateObservation {
  won: boolean;
  ask: number;
  returnRoi: number;
}

interface CandidateSimulation {
  sampleCount: number;
  signalCount: number;
  observations: CandidateObservation[];
}

type BaseStrategyCandidate = Omit<
  StrategyCandidate,
  "confidence" | "riskFlags" | "qualityScore" | "evDeltaVsCurrent"
>;

export class StrategyAnalysisEngine {
  private cache?: { key: string; response: StrategyAnalysisResponse };
  private readonly pending = new Map<string, Promise<StrategyAnalysisResponse>>();

  constructor(private readonly dataDir: string) {}

  async analyze(settings: StrategyAnalysisSettings, nowMs = Date.now()): Promise<StrategyAnalysisResponse> {
    const analyticsPath = join(this.dataDir, "analytics.jsonl");
    const key = `${await analyticsFileSignature(analyticsPath)}:${strategySettingsCacheKey(settings)}`;
    if (this.cache?.key === key) {
      return withGeneratedAt(this.cache.response, nowMs);
    }

    const existing = this.pending.get(key);
    if (existing) {
      return withGeneratedAt(await existing, nowMs);
    }

    const pending = readAnalyticsSamples(analyticsPath).then((samples) => buildStrategyAnalysis(samples, settings, nowMs));
    this.pending.set(key, pending);
    try {
      const response = await pending;
      this.cache = { key, response };
      return withGeneratedAt(response, nowMs);
    } finally {
      this.pending.delete(key);
    }
  }
}

export function buildStrategyAnalysis(
  samples: AnalyticsSample[],
  settings: StrategyAnalysisSettings,
  nowMs = Date.now(),
): StrategyAnalysisResponse {
  const analysisSamples = recentSamplesPerMarket(samples);
  const sampleRange = getSampleRange(analysisSamples);
  const currentBaseStrategies = buildCurrentStrategies(analysisSamples, settings);
  const currentEvByOutcome = new Map(
    currentBaseStrategies.map((strategy) => [strategyOutcomeKey(strategy), strategy.metrics.evRoi]),
  );
  const currentStrategies = currentBaseStrategies.map((strategy) => annotateStrategy(strategy, currentEvByOutcome));
  const candidates = SUPPORTED_MARKETS.flatMap((market) => {
    const marketSamples = analysisSamples.filter((sample) => sample.market === market);
    return OUTCOMES.flatMap((outcome) => buildOutcomeStrategyGrid(market, outcome, marketSamples, settings));
  }).map((strategy) => annotateStrategy(strategy, currentEvByOutcome));
  const rankedRaw = candidates
    .filter((candidate) => candidate.metrics.evRoi !== undefined)
    .sort(compareStrategies)
    .slice(0, TOP_STRATEGY_LIMIT);
  const rankedReliable = candidates
    .filter(isReliableStrategy)
    .sort(compareStrategies)
    .slice(0, TOP_STRATEGY_LIMIT);
  const ranked = uniqueStrategies([...rankedReliable, ...rankedRaw, ...currentStrategies]).sort(compareStrategies);
  const best = rankedRaw[0];
  const bestReliable = rankedReliable[0];

  return {
    generatedAtMs: nowMs,
    strategies: ranked,
    currentStrategies,
    summary: {
      sampleCount: analysisSamples.length,
      ...sampleRange,
      strategyCount: candidates.length,
      currentStrategyCount: currentStrategies.length,
      reliableStrategyCount: candidates.filter(isReliableStrategy).length,
      bestEvRoi: best?.metrics.evRoi,
      bestTradeCount: best?.metrics.tradeCount,
      bestReliableEvRoi: bestReliable?.metrics.evRoi,
      bestReliableTradeCount: bestReliable?.metrics.tradeCount,
    },
  };
}

function recentSamplesPerMarket(samples: AnalyticsSample[]): AnalyticsSample[] {
  const result: AnalyticsSample[] = [];
  for (const market of SUPPORTED_MARKETS) {
    const marketSamples = samples.filter((sample) => sample.market === market);
    if (marketSamples.length <= MAX_STRATEGY_SAMPLES_PER_MARKET) {
      result.push(...marketSamples);
      continue;
    }
    result.push(
      ...marketSamples
        .slice()
        .sort((left, right) => left.windowStartMs - right.windowStartMs)
        .slice(-MAX_STRATEGY_SAMPLES_PER_MARKET),
    );
  }
  return result;
}

function getSampleRange(
  samples: AnalyticsSample[],
): Pick<StrategyAnalysisResponse["summary"], "firstSampleAtMs" | "lastSampleAtMs"> {
  let firstSampleAtMs: number | undefined;
  let lastSampleAtMs: number | undefined;
  for (const sample of samples) {
    const sampleAtMs = sample.resolvedAtMs ?? sample.endMs ?? sample.windowStartMs;
    if (!Number.isFinite(sampleAtMs)) {
      continue;
    }
    firstSampleAtMs = firstSampleAtMs === undefined ? sampleAtMs : Math.min(firstSampleAtMs, sampleAtMs);
    lastSampleAtMs = lastSampleAtMs === undefined ? sampleAtMs : Math.max(lastSampleAtMs, sampleAtMs);
  }
  return { firstSampleAtMs, lastSampleAtMs };
}

function buildCurrentStrategies(
  samples: AnalyticsSample[],
  settings: StrategyAnalysisSettings,
): BaseStrategyCandidate[] {
  return SUPPORTED_MARKETS.flatMap((market) => {
    const marketSamples = samples.filter((sample) => sample.market === market);
    return OUTCOMES.map((outcome) => {
      const current = currentStrategyConfig(settings, market, outcome);
      return {
        market,
        outcome,
        ...current,
        metrics: simulateStrategy(
          marketSamples,
          outcome,
          current.entryWindowSeconds,
          current.minDistanceUsd,
          current.maxAskPrice,
          resolveLiveTradeAmountUsd(settings, market, outcome),
        ),
        isCurrent: true,
      };
    });
  });
}

function buildOutcomeStrategyGrid(
  market: MarketSymbol,
  outcome: Outcome,
  samples: AnalyticsSample[],
  settings: StrategyAnalysisSettings,
): BaseStrategyCandidate[] {
  const current = currentStrategyConfig(settings, market, outcome);
  const distances = buildDistanceCandidates(market, outcome, samples, current.minDistanceUsd);
  const askCaps = [...new Set([...ASK_CAP_CANDIDATES, current.maxAskPrice])]
    .filter((value) => value > 0 && value <= 1)
    .sort((left, right) => left - right);
  const candidates: BaseStrategyCandidate[] = [];

  for (const entryWindowSeconds of CANDIDATE_WINDOWS) {
    for (const minDistanceUsd of distances) {
      const simulation = buildCandidateSimulation(samples, outcome, entryWindowSeconds, minDistanceUsd);
      for (const maxAskPrice of askCaps) {
        candidates.push({
          market,
          outcome,
          entryWindowSeconds,
          minDistanceUsd,
          maxAskPrice,
          metrics: metricsFromSimulation(simulation, maxAskPrice, resolveLiveTradeAmountUsd(settings, market, outcome)),
          isCurrent:
            entryWindowSeconds === current.entryWindowSeconds &&
            minDistanceUsd === current.minDistanceUsd &&
            maxAskPrice === current.maxAskPrice,
        });
      }
    }
  }

  return candidates;
}

function currentStrategyConfig(
  settings: StrategyAnalysisSettings,
  market: MarketSymbol,
  outcome: Outcome,
): Pick<BaseStrategyCandidate, "entryWindowSeconds" | "minDistanceUsd" | "maxAskPrice"> {
  const marketDistance = getMinDistanceUsd(settings.minDistanceUsdByMarket, market);
  const marketWindow = getEntryWindowSeconds(settings.entryWindowSecondsByMarket, market, settings.entryWindowSeconds);
  return {
    entryWindowSeconds: getMarketOutcomeNumber(settings.entryWindowSecondsByMarketOutcome, market, outcome, marketWindow),
    minDistanceUsd: getMarketOutcomeNumber(settings.minDistanceUsdByMarketOutcome, market, outcome, marketDistance),
    maxAskPrice: getMarketOutcomeNumber(settings.maxAskPriceByMarketOutcome, market, outcome, settings.maxAskPrice),
  };
}

function buildDistanceCandidates(
  market: MarketSymbol,
  outcome: Outcome,
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
    .map((tick) => outcomeDistance(tick, outcome))
    .filter((value) => value > 0)
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

function simulateStrategy(
  samples: AnalyticsSample[],
  outcome: Outcome,
  entryWindowSeconds: number,
  minDistanceUsd: number,
  maxAskPrice: number,
  capitalUsd: number,
): StrategyMetrics {
  return metricsFromSimulation(
    buildCandidateSimulation(samples, outcome, entryWindowSeconds, minDistanceUsd),
    maxAskPrice,
    capitalUsd,
  );
}

function buildCandidateSimulation(
  samples: AnalyticsSample[],
  outcome: Outcome,
  entryWindowSeconds: number,
  minDistanceUsd: number,
): CandidateSimulation {
  const observations: CandidateObservation[] = [];
  let signalCount = 0;

  for (const sample of samples) {
    const signalTick = findSignalTick(sample, outcome, entryWindowSeconds, minDistanceUsd);
    if (!signalTick) {
      continue;
    }
    signalCount += 1;

    const quote = findClosestQuote(sample.quotes, signalTick.timestampMs);
    const ask = quote ? getAsk(quote, outcome) : undefined;
    if (!isPositiveFinite(ask) || !sample.winningOutcome) {
      continue;
    }

    const won = sample.winningOutcome === outcome;
    observations.push({
      won,
      ask,
      returnRoi: won ? 1 / ask - 1 : -1,
    });
  }

  return { sampleCount: samples.length, signalCount, observations };
}

function metricsFromSimulation(
  simulation: CandidateSimulation,
  maxAskPrice: number,
  capitalUsd: number,
): StrategyMetrics {
  const observations = simulation.observations.filter((observation) => observation.ask <= maxAskPrice);
  const returns = observations.map((observation) => observation.returnRoi);
  const tradeCount = observations.length;
  const winCount = observations.filter((observation) => observation.won).length;
  const lossCount = tradeCount - winCount;
  const averageAsk = tradeCount > 0 ? mean(observations.map((observation) => observation.ask)) : undefined;
  const historicalRoi = tradeCount > 0 ? mean(returns) : undefined;
  const expectedValue =
    averageAsk !== undefined
      ? calculateExpectedValue({
          capitalUsd,
          askPrice: averageAsk,
          winCount,
          tradeCount,
        })
      : undefined;

  return {
    sampleCount: simulation.sampleCount,
    signalCount: simulation.signalCount,
    tradeCount,
    winCount,
    lossCount,
    quoteCoverage: simulation.signalCount > 0 ? tradeCount / simulation.signalCount : 0,
    winRate: expectedValue?.realWinProbability,
    realWinProbability: expectedValue?.realWinProbability,
    adjustedWinProbability: expectedValue?.adjustedWinProbability,
    averageAsk,
    historicalRoi,
    evRoi: expectedValue?.expectedRoi,
    expectedRoi: expectedValue?.expectedRoi,
    expectedValueUsd: expectedValue?.expectedValueUsd,
    minExpectedValueUsd: expectedValue?.minExpectedValueUsd,
    winProfitUsd: expectedValue?.winProfitUsd,
    lossUsd: expectedValue?.lossUsd,
    breakEvenProbability: expectedValue?.breakEvenProbability,
    edge: expectedValue?.edge,
    liveTradeAmountUsd: expectedValue?.capitalUsd,
    askGuidance: expectedValue?.askGuidance,
    passesBasicEntry: expectedValue?.passesBasicEntry,
    passesSafetyMargin: expectedValue?.passesSafetyMargin,
    passesExpectedValue: expectedValue?.passesExpectedValue,
    passesRecommendedEntry: expectedValue?.passesRecommendedEntry,
    evDecisionReason: expectedValue?.decisionReason,
    maxDrawdown: maxDrawdown(returns),
  };
}

function findSignalTick(
  sample: AnalyticsSample,
  outcome: Outcome,
  entryWindowSeconds: number,
  minDistanceUsd: number,
): AnalyticsTickPoint | undefined {
  let best: AnalyticsTickPoint | undefined;
  for (const tick of sample.ticks) {
    if (
      tick.secondsToEnd > 0 &&
      tick.secondsToEnd <= entryWindowSeconds &&
      outcomeDistance(tick, outcome) >= minDistanceUsd &&
      (!best || tick.timestampMs < best.timestampMs)
    ) {
      best = tick;
    }
  }
  return best;
}

function outcomeDistance(tick: AnalyticsTickPoint, outcome: Outcome): number {
  return outcome === "UP" ? tick.distanceUsd : -tick.distanceUsd;
}

function findClosestQuote(quotes: AnalyticsQuotePoint[], timestampMs: number): AnalyticsQuotePoint | undefined {
  let best: AnalyticsQuotePoint | undefined;
  let bestDistanceMs = Infinity;
  for (const quote of quotes) {
    const distanceMs = Math.abs(quote.timestampMs - timestampMs);
    if (distanceMs <= QUOTE_MATCH_WINDOW_MS && distanceMs < bestDistanceMs) {
      best = quote;
      bestDistanceMs = distanceMs;
    }
  }
  return best;
}

function getAsk(quote: AnalyticsQuotePoint, outcome: Outcome): number | undefined {
  return outcome === "UP" ? quote.upBestAsk : quote.downBestAsk;
}

function compareStrategies(left: StrategyCandidate, right: StrategyCandidate): number {
  const evDelta = (right.metrics.evRoi ?? -Infinity) - (left.metrics.evRoi ?? -Infinity);
  if (Math.abs(evDelta) > 0.000001) {
    return evDelta;
  }
  const tradeDelta = right.metrics.tradeCount - left.metrics.tradeCount;
  if (tradeDelta !== 0) {
    return tradeDelta;
  }
  return right.metrics.quoteCoverage - left.metrics.quoteCoverage;
}

function annotateStrategy(
  strategy: BaseStrategyCandidate,
  currentEvByOutcome: Map<string, number | undefined>,
): StrategyCandidate {
  const riskFlags = strategyRiskFlags(strategy.metrics);
  const confidence = strategyConfidence(strategy.metrics, riskFlags);
  const currentEv = currentEvByOutcome.get(strategyOutcomeKey(strategy));
  const evRoi = strategy.metrics.evRoi;
  return {
    ...strategy,
    confidence,
    riskFlags,
    qualityScore: strategyQualityScore(strategy.metrics, confidence),
    evDeltaVsCurrent: evRoi !== undefined && currentEv !== undefined ? evRoi - currentEv : undefined,
  };
}

function strategyRiskFlags(metrics: StrategyMetrics): StrategyRiskFlag[] {
  const flags: StrategyRiskFlag[] = [];
  if (metrics.tradeCount === 0) {
    flags.push("no_trades");
    flags.push("insufficient_history");
  } else if (metrics.tradeCount < MIN_RELIABLE_TRADES) {
    flags.push("few_trades");
  }
  if (metrics.signalCount > 0 && metrics.quoteCoverage < MIN_RELIABLE_QUOTE_COVERAGE) {
    flags.push("low_quote_coverage");
  }
  if (metrics.evRoi !== undefined && metrics.evRoi <= 0) {
    flags.push("negative_ev");
  }
  if (metrics.passesSafetyMargin === false) {
    flags.push("unsafe_edge");
  }
  if (metrics.passesExpectedValue === false) {
    flags.push("below_min_ev");
  }
  if (metrics.askGuidance === "avoid_098" || metrics.askGuidance === "avoid_099") {
    flags.push("avoid_ask");
  }
  if (metrics.maxDrawdown > acceptableDrawdown(metrics.tradeCount)) {
    flags.push("high_drawdown");
  }
  return flags;
}

function strategyConfidence(metrics: StrategyMetrics, riskFlags: StrategyRiskFlag[]): StrategyConfidence {
  if (
    metrics.tradeCount >= MIN_HIGH_CONFIDENCE_TRADES &&
    metrics.quoteCoverage >= MIN_HIGH_CONFIDENCE_QUOTE_COVERAGE &&
    metrics.evRoi !== undefined &&
    metrics.evRoi > 0 &&
    metrics.passesRecommendedEntry === true &&
    !riskFlags.includes("high_drawdown")
  ) {
    return "high";
  }
  if (
    metrics.tradeCount >= MIN_RELIABLE_TRADES &&
    metrics.quoteCoverage >= MIN_RELIABLE_QUOTE_COVERAGE &&
    metrics.evRoi !== undefined &&
    metrics.evRoi > 0 &&
    metrics.passesRecommendedEntry === true
  ) {
    return "medium";
  }
  return "low";
}

function strategyQualityScore(metrics: StrategyMetrics, confidence: StrategyConfidence): number {
  const ev = metrics.evRoi ?? -1;
  const confidenceBonus = confidence === "high" ? 0.2 : confidence === "medium" ? 0.08 : 0;
  const tradeBonus = Math.min(metrics.tradeCount, 50) / 250;
  const coverageBonus = metrics.quoteCoverage / 10;
  const drawdownPenalty = metrics.maxDrawdown * 0.03;
  return ev + confidenceBonus + tradeBonus + coverageBonus - drawdownPenalty;
}

function isReliableStrategy(strategy: StrategyCandidate): boolean {
  return strategy.confidence === "medium" || strategy.confidence === "high";
}

function resolveLiveTradeAmountUsd(
  settings: StrategyAnalysisSettings,
  market: MarketSymbol,
  outcome: Outcome,
): number {
  return getMarketOutcomeNumber(
    settings.liveTradeAmountUsdByMarketOutcome,
    market,
    outcome,
    settings.liveTradeAmountUsd ?? 1,
  );
}

function uniqueStrategies(strategies: StrategyCandidate[]): StrategyCandidate[] {
  const unique = new Map<string, StrategyCandidate>();
  for (const strategy of strategies) {
    const key = strategyIdentityKey(strategy);
    const existing = unique.get(key);
    if (!existing || strategy.isCurrent || strategy.qualityScore > existing.qualityScore) {
      unique.set(key, strategy);
    }
  }
  return [...unique.values()];
}

function strategyOutcomeKey(strategy: Pick<StrategyCandidate, "market" | "outcome">): string {
  return `${strategy.market}:${strategy.outcome}`;
}

function strategyIdentityKey(
  strategy: Pick<StrategyCandidate, "market" | "outcome" | "entryWindowSeconds" | "minDistanceUsd" | "maxAskPrice">,
): string {
  return [
    strategy.market,
    strategy.outcome,
    strategy.entryWindowSeconds,
    strategy.minDistanceUsd,
    strategy.maxAskPrice,
  ].join(":");
}

function acceptableDrawdown(tradeCount: number): number {
  return Math.max(2, tradeCount * 0.25);
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

async function analyticsFileSignature(path: string): Promise<string> {
  try {
    const stats = await stat(path, { bigint: true });
    return `${stats.size}:${stats.mtimeNs}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return "missing";
    }
    throw error;
  }
}

function strategySettingsCacheKey(settings: StrategyAnalysisSettings): string {
  return JSON.stringify({
    minDistanceUsdByMarket: settings.minDistanceUsdByMarket,
    minDistanceUsdByMarketOutcome: settings.minDistanceUsdByMarketOutcome,
    entryWindowSeconds: settings.entryWindowSeconds,
    entryWindowSecondsByMarket: settings.entryWindowSecondsByMarket,
    entryWindowSecondsByMarketOutcome: settings.entryWindowSecondsByMarketOutcome,
    maxAskPrice: settings.maxAskPrice,
    maxAskPriceByMarketOutcome: settings.maxAskPriceByMarketOutcome,
    liveTradeAmountUsd: settings.liveTradeAmountUsd,
    liveTradeAmountUsdByMarketOutcome: settings.liveTradeAmountUsdByMarketOutcome,
  });
}

function withGeneratedAt(response: StrategyAnalysisResponse, generatedAtMs: number): StrategyAnalysisResponse {
  return response.generatedAtMs === generatedAtMs ? response : { ...response, generatedAtMs };
}

function isPositiveFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

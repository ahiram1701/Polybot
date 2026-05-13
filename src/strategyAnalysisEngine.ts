import { join } from "node:path";

import { readAnalyticsSamples } from "./analyticsRecorder.js";
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
}

interface CandidateObservation {
  won: boolean;
  ask: number;
  returnRoi: number;
}

type BaseStrategyCandidate = Omit<
  StrategyCandidate,
  "confidence" | "riskFlags" | "qualityScore" | "evDeltaVsCurrent"
>;

export class StrategyAnalysisEngine {
  constructor(private readonly dataDir: string) {}

  async analyze(settings: StrategyAnalysisSettings, nowMs = Date.now()): Promise<StrategyAnalysisResponse> {
    const samples = await readAnalyticsSamples(join(this.dataDir, "analytics.jsonl"));
    return buildStrategyAnalysis(samples, settings, nowMs);
  }
}

export function buildStrategyAnalysis(
  samples: AnalyticsSample[],
  settings: StrategyAnalysisSettings,
  nowMs = Date.now(),
): StrategyAnalysisResponse {
  const currentBaseStrategies = buildCurrentStrategies(samples, settings);
  const currentEvByOutcome = new Map(
    currentBaseStrategies.map((strategy) => [strategyOutcomeKey(strategy), strategy.metrics.evRoi]),
  );
  const currentStrategies = currentBaseStrategies.map((strategy) => annotateStrategy(strategy, currentEvByOutcome));
  const candidates = SUPPORTED_MARKETS.flatMap((market) => {
    const marketSamples = samples.filter((sample) => sample.market === market);
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
      sampleCount: samples.length,
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
        metrics: simulateStrategy(marketSamples, outcome, current.entryWindowSeconds, current.minDistanceUsd, current.maxAskPrice),
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
      for (const maxAskPrice of askCaps) {
        candidates.push({
          market,
          outcome,
          entryWindowSeconds,
          minDistanceUsd,
          maxAskPrice,
          metrics: simulateStrategy(samples, outcome, entryWindowSeconds, minDistanceUsd, maxAskPrice),
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
): StrategyMetrics {
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
    if (!isPositiveFinite(ask) || ask > maxAskPrice || !sample.winningOutcome) {
      continue;
    }

    const won = sample.winningOutcome === outcome;
    observations.push({
      won,
      ask,
      returnRoi: won ? 1 / ask - 1 : -1,
    });
  }

  const returns = observations.map((observation) => observation.returnRoi);
  const tradeCount = observations.length;
  const winCount = observations.filter((observation) => observation.won).length;
  const lossCount = tradeCount - winCount;

  return {
    sampleCount: samples.length,
    signalCount,
    tradeCount,
    winCount,
    lossCount,
    quoteCoverage: signalCount > 0 ? tradeCount / signalCount : 0,
    winRate: tradeCount > 0 ? winCount / tradeCount : undefined,
    averageAsk: tradeCount > 0 ? mean(observations.map((observation) => observation.ask)) : undefined,
    evRoi: tradeCount > 0 ? mean(returns) : undefined,
    maxDrawdown: maxDrawdown(returns),
  };
}

function findSignalTick(
  sample: AnalyticsSample,
  outcome: Outcome,
  entryWindowSeconds: number,
  minDistanceUsd: number,
): AnalyticsTickPoint | undefined {
  return sample.ticks
    .filter((tick) => tick.secondsToEnd > 0 && tick.secondsToEnd <= entryWindowSeconds)
    .sort((left, right) => left.timestampMs - right.timestampMs)
    .find((tick) => outcomeDistance(tick, outcome) >= minDistanceUsd);
}

function outcomeDistance(tick: AnalyticsTickPoint, outcome: Outcome): number {
  return outcome === "UP" ? tick.distanceUsd : -tick.distanceUsd;
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
  } else if (metrics.tradeCount < MIN_RELIABLE_TRADES) {
    flags.push("few_trades");
  }
  if (metrics.signalCount > 0 && metrics.quoteCoverage < MIN_RELIABLE_QUOTE_COVERAGE) {
    flags.push("low_quote_coverage");
  }
  if (metrics.evRoi !== undefined && metrics.evRoi <= 0) {
    flags.push("negative_ev");
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
    !riskFlags.includes("high_drawdown")
  ) {
    return "high";
  }
  if (
    metrics.tradeCount >= MIN_RELIABLE_TRADES &&
    metrics.quoteCoverage >= MIN_RELIABLE_QUOTE_COVERAGE &&
    metrics.evRoi !== undefined &&
    metrics.evRoi > 0
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

function isPositiveFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

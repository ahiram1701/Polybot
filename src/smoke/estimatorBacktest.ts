import { join } from "node:path";

import { QUOTE_MATCH_WINDOW_MS, readAnalyticsSamples } from "../analyticsRecorder.js";
import { applyCalibration, buildCalibrationMap, type CalibrationSample } from "../calibration.js";
import { loadConfig } from "../config.js";
import { calculateExpectedValue } from "../expectedValue.js";
import { calculateTradeFeeUsd, defaultTakerFeeRateBps } from "../fees.js";
import { getEntryWindowSeconds, getMinDistanceUsd, SUPPORTED_MARKETS } from "../markets.js";
import { estimateWinProbabilityBySimilarity, type SimilarityObservation } from "../similarityGate.js";
import type { MarketSymbol, Outcome } from "../types.js";

/**
 * Walk-forward sweep of the ESTIMATOR feeding the EV gate (the gate knobs stay at the deployed
 * config). Dimensions:
 *   estimador  {exact, knn3, knn6}   — exact per-outcome counting vs similarity with 3 or 6 features
 *   halfLife   {inf, 3, 7, 14} días  — recency decay of neighbour weights (knn only)
 *   prior      {0.5, ask}            — k-NN prior anchor (knn only)
 *   calibración {off, on}            — empirical map built ONLY from previously taken trades (no
 *                                      look-ahead; mirrors the runtime ledger source)
 * Adoption rule (pre-committed): a variant only becomes default if net$ >= the EXACT baseline AND its
 * calibration error is not worse.
 *
 * Run: npx tsx src/smoke/estimatorBacktest.ts
 */
const STAKE_USD = 1;

interface Entry {
  market: MarketSymbol;
  outcome: Outcome;
  ask: number;
  won: boolean;
  result: number;
  secondsToEnd: number;
  absDistanceUsd: number;
  velocityUsdPerSecond?: number;
  spread?: number;
  quoteSkew?: number;
  atMs: number;
}

type EstimatorKind = "exact" | "knn3" | "knn6";

interface Variant {
  estimator: EstimatorKind;
  halfLifeDays?: number;
  priorAsk: boolean;
  calibrated: boolean;
}

interface Result {
  trades: number;
  wins: number;
  net: number;
  calibrationErrorSum: number;
}

async function main(): Promise<void> {
  const { config } = loadConfig(["--mode", "sim"]);
  const all = await readAnalyticsSamples(join(config.dataDir, "analytics.jsonl"));
  const minExpectedRoi = config.evMinExpectedRoi ?? 0.01;
  const safetyMargin = config.evSafetyMargin ?? 0.03;
  const minHistory = config.evMinHistoryTrades ?? 15;

  const entriesByMarket = new Map<MarketSymbol, Entry[]>();
  for (const market of SUPPORTED_MARKETS) {
    const dist =
      config.minDistanceFloorUsdByMarket?.[market] ?? getMinDistanceUsd(config.minDistanceUsdByMarket, market);
    const win = getEntryWindowSeconds(config.entryWindowSecondsByMarket, market, config.entryWindowSeconds);
    const cap = config.maxAskPriceByMarketOutcome?.[market]?.UP ?? config.maxAskPriceCeiling ?? 0.85;
    const samples = all
      .filter((sample) => sample.market === market && sample.winningOutcome)
      .sort((left, right) => left.windowStartMs - right.windowStartMs);

    const entries: Entry[] = [];
    for (const sample of samples) {
      const ticks = [...sample.ticks].sort((left, right) => left.timestampMs - right.timestampMs);
      const signalIndex = ticks.findIndex(
        (tick) => tick.secondsToEnd > 0 && tick.secondsToEnd <= win && Math.abs(tick.distanceUsd) >= dist,
      );
      if (signalIndex < 0) {
        continue;
      }
      const signalTick = ticks[signalIndex];
      const outcome: Outcome = signalTick.distanceUsd >= 0 ? "UP" : "DOWN";
      const quote = sample.quotes
        .map((q) => ({ q, d: Math.abs(q.timestampMs - signalTick.timestampMs) }))
        .filter((item) => item.d <= QUOTE_MATCH_WINDOW_MS)
        .sort((left, right) => left.d - right.d)[0]?.q;
      if (!quote) {
        continue;
      }
      const ask = outcome === "UP" ? quote.upBestAsk : quote.downBestAsk;
      if (ask == null || !(ask > 0) || ask > cap) {
        continue;
      }
      const bid = outcome === "UP" ? quote.upBestBid : quote.downBestBid;
      const oppositeAsk = outcome === "UP" ? quote.downBestAsk : quote.upBestAsk;
      const previous = signalIndex > 0 ? ticks[signalIndex - 1] : undefined;
      const elapsed = previous ? (signalTick.timestampMs - previous.timestampMs) / 1000 : 0;
      const won = sample.winningOutcome === outcome;
      entries.push({
        market,
        outcome,
        ask,
        won,
        result: tradeResult(ask, won, market),
        secondsToEnd: signalTick.secondsToEnd,
        absDistanceUsd: Math.abs(signalTick.distanceUsd),
        velocityUsdPerSecond:
          previous && elapsed > 0 ? (signalTick.distanceUsd - previous.distanceUsd) / elapsed : undefined,
        spread: bid != null && bid > 0 ? ask - bid : undefined,
        quoteSkew: oppositeAsk != null && oppositeAsk > 0 ? oppositeAsk - ask : undefined,
        atMs: signalTick.timestampMs,
      });
    }
    entriesByMarket.set(market, entries);
  }

  const totalEntries = [...entriesByMarket.values()].reduce((sum, list) => sum + list.length, 0);
  console.log(
    `Muestras: ${all.length} | señales candidatas bajo el cap actual: ${totalEntries} | gate: margen=${safetyMargin} hist=${minHistory}\n`,
  );

  const variants: Variant[] = [{ estimator: "exact", priorAsk: false, calibrated: false }];
  for (const estimator of ["knn3", "knn6"] as EstimatorKind[]) {
    for (const halfLifeDays of [undefined, 3, 7, 14]) {
      for (const priorAsk of [false, true]) {
        variants.push({ estimator, halfLifeDays, priorAsk, calibrated: false });
      }
    }
  }
  // Calibración: sobre el baseline exacto y sobre el mejor knn "plano" (se agregan aquí explícitas).
  variants.push({ estimator: "exact", priorAsk: false, calibrated: true });
  variants.push({ estimator: "knn6", priorAsk: true, calibrated: true });
  variants.push({ estimator: "knn6", priorAsk: false, calibrated: true });

  const rows: { variant: Variant; agg: Result }[] = [];
  for (const variant of variants) {
    const agg: Result = { trades: 0, wins: 0, net: 0, calibrationErrorSum: 0 };
    for (const market of SUPPORTED_MARKETS) {
      const result = runVariant(entriesByMarket.get(market) ?? [], variant, { safetyMargin, minExpectedRoi, minHistory });
      agg.trades += result.trades;
      agg.wins += result.wins;
      agg.net += result.net;
      agg.calibrationErrorSum += result.calibrationErrorSum;
    }
    rows.push({ variant, agg });
  }

  rows.sort((left, right) => right.agg.net - left.agg.net);
  console.log("=== Variantes (ordenadas por net $ desc) ===");
  console.log("  estimador  halfLife  prior  calib | trades  win%   net$     ROI%   calErr");
  for (const { variant, agg } of rows) {
    const tag = variant.estimator === "exact" && !variant.calibrated ? "  <= BASELINE" : "";
    const hl = variant.estimator === "exact" ? "  -" : variant.halfLifeDays === undefined ? "inf" : String(variant.halfLifeDays);
    const calErr = agg.trades > 0 ? (agg.calibrationErrorSum / agg.trades).toFixed(3) : "-";
    console.log(
      `  ${variant.estimator.padEnd(9)}  ${hl.padStart(5)}    ${variant.priorAsk ? "ask " : "0.5 "}  ${variant.calibrated ? "on " : "off"} | ` +
        `${String(agg.trades).padStart(5)}  ${pct(agg.wins, agg.trades).padStart(4)}  ${fmtNet(agg.net)}  ${roi(agg).padStart(6)}  ${calErr}${tag}`,
    );
  }
}

function runVariant(
  entries: Entry[],
  variant: Variant,
  gate: { safetyMargin: number; minExpectedRoi: number; minHistory: number },
): Result {
  const exactHistory: Record<Outcome, { wins: number; trades: number }> = {
    UP: { wins: 0, trades: 0 },
    DOWN: { wins: 0, trades: 0 },
  };
  const pool: (SimilarityObservation & { entry: Entry })[] = [];
  const takenPredictions: CalibrationSample[] = [];
  const result: Result = { trades: 0, wins: 0, net: 0, calibrationErrorSum: 0 };

  for (const entry of entries) {
    let winCount: number;
    let tradeCount: number;
    if (variant.estimator === "exact") {
      winCount = exactHistory[entry.outcome].wins;
      tradeCount = exactHistory[entry.outcome].trades;
    } else {
      const rich = variant.estimator === "knn6";
      const estimate = estimateWinProbabilityBySimilarity(
        pool,
        {
          secondsToEnd: entry.secondsToEnd,
          favorableDistanceUsd: entry.absDistanceUsd,
          ask: entry.ask,
          velocityUsdPerSecond: rich ? entry.velocityUsdPerSecond : undefined,
          spread: rich ? entry.spread : undefined,
          quoteSkew: rich ? entry.quoteSkew : undefined,
        },
        {
          priorProbability: variant.priorAsk ? entry.ask : 0.5,
          recencyHalfLifeDays: variant.halfLifeDays,
          nowMs: entry.atMs,
        },
      );
      tradeCount = Math.round(estimate.effectiveSampleSize);
      winCount = Math.min(tradeCount, Math.round(estimate.winProbability * tradeCount));
    }

    if (tradeCount >= gate.minHistory) {
      const feeFraction = (defaultTakerFeeRateBps(entry.market) / 10_000) * (1 - entry.ask);
      const calibration =
        variant.calibrated && takenPredictions.length > 0 ? buildCalibrationMap(takenPredictions) : undefined;
      const ev = calculateExpectedValue({
        capitalUsd: STAKE_USD,
        askPrice: entry.ask,
        winCount,
        tradeCount,
        safetyMargin: gate.safetyMargin,
        minExpectedRoi: gate.minExpectedRoi + feeFraction,
        calibration,
      });
      if (ev.passesRecommendedEntry) {
        result.trades += 1;
        result.net += entry.result;
        result.calibrationErrorSum += Math.abs(ev.adjustedWinProbability - (entry.won ? 1 : 0));
        if (entry.won) {
          result.wins += 1;
        }
        // Runtime parity: the ledger stores the PRE-calibration shrinkage probability of taken trades.
        const raw = variant.calibrated
          ? applyCalibrationInverseSafe(ev.adjustedWinProbability, winCount, tradeCount, entry.ask)
          : ev.adjustedWinProbability;
        takenPredictions.push({ predicted: raw, won: entry.won });
      }
    }

    exactHistory[entry.outcome].trades += 1;
    exactHistory[entry.outcome].wins += entry.won ? 1 : 0;
    pool.push({
      secondsToEnd: entry.secondsToEnd,
      favorableDistanceUsd: entry.absDistanceUsd,
      ask: entry.ask,
      won: entry.won,
      velocityUsdPerSecond: entry.velocityUsdPerSecond,
      spread: entry.spread,
      quoteSkew: entry.quoteSkew,
      atMs: entry.atMs,
      entry,
    });
    // Rolling training window: keeps the sweep tractable (k-NN is O(pool) per entry) and mirrors the
    // engine's WALK_FORWARD_TRAINING_WINDOW idea of training on recent history.
    if (pool.length > 3000) {
      pool.shift();
    }
  }
  return result;
}

/** The ledger records the pre-calibration probability; recompute it for calibration training parity. */
function applyCalibrationInverseSafe(
  _calibrated: number,
  winCount: number,
  tradeCount: number,
  ask: number,
): number {
  // Recompute the raw shrinkage probability directly (cheaper and exact vs inverting the map).
  const strength = 2;
  return Math.min(Math.max((winCount + strength * Math.min(Math.max(ask, 0.05), 0.95)) / (tradeCount + strength), 0.05), 0.95);
}

function tradeResult(ask: number, won: boolean, market: MarketSymbol): number {
  const shares = STAKE_USD / ask;
  const fee = calculateTradeFeeUsd({ shares, price: ask, feeRateBps: defaultTakerFeeRateBps(market) });
  const payout = won ? shares : 0;
  return payout - STAKE_USD - fee;
}

function roi(result: Result): string {
  return result.trades > 0 ? `${((100 * result.net) / (result.trades * STAKE_USD)).toFixed(1)}%` : "-";
}

function pct(part: number, total: number): string {
  return total > 0 ? `${((100 * part) / total).toFixed(0)}%` : "-";
}

function fmtNet(net: number): string {
  return `${net >= 0 ? "+" : "-"}$${Math.abs(net).toFixed(2)}`.padStart(8);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

import { join } from "node:path";

import { QUOTE_MATCH_WINDOW_MS, readAnalyticsSamples } from "../analyticsRecorder.js";
import { loadConfig } from "../config.js";
import { calculateExpectedValue } from "../expectedValue.js";
import { calculateTradeFeeUsd, defaultTakerFeeRateBps } from "../fees.js";
import { getEntryWindowSeconds, getMinDistanceUsd, SUPPORTED_MARKETS } from "../markets.js";
import type { MarketSymbol, Outcome } from "../types.js";

/**
 * Walk-forward parameter SWEEP for the expected-value gate over the recorded analytics samples. For each
 * combination of gate knobs (ask ceiling, safety margin, min history, prior strength) it replays the
 * momentum entries chronologically and, using only PAST outcomes (no look-ahead), applies the same
 * fee-aware EV check the live bot uses (calculateExpectedValue). It then aggregates net P&L / win% / ROI
 * across all markets and prints every combo sorted by net $, so we can pick the config that maximizes net
 * out-of-sample without look-ahead. The current defaults are marked as BASELINE for comparison.
 *
 * Run: npx tsx src/smoke/evGateBacktest.ts
 */
const STAKE_USD = 1;

// Precomputed, gate-independent per-would-be-trade record so the sweep only re-runs the cheap gate check.
interface Entry {
  market: MarketSymbol;
  outcome: Outcome;
  ask: number;
  won: boolean;
  result: number; // net $ for a $1 stake if taken
}

interface Knobs {
  maxAsk: number;
  safetyMargin: number;
  minHistory: number;
  priorStrength: number;
}

interface Bucket {
  trades: number;
  wins: number;
  net: number;
}

const ASK_CEILINGS = [0.6, 0.65, 0.7, 0.85];
const SAFETY_MARGINS = [0.03, 0.05, 0.08];
const MIN_HISTORIES = [10, 15, 25];
const PRIOR_STRENGTHS = [2, 4, 8];

async function main(): Promise<void> {
  const { config } = loadConfig(["--mode", "sim"]);
  const path = join(config.dataDir, "analytics.jsonl");
  const all = await readAnalyticsSamples(path);
  const minExpectedRoi = config.evMinExpectedRoi ?? 0.01;

  // Build the chronological list of would-be entries per market (independent of the gate knobs).
  const entriesByMarket = new Map<MarketSymbol, Entry[]>();
  for (const market of SUPPORTED_MARKETS) {
    // Use the DISTANCE FLOOR the live bot actually trades at (ETH ~0.1, DOGE ~3e-5), not the stale
    // per-market default (ETH 5, DOGE 5e-4). Otherwise ETH/DOGE produce zero entries and the sweep is
    // BTC-only — which would hide exactly the markets (ETH) where the recent losses happened.
    const dist =
      config.minDistanceFloorUsdByMarket?.[market] ?? getMinDistanceUsd(config.minDistanceUsdByMarket, market);
    const win = getEntryWindowSeconds(config.entryWindowSecondsByMarket, market, config.entryWindowSeconds);
    const samples = all
      .filter((sample) => sample.market === market && sample.winningOutcome)
      .sort((left, right) => left.windowStartMs - right.windowStartMs);

    const entries: Entry[] = [];
    for (const sample of samples) {
      const signalTick = sample.ticks
        .filter((tick) => tick.secondsToEnd > 0 && tick.secondsToEnd <= win)
        .sort((left, right) => left.timestampMs - right.timestampMs)
        .find((tick) => Math.abs(tick.distanceUsd) >= dist);
      if (!signalTick) {
        continue;
      }
      const outcome: Outcome = signalTick.distanceUsd >= 0 ? "UP" : "DOWN";
      const quote = sample.quotes
        .map((q) => ({ q, d: Math.abs(q.timestampMs - signalTick.timestampMs) }))
        .filter((item) => item.d <= QUOTE_MATCH_WINDOW_MS)
        .sort((left, right) => left.d - right.d)[0]?.q;
      if (!quote) {
        continue;
      }
      const ask = outcome === "UP" ? quote.upBestAsk : quote.downBestAsk;
      if (ask == null || !(ask > 0)) {
        continue;
      }
      const won = sample.winningOutcome === outcome;
      entries.push({ market, outcome, ask, won, result: tradeResult(ask, won, market) });
    }
    entriesByMarket.set(market, entries);
  }

  const totalEntries = [...entriesByMarket.values()].reduce((sum, list) => sum + list.length, 0);
  console.log(`Muestras: ${all.length} | señales candidatas: ${totalEntries}`);
  console.log(
    `Baseline (config actual): ask<=${config.maxAskPriceCeiling ?? 0.85} margen=${config.evSafetyMargin ?? 0.03} ` +
      `hist=${config.evMinHistoryTrades ?? 10} prior=2\n`,
  );

  const baseline: Knobs = {
    maxAsk: config.maxAskPriceCeiling ?? 0.85,
    safetyMargin: config.evSafetyMargin ?? 0.03,
    minHistory: config.evMinHistoryTrades ?? 10,
    priorStrength: 2,
  };

  const rows: { knobs: Knobs; agg: Bucket; isBaseline: boolean }[] = [];
  for (const maxAsk of dedupeWith(ASK_CEILINGS, baseline.maxAsk)) {
    for (const safetyMargin of dedupeWith(SAFETY_MARGINS, baseline.safetyMargin)) {
      for (const minHistory of dedupeWith(MIN_HISTORIES, baseline.minHistory)) {
        for (const priorStrength of dedupeWith(PRIOR_STRENGTHS, baseline.priorStrength)) {
          const knobs = { maxAsk, safetyMargin, minHistory, priorStrength };
          const agg = { trades: 0, wins: 0, net: 0 };
          for (const market of SUPPORTED_MARKETS) {
            const b = runGate(entriesByMarket.get(market) ?? [], market, knobs, minExpectedRoi);
            agg.trades += b.trades;
            agg.wins += b.wins;
            agg.net += b.net;
          }
          rows.push({ knobs, agg, isBaseline: sameKnobs(knobs, baseline) });
        }
      }
    }
  }

  rows.sort((left, right) => right.agg.net - left.agg.net);
  console.log("=== Barrido (ordenado por net $ desc) ===");
  console.log("  ask   margen  hist  prior | trades  win%   net$     ROI%");
  for (const row of rows) {
    const tag = row.isBaseline ? "  <= BASELINE" : "";
    const { maxAsk, safetyMargin, minHistory, priorStrength } = row.knobs;
    console.log(
      `  ${maxAsk.toFixed(2)}  ${safetyMargin.toFixed(2)}    ${String(minHistory).padStart(2)}    ${priorStrength}   | ` +
        `${String(row.agg.trades).padStart(5)}  ${winRate(row.agg).padStart(4)}  ${fmtNet(row.agg.net)}  ${roi(row.agg).padStart(6)}${tag}`,
    );
  }

  const best = rows[0];
  const baselineRow = rows.find((row) => row.isBaseline);
  console.log("\n=== Desglose por mercado: GANADOR vs BASELINE ===");
  console.log(
    `GANADOR  ask<=${best.knobs.maxAsk} margen=${best.knobs.safetyMargin} hist=${best.knobs.minHistory} prior=${best.knobs.priorStrength}` +
      `  -> trades=${best.agg.trades} win=${winRate(best.agg)} net=${fmtNet(best.agg.net)} ROI=${roi(best.agg)}`,
  );
  perMarketBreakdown(entriesByMarket, best.knobs, minExpectedRoi);
  if (baselineRow) {
    console.log(
      `\nBASELINE ask<=${baselineRow.knobs.maxAsk} margen=${baselineRow.knobs.safetyMargin} hist=${baselineRow.knobs.minHistory} prior=${baselineRow.knobs.priorStrength}` +
        `  -> trades=${baselineRow.agg.trades} win=${winRate(baselineRow.agg)} net=${fmtNet(baselineRow.agg.net)} ROI=${roi(baselineRow.agg)}`,
    );
    perMarketBreakdown(entriesByMarket, baselineRow.knobs, minExpectedRoi);
    const delta = best.agg.net - baselineRow.agg.net;
    console.log(`\nMejora del ganador vs baseline: ${fmtNet(delta)} (${delta >= 0 ? "mejor" : "PEOR"}).`);
  }
}

function runGate(entries: Entry[], market: MarketSymbol, knobs: Knobs, minExpectedRoi: number): Bucket {
  const history: Record<Outcome, { wins: number; trades: number }> = {
    UP: { wins: 0, trades: 0 },
    DOWN: { wins: 0, trades: 0 },
  };
  const bucket: Bucket = { trades: 0, wins: 0, net: 0 };
  for (const entry of entries) {
    if (entry.ask > knobs.maxAsk) {
      continue; // ask ceiling
    }
    const h = history[entry.outcome];
    if (h.trades >= knobs.minHistory) {
      const feeFraction = (defaultTakerFeeRateBps(market) / 10_000) * (1 - entry.ask);
      const ev = calculateExpectedValue({
        capitalUsd: STAKE_USD,
        askPrice: entry.ask,
        winCount: h.wins,
        tradeCount: h.trades,
        safetyMargin: knobs.safetyMargin,
        minExpectedRoi: minExpectedRoi + feeFraction,
        priorStrength: knobs.priorStrength,
      });
      if (ev.passesRecommendedEntry) {
        bucket.trades += 1;
        bucket.net += entry.result;
        if (entry.won) {
          bucket.wins += 1;
        }
      }
    }
    h.trades += 1;
    if (entry.won) {
      h.wins += 1;
    }
  }
  return bucket;
}

function perMarketBreakdown(
  entriesByMarket: Map<MarketSymbol, Entry[]>,
  knobs: Knobs,
  minExpectedRoi: number,
): void {
  for (const market of SUPPORTED_MARKETS) {
    const b = runGate(entriesByMarket.get(market) ?? [], market, knobs, minExpectedRoi);
    console.log(`   ${market}: trades=${b.trades} win=${winRate(b)} net=${fmtNet(b.net)} ROI=${roi(b)}`);
  }
}

function dedupeWith(values: number[], extra: number): number[] {
  return [...new Set([...values, extra])];
}

function sameKnobs(left: Knobs, right: Knobs): boolean {
  return (
    left.maxAsk === right.maxAsk &&
    left.safetyMargin === right.safetyMargin &&
    left.minHistory === right.minHistory &&
    left.priorStrength === right.priorStrength
  );
}

function tradeResult(ask: number, won: boolean, market: MarketSymbol): number {
  const shares = STAKE_USD / ask;
  const fee = calculateTradeFeeUsd({ shares, price: ask, feeRateBps: defaultTakerFeeRateBps(market) });
  const payout = won ? shares : 0;
  return payout - STAKE_USD - fee;
}

function roi(bucket: Bucket): string {
  return bucket.trades > 0 ? `${((100 * bucket.net) / (bucket.trades * STAKE_USD)).toFixed(1)}%` : "-";
}

function winRate(bucket: Bucket): string {
  return bucket.trades > 0 ? `${((100 * bucket.wins) / bucket.trades).toFixed(0)}%` : "-";
}

function fmtNet(net: number): string {
  return `${net >= 0 ? "+" : "-"}$${Math.abs(net).toFixed(2)}`.padStart(8);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

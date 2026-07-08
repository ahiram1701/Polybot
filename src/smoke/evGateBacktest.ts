import { join } from "node:path";

import { QUOTE_MATCH_WINDOW_MS, readAnalyticsSamples } from "../analyticsRecorder.js";
import { loadConfig } from "../config.js";
import { calculateExpectedValue } from "../expectedValue.js";
import { calculateTradeFeeUsd, defaultTakerFeeRateBps } from "../fees.js";
import { getEntryWindowSeconds, getMinDistanceUsd, SUPPORTED_MARKETS } from "../markets.js";
import type { MarketSymbol } from "../types.js";

/**
 * Walk-forward backtest comparing the momentum strategy WITH vs WITHOUT the expected-value gate,
 * over the recorded analytics samples. The gate only ever uses PAST outcomes (no look-ahead): for
 * each would-be trade it estimates the win rate from the (market, outcome) history seen so far, then
 * applies the same fee-aware EV check the live bot uses (calculateExpectedValue).
 *
 * Run: npx tsx src/smoke/evGateBacktest.ts
 */
const STAKE_USD = 1;

async function main(): Promise<void> {
  const { config } = loadConfig(["--mode", "sim"]);
  const path = join(config.dataDir, "analytics.jsonl");
  const all = await readAnalyticsSamples(path);
  const safetyMargin = config.evSafetyMargin ?? 0.05;
  const minExpectedRoi = config.evMinExpectedRoi ?? 0.01;
  const minHistoryTrades = config.evMinHistoryTrades ?? 15;

  console.log(`Muestras: ${all.length} | maxAsk=${config.maxAskPrice} safetyMargin=${safetyMargin} minHist=${minHistoryTrades}`);

  for (const market of SUPPORTED_MARKETS) {
    const dist = getMinDistanceUsd(config.minDistanceUsdByMarket, market);
    const win = getEntryWindowSeconds(config.entryWindowSecondsByMarket, market, config.entryWindowSeconds);
    const samples = all
      .filter((sample) => sample.market === market && sample.winningOutcome)
      .sort((left, right) => left.windowStartMs - right.windowStartMs);

    const history: Record<string, { wins: number; trades: number }> = {
      UP: { wins: 0, trades: 0 },
      DOWN: { wins: 0, trades: 0 },
    };
    const noGate = { trades: 0, wins: 0, net: 0 };
    const gate = { trades: 0, wins: 0, net: 0 };

    for (const sample of samples) {
      const signalTick = sample.ticks
        .filter((tick) => tick.secondsToEnd > 0 && tick.secondsToEnd <= win)
        .sort((left, right) => left.timestampMs - right.timestampMs)
        .find((tick) => Math.abs(tick.distanceUsd) >= dist);
      if (!signalTick) {
        continue;
      }
      const outcome = signalTick.distanceUsd >= 0 ? "UP" : "DOWN";
      const quote = sample.quotes
        .map((q) => ({ q, d: Math.abs(q.timestampMs - signalTick.timestampMs) }))
        .filter((item) => item.d <= QUOTE_MATCH_WINDOW_MS)
        .sort((left, right) => left.d - right.d)[0]?.q;
      if (!quote) {
        continue;
      }
      const ask = outcome === "UP" ? quote.upBestAsk : quote.downBestAsk;
      if (ask == null || !(ask > 0) || ask > config.maxAskPrice) {
        continue;
      }
      const won = sample.winningOutcome === outcome;
      const result = tradeResult(ask, won, market);

      noGate.trades += 1;
      noGate.net += result;
      if (won) {
        noGate.wins += 1;
      }

      const h = history[outcome];
      if (h.trades >= minHistoryTrades) {
        const feeFraction = (defaultTakerFeeRateBps(market) / 10_000) * (1 - ask);
        const ev = calculateExpectedValue({
          capitalUsd: STAKE_USD,
          askPrice: ask,
          winCount: h.wins,
          tradeCount: h.trades,
          safetyMargin,
          minExpectedRoi: minExpectedRoi + feeFraction,
        });
        if (ev.passesRecommendedEntry) {
          gate.trades += 1;
          gate.net += result;
          if (won) {
            gate.wins += 1;
          }
        }
      }
      h.trades += 1;
      if (won) {
        h.wins += 1;
      }
    }

    console.log(
      `${market}: SIN gate -> trades=${noGate.trades} win=${winRate(noGate)} neto=$${noGate.net.toFixed(2)} ROI=${roi(noGate)} | ` +
        `CON gate -> trades=${gate.trades} win=${winRate(gate)} neto=$${gate.net.toFixed(2)} ROI=${roi(gate)}`,
    );
  }
}

function tradeResult(ask: number, won: boolean, market: MarketSymbol): number {
  const shares = STAKE_USD / ask;
  const fee = calculateTradeFeeUsd({ shares, price: ask, feeRateBps: defaultTakerFeeRateBps(market) });
  const payout = won ? shares : 0;
  return payout - STAKE_USD - fee;
}

function roi(bucket: { trades: number; net: number }): string {
  return bucket.trades > 0 ? `${((100 * bucket.net) / (bucket.trades * STAKE_USD)).toFixed(1)}%` : "-";
}

function winRate(bucket: { trades: number; wins: number }): string {
  return bucket.trades > 0 ? `${((100 * bucket.wins) / bucket.trades).toFixed(0)}%` : "-";
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

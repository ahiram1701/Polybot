import { join } from "node:path";

import { QUOTE_MATCH_WINDOW_MS, readAnalyticsSamples } from "../analyticsRecorder.js";
import { loadConfig } from "../config.js";
import { calculateExpectedValue } from "../expectedValue.js";
import { calculateTradeFeeUsd, defaultTakerFeeRateBps } from "../fees.js";
import { getEntryWindowSeconds, getMinDistanceUsd, SUPPORTED_MARKETS } from "../markets.js";
import type { AnalyticsQuotePoint, MarketSymbol, Outcome } from "../types.js";

/**
 * MAKER vs TAKER backtest on identical signals. Today the bot always crosses the spread (taker,
 * ~7% x p x (1-p) fee per leg — verified on-chain). This measures what a passive limit BUY on the same
 * signal would have kept, with the two real maker costs included:
 *   - missed fills (no fill => the opportunity is LOST, not $0)
 *   - adverse selection (you get filled more often exactly when price turns against you) — visible as
 *     the win% gap between filled maker entries and taker entries.
 * Fill rule (conservative lower bound): the limit at price L counts as FILLED only if a LATER quote in
 * the same window shows bestAsk <= L (the market traded through our price). Quotes are sampled every
 * few seconds (no tape), so true fill rates are likely somewhat higher.
 *
 * Decision criterion (fixed before running): a maker variant is promising only if its net$ >= taker
 * net$ on the same signals in >= 2 of 3 markets.
 *
 * Run: npx tsx src/smoke/makerBacktest.ts
 */
const STAKE_USD = 1;
const TICK = 0.01;

type Variant = "taker" | "join" | "mid" | "near";
const MAKER_VARIANTS: Exclude<Variant, "taker">[] = ["join", "mid", "near"];

interface Bucket {
  signals: number;
  filled: number;
  wins: number;
  net: number;
}

function emptyBucket(): Bucket {
  return { signals: 0, filled: 0, wins: 0, net: 0 };
}

function limitPrice(variant: Exclude<Variant, "taker">, bid: number, ask: number): number {
  if (variant === "join") {
    return bid;
  }
  if (variant === "mid") {
    return Math.floor(((bid + ask) / 2) / TICK) * TICK;
  }
  return Math.max(bid, ask - TICK); // near: one tick inside the spread, never below the bid
}

async function main(): Promise<void> {
  const { config } = loadConfig(["--mode", "sim"]);
  const all = await readAnalyticsSamples(join(config.dataDir, "analytics.jsonl"));
  const safetyMargin = config.evSafetyMargin ?? 0.03;
  const minExpectedRoi = config.evMinExpectedRoi ?? 0.01;
  const minHistoryTrades = config.evMinHistoryTrades ?? 15;
  const maxAsk = config.maxAskPrice ?? 0.8;

  console.log(`Muestras: ${all.length} | maxAsk=${maxAsk} margen=${safetyMargin} hist=${minHistoryTrades}`);
  console.log("Regla de fill maker: bestAsk posterior <= L (cota inferior; sin tape real)\n");

  for (const market of SUPPORTED_MARKETS) {
    const dist = config.minDistanceFloorUsdByMarket?.[market] ?? getMinDistanceUsd(config.minDistanceUsdByMarket, market);
    const win = getEntryWindowSeconds(config.entryWindowSecondsByMarket, market, config.entryWindowSeconds);
    const samples = all
      .filter((sample) => sample.market === market && sample.winningOutcome)
      .sort((left, right) => left.windowStartMs - right.windowStartMs);

    const history: Record<Outcome, { wins: number; trades: number }> = {
      UP: { wins: 0, trades: 0 },
      DOWN: { wins: 0, trades: 0 },
    };
    const buckets: Record<Variant, Bucket> = {
      taker: emptyBucket(),
      join: emptyBucket(),
      mid: emptyBucket(),
      near: emptyBucket(),
    };

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
      const ask = getAsk(quote, outcome);
      const bid = getBid(quote, outcome);
      if (ask == null || !(ask > 0) || ask > maxAsk || bid == null || !(bid > 0) || bid >= ask) {
        continue;
      }

      // Same EV gate as live: only setups the bot would actually take (walk-forward, no look-ahead).
      const h = history[outcome];
      const won = sample.winningOutcome === outcome;
      let passes = false;
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
        passes = ev.passesRecommendedEntry;
      }
      h.trades += 1;
      if (won) {
        h.wins += 1;
      }
      if (!passes) {
        continue;
      }

      // TAKER baseline: fill at bestAsk with the taker fee.
      buckets.taker.signals += 1;
      buckets.taker.filled += 1;
      const takerShares = STAKE_USD / ask;
      const takerFee = calculateTradeFeeUsd({ shares: takerShares, price: ask, feeRateBps: defaultTakerFeeRateBps(market) });
      buckets.taker.net += (won ? takerShares : 0) - STAKE_USD - takerFee;
      if (won) {
        buckets.taker.wins += 1;
      }

      // MAKER variants: filled only if a later quote's ask crosses down to our limit. Fee $0.
      const laterQuotes = sample.quotes
        .filter((q) => q.timestampMs > quote.timestampMs)
        .sort((left, right) => left.timestampMs - right.timestampMs);
      for (const variant of MAKER_VARIANTS) {
        const bucket = buckets[variant];
        bucket.signals += 1;
        const L = limitPrice(variant, bid, ask);
        if (!(L > 0)) {
          continue;
        }
        const filled = laterQuotes.some((q) => {
          const laterAsk = getAsk(q, outcome);
          return laterAsk !== undefined && laterAsk <= L;
        });
        if (!filled) {
          continue;
        }
        bucket.filled += 1;
        const shares = STAKE_USD / L;
        bucket.net += (won ? shares : 0) - STAKE_USD;
        if (won) {
          bucket.wins += 1;
        }
      }
    }

    console.log(`${market} (señales con gate: ${buckets.taker.signals})`);
    console.log("  variante | fill% | win% llenadas | net$    | vs taker");
    for (const variant of ["taker", ...MAKER_VARIANTS] as Variant[]) {
      const b = buckets[variant];
      const fillRate = b.signals > 0 ? (100 * b.filled) / b.signals : 0;
      const winRate = b.filled > 0 ? (100 * b.wins) / b.filled : 0;
      const delta = b.net - buckets.taker.net;
      console.log(
        `  ${variant.padEnd(8)} | ${fillRate.toFixed(0).padStart(4)}% | ${winRate.toFixed(0).padStart(4)}%         | ` +
          `${fmt(b.net).padStart(8)} | ${variant === "taker" ? "—" : fmt(delta)}`,
      );
    }
    console.log("");
  }
}

function getAsk(quote: AnalyticsQuotePoint, outcome: Outcome): number | undefined {
  return outcome === "UP" ? quote.upBestAsk : quote.downBestAsk;
}

function getBid(quote: AnalyticsQuotePoint, outcome: Outcome): number | undefined {
  return outcome === "UP" ? quote.upBestBid : quote.downBestBid;
}

function fmt(net: number): string {
  return `${net >= 0 ? "+" : "-"}$${Math.abs(net).toFixed(2)}`;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

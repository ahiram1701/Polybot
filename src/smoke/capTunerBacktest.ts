import { join } from "node:path";
import { readFile } from "node:fs/promises";

import { summarizeAskBands } from "../askBands.js";
import { recommendAskCap } from "../askCapTuner.js";
import { loadConfig } from "../config.js";
import { calculateTradePnl } from "../pnl.js";
import { SUPPORTED_MARKETS } from "../markets.js";
import type { MarketSymbol, TradeAttempt } from "../types.js";

/**
 * Chronological replay of the ask-cap tuner rule over the REAL live ledger: every simulated 24h the
 * tuner recomputes each market's cap from the bands realized SO FAR, and a trade only counts if its
 * ask was under the simulated cap at that moment. Compared against fixed caps (0.65 deployed, 0.85
 * ceiling).
 *
 * Caveat (stated upfront): the ledger only contains trades the bot ACTUALLY made, so raising the cap
 * can only re-admit trades from eras when the cap was higher — the replay measures mostly whether the
 * rule SUBTRACTS bad trades and keeps good ones, which is exactly its job.
 *
 * Run: npx tsx src/smoke/capTunerBacktest.ts
 */

const DAY_MS = 86_400_000;

async function main(): Promise<void> {
  const { config } = loadConfig(["--mode", "sim"]);
  const state = JSON.parse(await readFile(join(config.dataDir, "state.json"), "utf8")) as {
    tradedMarkets: Record<string, TradeAttempt>;
  };
  const trades = Object.values(state.tradedMarkets)
    .filter((trade) => trade.mode === "live" && trade.resolved && typeof trade.bestAsk === "number" && trade.kind !== "arb")
    .sort((left, right) => left.createdAtMs - right.createdAtMs);
  console.log(`Trades live resueltos en el ledger: ${trades.length}\n`);

  const fixed065 = evaluate(trades, () => 0.65);
  const fixed085 = evaluate(trades, () => 0.85);

  // Tuner dinámico: recalcula cada 24h con lo visto hasta ese momento.
  const caps = new Map<MarketSymbol, number>(SUPPORTED_MARKETS.map((market) => [market, 0.65]));
  let nextTuneAtMs = trades.length > 0 ? trades[0].createdAtMs + DAY_MS : 0;
  const seen: TradeAttempt[] = [];
  const tuned = { trades: 0, wins: 0, net: 0 };
  const capHistory: string[] = [];
  for (const trade of trades) {
    while (trade.createdAtMs >= nextTuneAtMs) {
      for (const market of SUPPORTED_MARKETS) {
        const bands = summarizeAskBands(seen, "live", {}, { market });
        const reco = recommendAskCap(bands, caps.get(market)!);
        if (reco) {
          caps.set(market, reco.nextCap);
          capHistory.push(
            `${new Date(nextTuneAtMs).toISOString().slice(0, 10)} ${market}: -> ${reco.nextCap.toFixed(2)} (objetivo ${reco.targetCap.toFixed(2)})`,
          );
        }
      }
      nextTuneAtMs += DAY_MS;
    }
    seen.push(trade);
    const market = trade.asset as MarketSymbol | undefined;
    const cap = market ? caps.get(market)! : 0.65;
    if ((trade.bestAsk ?? 1) <= cap) {
      const net = calculateTradePnl(trade).netUsd ?? 0;
      tuned.trades += 1;
      tuned.net += net;
      tuned.wins += trade.resolved?.won ? 1 : 0;
    }
  }

  console.log("=== Resultados (mismo ledger, distinta política de cap) ===");
  print("cap fijo 0.65 (actual)", fixed065);
  print("cap fijo 0.85 (techo) ", fixed085);
  print("tuner dinámico        ", tuned);
  console.log(`\nAjustes del tuner durante el replay: ${capHistory.length}`);
  for (const line of capHistory.slice(0, 15)) {
    console.log("  " + line);
  }
  if (capHistory.length > 15) {
    console.log(`  ... (+${capHistory.length - 15})`);
  }
  const delta = tuned.net - fixed065.net;
  console.log(`\nTuner vs cap fijo 0.65: ${delta >= 0 ? "+" : "-"}$${Math.abs(delta).toFixed(2)} (${delta >= 0 ? "NO pierde: adoptable" : "PIERDE: no adoptar"})`);
}

function evaluate(trades: TradeAttempt[], capFor: (market?: string) => number): { trades: number; wins: number; net: number } {
  const bucket = { trades: 0, wins: 0, net: 0 };
  for (const trade of trades) {
    if ((trade.bestAsk ?? 1) <= capFor(trade.asset)) {
      bucket.trades += 1;
      bucket.net += calculateTradePnl(trade).netUsd ?? 0;
      bucket.wins += trade.resolved?.won ? 1 : 0;
    }
  }
  return bucket;
}

function print(label: string, bucket: { trades: number; wins: number; net: number }): void {
  const win = bucket.trades > 0 ? `${((100 * bucket.wins) / bucket.trades).toFixed(0)}%` : "-";
  console.log(`  ${label} | trades=${String(bucket.trades).padStart(4)} win=${win.padStart(4)} net=${bucket.net >= 0 ? "+" : "-"}$${Math.abs(bucket.net).toFixed(2)}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

import { join } from "node:path";
import { readFile } from "node:fs/promises";

import { loadConfig } from "../config.js";
import { calculateTradePnl } from "../pnl.js";
import { SUPPORTED_MARKETS } from "../markets.js";
import type { MarketSymbol, TradeAttempt } from "../types.js";

/**
 * Replay of the REAL live ledger to pick an ask WINDOW [floor, cap] per market: which entry-price band
 * actually paid, over lifetime AND over the recent period separately. A pocket is only worth fixing if
 * it paid in both — lifetime-only winners are usually a dead regime (e.g. the old cap-0.98 era).
 *
 * Criterion (pre-committed): highest lifetime net whose RECENT net is not negative, with n>=10;
 * ties -> more trades.
 *
 * Run: npx tsx src/smoke/askWindowBacktest.ts
 */

const FLOORS = [0, 0.3, 0.45, 0.55];
const CAPS = [0.55, 0.65, 0.8, 1.01];
const RECENT_FROM_MS = Date.UTC(2026, 6, 14); // 14-jul: inicio de la corrida reciente

interface Bucket {
  n: number;
  wins: number;
  net: number;
}

function evaluate(trades: TradeAttempt[]): Bucket {
  const bucket: Bucket = { n: 0, wins: 0, net: 0 };
  for (const trade of trades) {
    bucket.n += 1;
    bucket.net += calculateTradePnl(trade).netUsd ?? 0;
    bucket.wins += trade.resolved?.won ? 1 : 0;
  }
  return bucket;
}

function fmt(bucket: Bucket): string {
  const win = bucket.n > 0 ? `${((100 * bucket.wins) / bucket.n).toFixed(0)}%` : "-";
  const net = `${bucket.net >= 0 ? "+" : "-"}$${Math.abs(bucket.net).toFixed(2)}`;
  return `n=${String(bucket.n).padStart(3)} win=${win.padStart(4)} net=${net.padStart(8)}`;
}

async function main(): Promise<void> {
  const { config } = loadConfig(["--mode", "sim"]);
  const state = JSON.parse(await readFile(join(config.dataDir, "state.json"), "utf8")) as {
    tradedMarkets: Record<string, TradeAttempt>;
  };
  const live = Object.values(state.tradedMarkets).filter(
    (trade) =>
      trade.mode === "live" &&
      trade.resolved &&
      trade.kind !== "arb" &&
      typeof trade.bestAsk === "number" &&
      trade.asset,
  );
  console.log(`Trades live resueltos: ${live.length}\n`);

  for (const market of SUPPORTED_MARKETS) {
    const marketTrades = live.filter((trade) => trade.asset === market);
    if (marketTrades.length < 10) {
      console.log(`=== ${market}: solo ${marketTrades.length} trades, se omite ===\n`);
      continue;
    }
    console.log(`=== ${market} (${marketTrades.length} trades) ===`);
    const rows: { floor: number; cap: number; life: Bucket; recent: Bucket }[] = [];
    for (const floor of FLOORS) {
      for (const cap of CAPS) {
        if (cap <= floor) {
          continue;
        }
        const inWindow = marketTrades.filter((trade) => (trade.bestAsk ?? 0) >= floor && (trade.bestAsk ?? 0) < cap);
        if (inWindow.length < 10) {
          continue;
        }
        rows.push({
          floor,
          cap,
          life: evaluate(inWindow),
          recent: evaluate(inWindow.filter((trade) => trade.createdAtMs >= RECENT_FROM_MS)),
        });
      }
    }
    rows.sort((left, right) => right.life.net - left.life.net);
    console.log(`  ${"ventana".padEnd(12)} ${"VIDA".padEnd(30)} RECIENTE (post 14-jul)`);
    for (const row of rows) {
      console.log(`  [${row.floor.toFixed(2)}-${row.cap.toFixed(2)}) ${fmt(row.life).padEnd(30)} ${fmt(row.recent)}`);
    }
    const winner = rows.find((row) => row.recent.net >= 0 && row.life.n >= 10);
    console.log(
      winner
        ? `  => GANADORA: [${winner.floor.toFixed(2)}, ${winner.cap.toFixed(2)}) (vida ${fmt(winner.life)} | reciente ${fmt(winner.recent)})\n`
        : `  => ninguna ventana cumple (recorte reciente >= 0); NO fijar ventana para ${market}\n`,
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

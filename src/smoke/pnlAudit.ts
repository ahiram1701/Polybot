/**
 * Auditoría de P&L: desglosa el resultado REAL (con el mismo `calculateTradePnl` que usa la UI)
 * por modo / tipo / mercado / periodo, leyendo `data/state.json`.
 *
 * Existe porque el número agregado del dashboard esconde de dónde sale el dinero: un mercado que
 * gana mucho en pocos trades puede tapar otro que sangra en muchos. Uso:
 *   npx tsx src/smoke/pnlAudit.ts [--all]     (--all ignora los resets de P&L)
 */
import { calculateTradePnl, isWinningTrade, filterTradesForPnlReset } from "../pnl.js";
import { StateStore } from "../stateStore.js";
import type { TradeAttempt } from "../types.js";

interface Bucket {
  n: number;
  net: number;
  stake: number;
  won: number;
  fees: number;
  askSum: number;
}

function emptyBucket(): Bucket {
  return { n: 0, net: 0, stake: 0, won: 0, fees: 0, askSum: 0 };
}

function add(bucket: Bucket, trade: TradeAttempt): void {
  const pnl = calculateTradePnl(trade);
  if (pnl.status !== "resolved") {
    return;
  }
  bucket.n += 1;
  bucket.net += pnl.netUsd ?? 0;
  bucket.stake += pnl.stakeUsd;
  bucket.won += isWinningTrade(trade) ? 1 : 0;
  bucket.askSum += trade.averageFillPrice ?? trade.bestAsk ?? 0;
}

function render(label: string, bucket: Bucket): string {
  if (bucket.n === 0) {
    return `${label.padEnd(26)} (sin trades)`;
  }
  const roi = bucket.stake > 0 ? (100 * bucket.net) / bucket.stake : 0;
  return [
    label.padEnd(26),
    `n=${String(bucket.n).padStart(4)}`,
    `win=${((100 * bucket.won) / bucket.n).toFixed(1).padStart(5)}%`,
    `net=$${bucket.net.toFixed(2).padStart(9)}`,
    `ROI=${roi.toFixed(2).padStart(7)}%`,
    `$/trade=${(bucket.net / bucket.n).toFixed(3).padStart(7)}`,
    `ask=${(bucket.askSum / bucket.n).toFixed(3)}`,
  ].join("  ");
}

function group(trades: TradeAttempt[], key: (trade: TradeAttempt) => string): Map<string, Bucket> {
  const map = new Map<string, Bucket>();
  for (const trade of trades) {
    const k = key(trade);
    let bucket = map.get(k);
    if (!bucket) {
      bucket = emptyBucket();
      map.set(k, bucket);
    }
    add(bucket, trade);
  }
  return map;
}

function section(title: string, map: Map<string, Bucket>): void {
  console.log(`\n===== ${title} =====`);
  for (const k of [...map.keys()].sort()) {
    console.log(render(k, map.get(k)!));
  }
}

async function main(): Promise<void> {
  const includeAll = process.argv.includes("--all");
  const store = new StateStore("data");
  await store.load();
  const resetAtMs = store.getPnlResetAtMs();
  const all = store.listTrades().filter((trade) => trade.resolved);
  const trades = includeAll ? all : filterTradesForPnlReset(all, resetAtMs);
  console.log(
    `trades resueltos: ${trades.length}/${all.length}  ${includeAll ? "(historial completo)" : `(post-reset ${JSON.stringify(resetAtMs)})`}`,
  );

  for (const mode of ["sim", "live"] as const) {
    const scoped = trades.filter((trade) => trade.mode === mode);
    if (scoped.length === 0) {
      continue;
    }
    const total = emptyBucket();
    for (const trade of scoped) {
      add(total, trade);
    }
    console.log(`\n########## ${mode.toUpperCase()} ##########`);
    console.log(render("TOTAL", total));
    section(
      `${mode}: mercado x tipo`,
      group(scoped, (t) => `${t.kind === "arb" ? "ARB" : "DIR"} ${t.asset}`),
    );
    section(
      `${mode}: mercado x lado (direccional)`,
      group(
        scoped.filter((t) => t.kind !== "arb"),
        (t) => `${t.asset} ${t.outcome}`,
      ),
    );
    section(
      `${mode}: por dia (ultimos)`,
      group(scoped, (t) => new Date(t.createdAtMs).toISOString().slice(0, 10)),
    );
  }
}

await main();

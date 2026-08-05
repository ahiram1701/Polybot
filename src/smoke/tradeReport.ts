/**
 * El corte estandar de una corrida, con las medidas correctas.
 *
 * Sustituye a los scripts de analisis de usar y tirar: al escribirlos de cero cada vez es facil colar
 * una medida sesgada sin darse cuenta (paso: se uso "quitar los 5 mejores" como prueba de suerte, que
 * penaliza estructuralmente a una estrategia con perdidas topadas). Aqui las medidas viven en
 * src/tradeStats.ts, con tests.
 *
 * Uso:  npx tsx src/smoke/tradeReport.ts [--mode sim|live] [--since <epochMs>]
 */
import { readFileSync } from "node:fs";

import { calculateTradePnl, isWinningTrade } from "../pnl.js";
import { bootstrapCI, trimmedNet, winLossProfile } from "../tradeStats.js";
import type { MarketSymbol, Mode, TradeAttempt } from "../types.js";

const MARKETS: MarketSymbol[] = ["BTC", "ETH", "DOGE"];

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function loadTrades(): TradeAttempt[] {
  const byId = new Map<string, TradeAttempt>();
  for (const line of readFileSync("data/trades.jsonl", "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      const trade: TradeAttempt = record.trade ?? record;
      if (trade?.id) byId.set(trade.id, trade);
    } catch {
      /* linea corrupta: se ignora */
    }
  }
  return [...byId.values()];
}

function main(): void {
  const mode = (argValue("--mode") ?? "sim") as Mode;
  const since = Number(argValue("--since") ?? 0);
  const trades = loadTrades()
    .filter((t) => t.mode === mode && t.resolved && t.createdAtMs > since)
    .sort((a, b) => a.createdAtMs - b.createdAtMs);

  if (trades.length === 0) {
    console.log(`Sin trades resueltos para mode=${mode} desde ${since}.`);
    return;
  }

  const nets = trades.map((t) => calculateTradePnl(t).netUsd ?? 0);
  const stake = trades.reduce((a, t) => a + calculateTradePnl(t).stakeUsd, 0);
  const total = nets.reduce((a, b) => a + b, 0);
  const wins = trades.filter(isWinningTrade).length;

  console.log(`=== ${trades.length} trades resueltos (${mode}${since ? `, desde ${new Date(since).toISOString().slice(0, 16)}` : ""}) ===`);
  console.log(`  neto=$${total.toFixed(2)}  win=${((100 * wins) / trades.length).toFixed(1)}%  ROI=${((100 * total) / stake).toFixed(2)}%`);

  const ci = bootstrapCI(nets);
  console.log(`\n--- Intervalo bootstrap (5.000 remuestreos, sin asumir normalidad) ---`);
  console.log(`  95% del rango:  [$${ci.lowerUsd.toFixed(2)}, $${ci.upperUsd.toFixed(2)}]`);
  console.log(`  sale ganando en el ${(100 * ci.positiveShare).toFixed(1)}% de los remuestreos`);
  console.log(`  ${ci.lowerUsd > 0 ? "El rango NO incluye el cero: resultado solido." : "El rango incluye el cero: aun no concluyente."}`);

  const trimmed = trimmedNet(nets, 5);
  console.log(`\n--- Concentracion (recorte SIMETRICO, no solo los ganadores) ---`);
  console.log(`  quitando 5 por cada cola: $${trimmed.netUsd.toFixed(2)} en ${trimmed.count} trades`);
  console.log(`  ${trimmed.netUsd > 0 ? "Sigue positivo sin las colas: el beneficio esta repartido." : "Sin las colas se vuelve negativo: depende de pocas operaciones."}`);

  const profile = winLossProfile(nets);
  console.log(`\n--- Perfil ganancia/perdida ---`);
  console.log(`  ${profile.wins} ganadoras (media $${profile.averageWinUsd.toFixed(2)}, mejor $${profile.bestUsd.toFixed(2)})`);
  console.log(`  ${profile.losses} perdedoras (media $${profile.averageLossUsd.toFixed(2)}, peor $${profile.worstUsd.toFixed(2)})`);
  console.log(`  ratio pago/riesgo: ${profile.payoffRatio.toFixed(2)}x`);

  console.log(`\n--- Por mercado ---`);
  for (const market of MARKETS) {
    const group = trades.filter((t) => t.asset === market && t.kind !== "arb");
    if (group.length === 0) {
      console.log(`  ${market}: sin trades`);
      continue;
    }
    const groupNets = group.map((t) => calculateTradePnl(t).netUsd ?? 0);
    const groupCi = bootstrapCI(groupNets, { iterations: 2_000 });
    console.log(
      `  ${market}: n=${String(group.length).padStart(3)} neto=$${groupNets.reduce((a, b) => a + b, 0).toFixed(2).padStart(8)} win=${((100 * group.filter(isWinningTrade).length) / group.length).toFixed(1).padStart(5)}% gana en el ${(100 * groupCi.positiveShare).toFixed(0).padStart(3)}% de los remuestreos`,
    );
  }
  const arb = trades.filter((t) => t.kind === "arb");
  if (arb.length > 0) {
    console.log(`  ARB: n=${arb.length} neto=$${arb.reduce((a, t) => a + (calculateTradePnl(t).netUsd ?? 0), 0).toFixed(2)}`);
  }
}

main();

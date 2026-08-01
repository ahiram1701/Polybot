/**
 * ¿Puede un modelo probabilistico superar al MERCADO?
 *
 * Entrena una regresion logistica walk-forward sobre las ventanas observadas y la compara contra el
 * baseline honesto: el ask solo. El ask ES la probabilidad que el mercado asigna, asi que superarlo
 * fuera de muestra es exactamente la definicion de tener ventaja.
 *
 * CRITERIO FIJADO ANTES DE CORRERLO: el modelo se adopta solo si (a) mejora el log-loss contra el
 * ask-solo fuera de muestra Y (b) da P&L walk-forward positivo. Las dos cosas.
 *
 * Sin look-ahead: en cada bloque se entrena SOLO con ventanas anteriores.
 */
import { readAnalyticsSamples } from "../analyticsRecorder.js";
import {
  extractFeatures,
  fitLogistic,
  logLoss,
  predictLogistic,
  FEATURE_NAMES,
  type FeatureRow,
} from "../directionalModel.js";
import { calculateTradeFeeUsd, defaultTakerFeeRateBps } from "../fees.js";
import type { MarketSymbol, Outcome } from "../types.js";

const DECISION_SECONDS_TO_END = 30;
const MIN_TRAIN = 300;
const RETRAIN_EVERY = 100;
const STAKE_USD = 5;
const MARGIN = 0.03; // margen sobre el ask, igual que el gate actual
const MARKETS: MarketSymbol[] = ["BTC", "ETH", "DOGE"];
const OUTCOMES: Outcome[] = ["UP", "DOWN"];

interface Scored {
  row: FeatureRow;
  market: MarketSymbol;
  pModel: number;
}

async function main(): Promise<void> {
  const samples = await readAnalyticsSamples("data/analytics.jsonl");
  console.log(`Ventanas observadas: ${samples.length}`);

  const rows: { row: FeatureRow; market: MarketSymbol }[] = [];
  for (const sample of samples) {
    for (const outcome of OUTCOMES) {
      const row = extractFeatures(sample, outcome, DECISION_SECONDS_TO_END);
      if (row) rows.push({ row, market: sample.market });
    }
  }
  rows.sort((a, b) => a.row.windowStartMs - b.row.windowStartMs);
  console.log(`Filas con features completas (a ${DECISION_SECONDS_TO_END}s del cierre): ${rows.length}\n`);
  if (rows.length < MIN_TRAIN + RETRAIN_EVERY) {
    console.log("Datos insuficientes para walk-forward.");
    return;
  }

  // --- Walk-forward: entrena con el pasado, predice el bloque siguiente ---
  const scored: Scored[] = [];
  for (let start = MIN_TRAIN; start < rows.length; start += RETRAIN_EVERY) {
    const train = rows.slice(0, start).map((r) => r.row);
    const model = fitLogistic(train);
    for (const item of rows.slice(start, start + RETRAIN_EVERY)) {
      scored.push({ row: item.row, market: item.market, pModel: predictLogistic(model, item.row.x) });
    }
  }
  const labels = scored.map((s) => s.row.y);
  const llModel = logLoss(scored.map((s) => s.pModel), labels);
  const llAsk = logLoss(scored.map((s) => s.row.ask), labels);
  const llBase = logLoss(scored.map(() => labels.reduce((a, b) => a + b, 0) / labels.length), labels);

  console.log("=== (a) CALIDAD DE LA PROBABILIDAD (log-loss, menos es mejor) ===");
  console.log(`  tasa base (siempre lo mismo): ${llBase.toFixed(4)}`);
  console.log(`  EL MERCADO (ask solo):        ${llAsk.toFixed(4)}   <- la vara a superar`);
  console.log(`  modelo logistico:             ${llModel.toFixed(4)}`);
  const mejora = llAsk - llModel;
  console.log(`  ${mejora > 0 ? "SUPERA" : "NO supera"} al mercado por ${Math.abs(mejora).toFixed(4)} (${((100 * mejora) / llAsk).toFixed(1)}%)`);

  // --- (b) P&L walk-forward operando cuando el modelo le gana al ask por el margen ---
  console.log(`\n=== (b) P&L walk-forward (opera si P(modelo) >= ask + ${MARGIN}) ===`);
  let net = 0;
  let trades = 0;
  let wins = 0;
  const perMarket = new Map<MarketSymbol, { n: number; net: number; wins: number }>();
  for (const s of scored) {
    if (s.pModel < s.row.ask + MARGIN) continue;
    const feeRateBps = defaultTakerFeeRateBps(s.market);
    const shares = STAKE_USD / s.row.ask;
    const fee = calculateTradeFeeUsd({ shares, price: s.row.ask, feeRateBps });
    const pnl = (s.row.y === 1 ? shares : 0) - STAKE_USD - fee;
    net += pnl;
    trades += 1;
    if (s.row.y === 1) wins += 1;
    const acc = perMarket.get(s.market) ?? { n: 0, net: 0, wins: 0 };
    acc.n += 1;
    acc.net += pnl;
    acc.wins += s.row.y;
    perMarket.set(s.market, acc);
  }
  console.log(
    `  n=${trades}  net=$${net.toFixed(2)}  win=${trades ? ((100 * wins) / trades).toFixed(1) : "--"}%  ROI=${trades ? ((100 * net) / (trades * STAKE_USD)).toFixed(1) : "--"}%`,
  );
  for (const m of MARKETS) {
    const acc = perMarket.get(m);
    if (acc) console.log(`    ${m}: n=${acc.n} net=$${acc.net.toFixed(2)} win=${((100 * acc.wins) / acc.n).toFixed(1)}%`);
  }

  // --- Que aprendio (signo y peso relativo) ---
  const finalModel = fitLogistic(rows.map((r) => r.row));
  console.log(`\n=== Que pesa en el modelo (features estandarizadas) ===`);
  FEATURE_NAMES.map((name, j) => ({ name, w: finalModel.weights[j] }))
    .sort((a, b) => Math.abs(b.w) - Math.abs(a.w))
    .forEach(({ name, w }) => console.log(`  ${name.padEnd(18)} ${w >= 0 ? "+" : ""}${w.toFixed(3)}`));

  console.log(`\n=== VEREDICTO segun el criterio prefijado ===`);
  const pasaA = mejora > 0;
  const pasaB = net > 0;
  console.log(`  (a) supera al ask en log-loss: ${pasaA ? "SI" : "NO"}`);
  console.log(`  (b) P&L walk-forward positivo: ${pasaB ? "SI" : "NO"}`);
  console.log(`  -> ${pasaA && pasaB ? "ADOPTAR" : "NO adoptar"}`);
}

await main();

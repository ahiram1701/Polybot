/**
 * Walk-forward de las mejoras del gate de EV, medido sobre el ledger real.
 *
 * Contrafactual: para cada trade REALMENTE tomado se recalcula que habria decidido el gate bajo cada
 * variante y, si la variante lo habria rechazado, su P&L sale del total. La probabilidad cruda se
 * reconstruye exactamente de winCount/tradeCount/ask (los trades viejos no la guardaban).
 *
 * Limitacion honesta: solo puede medir trades que SI se tomaron, asi que evalua "¿filtra los malos?",
 * no "¿encuentra buenos nuevos?". Es la pregunta correcta aqui porque ambas mejoras son filtros
 * restrictivos. Los sondeos de exploracion (historial<15) se excluyen: entran por otra puerta y son
 * identicos en todas las variantes.
 *
 * Criterio de adopcion FIJADO ANTES de correrlo: adoptar solo si mejora el P&L walk-forward Y no
 * empeora la discriminacion por mercado.
 */
import { readFileSync } from "node:fs";

import { applyCalibration, buildCalibrationMap, type CalibrationSample } from "../calibration.js";
import { calculateAdjustedWinProbability, PRIOR_STRENGTH } from "../expectedValue.js";
import { calculateTradePnl, isWinningTrade } from "../pnl.js";
import type { MarketSymbol, TradeAttempt } from "../types.js";

const MIN_HISTORY = 15;
const SAFETY_MARGIN = 0.03;
const MIN_EXPECTED_ROI = 0.01;
const FEE_RATE = 0.07;

interface Arm {
  name: string;
  perMarketCalibration: boolean;
  globalCalibration: boolean;
  maxClaimedEdge?: number;
}

const ARMS: Arm[] = [
  { name: "BASE (hoy: global, sin techo)", perMarketCalibration: false, globalCalibration: true },
  { name: "sin calibracion", perMarketCalibration: false, globalCalibration: false },
  { name: "calibracion POR MERCADO", perMarketCalibration: true, globalCalibration: false },
  { name: "BASE + techo edge 0.20", perMarketCalibration: false, globalCalibration: true, maxClaimedEdge: 0.2 },
  { name: "POR MERCADO + techo 0.15", perMarketCalibration: true, globalCalibration: false, maxClaimedEdge: 0.15 },
  { name: "POR MERCADO + techo 0.20", perMarketCalibration: true, globalCalibration: false, maxClaimedEdge: 0.2 },
  { name: "POR MERCADO + techo 0.25", perMarketCalibration: true, globalCalibration: false, maxClaimedEdge: 0.25 },
];

function loadTrades(): TradeAttempt[] {
  const byId = new Map<string, TradeAttempt>();
  for (const line of readFileSync("data/trades.jsonl", "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      const t: TradeAttempt = rec.trade ?? rec;
      if (t?.id) byId.set(t.id, t);
    } catch {
      /* linea corrupta: se ignora */
    }
  }
  return [...byId.values()]
    .filter((t) => t.resolved && t.kind !== "arb" && t.expectedValue && t.asset)
    .sort((a, b) => a.createdAtMs - b.createdAtMs);
}

/** Probabilidad ANTES de calibrar: guardada si existe, reconstruida si el trade es viejo. */
function rawProbability(t: TradeAttempt): number | undefined {
  const ev = t.expectedValue;
  if (!ev) return undefined;
  if (typeof ev.rawWinProbability === "number") return ev.rawWinProbability;
  if (typeof ev.winCount === "number" && typeof ev.tradeCount === "number" && ev.tradeCount > 0) {
    return calculateAdjustedWinProbability(ev.winCount, ev.tradeCount, ev.askPrice, PRIOR_STRENGTH);
  }
  return undefined;
}

function passesGate(adjusted: number, ask: number): boolean {
  const passesSafety = adjusted >= ask + SAFETY_MARGIN;
  const expectedRoi = adjusted / ask - 1;
  return passesSafety && expectedRoi >= MIN_EXPECTED_ROI + FEE_RATE * (1 - ask);
}

function discrimination(rows: { p: number; won: boolean }[]): number | undefined {
  if (rows.length < 10) return undefined;
  const sorted = [...rows].sort((a, b) => a.p - b.p);
  const half = Math.floor(sorted.length / 2);
  const lo = sorted.slice(0, half);
  const hi = sorted.slice(sorted.length - half);
  return (hi.filter((x) => x.won).length / hi.length - lo.filter((x) => x.won).length / lo.length) * 100;
}

function run(): void {
  const trades = loadTrades().filter((t) => (t.expectedValue?.tradeCount ?? 0) >= MIN_HISTORY);
  console.log(`Trades evaluables (no-arb, no-exploracion, con EV): ${trades.length}\n`);

  for (const arm of ARMS) {
    // Historial walk-forward: solo pares ANTERIORES a cada trade alimentan su mapa.
    const globalHistory: CalibrationSample[] = [];
    const perMarket = new Map<MarketSymbol, CalibrationSample[]>();
    let net = 0;
    let taken = 0;
    let wins = 0;
    const byMarketRows = new Map<MarketSymbol, { p: number; won: boolean }[]>();

    for (const t of trades) {
      const raw = rawProbability(t);
      const ask = t.expectedValue?.askPrice;
      if (raw === undefined || typeof ask !== "number" || ask <= 0) continue;
      const market = t.asset as MarketSymbol;

      let adjusted = raw;
      if (arm.perMarketCalibration) {
        adjusted = applyCalibration(buildCalibrationMap(perMarket.get(market) ?? []), raw);
      } else if (arm.globalCalibration) {
        adjusted = applyCalibration(buildCalibrationMap(globalHistory), raw);
      }
      if (arm.maxClaimedEdge !== undefined) {
        adjusted = Math.min(adjusted, ask + arm.maxClaimedEdge);
      }

      const won = isWinningTrade(t);
      if (passesGate(adjusted, ask)) {
        net += calculateTradePnl(t).netUsd ?? 0;
        taken += 1;
        if (won) wins += 1;
        byMarketRows.set(market, [...(byMarketRows.get(market) ?? []), { p: adjusted, won }]);
      }
      // El historial de calibracion se alimenta de lo OBSERVADO (todos los trades reales), no solo de
      // los que la variante habria tomado: es la informacion que el bot realmente habria tenido.
      globalHistory.push({ predicted: raw, won });
      perMarket.set(market, [...(perMarket.get(market) ?? []), { predicted: raw, won }]);
    }

    const discParts: string[] = [];
    for (const [market, rows] of [...byMarketRows.entries()].sort()) {
      const d = discrimination(rows);
      discParts.push(`${market} ${d === undefined ? `n=${rows.length}` : `${d >= 0 ? "+" : ""}${d.toFixed(1)}pp`}`);
    }
    console.log(
      `${arm.name.padEnd(30)} net=$${net.toFixed(2).padStart(8)}  trades=${String(taken).padStart(3)}  win=${taken ? ((100 * wins) / taken).toFixed(1) : "--"}%  | disc: ${discParts.join("  ")}`,
    );
  }
}

run();

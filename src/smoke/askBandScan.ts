/**
 * ¿En que BANDA DE PRECIO esta el dinero? La comision de Polymarket es shares*bps*p*(1-p): maxima
 * en 0.50 y casi nula en los extremos. Comprar cerca de 0.50 paga ~3.5% del stake en comision; a 0.95
 * paga ~0.35%. Esto barre el resultado por tramo de ask con tres formas de puntuar:
 *   JUZGADO  - solo ventanas con veredicto claro (optimista: excluye los empates, que suelen perder)
 *   ESPERADO - las ventanas sin veredicto valen su probabilidad implicita en el libro (lo mas justo)
 *   PEOR     - las ventanas sin veredicto son moneda al aire (pesimista)
 * Run: npx tsx src/smoke/askBandScan.ts [--bps 4] [--window 42]
 */
import { join } from "node:path";
import { QUOTE_MATCH_WINDOW_MS, readAnalyticsSamples } from "../analyticsRecorder.js";
import { resolveSampleTruth } from "../analyticsTruth.js";
import { loadConfig } from "../config.js";
import { calculateTradeFeeUsd, defaultTakerFeeRateBps } from "../fees.js";
import { SUPPORTED_MARKETS } from "../markets.js";
import type { AnalyticsSample, MarketSymbol, Outcome } from "../types.js";

const arg = (f: string, d: number) => { const i = process.argv.indexOf(f); return i >= 0 ? Number(process.argv[i+1]) : d; };
const BPS = arg("--bps", 4), WIN = arg("--window", 42);
const BANDS = [0, 0.3, 0.45, 0.55, 0.65, 0.75, 0.85, 0.92, 0.96, 1.01];

function net(ask: number, won: boolean, m: MarketSymbol): number {
  const sh = 1 / ask;
  return (won ? sh : 0) - 1 - calculateTradeFeeUsd({ shares: sh, price: ask, feeRateBps: defaultTakerFeeRateBps(m) });
}
function mid(b?: number, a?: number) { return b != null && a != null ? (b + a) / 2 : (b ?? a); }

/** Probabilidad implicita en el libro al cierre para `outcome` (null si no hay quote usable). */
function impliedProb(s: AnalyticsSample, outcome: Outcome): number | undefined {
  const near = s.quotes.filter((q) => q.secondsToEnd >= 0 && q.secondsToEnd <= 30)
    .sort((a, b) => a.secondsToEnd - b.secondsToEnd);
  for (const q of near) {
    const up = mid(q.upBestBid, q.upBestAsk), down = mid(q.downBestBid, q.downBestAsk);
    const p = up ?? (down !== undefined ? 1 - down : undefined);
    if (p === undefined) continue;
    return outcome === "UP" ? p : 1 - p;
  }
  return undefined;
}

const { config } = loadConfig(["--mode", "sim"]);
const all = await readAnalyticsSamples(join(config.dataDir, "analytics.jsonl"));

console.log(`Entrada: momentum >= ${BPS} bps dentro de los ultimos ${WIN}s\n`);
for (const market of SUPPORTED_MARKETS) {
  const samples = all.filter((s) => s.market === market);
  type B = { n: number; judged: number; wins: number; net: number; exp: number; worst: number; res: number[] };
  const bands = new Map<number, B>();
  for (const s of samples) {
    const minD = (BPS / 10_000) * s.openingPrice;
    const tick = s.ticks.filter((t) => t.secondsToEnd > 0 && t.secondsToEnd <= WIN)
      .sort((a, b) => a.timestampMs - b.timestampMs).find((t) => Math.abs(t.distanceUsd) >= minD);
    if (!tick) continue;
    const outcome: Outcome = tick.distanceUsd >= 0 ? "UP" : "DOWN";
    const q = s.quotes.map((x) => ({ x, g: Math.abs(x.timestampMs - tick.timestampMs) }))
      .filter((i) => i.g <= QUOTE_MATCH_WINDOW_MS).sort((a, b) => a.g - b.g)[0]?.x;
    if (!q) continue;
    const ask = outcome === "UP" ? q.upBestAsk : q.downBestAsk;
    if (ask == null || !(ask > 0) || ask >= 1) continue;
    const bi = BANDS.findIndex((e, i) => ask >= e && ask < BANDS[i + 1]);
    if (bi < 0) continue;
    const b = bands.get(bi) ?? { n: 0, judged: 0, wins: 0, net: 0, exp: 0, worst: 0, res: [] };
    b.n++;
    const truth = resolveSampleTruth(s);
    const winNet = net(ask, true, market), loseNet = net(ask, false, market);
    if (truth) {
      const won = truth.outcome === outcome;
      b.judged++; if (won) b.wins++;
      const r = won ? winNet : loseNet;
      b.net += r; b.exp += r; b.worst += r; b.res.push(r);
    } else {
      const p = impliedProb(s, outcome) ?? 0.5;
      b.exp += p * winNet + (1 - p) * loseNet;
      b.worst += 0.5 * winNet + 0.5 * loseNet;
    }
    bands.set(bi, b);
  }
  console.log(`===== ${market} =====`);
  console.log("  banda ask   |    n  sinJuez |  win%  | JUZGADO ROI%   t  | ESPERADO ROI% | PEOR ROI%");
  for (const bi of [...bands.keys()].sort((a, b) => a - b)) {
    const b = bands.get(bi)!;
    if (b.n < 40) continue;
    const mean = b.judged ? b.net / b.judged : 0;
    const sd = b.res.length > 1 ? Math.sqrt(b.res.reduce((s, r) => s + (r - mean) ** 2, 0) / (b.res.length - 1)) : 0;
    const t = sd > 0 ? mean / (sd / Math.sqrt(b.res.length)) : 0;
    const mark = b.exp / b.n > 0 && t >= 2 ? "  <<<" : "";
    console.log(
      `  ${BANDS[bi].toFixed(2)}-${BANDS[bi+1].toFixed(2)}   | ${String(b.n).padStart(4)} ${String(b.n-b.judged).padStart(7)} |` +
      ` ${b.judged ? (100*b.wins/b.judged).toFixed(1).padStart(5) : '  -  '}  |` +
      ` ${(100*mean).toFixed(2).padStart(10)} ${t.toFixed(1).padStart(5)} |` +
      ` ${(100*b.exp/b.n).toFixed(2).padStart(12)} | ${(100*b.worst/b.n).toFixed(2).padStart(8)}${mark}`);
  }
  console.log("");
}

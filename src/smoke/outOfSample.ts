/**
 * Guardia anti-sobreajuste: parte las muestras por la MITAD CRONOLOGICA, elige la mejor config en la
 * primera mitad (in-sample) y la mide en la segunda (out-of-sample). Un edge que no sobrevive el
 * cambio de periodo es ruido de barrido, no dinero.
 */
import { join } from "node:path";
import { QUOTE_MATCH_WINDOW_MS, readAnalyticsSamples } from "../analyticsRecorder.js";
import { resolveSampleTruth } from "../analyticsTruth.js";
import { loadConfig } from "../config.js";
import { calculateTradeFeeUsd, defaultTakerFeeRateBps } from "../fees.js";
import { SUPPORTED_MARKETS } from "../markets.js";
import type { AnalyticsSample, MarketSymbol, Outcome } from "../types.js";

const BPS = [1, 2, 4, 8, 16], WINS = [20, 42, 60, 120];
const BANDS: [number, number][] = [[0.65, 0.85], [0.85, 0.92], [0.92, 0.96], [0.96, 1], [0.75, 0.96], [0.85, 1], [0.01, 1]];

function net(ask: number, won: boolean, m: MarketSymbol) {
  const sh = 1 / ask;
  return (won ? sh : 0) - 1 - calculateTradeFeeUsd({ shares: sh, price: ask, feeRateBps: defaultTakerFeeRateBps(m) });
}
function mid(b?: number, a?: number) { return b != null && a != null ? (b + a) / 2 : (b ?? a); }
function impliedProb(s: AnalyticsSample, o: Outcome) {
  for (const q of s.quotes.filter((x) => x.secondsToEnd >= 0 && x.secondsToEnd <= 30).sort((a, b) => a.secondsToEnd - b.secondsToEnd)) {
    const up = mid(q.upBestBid, q.upBestAsk), dn = mid(q.downBestBid, q.downBestAsk);
    const p = up ?? (dn !== undefined ? 1 - dn : undefined);
    if (p !== undefined) return o === "UP" ? p : 1 - p;
  }
  return undefined;
}
/** ROI esperado por trade (ventanas sin veredicto valen su probabilidad implicita). */
function evaluate(samples: AnalyticsSample[], m: MarketSymbol, bps: number, win: number, band: [number, number]) {
  let n = 0, sum = 0, judged = 0, wins = 0;
  const res: number[] = [];
  for (const s of samples) {
    const minD = (bps / 10_000) * s.openingPrice;
    const tick = s.ticks.filter((t) => t.secondsToEnd > 0 && t.secondsToEnd <= win)
      .sort((a, b) => a.timestampMs - b.timestampMs).find((t) => Math.abs(t.distanceUsd) >= minD);
    if (!tick) continue;
    const o: Outcome = tick.distanceUsd >= 0 ? "UP" : "DOWN";
    const q = s.quotes.map((x) => ({ x, g: Math.abs(x.timestampMs - tick.timestampMs) }))
      .filter((i) => i.g <= QUOTE_MATCH_WINDOW_MS).sort((a, b) => a.g - b.g)[0]?.x;
    if (!q) continue;
    const ask = o === "UP" ? q.upBestAsk : q.downBestAsk;
    if (ask == null || ask < band[0] || ask >= band[1]) continue;
    n++;
    const truth = resolveSampleTruth(s);
    const w = net(ask, true, m), l = net(ask, false, m);
    if (truth) { const won = truth.outcome === o; judged++; if (won) wins++; const r = won ? w : l; sum += r; res.push(r); }
    else { const p = impliedProb(s, o) ?? 0.5; sum += p * w + (1 - p) * l; }
  }
  const mean = n ? sum / n : 0;
  const sd = res.length > 1 ? Math.sqrt(res.reduce((a, r) => a + (r - mean) ** 2, 0) / (res.length - 1)) : 0;
  return { n, roi: 100 * mean, netUsd: sum, t: sd > 0 && res.length ? mean / (sd / Math.sqrt(res.length)) : 0, winPct: judged ? 100 * wins / judged : 0 };
}

const { config } = loadConfig(["--mode", "sim"]);
const all = await readAnalyticsSamples(join(config.dataDir, "analytics.jsonl"));
for (const market of SUPPORTED_MARKETS) {
  const s = all.filter((x) => x.market === market).sort((a, b) => a.windowStartMs - b.windowStartMs);
  const cut = Math.floor(s.length / 2);
  const A = s.slice(0, cut), B = s.slice(cut);
  const rows = [];
  for (const bps of BPS) for (const win of WINS) for (const band of BANDS) {
    const ins = evaluate(A, market, bps, win, band);
    if (ins.n < 80) continue;
    rows.push({ bps, win, band, ins, oos: evaluate(B, market, bps, win, band) });
  }
  rows.sort((a, b) => b.ins.roi - a.ins.roi);
  console.log(`\n===== ${market} =====  (in-sample: ${A.length} muestras hasta ${new Date(A[cut-1].windowStartMs).toISOString().slice(0,10)}, out: ${B.length})`);
  console.log("  bps vent  banda      | IN-SAMPLE  n   ROI%    t  | OUT-OF-SAMPLE  n   ROI%    t   net$");
  for (const r of rows.slice(0, 8)) {
    const ok = r.oos.roi > 0 ? "  OK" : "  FALLA";
    console.log(`  ${String(r.bps).padStart(3)} ${String(r.win).padStart(4)}s ${r.band[0].toFixed(2)}-${r.band[1].toFixed(2)} |` +
      ` ${String(r.ins.n).padStart(9)} ${r.ins.roi.toFixed(2).padStart(6)} ${r.ins.t.toFixed(1).padStart(4)} |` +
      ` ${String(r.oos.n).padStart(13)} ${r.oos.roi.toFixed(2).padStart(6)} ${r.oos.t.toFixed(1).padStart(4)} ${r.oos.netUsd.toFixed(1).padStart(7)}${ok}`);
  }
}

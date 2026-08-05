/**
 * Juez definitivo: la resolucion OFICIAL de Polymarket (trades.jsonl -> trade_official_resolution /
 * resolved.officialWinningOutcome) contra la etiqueta `winningOutcome` que la muestra de analitica
 * calcula sola (finalPrice >= openingPrice). Si discrepan, todo backtest puntuado con la etiqueta
 * propia mide una realidad que no existe.
 */
import fs from "node:fs";
import { join } from "node:path";
import { readAnalyticsSamples } from "../analyticsRecorder.js";
import { loadConfig } from "../config.js";
import type { Outcome } from "../types.js";

const { config } = loadConfig(["--mode", "sim"]);
const official = new Map<string, Outcome>();
for (const line of fs.readFileSync(join(config.dataDir, "trades.jsonl"), "utf8").split("\n")) {
  if (!line.trim()) continue;
  const e = JSON.parse(line) as any;
  const w = e.officialResolution?.winningOutcome ?? e.trade?.officialResolution?.winningOutcome
    ?? e.resolution?.officialWinningOutcome ?? e.trade?.resolved?.officialWinningOutcome;
  const slug = e.slug ?? e.trade?.slug;
  if (slug && (w === "UP" || w === "DOWN")) official.set(slug, w);
}
console.log(`slugs con resolucion oficial: ${official.size}`);

const all = await readAnalyticsSamples(join(config.dataDir, "analytics.jsonl"));
const byMarket = new Map<string, { n: number; agree: number; examples: string[] }>();
for (const s of all) {
  const off = official.get(s.slug);
  if (!off || !s.winningOutcome) continue;
  const b = byMarket.get(s.market) ?? { n: 0, agree: 0, examples: [] };
  b.n++;
  if (off === s.winningOutcome) b.agree++;
  else if (b.examples.length < 3) {
    b.examples.push(`${s.slug} open=${s.openingPrice} final=${s.finalPrice} delta=${((s.finalPrice ?? 0) - s.openingPrice).toExponential(2)} nuestra=${s.winningOutcome} oficial=${off}`);
  }
  byMarket.set(s.market, b);
}
let tn = 0, ta = 0;
for (const [m, b] of [...byMarket].sort()) {
  console.log(`\n${m}: comparables=${b.n} coincide=${(100*b.agree/b.n).toFixed(2)}%  DISCREPA=${b.n-b.agree} (${(100*(b.n-b.agree)/b.n).toFixed(2)}%)`);
  for (const e of b.examples) console.log(`   ! ${e}`);
  tn += b.n; ta += b.agree;
}
console.log(`\nTOTAL: comparables=${tn} coincide=${(100*ta/tn).toFixed(2)}% DISCREPA=${tn-ta}`);

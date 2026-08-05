/**
 * ¿Cuanto se desvia el tick de apertura que capturamos respecto al inicio real de la ventana, y
 * cuanto cuesta ese desfase en etiquetas equivocadas? El precio de apertura es el termino comun de
 * TODA la estrategia: la distancia (senal) y el ganador (etiqueta) se miden contra el.
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
const all = await readAnalyticsSamples(join(config.dataDir, "analytics.jsonl"));

console.log("=== Desfase del tick de apertura (openingTickTimestampMs - windowStartMs) ===");
for (const market of ["BTC", "ETH", "DOGE"]) {
  const rows = all.filter((s) => s.market === market);
  const lags = rows.map((s) => (s.openingTickTimestampMs - s.windowStartMs) / 1000).sort((a, b) => a - b);
  const q = (p: number) => lags[Math.min(lags.length - 1, Math.floor(p * lags.length))];
  const beyond = lags.filter((l) => Math.abs(l) > 15).length;
  console.log(`${market}: n=${lags.length} min=${q(0).toFixed(1)}s p10=${q(0.1).toFixed(1)}s p50=${q(0.5).toFixed(1)}s p90=${q(0.9).toFixed(1)}s max=${q(0.999).toFixed(1)}s | |lag|>15s: ${beyond} (${(100*beyond/lags.length).toFixed(2)}%)`);
}

console.log("\n=== Fiabilidad de la etiqueta segun el desfase (solo con resolucion oficial) ===");
const EDGES = [0, 2, 5, 10, 15, 30, Infinity];
for (const market of ["BTC", "ETH", "DOGE"]) {
  const rows = all.filter((s) => s.market === market && s.winningOutcome && official.has(s.slug));
  if (rows.length < 20) { console.log(`${market}: pocos comparables (${rows.length})`); continue; }
  console.log(`${market} (n=${rows.length}):`);
  for (let i = 0; i < EDGES.length - 1; i++) {
    const b = rows.filter((s) => {
      const lag = Math.abs(s.openingTickTimestampMs - s.windowStartMs) / 1000;
      return lag >= EDGES[i] && lag < EDGES[i + 1];
    });
    if (!b.length) continue;
    const ok = b.filter((s) => official.get(s.slug) === s.winningOutcome).length;
    console.log(`   |lag| ${String(EDGES[i]).padStart(3)}-${String(EDGES[i+1]).padStart(4)}s | n=${String(b.length).padStart(4)} correcta=${(100*ok/b.length).toFixed(1)}%`);
  }
}

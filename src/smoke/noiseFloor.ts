/**
 * ¿A partir de que distancia deja de ser ruido? Cruza la etiqueta propia de cada muestra con la
 * resolucion OFICIAL y mide la fiabilidad por tramo de |finalPrice - openingPrice|. Cualquier umbral
 * de distancia por debajo del punto donde la fiabilidad se estabiliza esta operando ruido de medicion.
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

// tramos relativos (bps sobre el precio de apertura) para poder comparar mercados
const EDGES = [0, 0.25, 0.5, 1, 2, 4, 8, 16, 32, Infinity];
for (const market of ["BTC", "ETH", "DOGE"]) {
  const rows = all.filter((s) => s.market === market && s.winningOutcome && official.has(s.slug));
  if (!rows.length) continue;
  console.log(`\n=== ${market} (n=${rows.length}) — fiabilidad de la etiqueta por |delta| en bps ===`);
  console.log("   bps               |    n | correcta |  delta USD tipico");
  for (let i = 0; i < EDGES.length - 1; i++) {
    const lo = EDGES[i], hi = EDGES[i + 1];
    const bucket = rows.filter((s) => {
      const bps = (Math.abs((s.finalPrice ?? 0) - s.openingPrice) / s.openingPrice) * 10_000;
      return bps >= lo && bps < hi;
    });
    if (!bucket.length) continue;
    const ok = bucket.filter((s) => official.get(s.slug) === s.winningOutcome).length;
    const usd = bucket.map((s) => Math.abs((s.finalPrice ?? 0) - s.openingPrice)).sort((a, b) => a - b);
    const med = usd[Math.floor(usd.length / 2)];
    console.log(`   ${String(lo).padStart(5)}-${String(hi).padStart(5)}       | ${String(bucket.length).padStart(4)} |  ${(100*ok/bucket.length).toFixed(1).padStart(5)}% | ${med.toPrecision(3)}`);
  }
  const px = rows[0].openingPrice;
  console.log(`   (precio ~${px.toPrecision(6)} -> 1 bps = ${(px/10_000).toPrecision(3)} USD)`);
  const cfgDist = config.minDistanceFloorUsdByMarket?.[market as "BTC"];
  if (cfgDist) console.log(`   umbral MINIMO configurado: ${cfgDist} USD = ${((cfgDist/px)*10_000).toFixed(2)} bps`);
}

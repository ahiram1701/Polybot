/**
 * ¿La etiqueta `winningOutcome` de las muestras coincide con lo que dijo el MERCADO?
 * En los ultimos segundos el libro converge a 0/1, asi que el ultimo quote es un juez independiente
 * del ganador. Si nuestra etiqueta (derivada de openingPrice + ticks propios) discrepa, el backtest
 * esta puntuando contra una verdad inventada.
 */
import { join } from "node:path";
import { readAnalyticsSamples } from "../analyticsRecorder.js";
import { loadConfig } from "../config.js";
import { SUPPORTED_MARKETS } from "../markets.js";

const { config } = loadConfig(["--mode", "sim"]);
const all = await readAnalyticsSamples(join(config.dataDir, "analytics.jsonl"));

for (const market of SUPPORTED_MARKETS) {
  const samples = all.filter((s) => s.market === market && s.winningOutcome);
  let cmp = 0, agree = 0;
  let upLabel = 0;
  const byConf = new Map<string, { n: number; agree: number }>();
  for (const s of samples) {
    if (s.winningOutcome === "UP") upLabel++;
    // ultimo quote con ambos lados, dentro de los ultimos 25s
    const last = s.quotes
      .filter((q) => q.secondsToEnd >= 0 && q.secondsToEnd <= 25 && q.upBestBid != null && q.downBestBid != null)
      .sort((a, b) => a.secondsToEnd - b.secondsToEnd)[0];
    if (!last) continue;
    const up = last.upBestBid!, down = last.downBestBid!;
    const conf = Math.abs(up - down);
    if (conf < 0.6) continue; // solo casos donde el mercado ya lo tiene decidido
    const implied = up > down ? "UP" : "DOWN";
    cmp++;
    const ok = implied === s.winningOutcome;
    if (ok) agree++;
    const key = conf >= 0.9 ? "0.9+ (casi resuelto)" : conf >= 0.75 ? "0.75-0.9" : "0.6-0.75";
    const b = byConf.get(key) ?? { n: 0, agree: 0 };
    b.n++; if (ok) b.agree++; byConf.set(key, b);
  }
  console.log(`\n${market}: muestras=${samples.length} etiquetadas UP=${(100*upLabel/samples.length).toFixed(1)}%`);
  console.log(`  comparables=${cmp} coincide con el mercado=${(100*agree/cmp).toFixed(2)}%  DISCREPA=${cmp-agree} (${(100*(cmp-agree)/cmp).toFixed(2)}%)`);
  for (const k of [...byConf.keys()].sort().reverse()) {
    const b = byConf.get(k)!;
    console.log(`    confianza ${k.padEnd(20)} n=${String(b.n).padStart(5)} coincide=${(100*b.agree/b.n).toFixed(2)}%`);
  }
}

/**
 * ¿El TWAP publicado anticipa el resultado ANTES que el mercado?
 *
 * Es la tesis del rediseño en un número. El mercado resuelve por una media móvil de la serie TWAP, así
 * que a R segundos del cierre una fracción del desenlace ya está publicada. Si el precio del mercado
 * tarda en reflejarlo, ahí hay dinero — y si no tarda, no lo hay y hay que decirlo.
 *
 * Se compara, en cada corte de segundos-al-cierre:
 *   - qué diría la serie TWAP publicada (su último valor frente a la apertura),
 *   - qué dice el mercado (el mid del libro),
 *   - y quién acierta cuando discrepan, que es la única comparación que puede producir dinero.
 *
 * La etiqueta es `analyticsTruth`, nunca la propia del fichero: la de spot se equivoca un 12,5% y sus
 * fallos correlacionan con la señal.
 */
import { join } from "node:path";

import { readAnalyticsSamples } from "../analyticsRecorder.js";
import { scoringOutcome } from "../analyticsTruth.js";
import { loadConfig } from "../config.js";
import type { AnalyticsSample } from "../types.js";

const CORTES = [90, 60, 45, 30, 20, 15, 10, 5];

interface Fila {
  n: number;
  aciertaTwap: number;
  aciertaMercado: number;
  discrepan: number;
  ganaTwap: number;
  /** Suma del |edge| implícito cuando el TWAP acierta y el mercado no. */
  edgeCapturable: number;
}

function mid(sample: AnalyticsSample, corte: number): { up: number; secondsToEnd: number } | undefined {
  const q = [...sample.quotes]
    .filter((x) => x.secondsToEnd >= corte && x.upBestAsk !== undefined && x.upBestBid !== undefined)
    .sort((l, r) => r.secondsToEnd - l.secondsToEnd)
    .pop();
  return q ? { up: ((q.upBestAsk as number) + (q.upBestBid as number)) / 2, secondsToEnd: q.secondsToEnd } : undefined;
}

async function main(): Promise<void> {
  const { config } = loadConfig(["--mode", "sim"]);
  const todas = await readAnalyticsSamples(join(config.dataDir, "analytics.jsonl"));
  // Solo muestras con la serie que resuelve. Sin ella no hay nada que comparar.
  const utiles = todas.filter((s) => s.ticks.some((t) => t.twapPrice !== undefined));
  console.log(`muestras totales: ${todas.length} | con serie TWAP: ${utiles.length}`);
  if (utiles.length === 0) {
    console.log("Sin serie TWAP grabada no hay tesis que medir.");
    return;
  }

  const acc = new Map<number, Fila>(
    CORTES.map((c) => [c, { n: 0, aciertaTwap: 0, aciertaMercado: 0, discrepan: 0, ganaTwap: 0, edgeCapturable: 0 }]),
  );

  for (const s of utiles) {
    const verdad = scoringOutcome(s);
    if (!verdad) continue;
    for (const corte of CORTES) {
      const tick = [...s.ticks].filter((t) => t.twapPrice !== undefined && t.secondsToEnd >= corte).pop();
      const m = mid(s, corte);
      if (!tick?.twapPrice || !m) continue;
      const f = acc.get(corte)!;
      f.n += 1;
      const dirTwap = tick.twapPrice >= s.openingPrice ? "UP" : "DOWN";
      const dirMercado = m.up >= 0.5 ? "UP" : "DOWN";
      if (dirTwap === verdad) f.aciertaTwap += 1;
      if (dirMercado === verdad) f.aciertaMercado += 1;
      if (dirTwap !== dirMercado) {
        f.discrepan += 1;
        if (dirTwap === verdad) {
          f.ganaTwap += 1;
          // Lo que se habría ganado comprando el lado que dice el TWAP al precio del mercado.
          f.edgeCapturable += dirTwap === "UP" ? 1 - m.up : m.up;
        }
      }
    }
  }

  console.log();
  console.log("s.cierre      n    TWAP%  mercado%   discrepan   gana TWAP   $/op si se opera la discrepancia");
  for (const c of CORTES) {
    const f = acc.get(c)!;
    if (!f.n) continue;
    const pc = (x: number) => `${((100 * x) / f.n).toFixed(1)}%`;
    const gana = f.discrepan ? `${((100 * f.ganaTwap) / f.discrepan).toFixed(0)}%` : "—";
    // Comprar a `precio` y cobrar 1 si acierta: neto medio por operación sobre las discrepancias.
    const neto = f.discrepan ? (f.edgeCapturable - (f.discrepan - f.ganaTwap)) / f.discrepan : 0;
    console.log(
      `${String(c).padStart(6)}s ${String(f.n).padStart(6)}  ${pc(f.aciertaTwap).padStart(6)} ${pc(f.aciertaMercado).padStart(8)} ${String(f.discrepan).padStart(11)}  ${gana.padStart(9)}   ${f.discrepan ? `$${neto.toFixed(3)}` : "—"}`,
    );
  }
}

void main();

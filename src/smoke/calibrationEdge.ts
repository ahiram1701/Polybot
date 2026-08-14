/**
 * ¿Está bien PRECIADO el mercado? (no: ¿acierta?)
 *
 * Un mercado puede acertar la dirección el 99% y seguir dejando dinero encima: lo que importa es si el
 * precio iguala la frecuencia real. Se agrupan cotizaciones por precio de ask y se comparan contra
 * cuántas de esas veces ganó de verdad, con la comisión taker descontada.
 *
 * DOS controles, porque la primera versión de este estudio tenía un agujero que podía explicarlo todo:
 *
 *  1. **Separación temporal.** La etiqueta (`analyticsTruth`) se deriva del propio libro a ≤30 s del
 *     cierre. Si además se agrupan cotizaciones de esos mismos segundos, se está midiendo el libro
 *     contra sí mismo. Con `--desde/--hasta` se aleja la cotización del juez: si la brecha sobrevive a
 *     90 segundos de distancia, la circularidad ya no la explica.
 *  2. **Fuera de muestra.** Corte cronológico por la mitad. Una brecha que solo existe en la primera
 *     mitad es sobreajuste con otro nombre.
 *
 * Uso: `npx tsx src/smoke/calibrationEdge.ts --desde 90 --hasta 120`
 */
import { join } from "node:path";

import { readAnalyticsSamples } from "../analyticsRecorder.js";
import { scoringOutcome } from "../analyticsTruth.js";
import { loadConfig } from "../config.js";
import { calculateTradeFeeUsd, defaultTakerFeeRateBps } from "../fees.js";
import type { AnalyticsSample } from "../types.js";

const TRAMOS = [0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95];
const APUESTA_USD = 5;

function argNumero(bandera: string, porDefecto: number): number {
  const i = process.argv.indexOf(bandera);
  const v = i >= 0 ? Number(process.argv[i + 1]) : NaN;
  return Number.isFinite(v) ? v : porDefecto;
}

/** Neto de comprar `lado` al precio `ask`, con la comisión real. */
function neto(ask: number, gana: boolean, market: AnalyticsSample["market"]): number {
  const shares = APUESTA_USD / ask;
  const fee = calculateTradeFeeUsd({ shares, price: ask, feeRateBps: defaultTakerFeeRateBps(market) });
  return (gana ? shares : 0) - APUESTA_USD - fee;
}

interface Obs {
  tramo: number;
  gana: boolean;
  neto: number;
}

function observar(muestras: AnalyticsSample[], desde: number, hasta: number): Obs[] {
  const out: Obs[] = [];
  for (const s of muestras) {
    const verdad = scoringOutcome(s);
    if (!verdad) continue;
    // UNA observación por muestra y lado: si no, una ventana con muchas quotes pesa más que otra.
    const q = [...s.quotes]
      .filter((x) => x.secondsToEnd >= desde && x.secondsToEnd <= hasta)
      .sort((l, r) => l.secondsToEnd - r.secondsToEnd)
      .shift();
    if (!q) continue;
    for (const lado of ["UP", "DOWN"] as const) {
      const ask = lado === "UP" ? q.upBestAsk : q.downBestAsk;
      if (ask === undefined || ask <= 0 || ask >= 1) continue;
      const tramo = TRAMOS.filter((t) => ask >= t).pop();
      if (tramo === undefined) continue;
      const gana = lado === verdad;
      out.push({ tramo, gana, neto: neto(ask, gana, s.market) });
    }
  }
  return out;
}

function tabla(titulo: string, obs: Obs[]): void {
  console.log(`\n${titulo}`);
  console.log("ask       n    gana%   implic.   brecha    $/op        t");
  for (const t of TRAMOS) {
    const g = obs.filter((o) => o.tramo === t);
    if (g.length < 30) continue;
    const ganadas = g.filter((o) => o.gana).length;
    const real = ganadas / g.length;
    const netos = g.map((o) => o.neto);
    const media = netos.reduce((a, b) => a + b, 0) / netos.length;
    const sd = Math.sqrt(netos.reduce((a, b) => a + (b - media) ** 2, 0) / (netos.length - 1));
    const tStat = sd > 0 ? media / (sd / Math.sqrt(netos.length)) : 0;
    const brecha = (real - t) * 100;
    console.log(
      `${t.toFixed(2)} ${String(g.length).padStart(6)}   ${(100 * real).toFixed(1)}%    ${(100 * t).toFixed(0)}%   ${brecha >= 0 ? "+" : ""}${brecha.toFixed(1)}pp   $${media.toFixed(4)}   ${tStat.toFixed(2)}`,
    );
  }
}

async function main(): Promise<void> {
  const desde = argNumero("--desde", 0);
  const hasta = argNumero("--hasta", 60);
  const { config } = loadConfig(["--mode", "sim"]);
  const todas = await readAnalyticsSamples(join(config.dataDir, "analytics.jsonl"));
  const ordenadas = [...todas].sort((l, r) => l.windowStartMs - r.windowStartMs);

  console.log(`cotizaciones de ${desde}-${hasta}s al cierre | etiqueta: libro a <=30s`);
  console.log(`separacion entre cotizacion y juez: ${Math.max(0, desde - 30)}s`);
  console.log(`muestras: ${ordenadas.length}`);

  const corte = Math.floor(ordenadas.length / 2);
  tabla("== TODO ==", observar(ordenadas, desde, hasta));
  tabla("== primera mitad (descubrimiento) ==", observar(ordenadas.slice(0, corte), desde, hasta));
  tabla("== segunda mitad (FUERA DE MUESTRA) ==", observar(ordenadas.slice(corte), desde, hasta));
}

void main();

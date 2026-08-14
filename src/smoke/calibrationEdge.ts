/**
 * ¿Está bien PRECIADO el mercado? (no: ¿acierta?)
 *
 * Un mercado puede acertar la dirección el 99% y seguir dejando dinero: lo que importa es si el precio
 * iguala la frecuencia real. Se agrupan las cotizaciones por precio de ask y se compara contra cuántas
 * de esas veces ganó de verdad, con la comisión taker real descontada.
 *
 * Etiqueta: `analyticsTruth`, nunca la del propio fichero.
 */
import { join } from "node:path";

import { readAnalyticsSamples } from "../analyticsRecorder.js";
import { scoringOutcome } from "../analyticsTruth.js";
import { loadConfig } from "../config.js";
import { calculateTradeFeeUsd, defaultTakerFeeRateBps } from "../fees.js";

const TRAMOS = [0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.93, 0.95, 0.97, 0.99];
const VENTANA = [0, 60] as const; // últimos 60 s: donde el desenlace ya está medio determinado

async function main(): Promise<void> {
  const { config } = loadConfig(["--mode", "sim"]);
  const todas = await readAnalyticsSamples(join(config.dataDir, "analytics.jsonl"));
  const acc = new Map<number, { n: number; ganadas: number; neto: number }>();

  for (const s of todas) {
    const verdad = scoringOutcome(s);
    if (!verdad) continue;
    // Una sola observación por muestra y lado, la más cercana al centro de la ventana, para que una
    // ventana con muchas quotes no pese más que otra.
    for (const lado of ["UP", "DOWN"] as const) {
      const q = [...s.quotes]
        .filter((x) => x.secondsToEnd >= VENTANA[0] && x.secondsToEnd <= VENTANA[1])
        .sort((l, r) => l.secondsToEnd - r.secondsToEnd)
        .pop();
      const ask = lado === "UP" ? q?.upBestAsk : q?.downBestAsk;
      if (!q || ask === undefined || ask <= 0 || ask >= 1) continue;
      const tramo = TRAMOS.filter((t) => ask >= t).pop();
      if (tramo === undefined) continue;
      const f = acc.get(tramo) ?? { n: 0, ganadas: 0, neto: 0 };
      f.n += 1;
      const gana = lado === verdad;
      if (gana) f.ganadas += 1;
      // $5 de apuesta: participaciones = 5/ask, cobra 1 por participación si gana.
      const shares = 5 / ask;
      const fee = calculateTradeFeeUsd({ shares, price: ask, feeRateBps: defaultTakerFeeRateBps(s.market) });
      f.neto += (gana ? shares : 0) - 5 - fee;
      acc.set(tramo, f);
    }
  }

  console.log("ask      n    gana%   implícita   brecha    $/op tras comisión         t");
  for (const t of TRAMOS) {
    const f = acc.get(t);
    if (!f || f.n < 30) continue;
    const real = f.ganadas / f.n;
    const media = f.neto / f.n;
    // t sobre el neto por operación, asumiendo pérdida completa o ganancia (1/ask - 1).
    const sd = Math.sqrt(real * (1 - real)) * (1 / t);
    const tStat = sd > 0 ? (media / (sd * 5)) * Math.sqrt(f.n) : 0;
    console.log(
      `${t.toFixed(2)} ${String(f.n).padStart(6)}  ${(100 * real).toFixed(1)}%   ${(100 * t).toFixed(0)}%  ${((real - t) * 100 >= 0 ? "+" : "")}${((real - t) * 100).toFixed(1)}pp   $${media.toFixed(4)}   ${tStat.toFixed(2)}`,
    );
  }
}

void main();

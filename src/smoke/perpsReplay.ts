import { join } from "node:path";

import { loadConfig } from "../config.js";
import { readPerpsSamples } from "../perpsRecorder.js";
import { bucketMetrics, replayCarry, summarizeReplay, TRAMOS } from "../perpsReplay.js";
import type { PerpsSample } from "../perpsTypes.js";

/**
 * El arnes de medicion de perps.
 *
 * Juzga con la MISMA regla que el resto del proyecto, y conviene decir por que es esa y no otra:
 *
 * - **Seis tramos cronologicos, y gana el mejor PEOR TRAMO.** Nunca el neto medio. Elegir por la media
 *   premia las casillas pequenas que salieron bien por suerte, que es literalmente como se fabrico la
 *   configuracion del 8 de septiembre que luego perdio hacia delante.
 * - **Bootstrap por BLOQUES**, remuestreando cubos enteros. Dos instrumentos del mismo cubo no son dos
 *   sorteos independientes: BTC y ETH se mueven juntos. Remuestrear operaciones sueltas estrecha el
 *   intervalo y produce el "positivo el 100%" que ya enganó una vez.
 * - **`--desde <ISO>` NO corre la rejilla**, a proposito. Buscar la mejor casilla dentro del periodo de
 *   prueba lo gasta. Ese modo solo evalua la configuracion que ya estaba elegida.
 *
 *   npx tsx src/smoke/perpsReplay.ts
 *   npx tsx src/smoke/perpsReplay.ts --desde 2026-09-20T00:00:00Z
 */
async function main(): Promise<void> {
  const { config } = loadConfig(["--mode", "sim"]);
  const desdeArg = leerArg("--desde");
  const desdeMs = desdeArg ? Date.parse(desdeArg) : undefined;
  if (desdeArg && !Number.isFinite(desdeMs)) {
    throw new Error(`--desde no es una fecha ISO valida: ${desdeArg}`);
  }

  const path = join(config.dataDir, "perps-analytics.jsonl");
  const todas = await readPerpsSamples(path);
  const samples = desdeMs === undefined ? todas : todas.filter((sample) => sample.bucketStartMs >= desdeMs);

  if (samples.length === 0) {
    console.log(`Sin cubos en ${path}${desdeArg ? ` desde ${desdeArg}` : ""}.`);
    console.log("Arranca el bot con PERPS_ENABLED=true y vuelve dentro de un rato.");
    return;
  }

  resumirCaptura(samples, path);

  const nocional = 100;
  if (desdeMs !== undefined) {
    // Modo pre-registrado: UNA configuracion, la que ya estaba elegida. Sin rejilla.
    imprimirFila("config viva", samples, { notionalUsd: nocional, minFundingRate: 0, holdBuckets: 12 });
    return;
  }

  console.log("");
  console.log(`Rejilla de carry de funding, nocional $${nocional}:`);
  console.log("");
  console.log("umbral / horas       ops    neto $    /op $   peor tramo $     P5 $   P(+)  bloques");
  // Las duraciones van en HORAS y no en cubos porque es la unidad en la que se cobra el funding (cada
  // hora) y en la que se entiende la cuenta: la ida y vuelta cuesta 0,08% del nocional, y a 0,0013%/h
  // hacen falta ~62 horas de funding para cubrirla. Barrer duraciones cortas es barrer el tramo donde
  // la respuesta ya se sabe; se dejan igualmente, porque una tabla que ensena POR QUE no sale a cuenta
  // vale mas que una regla escrita en un comentario.
  for (const horas of [1, 6, 12, 24, 48, 72]) {
    const holdBuckets = horas * 12;
    for (const umbral of [0, 0.0001, 0.0005]) {
      imprimirFila(`${horas}h, >= ${(umbral * 100).toFixed(3)}%`, samples, {
        notionalUsd: nocional,
        minFundingRate: umbral,
        holdBuckets,
      });
    }
  }

  console.log("");
  console.log("REGLA: gana el mejor PEOR TRAMO con al menos 150 operaciones y datos en los 6 tramos.");
  console.log("Cualquier resultado espectacular es sospechoso antes que prometedor.");
}

function imprimirFila(
  etiqueta: string,
  samples: PerpsSample[],
  params: { notionalUsd: number; minFundingRate: number; holdBuckets?: number },
): void {
  const trades = replayCarry(samples, params);
  const resumen = summarizeReplay(trades, samples.length);
  const completo = resumen.tramos.length === TRAMOS;
  console.log(
    `${etiqueta.padEnd(18)} ${String(trades.length).padStart(5)} ` +
      `${resumen.netUsd.toFixed(2).padStart(9)} ${resumen.perTradeUsd.toFixed(4).padStart(8)} ` +
      `${resumen.peorTramo.toFixed(2).padStart(14)} ${resumen.bootstrap.p5Usd.toFixed(2).padStart(8)} ` +
      `${(resumen.bootstrap.positiveShare * 100).toFixed(0).padStart(5)}% ` +
      `${String(resumen.bootstrap.bloques).padStart(8)}` +
      `${completo ? "" : `   (solo ${resumen.tramos.length}/${TRAMOS} tramos)`}`,
  );
}

function resumirCaptura(samples: PerpsSample[], path: string): void {
  const metricas = bucketMetrics(samples);
  const primera = samples[0];
  const ultima = samples[samples.length - 1];
  const horas = (ultima.bucketEndMs - primera.bucketStartMs) / 3_600_000;
  const simbolos = new Set(samples.map((sample) => sample.symbol));
  console.log(`${path}`);
  console.log(
    `  ${samples.length} cubos de ${simbolos.size} instrumentos (${[...simbolos].join(", ")}) ` +
      `en ${horas.toFixed(1)} h`,
  );
  // La diferencia entre cubos y cubos PUNTUABLES es una medida de salud del feed, no un detalle: un
  // hueco grande aqui significa que se esta midiendo el feed y no el mercado.
  console.log(
    `  puntuables ${metricas.length} de ${samples.length} ` +
      `(${((metricas.length / samples.length) * 100).toFixed(1)}%)`,
  );
  const conOraculo = metricas.filter((metrica) => metrica.basisVsOracle !== undefined);
  if (conOraculo.length > 0) {
    const media = conOraculo.reduce((sum, metrica) => sum + (metrica.basisVsOracle ?? 0), 0) / conOraculo.length;
    console.log(
      `  base contra el TWAP de Chainlink: ${(media * 10_000).toFixed(2)} bps de media ` +
        `sobre ${conOraculo.length} cubos`,
    );
  }
  const conBase = metricas.filter((metrica) => metrica.basisVsIndex !== undefined);
  if (conBase.length > 0) {
    const media = conBase.reduce((sum, metrica) => sum + (metrica.basisVsIndex ?? 0), 0) / conBase.length;
    console.log(`  base contra el indice de Polymarket: ${(media * 10_000).toFixed(2)} bps de media`);
  }
  const spreads = metricas.map((metrica) => metrica.meanSpreadBps).filter((v): v is number => v !== undefined);
  if (spreads.length > 0) {
    console.log(
      `  spread medio ${(spreads.reduce((a, b) => a + b, 0) / spreads.length).toFixed(2)} bps ` +
        `(la ida y vuelta al tramo base cuesta 8 bps)`,
    );
  }
}

function leerArg(nombre: string): string | undefined {
  const i = process.argv.indexOf(nombre);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

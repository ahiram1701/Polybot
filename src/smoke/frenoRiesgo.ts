/**
 * ¿Cuanto habria protegido el cortacircuitos, y a que precio?
 *
 *   npx tsx src/smoke/frenoRiesgo.ts
 *
 * EL PROBLEMA QUE MIDE. Sobre las 632 operaciones resueltas del favorito entre el 12 y el 19 de
 * septiembre, el neto fue +29,38 $ pero la peor caida desde el pico fue -43,45 $: la caida es mayor que
 * todo lo ganado. Eso es "las ganancias se voltean". El freno existe (`evaluateRiskCircuitBreaker`) y esta
 * APAGADO, porque sus dos limites valen 0 y 0 significa desactivado.
 *
 * Esa caida no es una tarde mala cualquiera: fue del 2026-09-17T01:45Z al 12:35Z, 10,8 horas y 44
 * operaciones seguidas, dentro de un mismo dia UTC. Que quepa en un dia es justo lo que hace que un freno
 * DIARIO pueda tocarla — medido con la zona del portatil (CST) la caida se parte en dos dias y ningun
 * limite la ve. El bot corre en un contenedor en UTC; medirlo en otra zona da otra ganadora.
 *
 * POR QUE EL CONTRAFACTUAL ES EXACTO. Las operaciones de papel no mueven el mercado, asi que saltarse una
 * entrada no cambia el resultado de las demas: basta con no contarla. Esto NO valdria en live.
 *
 * REGLA DURA, la de siempre: aqui no se reimplementa el freno, se LLAMA a `evaluateDirectionalRiskHalt`,
 * el mismo que aplican el bucle y la UI. Tener dos copias de esa condicion ya hizo que el chip de riesgo
 * anunciara un halt que el bucle no estaba aplicando.
 *
 * LO QUE UN FRENO NO PUEDE HACER. Si las operaciones fueran independientes, parar tras una racha no mejora
 * la ganancia esperada: solo recorta la cola. Lo que si hace es acotar la caida. Aqui hay motivo para
 * pensar que ademas hay persistencia —las perdidas llegan en racimos: si un mercado pierde en una ventana,
 * otro de esa ventana pierde el 47,5% de las veces frente al 13,2% habitual— pero eso lo dice la tabla, no
 * el deseo. Si el freno cuesta ganancia media, es una compra consciente de proteccion.
 */
import { join } from "node:path";

import { muestrasEnOrden } from "../analyticsStream.js";
import { loadConfig } from "../config.js";
import { crearReplayFavorito, type FavoriteSignal } from "../favoriteReplay.js";
import { DEFAULT_FAVORITE_MAX_ASK, DEFAULT_FAVORITE_MIN_ASK, DEFAULT_MAX_ASK_SUM } from "../favoriteSelector.js";
import { netoDeLasSaltadas, simular, type Regla, type Resultado } from "../frenoSimulacion.js";
import { cargarLedgerFavorito } from "../ledgerFavorito.js";
import { DEFAULT_MIN_SECONDS_TO_END } from "../markets.js";
import { resolveTimeZone } from "../timezone.js";
import type { BotConfig, MarketSymbol, TradeAttempt } from "../types.js";
import { applySettings, UiSettingsStore } from "../ui/settings.js";

const STAKE_USD = 5;
const REGIMEN_TWAP_MS = Date.parse("2026-08-08T00:00:00Z");
/** Cuando se aplico la config viva. Todo lo anterior es el periodo de ELECCION. */
const CAMBIO_MS = Date.parse("2026-09-11T05:25:47Z");
/** Cuando el papel volvio a operar tras el paron de la poda. Desde aqui es el periodo de PRUEBA. */
const REANUDACION_MS = Date.parse("2026-09-12T11:49:23Z");
const DEFAULT_MAX_ASK_SPREAD = 0.02;

/**
 * Las señales del replay como operaciones. Solo se rellena lo que el freno mira: modo, importe,
 * participaciones, precio de entrada y el cierre. La comision no se pone a mano — `getFeeUsd` la estima
 * en sim desde las participaciones y el precio, que es justo lo que hace el P&L de produccion.
 */
function comoOperacion(signal: FavoriteSignal, endMs: number): TradeAttempt {
  const createdAtMs = endMs - signal.secondsToEnd * 1000;
  return {
    id: `${signal.slug}-${signal.outcome}`,
    asset: signal.market as MarketSymbol,
    slug: signal.slug,
    mode: "sim",
    outcome: signal.outcome,
    amountUsd: STAKE_USD,
    estimatedShares: STAKE_USD / signal.ask,
    bestAsk: signal.ask,
    createdAtMs,
    endMs,
    resolved: { won: signal.won, resolvedAtMs: endMs },
  } as unknown as TradeAttempt;
}

/**
 * Las entradas que el favorito habria hecho antes del cambio de config, leyendo la analitica EN FLUJO.
 *
 * Cargar las dos fuentes enteras con `readAnalyticsSamples` —900 MB de archivo y 371 MB de vivo— agoto la
 * memoria de la maquina y la dejo sin responder. Aqui las ventanas llegan de una en una y en orden, que es
 * lo unico que el replay necesita, y solo se guarda lo diminuto: las señales y el cierre de cada ventana.
 */
async function señalesDeEleccion(
  dataDir: string,
  params: Parameters<typeof crearReplayFavorito>[0],
): Promise<{ signals: FavoriteSignal[]; endMsPorSlug: Map<string, number>; ventanas: number }> {
  const replay = crearReplayFavorito(params);
  const endMsPorSlug = new Map<string, number>();
  const fuentes = [join(dataDir, "archive", "analytics-archive.jsonl"), join(dataDir, "analytics.jsonl")];
  let ventanas = 0;
  for await (const sample of muestrasEnOrden(fuentes, (u) => u.windowStartMs >= REGIMEN_TWAP_MS && u.windowStartMs < CAMBIO_MS)) {
    ventanas += 1;
    endMsPorSlug.set(sample.slug, sample.endMs);
    replay.observa(sample);
  }
  return { signals: replay.resultado().signals, endMsPorSlug, ventanas };
}

function reglas(): Regla[] {
  const lista: Regla[] = [{ nombre: "SIN FRENO (lo que corre hoy)", limites: {}, topeGastoDiarioUsd: 0 }];
  // El enfriamiento cuenta desde el DISPARO, no hasta la medianoche: 24 h es un dia entero parado, no
  // "lo que queda del dia". El contador de perdidas del dia si se reinicia a medianoche, el enfriamiento no.
  for (const cooldownHours of [2, 4, 24]) {
    for (const maxDailyLossUsd of [0, 5, 8, 10, 15, 20]) {
      for (const maxConsecutiveLosses of [0, 3, 4, 5]) {
        if (maxDailyLossUsd === 0 && maxConsecutiveLosses === 0) continue;
        const partes = [
          maxDailyLossUsd > 0 ? `perdida ${maxDailyLossUsd}$` : "",
          maxConsecutiveLosses > 0 ? `racha ${maxConsecutiveLosses}` : "",
        ].filter(Boolean);
        lista.push({
          nombre: `${partes.join(" + ")} (enfr. ${cooldownHours}h)`,
          limites: { maxDailyLossUsd, maxConsecutiveLosses, cooldownHours },
          topeGastoDiarioUsd: 0,
        });
      }
    }
  }
  // El otro freno que ya existe: a 5 $ por entrada, 50 $ son 10 operaciones al dia.
  for (const tope of [50, 100, 150, 200]) {
    lista.push({ nombre: `tope de gasto ${tope}$/dia (${tope / STAKE_USD} entradas)`, limites: {}, topeGastoDiarioUsd: tope });
  }
  return lista;
}

function linea(nombre: string, r: Resultado): string {
  const usd = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}$`;
  return [
    nombre.padEnd(38),
    `n=${String(r.n).padStart(4)}`,
    `saltadas=${String(r.saltadas).padStart(4)}`,
    `neto=${usd(r.netoUsd).padStart(9)}`,
    `caida max=${r.caidaMaxUsd.toFixed(2).padStart(6)}$`,
    `minimo=${usd(r.minimoUsd).padStart(8)}`,
    `comision=${r.comisionUsd.toFixed(2).padStart(6)}$`,
    `dias con freno=${r.diasConFreno}`,
  ].join(" ");
}

async function main(): Promise<void> {
  const { config } = loadConfig(["--mode", "sim"]);
  const settings = await new UiSettingsStore(config.dataDir).load(config);
  const efectiva: BotConfig = applySettings(config, settings);
  // El freno corta POR DIA, asi que la frontera del dia cambia el resultado: una mala racha que cruza la
  // medianoche se le escapa. La config viva dice "auto", que significa "la zona del sistema", y el sistema
  // que manda es el CONTENEDOR, que corre en UTC — no esta maquina, que va en CST y partiria los dias seis
  // horas antes. Medirlo con la zona del portatil daba otra tabla y otra ganadora.
  const timeZone = resolveTimeZone(efectiva.timezone) ?? "UTC";

  const { signals, endMsPorSlug, ventanas } = await señalesDeEleccion(config.dataDir, {
    entryWindowSeconds: efectiva.entryWindowSeconds,
    minSecondsToEnd: efectiva.minSecondsToEndForEntry ?? DEFAULT_MIN_SECONDS_TO_END,
    minAsk: efectiva.favoriteMinAsk ?? DEFAULT_FAVORITE_MIN_ASK,
    maxAsk: efectiva.favoriteMaxAsk ?? DEFAULT_FAVORITE_MAX_ASK,
    maxAskSum: efectiva.favoriteMaxAskSum ?? DEFAULT_MAX_ASK_SUM,
    maxAskSpread: efectiva.maxAskSpread ?? DEFAULT_MAX_ASK_SPREAD,
    minCertainty: efectiva.favoriteMinCertainty ?? 1,
  });

  const eleccion = signals.map((s) => comoOperacion(s, endMsPorSlug.get(s.slug) as number));
  const prueba = (await cargarLedgerFavorito(config.dataDir)).filter((t) => t.createdAtMs >= REANUDACION_MS);

  console.log(`FRENO DE RIESGO — contrafactual sobre operaciones ya resueltas, zona ${timeZone}`);
  console.log(`ELECCION: ${eleccion.length} entradas del replay sobre ${ventanas} ventanas anteriores al ${new Date(CAMBIO_MS).toISOString()}`);
  console.log(`PRUEBA:   ${prueba.length} entradas REALES del ledger desde ${new Date(REANUDACION_MS).toISOString()}`);
  console.log("");

  const todas = reglas().map((regla) => ({
    regla,
    eleccion: simular(eleccion, regla, timeZone),
    prueba: simular(prueba, regla, timeZone),
  }));
  const base = todas[0];

  // Criterio escrito ANTES del dato: entre las que conservan >=75% del neto en ELECCION, gana la de menor
  // caida maxima; empate, la que menos opera. Nunca al reves: no se elige por el neto.
  const minimoNeto = 0.75 * base.eleccion.netoUsd;
  const aptas = todas.filter((x) => x.regla !== base.regla && x.eleccion.netoUsd >= minimoNeto);
  aptas.sort((izq, der) => izq.eleccion.caidaMaxUsd - der.eleccion.caidaMaxUsd || izq.eleccion.n - der.eleccion.n);
  const elegida = aptas[0];

  console.log("=== PERIODO DE ELECCION (con esto se decide) ===");
  console.log(linea(base.regla.nombre, base.eleccion));
  for (const x of [...todas.slice(1)].sort((a, b) => a.eleccion.caidaMaxUsd - b.eleccion.caidaMaxUsd)) {
    const marca = x === elegida ? "  <- ELEGIDA" : x.eleccion.netoUsd < minimoNeto ? "  (pierde mas del 25% del neto)" : "";
    console.log(linea(x.regla.nombre, x.eleccion) + marca);
  }
  console.log(`\nneto minimo exigido (75% de ${base.eleccion.netoUsd.toFixed(2)}$): ${minimoNeto.toFixed(2)}$`);
  console.log(`ELEGIDA: ${elegida ? elegida.regla.nombre : "ninguna cumple el criterio"}`);

  console.log("\n=== PERIODO DE PRUEBA (juicio, nunca usado para elegir) ===");
  console.log(linea(base.regla.nombre, base.prueba));
  for (const x of [...todas.slice(1)].sort((a, b) => a.prueba.caidaMaxUsd - b.prueba.caidaMaxUsd)) {
    console.log(linea(x.regla.nombre, x.prueba) + (x === elegida ? "  <- ELEGIDA" : ""));
  }

  // LO QUE DE VERDAD DECIDE SI ESTO ES UN MECANISMO O SUERTE: ¿que valian las entradas que el freno tira?
  // Si el freno acertara, lo saltado seria negativo en los dos periodos. Si cambia de signo, no hay
  // mecanismo, hay ruido, y lo que pase el mes que viene es una moneda al aire.
  if (elegida) {
    const saltadoEleccion = netoDeLasSaltadas(eleccion, elegida.regla, timeZone);
    const saltadoPrueba = netoDeLasSaltadas(prueba, elegida.regla, timeZone);
    const usd = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}$`;
    console.log("\n=== LO QUE LA ELEGIDA TIRA A LA BASURA ===");
    console.log(
      `ELECCION: ${elegida.eleccion.saltadas} entradas saltadas valian ${usd(saltadoEleccion)} ` +
        `(${usd(saltadoEleccion / Math.max(1, elegida.eleccion.saltadas))}/op)`,
    );
    console.log(
      `PRUEBA:   ${elegida.prueba.saltadas} entradas saltadas valian ${usd(saltadoPrueba)} ` +
        `(${usd(saltadoPrueba / Math.max(1, elegida.prueba.saltadas))}/op)`,
    );
    console.log(
      saltadoEleccion * saltadoPrueba < 0
        ? "El signo CAMBIA entre los dos periodos: el freno no distingue buenas de malas, acota y ya."
        : "Mismo signo en los dos periodos.",
    );
  }
}

await main();

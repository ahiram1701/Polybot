/**
 * ¿Se puede cerrar CADA DIA en verde? Saber cuando parar porque ya se gano.
 *
 *   npx tsx src/smoke/cerrarEnVerde.ts
 *
 * LA PREGUNTA, Y NO ES LA DE ANTES. El cortacircuitos que hay sabe parar cuando se PIERDE. Lo que se
 * pide aqui es lo contrario: parar cuando ya se ha GANADO lo del dia, para que el dia no devuelva lo
 * ganado y el acumulado suba dia tras dia. Eso no existe en el bot y no hay funcion de produccion a la
 * que llamar: `objetivoDiarioUsd` esta calculado en `frenoSimulacion.ts`, con la misma disciplina que el
 * resto — solo cuenta lo que ya habia CERRADO en el instante de decidir cada entrada.
 *
 * LO QUE UN OBJETIVO DIARIO NO PUEDE HACER, dicho antes de ver la tabla:
 *
 * 1. NO sube la ganancia esperada. Si cada entrada tiene ventaja positiva, dejar de entrar cuando vas
 *    ganando solo quita entradas buenas. Lo que compra es REGULARIDAD, y se paga en media.
 * 2. NO garantiza cerrar en verde. Al parar quedan posiciones abiertas que aun tienen que resolver, y
 *    un dia parado en +6 $ puede acabar en +1 $ o en rojo. Esta simulado asi, no idealizado.
 * 3. NO ayuda en los dias malos. Un dia que nunca llega al objetivo no se para nunca por esta via: para
 *    eso esta el limite de perdida, que es el otro lado y ya existe.
 * 4. HAY UNA SOLUCION DEGENERADA y esta en la rejilla a proposito: con un objetivo diminuto se cierra en
 *    verde casi todos los dias ganando calderilla. Por eso el criterio exige NO ganar menos que hoy.
 */
import { join } from "node:path";

import { muestrasEnOrden } from "../analyticsStream.js";
import { loadConfig } from "../config.js";
import { crearReplayFavorito, type FavoriteSignal } from "../favoriteReplay.js";
import { DEFAULT_FAVORITE_MAX_ASK, DEFAULT_FAVORITE_MIN_ASK, DEFAULT_MAX_ASK_SUM } from "../favoriteSelector.js";
import { simular, type Regla, type Resultado } from "../frenoSimulacion.js";
import { cargarLedgerFavorito } from "../ledgerFavorito.js";
import { DEFAULT_MIN_SECONDS_TO_END } from "../markets.js";
import { resolveTimeZone } from "../timezone.js";
import type { BotConfig, MarketSymbol, TradeAttempt } from "../types.js";
import { applySettings, UiSettingsStore } from "../ui/settings.js";

const STAKE_USD = 5;
const REGIMEN_TWAP_MS = Date.parse("2026-08-08T00:00:00Z");
const CAMBIO_MS = Date.parse("2026-09-11T05:25:47Z");
const REANUDACION_MS = Date.parse("2026-09-12T11:49:23Z");
const DEFAULT_MAX_ASK_SPREAD = 0.02;

interface Cuenta {
  diasEnVerde: number;
  dias: number;
  netoUsd: number;
  netoPorDia: number;
  peorDiaUsd: number;
  /** Dias que llegaron a estar en +3 $ o mas y acabaron en rojo. El sintoma exacto que se quiere curar. */
  diasQueDevolvieron: number;
  n: number;
  comisionUsd: number;
}

const DEVOLVIO_DESDE_USD = 3;

function contar(r: Resultado): Cuenta {
  const dias = r.dias;
  return {
    diasEnVerde: dias.filter((d) => d.netoUsd > 0).length,
    dias: dias.length,
    netoUsd: r.netoUsd,
    netoPorDia: dias.length ? r.netoUsd / dias.length : 0,
    peorDiaUsd: dias.length ? Math.min(...dias.map((d) => d.netoUsd)) : 0,
    diasQueDevolvieron: dias.filter((d) => d.picoUsd >= DEVOLVIO_DESDE_USD && d.netoUsd < 0).length,
    n: r.n,
    comisionUsd: r.comisionUsd,
  };
}

function linea(nombre: string, c: Cuenta): string {
  const usd = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}$`;
  const pct = (100 * c.diasEnVerde) / Math.max(1, c.dias);
  return [
    nombre.padEnd(34),
    `dias en verde=${String(c.diasEnVerde).padStart(2)}/${c.dias} (${pct.toFixed(0).padStart(3)}%)`,
    `neto=${usd(c.netoUsd).padStart(9)}`,
    `neto/dia=${usd(c.netoPorDia).padStart(8)}`,
    `peor dia=${usd(c.peorDiaUsd).padStart(8)}`,
    `devolvieron=${c.diasQueDevolvieron}`,
    `n=${String(c.n).padStart(4)}`,
    `comision=${c.comisionUsd.toFixed(1).padStart(5)}$`,
  ].join(" ");
}

/**
 * La rejilla, escrita antes de mirar.
 *
 * El objetivo diario en dolares (parar cuando lo ganado hoy llegue a X) cruzado con el limite de
 * perdida diaria que YA existe (parar cuando lo perdido hoy llegue a Y). A 5 $ por entrada y ~83
 * entradas al dia, los dias buenos del papel han dado entre +4 y +16 $, asi que un objetivo de 20 $ no
 * se alcanza casi nunca y uno de 2 $ se alcanza el primer cuarto de hora.
 */
function reglas(): Regla[] {
  const base: Regla = {
    nombre: "HOY (racha 3, enfr. 24h)",
    limites: { maxConsecutiveLosses: 3, cooldownHours: 24 },
    topeGastoDiarioUsd: 0,
    objetivoDiarioUsd: 0,
  };
  const lista: Regla[] = [
    { nombre: "SIN NADA (como antes del 19)", limites: {}, topeGastoDiarioUsd: 0, objetivoDiarioUsd: 0 },
    base,
  ];
  for (const objetivo of [2, 3, 5, 8, 10, 15]) {
    lista.push({
      nombre: `objetivo ${objetivo}$/dia`,
      limites: {},
      topeGastoDiarioUsd: 0,
      objetivoDiarioUsd: objetivo,
    });
    for (const perdida of [5, 8, 10]) {
      lista.push({
        nombre: `objetivo ${objetivo}$ + perdida ${perdida}$`,
        limites: { maxDailyLossUsd: perdida, cooldownHours: 24 },
        topeGastoDiarioUsd: 0,
        objetivoDiarioUsd: objetivo,
      });
    }
    lista.push({
      nombre: `objetivo ${objetivo}$ + racha 3`,
      limites: { maxConsecutiveLosses: 3, cooldownHours: 24 },
      topeGastoDiarioUsd: 0,
      objetivoDiarioUsd: objetivo,
    });
  }
  // Solo el lado de la perdida, para ver cuanto del resultado viene de cada lado.
  for (const perdida of [5, 8, 10]) {
    lista.push({
      nombre: `solo perdida ${perdida}$/dia`,
      limites: { maxDailyLossUsd: perdida, cooldownHours: 24 },
      topeGastoDiarioUsd: 0,
      objetivoDiarioUsd: 0,
    });
  }
  return lista;
}

function comoOperacion(signal: FavoriteSignal, endMs: number): TradeAttempt {
  return {
    id: `${signal.slug}-${signal.outcome}`,
    asset: signal.market as MarketSymbol,
    slug: signal.slug,
    mode: "sim",
    outcome: signal.outcome,
    amountUsd: STAKE_USD,
    estimatedShares: STAKE_USD / signal.ask,
    bestAsk: signal.ask,
    createdAtMs: endMs - signal.secondsToEnd * 1000,
    endMs,
    resolved: { won: signal.won, resolvedAtMs: endMs },
  } as unknown as TradeAttempt;
}

async function entradasDeEleccion(dataDir: string, efectiva: BotConfig): Promise<TradeAttempt[]> {
  const replay = crearReplayFavorito({
    entryWindowSeconds: efectiva.entryWindowSeconds,
    minSecondsToEnd: efectiva.minSecondsToEndForEntry ?? DEFAULT_MIN_SECONDS_TO_END,
    minAsk: efectiva.favoriteMinAsk ?? DEFAULT_FAVORITE_MIN_ASK,
    maxAsk: efectiva.favoriteMaxAsk ?? DEFAULT_FAVORITE_MAX_ASK,
    maxAskSum: efectiva.favoriteMaxAskSum ?? DEFAULT_MAX_ASK_SUM,
    maxAskSpread: efectiva.maxAskSpread ?? DEFAULT_MAX_ASK_SPREAD,
    minCertainty: efectiva.favoriteMinCertainty ?? 1,
  });
  const endMsPorSlug = new Map<string, number>();
  const fuentes = [join(dataDir, "archive", "analytics-archive.jsonl"), join(dataDir, "analytics.jsonl")];
  for await (const sample of muestrasEnOrden(
    fuentes,
    (u) => u.windowStartMs >= REGIMEN_TWAP_MS && u.windowStartMs < CAMBIO_MS,
  )) {
    endMsPorSlug.set(sample.slug, sample.endMs);
    replay.observa(sample);
  }
  return replay.resultado().signals.map((s) => comoOperacion(s, endMsPorSlug.get(s.slug) ?? 0));
}

async function main(): Promise<void> {
  const { config } = loadConfig(["--mode", "sim"]);
  const settings = await new UiSettingsStore(config.dataDir).load(config);
  const efectiva: BotConfig = applySettings(config, settings);
  // El dia del bot es el del CONTENEDOR, que va en UTC. Medirlo en la zona del portatil (CST) parte los
  // dias seis horas antes y da otra tabla.
  const timeZone = resolveTimeZone(efectiva.timezone) ?? "UTC";

  const eleccion = await entradasDeEleccion(config.dataDir, efectiva);
  const juicio = (await cargarLedgerFavorito(config.dataDir)).filter((t) => t.createdAtMs >= REANUDACION_MS);

  console.log(`CERRAR EN VERDE CADA DIA — dias del calendario en ${timeZone}`);
  console.log(`ELECCION: ${eleccion.length} entradas del replay anteriores al ${new Date(CAMBIO_MS).toISOString()}`);
  console.log(`JUICIO:   ${juicio.length} entradas REALES del ledger desde ${new Date(REANUDACION_MS).toISOString()}`);
  console.log(`"devolvieron" = dias que llegaron a +${DEVOLVIO_DESDE_USD}$ o mas y cerraron en rojo\n`);

  const todas = reglas().map((regla) => ({
    regla,
    eleccion: contar(simular(eleccion, regla, timeZone)),
    juicio: contar(simular(juicio, regla, timeZone)),
  }));
  const sinNada = todas[0];

  console.log("=== EL PROBLEMA, DIA A DIA (sin ninguna regla) ===");
  for (const d of simular(juicio, sinNada.regla, timeZone).dias) {
    const marca = d.netoUsd < 0 && d.picoUsd >= DEVOLVIO_DESDE_USD ? `  <- llego a +${d.picoUsd.toFixed(2)}$ y lo devolvio` : "";
    console.log(
      `  ${d.dia}  n=${String(d.n).padStart(3)}  pico=${d.picoUsd >= 0 ? "+" : ""}${d.picoUsd.toFixed(2)}$  cierre=${d.netoUsd >= 0 ? "+" : ""}${d.netoUsd.toFixed(2)}$${marca}`,
    );
  }

  // CRITERIO ESCRITO ANTES DEL DATO. Lo que se pide es cerrar mas dias en verde SIN ganar menos: el
  // objetivo declarado es acumular dia tras dia, no cambiar ganancia por regularidad. Asi que solo son
  // elegibles las reglas que en ELECCION ganan al menos lo que se gana hoy; entre esas, la que mas dias
  // cierra en verde; empate, la de mas neto. Si no hay ninguna, eso ES la respuesta.
  const referencia = todas.find((x) => x.regla.nombre.startsWith("HOY"));
  const suelo = referencia?.eleccion.netoUsd ?? 0;
  const aptas = todas.filter((x) => x !== sinNada && x !== referencia && x.eleccion.netoUsd >= suelo);
  aptas.sort(
    (izq, der) =>
      der.eleccion.diasEnVerde / der.eleccion.dias - izq.eleccion.diasEnVerde / izq.eleccion.dias ||
      der.eleccion.netoUsd - izq.eleccion.netoUsd,
  );
  const elegida = aptas[0];

  console.log("\n=== PERIODO DE ELECCION (con esto se decide) ===");
  for (const x of [...todas].sort((a, b) => b.eleccion.diasEnVerde / b.eleccion.dias - a.eleccion.diasEnVerde / a.eleccion.dias)) {
    const marca =
      x === elegida ? "  <- ELEGIDA" : x === referencia ? "  <- lo que corre hoy" : x.eleccion.netoUsd < suelo ? "  (gana menos que hoy)" : "";
    console.log(linea(x.regla.nombre, x.eleccion) + marca);
  }
  console.log(`\nsuelo de neto exigido (lo que gana la config de hoy): ${suelo.toFixed(2)}$`);
  console.log(`ELEGIDA: ${elegida ? elegida.regla.nombre : "NINGUNA cumple — no se puede tener las dos cosas"}`);

  console.log("\n=== PERIODO DE JUICIO (nunca usado para elegir) ===");
  for (const x of [...todas].sort((a, b) => b.juicio.diasEnVerde / b.juicio.dias - a.juicio.diasEnVerde / a.juicio.dias)) {
    const marca = x === elegida ? "  <- ELEGIDA" : x === referencia ? "  <- lo que corre hoy" : "";
    console.log(linea(x.regla.nombre, x.juicio) + marca);
  }
}

await main();

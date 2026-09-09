/**
 * Barrido de configuraciones del FAVORITO sobre las ventanas ya observadas, con particion fuera de
 * muestra.
 *
 * La pregunta que responde: de todo lo que se puede tocar del favorito, ¿algo tiene ventaja de verdad,
 * o la banda 0,79-0,90 esta simplemente bien preciada? Hasta ahora no habia forma de preguntarlo — el
 * replay del repo solo sabe reconstruir el camino direccional, asi que cada ajuste del favorito se
 * decidio con una tabla escrita a mano sobre un universo distinto y sin particion. Ver `favoriteReplay`.
 *
 * Como se lee la salida, y cual es la unica columna que importa:
 *
 *   - `acierto` a secas NO dice nada. A un ask de 0,86 hace falta acertar el 87,3% solo para empatar.
 *   - `ventaja` = acierto - equilibrio, en puntos porcentuales. Esa es la cifra.
 *   - `IS` / `OOS` = primera y segunda mitad cronologica. Se ELIGE por la primera y se JUZGA por la
 *     segunda. Una ventaja que solo aparece en el conjunto entero es ruido de barrido: la rejilla
 *     tiene decenas de casillas y alguna sale bien por sorteo. Y elegir mirando la segunda mitad
 *     tampoco vale: entonces deja de ser fuera de muestra y solo se esta sobreajustando mas tarde.
 *   - `boot+` = fraccion de remuestreos con neto total positivo (`bootstrapCI`). El estadistico t
 *     asume normalidad y esta distribucion es asimetrica por construccion —las perdidas estan topadas
 *     en el stake y las ganancias no— asi que el bootstrap es la vara correcta.
 *
 * Se imprimen DOS lineas por configuracion: sin el gate de EV y con el. No es redundante — es la
 * leccion de DOGE: una tabla que evaluaba banda+momentum sin el gate real declaro perdedora una
 * ventana que el gate hacia ganadora. Si las dos lineas se parecen, el gate no esta aportando nada
 * sobre este camino y esa tambien es informacion.
 */
import { join } from "node:path";

import { readAnalyticsSamples } from "../analyticsRecorder.js";
import { loadConfig } from "../config.js";
import {
  replayFavoriteSignals,
  settleFavoriteSignals,
  type FavoriteReplayParams,
  type FavoriteSignal,
} from "../favoriteReplay.js";
import { defaultTakerFeeRateBps } from "../fees.js";
import { simulateGate, summarizeGateTrades, type SimulatedTrade } from "../gateSimulation.js";
import { SUPPORTED_MARKETS } from "../markets.js";
import { bootstrapCI } from "../tradeStats.js";
import type { AnalyticsSample, MarketSymbol } from "../types.js";

const STAKE_USD = 5;
/** Los del gate de EV en produccion (`EV_SAFETY_MARGIN`, `EV_MIN_EXPECTED_ROI`, `evMaxClaimedEdge`). */
const SAFETY_MARGIN = 0.03;
const MIN_EXPECTED_ROI = 0.01;
const REJECT_EDGE_ABOVE = 0.2;

/**
 * La configuracion VIVA del `.env`, no un valor bonito.
 *
 * Es la linea de referencia contra la que se compara todo lo demas, asi que si deja de coincidir con
 * produccion el barrido entero mide una cosa y decide sobre otra — el mismo fallo que tenia el
 * backtest del tuner comparando contra un tope fijo impreso como "(actual)".
 */
const PRODUCCION: FavoriteReplayParams = {
  entryWindowSeconds: 120,
  minSecondsToEnd: 45,
  minAsk: 0.79,
  maxAsk: 0.9,
  maxAskSum: 1.15,
  maxAskSpread: 0.02,
  minCertainty: 1,
};

const VENTANAS = [60, 80, 100, 120, 140];
/** `-Infinity` = filtro APAGADO. Hay que saber cuanto aporta, no solo cual es su mejor umbral. */
const CERTEZAS = [Number.NEGATIVE_INFINITY, 0, 0.5, 1, 1.5];
const SUMAS = [1.03, 1.05, 1.1, 1.15];
const BANDAS: Array<[number, number]> = [
  [0.76, 0.85],
  [0.79, 0.9],
  [0.82, 0.92],
  [0.86, 0.94],
  [0.7, 0.95],
];

interface Medida {
  n: number;
  aciertoPct: number;
  equilibrioPct: number;
  ventajaPp: number;
  netPerTradeUsd: number;
  netUsd: number;
  tStat: number;
  bootPositivo: number;
}

interface Fila {
  nombre: string;
  ejecucionPct: number;
  todo: Medida;
  /** Primera mitad cronologica. Es donde se ELIGE, y por eso nunca se usa para presumir. */
  dentro: Medida;
  oos: Medida;
  porMercado: Map<MarketSymbol, Medida>;
}

/**
 * Liquida las señales de un mercado, con o sin el gate de EV.
 *
 * Con gate se delega en `simulateGate`, que es el mismo que corre el evaluador contrafactual del
 * autoajuste. Aqui no se reimplementa: tener dos versiones del gate ya se equivoco una vez.
 */
function liquidar(signals: readonly FavoriteSignal[], market: MarketSymbol, conGateEv: boolean): SimulatedTrade[] {
  const feeRateBps = defaultTakerFeeRateBps(market);
  if (!conGateEv) {
    return settleFavoriteSignals(signals, { stakeUsd: STAKE_USD, feeRateBps });
  }
  return simulateGate(signals, {
    // Sin recorte de banda: el favorito ya la aplico al elegir. Repetirla aqui la aplicaria dos veces.
    minAsk: 0,
    maxAsk: 1,
    safetyMargin: SAFETY_MARGIN,
    minExpectedRoi: MIN_EXPECTED_ROI,
    stakeUsd: STAKE_USD,
    feeRateBps,
    rejectEdgeAbove: REJECT_EDGE_ABOVE,
  });
}

/** El equilibrio medio de un conjunto de operaciones: lo que hay que acertar para no perder. */
function medir(trades: readonly SimulatedTrade[], breakEvenPorAsk: Map<number, number>): Medida {
  const resumen = summarizeGateTrades(trades);
  const n = resumen.trades;
  if (n === 0) {
    return { n: 0, aciertoPct: 0, equilibrioPct: 0, ventajaPp: 0, netPerTradeUsd: 0, netUsd: 0, tStat: 0, bootPositivo: 0 };
  }
  const equilibrio = trades.reduce((suma, t) => suma + (breakEvenPorAsk.get(t.ask) ?? t.ask), 0) / n;
  const aciertoPct = (100 * resumen.wins) / n;
  const equilibrioPct = 100 * equilibrio;
  const boot = bootstrapCI(trades.map((t) => t.netUsd));
  return {
    n,
    aciertoPct,
    equilibrioPct,
    ventajaPp: aciertoPct - equilibrioPct,
    netPerTradeUsd: resumen.netPerTradeUsd ?? 0,
    netUsd: resumen.netUsd,
    tStat: Number.isFinite(resumen.tStat ?? 0) ? (resumen.tStat ?? 0) : 0,
    bootPositivo: boot.positiveShare,
  };
}

function evaluar(
  samples: readonly AnalyticsSample[],
  nombre: string,
  params: FavoriteReplayParams,
  conGateEv: boolean,
): Fila {
  const todos: SimulatedTrade[] = [];
  const dentro: SimulatedTrade[] = [];
  const fuera: SimulatedTrade[] = [];
  const porMercado = new Map<MarketSymbol, Medida>();
  const breakEvenPorAsk = new Map<number, number>();
  let windows = 0;

  for (const market of SUPPORTED_MARKETS) {
    const delMercado = samples.filter((sample) => sample.market === market);
    const { signals, windows: vistas } = replayFavoriteSignals(delMercado, params);
    windows += vistas;
    for (const signal of signals) {
      breakEvenPorAsk.set(signal.ask, signal.breakEven);
    }

    const trades = liquidar(signals, market, conGateEv);
    todos.push(...trades);
    // Particion CRONOLOGICA por mercado, no sobre la mezcla: si un mercado empezo a registrarse mas
    // tarde, cortar el conjunto unido por la mitad le daria todas sus operaciones a la segunda mitad.
    const corte = Math.floor(trades.length / 2);
    dentro.push(...trades.slice(0, corte));
    fuera.push(...trades.slice(corte));
    porMercado.set(market, medir(trades, breakEvenPorAsk));
  }

  todos.sort((izq, der) => izq.windowStartMs - der.windowStartMs);
  return {
    nombre,
    ejecucionPct: windows > 0 ? (100 * todos.length) / windows : 0,
    todo: medir(todos, breakEvenPorAsk),
    dentro: medir(dentro, breakEvenPorAsk),
    oos: medir(fuera, breakEvenPorAsk),
    porMercado,
  };
}

function linea(fila: Fila): string {
  const m = fila.todo;
  const o = fila.oos;
  const pp = (valor: number): string => `${valor >= 0 ? "+" : ""}${valor.toFixed(2)}pp`;
  const usd = (valor: number): string => `${valor >= 0 ? "+" : ""}${valor.toFixed(4)}`;
  return [
    fila.nombre.padEnd(34),
    `n=${String(m.n).padStart(4)}`,
    `ejec=${fila.ejecucionPct.toFixed(1).padStart(4)}%`,
    `acierto=${m.aciertoPct.toFixed(1).padStart(5)}%`,
    `equil=${m.equilibrioPct.toFixed(1).padStart(5)}%`,
    `ventaja=${pp(m.ventajaPp).padStart(8)}`,
    `neto/op=${usd(m.netPerTradeUsd).padStart(8)}`,
    `t=${m.tStat.toFixed(2).padStart(6)}`,
    `boot+=${(100 * m.bootPositivo).toFixed(0).padStart(3)}%`,
    `| IS neto/op=${usd(fila.dentro.netPerTradeUsd).padStart(8)}`,
    `| OOS n=${String(o.n).padStart(4)} ventaja=${pp(o.ventajaPp).padStart(8)} neto/op=${usd(o.netPerTradeUsd).padStart(8)}`,
  ].join(" ");
}

function porMercado(fila: Fila): string {
  return SUPPORTED_MARKETS.map((market) => {
    const m = fila.porMercado.get(market);
    if (!m || m.n === 0) {
      return `${market} -`;
    }
    return `${market} n=${m.n} ventaja=${m.ventajaPp >= 0 ? "+" : ""}${m.ventajaPp.toFixed(1)}pp neto/op=${m.netPerTradeUsd >= 0 ? "+" : ""}${m.netPerTradeUsd.toFixed(3)}`;
  }).join("  |  ");
}

function nombreDe(params: FavoriteReplayParams): string {
  const certeza = params.minCertainty === Number.NEGATIVE_INFINITY ? "off" : params.minCertainty.toFixed(1);
  return `v=${params.entryWindowSeconds}s z>=${certeza} suma<=${params.maxAskSum} ${params.minAsk}-${params.maxAsk}`;
}

async function main(): Promise<void> {
  const { config } = loadConfig(["--mode", "sim"]);
  const samples = await readAnalyticsSamples(join(config.dataDir, "analytics.jsonl"));

  console.log(`FAVORITO — replay sobre ${samples.length} ventanas de ${join(config.dataDir, "analytics.jsonl")}`);
  console.log(`stake $${STAKE_USD} · ventaja = acierto - equilibrio · OOS = segunda mitad cronologica por mercado`);
  console.log("");

  const referencia = replayFavoriteSignals(samples, PRODUCCION);
  console.log("Por que NO entra, con la configuracion de produccion:");
  for (const [motivo, veces] of Object.entries(referencia.skips).sort((izq, der) => der[1] - izq[1])) {
    console.log(`  ${motivo.padEnd(32)} ${String(veces).padStart(5)}`);
  }
  console.log("");

  for (const conGateEv of [false, true]) {
    console.log(conGateEv ? "=== CON gate de EV ===" : "=== SIN gate de EV ===");
    const base = evaluar(samples, `PRODUCCION ${nombreDe(PRODUCCION)}`, PRODUCCION, conGateEv);
    console.log(linea(base));
    console.log(`  ${porMercado(base)}`);
    console.log("");
  }

  // Rejilla CONJUNTA de tiempo y certeza. Por separado no vale: cuanto menos tiempo queda, mayor es z
  // para la misma distancia, asi que medir una sola le atribuye el efecto de la otra. Ese confounding
  // es la explicacion mas probable de que la tabla original viera en z una ventaja que era del tiempo.
  console.log("=== rejilla conjunta: ventana de entrada x certeza (sin gate de EV) ===");
  const rejilla: Fila[] = [];
  for (const entryWindowSeconds of VENTANAS) {
    for (const minCertainty of CERTEZAS) {
      const params = { ...PRODUCCION, entryWindowSeconds, minCertainty };
      rejilla.push(evaluar(samples, nombreDe(params), params, false));
    }
  }
  for (const fila of rejilla) {
    console.log(linea(fila));
  }
  console.log("");

  // Se elige por la PRIMERA mitad y se juzga por la segunda. Elegir por la segunda y reportar la
  // segunda es circular: la casilla ganadora lo es porque se la escogio mirando justo esa cifra, y el
  // "fuera de muestra" deja de serlo. Es el sobreajuste que `outOfSample` existe para evitar.
  const mejores = [...rejilla]
    .filter((fila) => fila.dentro.n >= 30)
    .sort((izq, der) => der.dentro.netPerTradeUsd - izq.dentro.netPerTradeUsd)
    .slice(0, 3);
  if (mejores.length === 0) {
    console.log("Ninguna casilla de la rejilla llega a 30 operaciones DENTRO de muestra.");
    return;
  }

  console.log("=== las 3 mejores DENTRO de muestra, cruzadas con el libro y la banda (se juzgan por OOS) ===");
  for (const mejor of mejores) {
    const base = rejilla.find((fila) => fila.nombre === mejor.nombre);
    if (!base) continue;
    const params = paramsDe(mejor.nombre);
    console.log(`-- sobre ${mejor.nombre}`);
    console.log(`   ${porMercado(base)}`);
    for (const maxAskSum of SUMAS) {
      const candidata = { ...params, maxAskSum };
      console.log(linea(evaluar(samples, nombreDe(candidata), candidata, false)));
    }
    for (const [minAsk, maxAsk] of BANDAS) {
      const candidata = { ...params, minAsk, maxAsk };
      console.log(linea(evaluar(samples, nombreDe(candidata), candidata, false)));
    }
    console.log("");
  }
}

/** Reconstruye los parametros desde el nombre impreso. Evita arrastrar la tupla por toda la rejilla. */
function paramsDe(nombre: string): FavoriteReplayParams {
  const ventana = Number(/v=(\d+)s/.exec(nombre)?.[1] ?? PRODUCCION.entryWindowSeconds);
  const crudo = /z>=([^\s]+)/.exec(nombre)?.[1] ?? "1.0";
  return {
    ...PRODUCCION,
    entryWindowSeconds: ventana,
    minCertainty: crudo === "off" ? Number.NEGATIVE_INFINITY : Number(crudo),
  };
}

await main();

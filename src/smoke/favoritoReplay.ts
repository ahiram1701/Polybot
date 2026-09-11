/**
 * Barrido del FAVORITO sobre las ventanas ya observadas: entradas por TRAMOS cronologicos, salidas, y
 * seguimiento hacia delante con cruce contra el ledger.
 *
 *   npx tsx src/smoke/favoritoReplay.ts                             rejilla de entradas + salidas
 *   npx tsx src/smoke/favoritoReplay.ts --desde 2026-09-11T12:00:00Z  solo lo posterior + cruce con ledger
 *
 * POR QUE TRAMOS Y NO MITADES. La primera version elegia la casilla con mas neto por operacion en la
 * primera mitad y la juzgaba en la segunda. Eligio 80 s con z>=1,5: 179 operaciones, "t=3,28,
 * bootstrap 100%". Hacia delante perdio (49 entradas, 83,7% de acierto contra 88,0% de equilibrio) y en
 * seis tramos solo salia positiva en cuatro, con los dos ultimos negativos. Maximizar el neto medio
 * premia a las casillas pequeñas con suerte; con dos mitades hay demasiado poco para verlo.
 *
 * REGLA DE ELECCION, y esta escrita aqui para que nadie la cambie sin leer lo de arriba: entre las
 * casillas con al menos `N_MINIMO` operaciones y datos en todos los tramos, se ordena por el PEOR tramo
 * y despues por el P5 del bootstrap por ventanas. Nunca por el neto medio.
 *
 * POR QUE BOOTSTRAP POR VENTANAS. Los tres mercados cierran a la vez y pierden juntos: si uno pierde,
 * otro de la misma ventana pierde el 47,5% de las veces, frente a un 13,2% sin esa condicion. Ver
 * `bootstrapCIPorBloques`.
 *
 * COMO SE LEE: el acierto a secas no dice nada. A un ask de 0,86 hace falta acertar el 87,2% solo para
 * empatar. La cifra es la `ventaja` = acierto - equilibrio, en puntos porcentuales.
 *
 * `--desde` NO corre la rejilla, a proposito. Esa ventana es la prueba pre-registrada de la config
 * elegida (docs/ARQUITECTURA.md), y buscar la mejor casilla dentro de ella la gastaria: es exactamente
 * como se fabrico el sobreajuste de 80 s y z>=1,5.
 */
import { createReadStream } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

import { readAnalyticsSamples } from "../analyticsRecorder.js";
import { loadConfig } from "../config.js";
import { resolveStopAsk } from "../favoriteExit.js";
import {
  CERTEZA_NUNCA,
  replayFavoriteExit,
  summarizeExitReplay,
  type ExitReplayPolicy,
  type ExitReplayResult,
} from "../favoriteExitReplay.js";
import {
  breakEvenWinRate,
  replayFavoriteSignals,
  settleFavoriteSignals,
  type FavoriteReplayParams,
  type FavoriteSignal,
} from "../favoriteReplay.js";
import { DEFAULT_FAVORITE_MAX_ASK, DEFAULT_FAVORITE_MIN_ASK, DEFAULT_MAX_ASK_SUM } from "../favoriteSelector.js";
import { defaultTakerFeeRateBps } from "../fees.js";
import { simulateGate } from "../gateSimulation.js";
import { DEFAULT_MIN_SECONDS_TO_END, SUPPORTED_MARKETS } from "../markets.js";
import { bootstrapCIPorBloques } from "../tradeStats.js";
import type { AnalyticsSample, BotConfig, MarketSymbol } from "../types.js";
import { applySettings, UiSettingsStore } from "../ui/settings.js";

const STAKE_USD = 5;
const TRAMOS = 6;
/** Por debajo de esto una casilla no compite: un 100% sobre 40 operaciones es suerte hasta que se demuestre. */
const N_MINIMO = 150;
/** Certezas por debajo de esto se leen como "filtro apagado". La config viva usa -1000. */
const CERTEZA_APAGADA = -100;
/** `DEFAULT_MAX_ASK_SPREAD` vive privado en `botRunner`; el valor se repite aqui y solo aqui. */
const DEFAULT_MAX_ASK_SPREAD = 0.02;
/**
 * Antes de esta fecha las muestras resolvian por snapshot y no por TWAP: son otro mercado. Ver el commit
 * `fafb5d4`, donde un "edge" de esa epoca no sobrevivio al cambio.
 */
const REGIMEN_TWAP_MS = Date.parse("2026-08-08T00:00:00Z");

const VENTANAS = [40, 50, 60, 80, 120];
const CERTEZAS = [Number.NEGATIVE_INFINITY, 0.5, 1, 1.5];
const BANDAS: Array<[number, number]> = [
  [0.79, 0.88],
  [0.79, 0.9],
  [0.82, 0.88],
];

/**
 * Entradas contra las que se miden las SALIDAS cuando la config viva no deja salir.
 *
 * Con entradas a <= 50 s las salidas no pueden dispararse (10 s de permanencia y >= 45 s al cierre),
 * asi que medirlas solo sobre la config viva daria una tabla de ceros que no dice nada. Estas son las
 * entradas de 80 s y z>=1,5 sobre las que se midio que ninguna salida mejora a aguantar.
 */
const ENTRADAS_REFERENCIA_SALIDAS: Omit<FavoriteReplayParams, "minSecondsToEnd" | "maxAskSum" | "maxAskSpread"> = {
  entryWindowSeconds: 80,
  minCertainty: 1.5,
  minAsk: 0.79,
  maxAsk: 0.9,
};

const POLITICAS_SALIDA: Array<[string, ExitReplayPolicy]> = [
  ["certeza<=0 + stop 0,35", { exitCertainty: 0, stopAsk: 0.35 }],
  ["solo certeza<=0", { exitCertainty: 0, stopAsk: 0 }],
  ["solo stop 0,35", { exitCertainty: CERTEZA_NUNCA, stopAsk: 0.35 }],
  ["certeza<=0,5 + stop 0,35", { exitCertainty: 0.5, stopAsk: 0.35 }],
  ["certeza<=0 + stop 0,35, hasta 30 s", { exitCertainty: 0, stopAsk: 0.35, minSecondsToEnd: 30 }],
];

interface AjustesEv {
  safetyMargin: number;
  minExpectedRoi: number;
  rejectEdgeAbove?: number;
}

interface ConfigViva {
  params: FavoriteReplayParams;
  /** `undefined` = salidas apagadas en produccion. */
  salida?: ExitReplayPolicy;
  ev: AjustesEv;
  requirePositiveEv: boolean;
}

/**
 * La configuracion que corre AHORA, leida de donde manda: `data/ui-config.json` PISA a `.env` en
 * caliente. Una copia escrita a mano aqui se queda desfasada justo cuando importa.
 *
 * `minSecondsToEnd` sale de `DEFAULT_MIN_SECONDS_TO_END` (10 s) y NO de los 45 del stop de salida:
 * confundirlos recorta el tramo final, que es donde la ventana ya esta resuelta.
 */
async function configuracionViva(dataDir: string, base: BotConfig): Promise<ConfigViva> {
  const settings = await new UiSettingsStore(dataDir).load(base);
  const e = applySettings(base, settings);
  const minAsk = e.favoriteMinAsk ?? DEFAULT_FAVORITE_MIN_ASK;
  return {
    params: {
      entryWindowSeconds: e.entryWindowSeconds,
      minSecondsToEnd: e.minSecondsToEndForEntry ?? DEFAULT_MIN_SECONDS_TO_END,
      minAsk,
      maxAsk: e.favoriteMaxAsk ?? DEFAULT_FAVORITE_MAX_ASK,
      maxAskSum: e.favoriteMaxAskSum ?? DEFAULT_MAX_ASK_SUM,
      maxAskSpread: e.maxAskSpread ?? DEFAULT_MAX_ASK_SPREAD,
      minCertainty: e.favoriteMinCertainty ?? 1,
    },
    salida: e.favoriteExitEnabled
      ? {
          exitCertainty: e.favoriteExitCertainty ?? 0,
          stopAsk: resolveStopAsk(minAsk, e.favoriteExitStopMargin, e.favoriteExitStopAsk),
          minSecondsToEnd: e.favoriteExitMinSecondsToEnd,
          minBid: e.favoriteExitMinBid,
          minSellFillRatio: e.favoriteExitMinFillRatio,
          maxAskSum: e.favoriteMaxAskSum,
          maxSpread: e.favoriteExitMaxSpread,
          minHoldMs: e.favoriteExitMinHoldSeconds === undefined ? undefined : e.favoriteExitMinHoldSeconds * 1000,
        }
      : undefined,
    ev: {
      safetyMargin: e.evSafetyMargin ?? 0.03,
      minExpectedRoi: e.evMinExpectedRoi ?? 0.01,
      rejectEdgeAbove: e.evMaxClaimedEdge ?? 0.2,
    },
    requirePositiveEv: e.requirePositiveEv === true,
  };
}

/** Una operacion ya liquidada, venga del replay directo o del gate de EV. */
interface Operacion {
  market: MarketSymbol;
  windowStartMs: number;
  won: boolean;
  breakEven: number;
  netUsd: number;
}

interface Medida {
  n: number;
  aciertoPct: number;
  equilibrioPct: number;
  ventajaPp: number;
  netoUsd: number;
  tramos: Array<{ n: number; ventajaPp?: number }>;
  tramosConDatos: number;
  tramosPositivos: number;
  peorTramoPp: number;
  pPositivo: number;
  p5Usd: number;
  porMercado: Map<MarketSymbol, { n: number; ventajaPp?: number }>;
}

function ventajaPp(ops: readonly Operacion[]): number | undefined {
  if (ops.length === 0) return undefined;
  const aciertos = ops.filter((op) => op.won).length / ops.length;
  const equilibrio = ops.reduce((suma, op) => suma + op.breakEven, 0) / ops.length;
  return 100 * (aciertos - equilibrio);
}

function liquidarSinGate(signals: readonly FavoriteSignal[]): Operacion[] {
  return signals.map((signal) => {
    const [liquidada] = settleFavoriteSignals([signal], {
      stakeUsd: STAKE_USD,
      feeRateBps: defaultTakerFeeRateBps(signal.market),
    });
    return { market: signal.market, windowStartMs: signal.windowStartMs, won: signal.won, breakEven: signal.breakEven, netUsd: liquidada.netUsd };
  });
}

/**
 * Con el gate de EV, delegando en `simulateGate`: el mismo que usa el evaluador contrafactual del
 * autoajuste. Por mercado, porque la calibracion de produccion es por mercado.
 */
function liquidarConGate(signals: readonly FavoriteSignal[], ev: AjustesEv): Operacion[] {
  const ops: Operacion[] = [];
  for (const market of SUPPORTED_MARKETS) {
    const feeRateBps = defaultTakerFeeRateBps(market);
    const delMercado = signals.filter((signal) => signal.market === market);
    for (const trade of simulateGate(delMercado, {
      // Sin recorte de banda: el favorito ya la aplico al elegir.
      minAsk: 0,
      maxAsk: 1,
      safetyMargin: ev.safetyMargin,
      minExpectedRoi: ev.minExpectedRoi,
      stakeUsd: STAKE_USD,
      feeRateBps,
      rejectEdgeAbove: ev.rejectEdgeAbove,
    })) {
      ops.push({ market, windowStartMs: trade.windowStartMs, won: trade.won, breakEven: breakEvenWinRate(trade.ask, feeRateBps), netUsd: trade.netUsd });
    }
  }
  return ops.sort((izq, der) => izq.windowStartMs - der.windowStartMs);
}

function medir(ops: readonly Operacion[], cortes: readonly number[]): Medida {
  const n = ops.length;
  const tramoDe = (ws: number): number => cortes.filter((corte) => ws >= corte).length;
  const porTramo: Operacion[][] = Array.from({ length: cortes.length + 1 }, () => []);
  for (const op of ops) porTramo[tramoDe(op.windowStartMs)].push(op);
  const tramos = porTramo.map((grupo) => ({ n: grupo.length, ventajaPp: ventajaPp(grupo) }));
  const conDatos = tramos.filter((tramo) => tramo.ventajaPp !== undefined);
  const boot = bootstrapCIPorBloques(
    ops.map((op) => op.netUsd),
    ops.map((op) => op.windowStartMs),
  );
  const porMercado = new Map<MarketSymbol, { n: number; ventajaPp?: number }>();
  for (const market of SUPPORTED_MARKETS) {
    const delMercado = ops.filter((op) => op.market === market);
    porMercado.set(market, { n: delMercado.length, ventajaPp: ventajaPp(delMercado) });
  }
  return {
    n,
    aciertoPct: n ? (100 * ops.filter((op) => op.won).length) / n : 0,
    equilibrioPct: n ? (100 * ops.reduce((suma, op) => suma + op.breakEven, 0)) / n : 0,
    ventajaPp: ventajaPp(ops) ?? 0,
    netoUsd: ops.reduce((suma, op) => suma + op.netUsd, 0),
    tramos,
    tramosConDatos: conDatos.length,
    tramosPositivos: conDatos.filter((tramo) => (tramo.ventajaPp ?? 0) > 0).length,
    peorTramoPp: conDatos.length ? Math.min(...conDatos.map((tramo) => tramo.ventajaPp ?? 0)) : 0,
    pPositivo: boot.positiveShare,
    p5Usd: boot.p5Usd,
    porMercado,
  };
}

/** Cortes de tiempo que parten las ventanas en `TRAMOS` grupos de igual numero de ventanas. */
function cortesDeTramos(samples: readonly AnalyticsSample[]): number[] {
  const tiempos = samples.map((sample) => sample.windowStartMs).sort((a, b) => a - b);
  if (tiempos.length < TRAMOS) return [];
  return Array.from({ length: TRAMOS - 1 }, (_, i) => tiempos[Math.floor(((i + 1) * tiempos.length) / TRAMOS)]);
}

const pp = (valor: number | undefined): string => (valor === undefined ? "-" : `${valor >= 0 ? "+" : ""}${valor.toFixed(2)}pp`);
const usd = (valor: number): string => `${valor >= 0 ? "+" : ""}${valor.toFixed(2)}$`;

function linea(nombre: string, m: Medida, dias: number): string {
  return [
    nombre.padEnd(34),
    `n=${String(m.n).padStart(4)}`,
    `${(m.n / dias).toFixed(0).padStart(3)}/dia`,
    `acierto=${m.aciertoPct.toFixed(1)}%`,
    `equil=${m.equilibrioPct.toFixed(1)}%`,
    `ventaja=${pp(m.ventajaPp).padStart(8)}`,
    `neto=${usd(m.netoUsd).padStart(9)}`,
    `${usd(m.netoUsd / dias).padStart(7)}/dia`,
    `tramos+=${m.tramosPositivos}/${m.tramosConDatos}`,
    `peor=${pp(m.peorTramoPp).padStart(8)}`,
    `P(+)=${(100 * m.pPositivo).toFixed(0).padStart(3)}%`,
    `P5=${usd(m.p5Usd).padStart(8)}`,
  ].join(" ");
}

function detalle(m: Medida): string {
  const tramos = m.tramos.map((tramo) => `${tramo.ventajaPp === undefined ? "-" : tramo.ventajaPp.toFixed(1)}(${tramo.n})`).join(" ");
  const mercados = SUPPORTED_MARKETS.map((market) => {
    const x = m.porMercado.get(market);
    return `${market} ${pp(x?.ventajaPp)}(${x?.n ?? 0})`;
  }).join(" · ");
  return `    tramos: ${tramos}   |   ${mercados}`;
}

function nombreDe(params: Pick<FavoriteReplayParams, "entryWindowSeconds" | "minCertainty" | "minAsk" | "maxAsk">): string {
  const certeza = params.minCertainty <= CERTEZA_APAGADA ? "off" : String(params.minCertainty);
  return `v=${params.entryWindowSeconds}s z>=${certeza} ${params.minAsk}-${params.maxAsk}`;
}

function leerDesde(argv: readonly string[]): number | undefined {
  const i = argv.findIndex((arg) => arg === "--desde" || arg.startsWith("--desde="));
  if (i < 0) return undefined;
  const crudo = argv[i].includes("=") ? argv[i].split("=")[1] : argv[i + 1];
  const ms = Date.parse(crudo ?? "");
  if (!Number.isFinite(ms)) {
    throw new Error(`--desde necesita una fecha ISO valida, no "${crudo}".`);
  }
  return ms;
}

// ---------------------------------------------------------------------------------------------------
// Salidas

function medirSalidas(
  titulo: string,
  signals: readonly FavoriteSignal[],
  porSlug: ReadonlyMap<string, AnalyticsSample>,
  viva: ExitReplayPolicy | undefined,
): void {
  const politicas: Array<[string, ExitReplayPolicy]> = viva ? [["VIVA", viva], ...POLITICAS_SALIDA] : POLITICAS_SALIDA;
  const aguantar = signals
    .map((signal) => {
      const sample = porSlug.get(signal.slug);
      return sample ? replayFavoriteExit({ sample, signal, stakeUsd: STAKE_USD }) : undefined;
    })
    .filter((r): r is ExitReplayResult => r !== undefined);
  const base = summarizeExitReplay(aguantar);
  console.log(`-- ${titulo}: ${base.entradas} entradas, aguantar siempre = ${usd(base.holdNetUsd)}${viva ? "" : "   (salidas APAGADAS en produccion)"}`);
  for (const [nombre, politica] of politicas) {
    const resultados = signals
      .map((signal) => {
        const sample = porSlug.get(signal.slug);
        return sample ? replayFavoriteExit({ sample, signal, policy: politica, stakeUsd: STAKE_USD }) : undefined;
      })
      .filter((r): r is ExitReplayResult => r !== undefined);
    const resumen = summarizeExitReplay(resultados);
    const boot = bootstrapCIPorBloques(
      resultados.map((r) => r.netUsd - r.holdNetUsd),
      resultados.map((r) => r.windowStartMs),
    );
    console.log(
      [
        `   ${nombre.padEnd(36)}`,
        `ventas=${String(resumen.ventas).padStart(4)}`,
        `que ganaban=${String(resumen.ventasQueGanaban).padStart(3)} (${resumen.ventas ? ((100 * resumen.ventasQueGanaban) / resumen.ventas).toFixed(0) : 0}%)`,
        `frente a aguantar=${usd(resumen.deltaUsd).padStart(8)}`,
        `por venta=${usd(resumen.ventas ? resumen.deltaUsd / resumen.ventas : 0).padStart(7)}`,
        `P(mejora)=${(100 * boot.positiveShare).toFixed(0)}%`,
      ].join("  "),
    );
  }
}

// ---------------------------------------------------------------------------------------------------
// Cruce con el ledger (solo --desde)

interface FilaLedger {
  id: string;
  slug: string;
  asset: MarketSymbol;
  outcome: string;
  bestAsk: number;
  createdAtMs: number;
  endMs: number;
  windowStartMs: number;
  mode: string;
  strategy?: string;
  reentry?: number;
}

async function leerLedger(path: string): Promise<{ trades: FilaLedger[]; ganador: Map<string, string> }> {
  const porId = new Map<string, FilaLedger>();
  const ganador = new Map<string, string>();
  const rl = createInterface({ input: createReadStream(path) });
  for await (const linea of rl) {
    if (!linea.trim()) continue;
    let fila: { trade?: FilaLedger & { officialResolution?: { winningOutcome?: string } }; officialResolution?: { winningOutcome?: string } };
    try {
      fila = JSON.parse(linea);
    } catch {
      continue;
    }
    if (!fila.trade?.id) continue;
    porId.set(fila.trade.id, { ...(porId.get(fila.trade.id) ?? {}), ...fila.trade });
    const w = fila.officialResolution?.winningOutcome ?? fila.trade.officialResolution?.winningOutcome;
    if (w) ganador.set(fila.trade.id, w);
  }
  return { trades: [...porId.values()], ganador };
}

function mediana(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  const ordenados = [...xs].sort((a, b) => a - b);
  return ordenados[Math.floor(ordenados.length / 2)];
}

async function cruzarConLedger(dataDir: string, desde: number, replay: readonly FavoriteSignal[], cortes: readonly number[], dias: number): Promise<void> {
  const { trades, ganador } = await leerLedger(join(dataDir, "trades.jsonl"));
  // Solo la entrada ORIGINAL de cada ventana: el replay no modela reentradas.
  const ledger = trades.filter((t) => t.strategy === "favorito" && t.mode === "sim" && (t.reentry ?? 0) === 0 && t.windowStartMs >= desde);
  const ledgerPorSlug = new Map(ledger.map((t) => [t.slug, t]));
  const replayPorSlug = new Map(replay.map((s) => [s.slug, s]));
  const ambos = [...ledgerPorSlug.keys()].filter((slug) => replayPorSlug.has(slug));
  const soloLedger = ledger.length - ambos.length;
  const soloReplay = replay.length - ambos.length;
  const ladoDistinto = ambos.filter((slug) => ledgerPorSlug.get(slug)!.outcome !== replayPorSlug.get(slug)!.outcome).length;
  const difAsk = ambos.map((slug) => ledgerPorSlug.get(slug)!.bestAsk - replayPorSlug.get(slug)!.ask);
  const difSegundos = ambos.map((slug) => {
    const t = ledgerPorSlug.get(slug)!;
    return (t.endMs - t.createdAtMs) / 1000 - replayPorSlug.get(slug)!.secondsToEnd;
  });

  console.log("=== CRUCE con el ledger (entradas originales del favorito en sim) ===");
  console.log(`ledger=${ledger.length} replay=${replay.length} | en ambos=${ambos.length} solo ledger=${soloLedger} solo replay=${soloReplay}`);
  console.log(`en las compartidas: lado distinto=${ladoDistinto} | ask ledger-replay (mediana)=${mediana(difAsk).toFixed(3)} | segundos al cierre ledger-replay (mediana)=${mediana(difSegundos).toFixed(1)}`);
  if (ladoDistinto > 0) {
    console.log("AVISO: el bot y el replay eligen lados distintos. No se juzga la estrategia hasta explicar esto.");
  }

  const resueltas: Operacion[] = ledger
    .filter((t) => ganador.has(t.id))
    .map((t) => {
      const feeRateBps = defaultTakerFeeRateBps(t.asset);
      const won = ganador.get(t.id) === t.outcome;
      const [liquidada] = settleFavoriteSignals(
        [{ predicted: t.bestAsk, won, ask: t.bestAsk, windowStartMs: t.windowStartMs, market: t.asset, slug: t.slug, outcome: t.outcome as FavoriteSignal["outcome"], secondsToEnd: 0, breakEven: breakEvenWinRate(t.bestAsk, feeRateBps) }],
        { stakeUsd: STAKE_USD, feeRateBps },
      );
      return { market: t.asset, windowStartMs: t.windowStartMs, won, breakEven: breakEvenWinRate(t.bestAsk, feeRateBps), netUsd: liquidada.netUsd };
    });
  const m = medir(resueltas, cortes);
  console.log(linea("LEDGER (verdad oficial, a 5 $)", m, dias));
  console.log(detalle(m));
}

// ---------------------------------------------------------------------------------------------------

async function main(): Promise<void> {
  const { config } = loadConfig(["--mode", "sim"]);
  const desde = leerDesde(process.argv.slice(2));
  const todas = (await readAnalyticsSamples(join(config.dataDir, "analytics.jsonl")))
    .filter((sample) => sample.windowStartMs >= REGIMEN_TWAP_MS)
    .sort((izq, der) => izq.windowStartMs - der.windowStartMs);
  const viva = await configuracionViva(config.dataDir, config);
  const universo = desde === undefined ? todas : todas.filter((sample) => sample.windowStartMs >= desde);
  if (universo.length === 0) {
    console.log("No hay ventanas en el periodo pedido.");
    return;
  }
  const dias = Math.max((universo[universo.length - 1].windowStartMs - universo[0].windowStartMs) / 86_400_000, 1 / 288);
  const cortes = cortesDeTramos(universo);
  const porSlug = new Map(todas.map((sample) => [sample.slug, sample]));
  // Siempre sobre TODO el historico y filtrando despues: asi la primera ventana del periodo no se pierde
  // como "calentamiento" del `predicted` walk-forward.
  const enUniverso = (signals: FavoriteSignal[]): FavoriteSignal[] =>
    desde === undefined ? signals : signals.filter((signal) => signal.windowStartMs >= desde);

  console.log(`FAVORITO — ${universo.length} ventanas del regimen TWAP en ${dias.toFixed(1)} dias${desde === undefined ? "" : ` desde ${new Date(desde).toISOString()}`}`);
  console.log(`config viva (data/ui-config.json sobre .env): ${nombreDe(viva.params)} suma<=${viva.params.maxAskSum} suelo=${viva.params.minSecondsToEnd}s | salidas ${viva.salida ? "ENCENDIDAS" : "apagadas"} | gate de EV ${viva.requirePositiveEv ? "encendido" : "apagado"}`);
  console.log(`stake ${STAKE_USD}$ · ventaja = acierto - equilibrio · ${TRAMOS} tramos cronologicos · bootstrap por ventanas`);
  console.log("");

  const vivaSignals = enUniverso(replayFavoriteSignals(todas, viva.params).signals);
  console.log("=== CONFIG VIVA ===");
  const sinGate = medir(liquidarSinGate(vivaSignals), cortes);
  console.log(linea(`sin gate de EV${viva.requirePositiveEv ? "" : " (lo que corre)"}`, sinGate, dias));
  console.log(detalle(sinGate));
  const conGate = medir(liquidarConGate(vivaSignals, viva.ev), cortes);
  console.log(linea(`con gate de EV${viva.requirePositiveEv ? " (lo que corre)" : ""}`, conGate, dias));
  console.log("");

  if (desde !== undefined) {
    await cruzarConLedger(config.dataDir, desde, vivaSignals, cortes, dias);
    return;
  }

  console.log(`=== REJILLA — ordenada por la regla: peor tramo, despues P5 (n >= ${N_MINIMO} y datos en los ${TRAMOS} tramos) ===`);
  const filas: Array<{ nombre: string; m: Medida; compite: boolean }> = [];
  for (const entryWindowSeconds of VENTANAS) {
    for (const minCertainty of CERTEZAS) {
      for (const [minAsk, maxAsk] of BANDAS) {
        const params: FavoriteReplayParams = { ...viva.params, entryWindowSeconds, minCertainty, minAsk, maxAsk };
        const m = medir(liquidarSinGate(replayFavoriteSignals(todas, params).signals), cortes);
        filas.push({ nombre: nombreDe(params), m, compite: m.n >= N_MINIMO && m.tramosConDatos === TRAMOS });
      }
    }
  }
  filas.sort((izq, der) => {
    if (izq.compite !== der.compite) return izq.compite ? -1 : 1;
    return der.m.peorTramoPp - izq.m.peorTramoPp || der.m.p5Usd - izq.m.p5Usd;
  });
  const nombreViva = nombreDe(viva.params);
  for (const fila of filas) {
    const marca = fila.nombre === nombreViva ? " <- viva" : fila.compite ? "" : " (no compite)";
    console.log(linea(fila.nombre + marca, fila.m, dias));
    if (fila.compite) console.log(detalle(fila.m));
  }
  console.log("");

  console.log("=== SALIDAS — frente a aguantar hasta la resolucion, sobre las MISMAS entradas ===");
  medirSalidas(`entradas de la config viva (${nombreViva})`, vivaSignals, porSlug, viva.salida);
  const referencia: FavoriteReplayParams = { ...viva.params, ...ENTRADAS_REFERENCIA_SALIDAS };
  medirSalidas(`entradas de referencia (${nombreDe(referencia)})`, replayFavoriteSignals(todas, referencia).signals, porSlug, viva.salida);
}

await main();

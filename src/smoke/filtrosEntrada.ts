/**
 * ¿Sobra la mitad de las entradas? Filtros de entrada, elegidos con un periodo y juzgados con otro.
 *
 *   npx tsx src/smoke/filtrosEntrada.ts
 *
 * LA PREGUNTA. El freno que se encendio el 2026-09-19 acota la caida, pero no toca el operar de mas: el
 * bot sigue entrando ~83 veces al dia y la comision se lleva el 56% del bruto. En el hito de 600, BTC
 * media +0,12 pp en 331 operaciones — la mitad del volumen sin ventaja distinguible de cero. Esto mide
 * si QUITAR entradas enteras (un mercado, un tramo de la banda, una franja horaria) deja mas dinero por
 * operacion, o si solo deja menos operaciones.
 *
 * POR QUE ESTA PARTIDO EN DOS PERIODOS Y NO SE TOCA. Quedarse con el filtro que mejor midio sobre TODO
 * el historico es como se fabricaron dos configuraciones sobreajustadas que hubo que retirar (la de
 * 80 s con z >= 1,5 y la del maximo de certeza). Aqui se elige con lo anterior al cambio de config y se
 * juzga con lo posterior, que no se ha usado para elegir. Los candidatos estan escritos ANTES de ver
 * ningun resultado, y se imprimen TODOS, tambien los que pierden.
 *
 * AVISO DE MULTIPLICIDAD, por escrito antes del dato: son ~15 candidatos sobre ~650 operaciones. Con
 * esa cantidad de casillas, la mejor de todas se ve bien por puro azar aunque ninguna sirva. Por eso la
 * regla no elige por la media sino por el PEOR TRAMO, y por eso el veredicto lo da el periodo de juicio.
 *
 * LA VENTAJA ES LO UNICO QUE SIGNIFICA ALGO. Acertar el 85% no dice nada por si solo: comprando a 0,85
 * hay que acertar ~85% solo para empatar. `ventaja = acierto - equilibrio`, en puntos porcentuales.
 */
import { muestrasEnOrden } from "../analyticsStream.js";
import { loadConfig } from "../config.js";
import { breakEvenWinRate, crearReplayFavorito, settleFavoriteSignals } from "../favoriteReplay.js";
import { DEFAULT_FAVORITE_MAX_ASK, DEFAULT_FAVORITE_MIN_ASK, DEFAULT_MAX_ASK_SUM } from "../favoriteSelector.js";
import { calculateTradeFeeUsd, defaultTakerFeeRateBps } from "../fees.js";
import { cargarLedgerFavorito } from "../ledgerFavorito.js";
import { DEFAULT_MIN_SECONDS_TO_END } from "../markets.js";
import { calculateTradePnl } from "../pnl.js";
import { bootstrapCIPorBloques } from "../tradeStats.js";
import type { BotConfig, MarketSymbol } from "../types.js";
import { applySettings, UiSettingsStore } from "../ui/settings.js";

const STAKE_USD = 5;
const REGIMEN_TWAP_MS = Date.parse("2026-08-08T00:00:00Z");
const CAMBIO_MS = Date.parse("2026-09-11T05:25:47Z");
const REANUDACION_MS = Date.parse("2026-09-12T11:49:23Z");
/**
 * Cuando se encendio el freno de racha 3. A partir de aqui el ledger deja de ser una serie limpia "sin
 * freno": las entradas que el freno salte no estan, y no estan POR UNA RAZON QUE DEPENDE DEL RESULTADO
 * de las anteriores. Mientras el freno no haya disparado ninguna vez no censura nada, pero en cuanto lo
 * haga, comparar filtros sobre este periodo mezcla dos regimenes. El smoke lo avisa solo.
 */
const FRENO_ENCENDIDO_MS = Date.parse("2026-09-19T20:49:00Z");
const DEFAULT_MAX_ASK_SPREAD = 0.02;
/** Menos de esto no es una muestra, es una anecdota. */
const N_MINIMO = 150;

/** Una entrada, con lo justo para poder filtrarla y puntuarla. */
interface Entrada {
  market: MarketSymbol;
  ask: number;
  horaUtc: number;
  segundosAlCierre: number;
  won: boolean;
  breakEven: number;
  netoUsd: number;
  comisionUsd: number;
  windowStartMs: number;
}

interface Medida {
  n: number;
  porDia: number;
  aciertoPct: number;
  equilibrioPct: number;
  ventajaPp: number;
  netoUsd: number;
  netoPorOp: number;
  comisionUsd: number;
  peorTramoPp: number;
  tramosPositivos: number;
  tramosConDatos: number;
  pPositivo: number;
}

type Filtro = { nombre: string; pasa: (e: Entrada) => boolean; unaPorVentana?: boolean };

/**
 * Los candidatos, escritos antes de mirar nada.
 *
 * Tres familias y una razon para cada una: por MERCADO (la tabla del hito de 600 sugiere que BTC no
 * aporta), por TRAMO DE LA BANDA (comprar mas barato deja mas margen sobre el equilibrio, comprar mas
 * caro acierta mas: no es obvio cual gana) y por FRANJA HORARIA (las sesiones de Asia, Europa y America
 * no se parecen). Mas una que no filtra por calidad sino por correlacion: una sola entrada por ventana,
 * porque las tres del mismo minuto pierden juntas el 47,5% de las veces.
 */
const CANDIDATOS: Filtro[] = [
  { nombre: "sin filtro (lo que corre hoy)", pasa: () => true },
  { nombre: "sin BTC", pasa: (e) => e.market !== "BTC" },
  { nombre: "sin ETH", pasa: (e) => e.market !== "ETH" },
  { nombre: "solo BTC", pasa: (e) => e.market === "BTC" },
  { nombre: "solo ETH", pasa: (e) => e.market === "ETH" },
  { nombre: "banda 0,82-0,88", pasa: (e) => e.ask >= 0.82 },
  { nombre: "banda 0,84-0,88", pasa: (e) => e.ask >= 0.84 },
  { nombre: "banda 0,79-0,85", pasa: (e) => e.ask <= 0.85 },
  { nombre: "banda 0,79-0,83", pasa: (e) => e.ask <= 0.83 },
  { nombre: "solo 00-06 UTC", pasa: (e) => e.horaUtc < 6 },
  { nombre: "solo 06-12 UTC", pasa: (e) => e.horaUtc >= 6 && e.horaUtc < 12 },
  { nombre: "solo 12-18 UTC", pasa: (e) => e.horaUtc >= 12 && e.horaUtc < 18 },
  { nombre: "solo 18-24 UTC", pasa: (e) => e.horaUtc >= 18 },
  { nombre: "sin 00-06 UTC", pasa: (e) => e.horaUtc >= 6 },
  { nombre: "sin 12-18 UTC", pasa: (e) => e.horaUtc < 12 || e.horaUtc >= 18 },
  { nombre: "una sola entrada por ventana", pasa: () => true, unaPorVentana: true },
];

/** De las tres del mismo minuto, la que entro ANTES (mas segundos al cierre). Sin mirar el resultado. */
function unaPorVentana(entradas: readonly Entrada[]): Entrada[] {
  const mejor = new Map<number, Entrada>();
  for (const e of entradas) {
    const previa = mejor.get(e.windowStartMs);
    if (!previa || e.segundosAlCierre > previa.segundosAlCierre) mejor.set(e.windowStartMs, e);
  }
  return [...mejor.values()].sort((izq, der) => izq.windowStartMs - der.windowStartMs);
}

function medir(todas: readonly Entrada[], filtro: Filtro): Medida | undefined {
  const base = todas.filter((e) => filtro.pasa(e));
  const sel = filtro.unaPorVentana ? unaPorVentana(base) : base;
  if (sel.length === 0) return undefined;

  const n = sel.length;
  const acierto = sel.filter((e) => e.won).length / n;
  const equilibrio = sel.reduce((suma, e) => suma + e.breakEven, 0) / n;
  const neto = sel.reduce((suma, e) => suma + e.netoUsd, 0);

  // Seis tramos CRONOLOGICOS sobre el universo completo, no sobre el filtrado: si los cortes se
  // recalcularan por candidato, cada uno tendria tramos distintos y no se podrian comparar.
  const ventanas = todas.map((e) => e.windowStartMs).sort((izq, der) => izq - der);
  const cortes = Array.from({ length: 5 }, (_, i) => ventanas[Math.floor(((i + 1) * ventanas.length) / 6)]);
  const tramoDe = (ws: number): number => cortes.filter((corte) => ws >= corte).length;
  const grupos: Entrada[][] = Array.from({ length: 6 }, () => []);
  for (const e of sel) grupos[tramoDe(e.windowStartMs)].push(e);
  const ventajas = grupos
    .filter((g) => g.length > 0)
    .map((g) => 100 * (g.filter((e) => e.won).length / g.length - g.reduce((s, e) => s + e.breakEven, 0) / g.length));

  const boot = bootstrapCIPorBloques(sel.map((e) => e.netoUsd), sel.map((e) => e.windowStartMs));
  const dias = (ventanas[ventanas.length - 1] - ventanas[0]) / 86_400_000;

  return {
    n,
    porDia: n / Math.max(dias, 1),
    aciertoPct: 100 * acierto,
    equilibrioPct: 100 * equilibrio,
    ventajaPp: 100 * (acierto - equilibrio),
    netoUsd: neto,
    netoPorOp: neto / n,
    comisionUsd: sel.reduce((suma, e) => suma + e.comisionUsd, 0),
    peorTramoPp: ventajas.length ? Math.min(...ventajas) : Number.NaN,
    tramosPositivos: ventajas.filter((v) => v > 0).length,
    tramosConDatos: ventajas.length,
    pPositivo: boot.positiveShare,
  };
}

function linea(nombre: string, m: Medida | undefined): string {
  if (!m) return `${nombre.padEnd(30)} sin datos`;
  const pp = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}pp`;
  const usd = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}$`;
  return [
    nombre.padEnd(30),
    `n=${String(m.n).padStart(4)}`,
    `${m.porDia.toFixed(0).padStart(3)}/dia`,
    `ventaja=${pp(m.ventajaPp).padStart(8)}`,
    `neto/op=${usd(m.netoPorOp).padStart(7)}`,
    `neto=${usd(m.netoUsd).padStart(9)}`,
    `comision=${m.comisionUsd.toFixed(1).padStart(5)}$`,
    `tramos+=${m.tramosPositivos}/${m.tramosConDatos}`,
    `peor=${pp(m.peorTramoPp).padStart(8)}`,
    `P(+)=${(100 * m.pPositivo).toFixed(0).padStart(3)}%`,
  ].join(" ");
}

async function entradasDelReplay(dataDir: string, efectiva: BotConfig): Promise<Entrada[]> {
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
  const fuentes = [`${dataDir}/archive/analytics-archive.jsonl`, `${dataDir}/analytics.jsonl`];
  for await (const sample of muestrasEnOrden(
    fuentes,
    (u) => u.windowStartMs >= REGIMEN_TWAP_MS && u.windowStartMs < CAMBIO_MS,
  )) {
    endMsPorSlug.set(sample.slug, sample.endMs);
    replay.observa(sample);
  }

  return replay.resultado().signals.map((signal) => {
    const feeRateBps = defaultTakerFeeRateBps(signal.market);
    const liquidada = settleFavoriteSignals([signal], { stakeUsd: STAKE_USD, feeRateBps })[0];
    const creadaMs = (endMsPorSlug.get(signal.slug) ?? 0) - signal.secondsToEnd * 1000;
    return {
      market: signal.market,
      ask: signal.ask,
      horaUtc: new Date(creadaMs).getUTCHours(),
      segundosAlCierre: signal.secondsToEnd,
      won: signal.won,
      breakEven: signal.breakEven,
      netoUsd: liquidada.netUsd,
      comisionUsd: calculateTradeFeeUsd({ shares: STAKE_USD / signal.ask, price: signal.ask, feeRateBps }),
      windowStartMs: signal.windowStartMs,
    };
  });
}

async function entradasDelLedger(dataDir: string): Promise<Entrada[]> {
  const trades = (await cargarLedgerFavorito(dataDir)).filter(
    // Sin mercado o sin precio de entrada no se puede ni filtrar ni puntuar. No deberia faltar ninguna;
    // si el recuento no cuadra con el del ledger, eso es una señal y no un detalle.
    (t) => t.createdAtMs >= REANUDACION_MS && t.asset !== undefined && t.bestAsk !== undefined,
  );
  return trades.map((t) => {
    const market = t.asset as MarketSymbol;
    const feeRateBps = defaultTakerFeeRateBps(market);
    const ask = t.bestAsk ?? 0;
    return {
      market,
      ask,
      horaUtc: new Date(t.createdAtMs).getUTCHours(),
      segundosAlCierre: ((t.endMs ?? t.createdAtMs) - t.createdAtMs) / 1000,
      won: Boolean(t.resolved?.won),
      breakEven: breakEvenWinRate(ask, feeRateBps),
      netoUsd: calculateTradePnl(t).netUsd ?? 0,
      comisionUsd: calculateTradeFeeUsd({ shares: t.estimatedShares, price: ask, feeRateBps }),
      // El ledger no guarda el inicio de ventana en todas las filas; el cierre identifica la ventana igual.
      windowStartMs: (t.endMs ?? t.createdAtMs) - 310_000,
    };
  });
}

async function main(): Promise<void> {
  const { config } = loadConfig(["--mode", "sim"]);
  const settings = await new UiSettingsStore(config.dataDir).load(config);
  const efectiva: BotConfig = applySettings(config, settings);

  const eleccion = await entradasDelReplay(config.dataDir, efectiva);
  const juicio = await entradasDelLedger(config.dataDir);

  console.log("FILTROS DE ENTRADA — ¿sobra volumen, o solo sobra dinero?");
  console.log(`ELECCION: ${eleccion.length} entradas del replay anteriores al ${new Date(CAMBIO_MS).toISOString()}`);
  console.log(`JUICIO:   ${juicio.length} entradas REALES del ledger desde ${new Date(REANUDACION_MS).toISOString()}`);
  console.log(`ventaja = acierto - equilibrio · 6 tramos cronologicos · bootstrap por ventanas · stake ${STAKE_USD}$`);
  const conFreno = juicio.filter((e) => e.windowStartMs >= FRENO_ENCENDIDO_MS).length;
  if (conFreno > 0) {
    console.log(
      `AVISO: ${conFreno} de las entradas del juicio son posteriores al encendido del freno ` +
        `(${new Date(FRENO_ENCENDIDO_MS).toISOString()}). Mientras el freno no dispare no falta ninguna, ` +
        "pero en cuanto dispare este periodo deja de ser comparable y hay que cortarlo ahi.",
    );
  }
  console.log("");

  const medidas = CANDIDATOS.map((filtro) => ({
    filtro,
    eleccion: medir(eleccion, filtro),
    juicio: medir(juicio, filtro),
  }));

  // REGLA ESCRITA ANTES DEL DATO: elegible con n >= 150 y los 6 tramos con datos; gana el mayor PEOR
  // TRAMO —la regla de la casa, porque la media premia al que tuvo una buena racha— y a igualdad, el
  // mayor neto por operacion. El periodo de juicio NO participa en esto.
  const aptos = medidas.filter(
    (m) => m.filtro.nombre !== CANDIDATOS[0].nombre && m.eleccion && m.eleccion.n >= N_MINIMO && m.eleccion.tramosConDatos === 6,
  );
  aptos.sort((izq, der) => der.eleccion!.peorTramoPp - izq.eleccion!.peorTramoPp || der.eleccion!.netoPorOp - izq.eleccion!.netoPorOp);
  const elegido = aptos[0];

  console.log("=== PERIODO DE ELECCION (con esto se decide) ===");
  for (const m of [...medidas].sort((a, b) => (b.eleccion?.peorTramoPp ?? -Infinity) - (a.eleccion?.peorTramoPp ?? -Infinity))) {
    const motivo =
      m.filtro.nombre === CANDIDATOS[0].nombre
        ? "  <- referencia"
        : m === elegido
          ? "  <- ELEGIDO"
          : m.eleccion && m.eleccion.n < N_MINIMO
            ? `  (n < ${N_MINIMO})`
            : "";
    console.log(linea(m.filtro.nombre, m.eleccion) + motivo);
  }
  console.log(`\nELEGIDO por la regla (mayor peor-tramo, n >= ${N_MINIMO}): ${elegido?.filtro.nombre ?? "ninguno cumple"}`);

  console.log("\n=== PERIODO DE JUICIO (nunca usado para elegir) ===");
  for (const m of [...medidas].sort((a, b) => (b.juicio?.peorTramoPp ?? -Infinity) - (a.juicio?.peorTramoPp ?? -Infinity))) {
    const marca = m.filtro.nombre === CANDIDATOS[0].nombre ? "  <- referencia" : m === elegido ? "  <- ELEGIDO" : "";
    console.log(linea(m.filtro.nombre, m.juicio) + marca);
  }

  // APENDICE DESCRIPTIVO, no participa en la eleccion. Sirve para una sola pregunta: si una franja
  // horaria sale mal, ¿es una hora suelta —y entonces es ruido— o es un bloque continuo con una razon?
  // Las 12-18 UTC son las 8-14 de Nueva York: la sesion americana, justo cuando la cripto se mueve mas y
  // el favorito de una ventana de cinco minutos tiene mas ocasiones de darse la vuelta.
  console.log("\n=== HORA A HORA (descriptivo, no se elige con esto) ===");
  console.log("hora UTC |            ELECCION            |             JUICIO");
  for (let hora = 0; hora < 24; hora += 1) {
    const porHora = (entradas: readonly Entrada[]) => {
      const sel = entradas.filter((e) => e.horaUtc === hora);
      if (sel.length === 0) return "        sin datos       ";
      const ventaja = 100 * (sel.filter((e) => e.won).length / sel.length - sel.reduce((s, e) => s + e.breakEven, 0) / sel.length);
      const netoOp = sel.reduce((s, e) => s + e.netoUsd, 0) / sel.length;
      return `n=${String(sel.length).padStart(3)} ventaja=${(ventaja >= 0 ? "+" : "") + ventaja.toFixed(2)}pp neto/op=${(netoOp >= 0 ? "+" : "") + netoOp.toFixed(2)}$`;
    };
    console.log(`  ${String(hora).padStart(2, "0")}:00  | ${porHora(eleccion)} | ${porHora(juicio)}`);
  }

  const base = medidas[0];
  if (elegido?.juicio && base.juicio) {
    const d = elegido.juicio;
    const b = base.juicio;
    console.log("\n=== EL ELEGIDO, EN EL PERIODO QUE NO USO PARA ELEGIR ===");
    console.log(`operaciones: ${b.n} -> ${d.n} (${(100 * (d.n / b.n - 1)).toFixed(0)}%)`);
    console.log(`ventaja:     ${b.ventajaPp.toFixed(2)}pp -> ${d.ventajaPp.toFixed(2)}pp`);
    console.log(`neto/op:     ${b.netoPorOp.toFixed(4)}$ -> ${d.netoPorOp.toFixed(4)}$`);
    console.log(`neto total:  ${b.netoUsd.toFixed(2)}$ -> ${d.netoUsd.toFixed(2)}$`);
    console.log(`comision:    ${b.comisionUsd.toFixed(2)}$ -> ${d.comisionUsd.toFixed(2)}$`);
    console.log(
      d.netoPorOp > b.netoPorOp
        ? "Deja mas dinero por operacion operando menos."
        : "Opera menos y ademas gana menos por operacion: no filtra calidad, solo volumen.",
    );
  }
}

await main();

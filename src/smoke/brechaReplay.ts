/**
 * ¿Por que el replay da unas tres veces lo que da el papel real?
 *
 *   npx tsx src/smoke/brechaReplay.ts                         desde el reinicio del P&L
 *   npx tsx src/smoke/brechaReplay.ts --desde 2026-09-22T00:00:00Z
 *
 * EL PROBLEMA. `simetria.ts` midio que, para el mismo periodo (22-sep → 10-oct), el replay del favorito
 * con la regla de hoy da unos +129 $ y el ledger real +42,87 $. Todas las decisiones de configuracion de
 * este proyecto se han tomado con el replay; si rinde el triple de la realidad, no se sabe cuanto de lo
 * que se eligio es ventaja y cuanto es el sesgo del replay.
 *
 * LO QUE YA ESTA DESCARTADO, medido antes de escribir esto: en el periodo no hay ninguna salida por stop
 * (`favoriteExitEnabled` apagado), ninguna reentrada, y el precio medio de llenado se separa del mejor ask
 * en 0,0004 de media. El replay no modela ninguna de las tres cosas, pero aqui no pesan.
 *
 * EL METODO: una cascada. Se parte del replay y se llega al ledger cambiando UNA cosa cada vez, siempre
 * con `calculateTradePnl` — el mismo calculo que el P&L de produccion — para que ningun paso dependa de
 * una formula propia:
 *
 *   1. replay sin frenos                      lo que la estrategia QUERRIA hacer
 *   2. − lo que el replay toma y el bot no    cobertura: frenos del bot, ventanas sin decision...
 *   3. etiqueta: ganador del replay → oficial el replay puntua con su `scoringOutcome`; paga el oficial
 *   4. precio: ask del replay → ask del bot    el bot decide en otro tick, a otro precio
 *   5. lado: el que eligio el replay → el bot  si eligen lados distintos en la misma ventana
 *   6. + lo que el bot toma y el replay no
 *   = ledger real
 *
 * Cada paso es una diferencia entre dos sumas exactas, asi que la cascada cuadra al centimo o hay un
 * error en la herramienta: el ultimo renglon lo comprueba.
 */
import { createReadStream } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

import { muestrasEnOrden } from "../analyticsStream.js";
import { loadConfig } from "../config.js";
import { crearReplayFavorito, type FavoriteSignal } from "../favoriteReplay.js";
import { DEFAULT_FAVORITE_MAX_ASK, DEFAULT_FAVORITE_MIN_ASK, DEFAULT_MAX_ASK_SUM } from "../favoriteSelector.js";
import { simular, type Regla } from "../frenoSimulacion.js";
import { DEFAULT_MIN_SECONDS_TO_END } from "../markets.js";
import { calculateTradePnl, tradeClosedAtMs } from "../pnl.js";
import { dayKeyInTimeZone } from "../timezone.js";
import type { BotConfig, MarketSymbol, Outcome, TradeAttempt } from "../types.js";
import { applySettings, UiSettingsStore } from "../ui/settings.js";

const STAKE_USD = 5;
const DEFAULT_MAX_ASK_SPREAD = 0.02;
const DESDE_POR_DEFECTO = Date.parse("2026-09-22T00:00:00Z");

type Real = TradeAttempt & { officialResolution?: { winningOutcome?: string } };

function leerDesde(argv: readonly string[]): number {
  const i = argv.findIndex((a) => a === "--desde" || a.startsWith("--desde="));
  if (i < 0) return DESDE_POR_DEFECTO;
  const crudo = argv[i].includes("=") ? argv[i].split("=")[1] : argv[i + 1];
  const ms = Date.parse(crudo ?? "");
  if (!Number.isFinite(ms)) throw new Error(`--desde necesita una fecha ISO valida, no "${crudo}".`);
  return ms;
}

async function leerLedger(path: string): Promise<{ trades: Real[]; oficial: Map<string, Outcome> }> {
  const porId = new Map<string, Real>();
  const oficial = new Map<string, Outcome>();
  const rl = createInterface({ input: createReadStream(path) });
  for await (const linea of rl) {
    if (!linea.trim()) continue;
    let fila: { trade?: Real; officialResolution?: { winningOutcome?: string } };
    try {
      fila = JSON.parse(linea);
    } catch {
      continue;
    }
    if (!fila.trade?.id) continue;
    porId.set(fila.trade.id, { ...(porId.get(fila.trade.id) ?? {}), ...fila.trade } as Real);
    const w = fila.officialResolution?.winningOutcome ?? fila.trade.officialResolution?.winningOutcome;
    if (w) oficial.set(fila.trade.id, w as Outcome);
  }
  return { trades: [...porId.values()], oficial };
}

/** Una operacion sintetica a 5 $ al ask dado, que gana o pierde. La comision la estima `calculateTradePnl`. */
function sintetica(args: { slug: string; market: MarketSymbol; outcome: Outcome; ask: number; won: boolean; endMs: number }): number {
  const trade = {
    id: `${args.slug}-${args.outcome}`,
    asset: args.market,
    slug: args.slug,
    mode: "sim",
    outcome: args.outcome,
    amountUsd: STAKE_USD,
    estimatedShares: STAKE_USD / args.ask,
    bestAsk: args.ask,
    createdAtMs: args.endMs - 30_000,
    endMs: args.endMs,
    resolved: { won: args.won, resolvedAtMs: args.endMs },
  } as unknown as TradeAttempt;
  return calculateTradePnl(trade).netUsd ?? 0;
}

const usd = (v: number): string => `${v >= 0 ? "+" : ""}${v.toFixed(2)}`;

async function main(): Promise<void> {
  const desde = leerDesde(process.argv.slice(2));
  const { config } = loadConfig(["--mode", "sim"]);
  const settings = await new UiSettingsStore(config.dataDir).load(config);
  const efectiva: BotConfig = applySettings(config, settings);

  // --- El ledger: TODO el papel del favorito en el periodo, con el P&L de produccion. ---
  const { trades, oficial } = await leerLedger(join(config.dataDir, "trades.jsonl"));
  const reales = trades.filter((t) => t.mode === "sim" && t.strategy === "favorito" && t.windowStartMs >= desde);
  const netoReal = (t: Real): number => {
    const o = oficial.get(t.id);
    const conOficial = o ? ({ ...t, resolved: { ...(t.resolved ?? {}), won: o === t.outcome } } as TradeAttempt) : t;
    return calculateTradePnl(conOficial).netUsd ?? 0;
  };
  const cerradas = reales.filter((t) => calculateTradePnl(t).status === "resolved");
  const totalReal = cerradas.reduce((s, t) => s + netoReal(t), 0);

  // --- El replay, en flujo, sobre las mismas ventanas. ---
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
  const ventanasGrabadas = new Set<string>();
  const fuentes = [join(config.dataDir, "archive", "analytics-archive.jsonl"), join(config.dataDir, "analytics.jsonl")];
  // El historial walk-forward del replay necesita lo anterior, asi que se le da TODO y se filtra despues.
  for await (const sample of muestrasEnOrden(fuentes, () => true)) {
    endMsPorSlug.set(sample.slug, sample.endMs);
    if (sample.windowStartMs >= desde) ventanasGrabadas.add(sample.slug);
    replay.observa(sample);
  }
  const resultado = replay.resultado();
  const señales = resultado.signals.filter((s) => s.windowStartMs >= desde);
  const ultimaReal = Math.max(...cerradas.map((t) => t.windowStartMs));
  // Mismo final para los dos lados: el replay no puede contar ventanas que el ledger aun no ha cerrado.
  const enPeriodo = señales.filter((s) => s.windowStartMs <= ultimaReal);

  const realPorSlug = new Map(cerradas.map((t) => [t.slug, t]));
  const replayPorSlug = new Map(enPeriodo.map((s) => [s.slug, s]));
  const ambos = enPeriodo.filter((s) => realPorSlug.has(s.slug));
  const soloReplay = enPeriodo.filter((s) => !realPorSlug.has(s.slug));
  const soloReal = cerradas.filter((t) => !replayPorSlug.has(t.slug));

  const netoReplay = (s: FavoriteSignal): number =>
    sintetica({ slug: s.slug, market: s.market, outcome: s.outcome, ask: s.ask, won: s.won, endMs: endMsPorSlug.get(s.slug) ?? s.windowStartMs + 300_000 });

  // --- La cascada. ---
  const paso1 = enPeriodo.reduce((acc, s) => acc + netoReplay(s), 0);
  const quitaSoloReplay = -soloReplay.reduce((acc, s) => acc + netoReplay(s), 0);

  let etiqueta = 0;
  let precio = 0;
  let lado = 0;
  let resto = 0;
  let sinOficial = 0;
  let mismoLado = 0;
  let etiquetasDistintas = 0;
  const difAsk: number[] = [];
  const difSegundos: number[] = [];
  for (const s of ambos) {
    const t = realPorSlug.get(s.slug)!;
    const endMs = endMsPorSlug.get(s.slug) ?? t.endMs;
    const ganador = oficial.get(t.id);
    if (!ganador) sinOficial += 1;
    // Sin resolucion oficial, el ganador que el bot dio por bueno: es lo que esta en su P&L.
    const verdad: Outcome = ganador ?? ((t.resolved?.won ? t.outcome : t.outcome === "UP" ? "DOWN" : "UP") as Outcome);

    const n0 = netoReplay(s);
    const n1 = sintetica({ slug: s.slug, market: s.market, outcome: s.outcome, ask: s.ask, won: s.outcome === verdad, endMs });
    if ((s.outcome === verdad) !== s.won) etiquetasDistintas += 1;
    if (t.outcome === s.outcome) {
      mismoLado += 1;
      const n2 = sintetica({ slug: s.slug, market: s.market, outcome: s.outcome, ask: t.bestAsk ?? s.ask, won: s.outcome === verdad, endMs });
      difAsk.push((t.bestAsk ?? s.ask) - s.ask);
      difSegundos.push((t.endMs - t.createdAtMs) / 1000 - s.secondsToEnd);
      etiqueta += n1 - n0;
      precio += n2 - n1;
      resto += netoReal(t) - n2;
    } else {
      const n2 = sintetica({ slug: s.slug, market: s.market, outcome: t.outcome as Outcome, ask: t.bestAsk ?? s.ask, won: t.outcome === verdad, endMs });
      etiqueta += n1 - n0;
      lado += n2 - n1;
      resto += netoReal(t) - n2;
    }
  }
  const sumaSoloReal = soloReal.reduce((acc, t) => acc + netoReal(t), 0);
  const final = paso1 + quitaSoloReplay + etiqueta + precio + lado + resto + sumaSoloReal;

  const mediana = (xs: number[]): number => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : 0);

  console.log(`BRECHA REPLAY → LEDGER, favorito en sim, ventanas desde ${new Date(desde).toISOString()}`);
  console.log(
    `ledger: ${cerradas.length} cerradas (+${reales.length - cerradas.length} abiertas) · replay: ${enPeriodo.length} señales sin frenos · ` +
      `ventanas grabadas en el periodo: ${ventanasGrabadas.size}`,
  );
  console.log(`en ambos ${ambos.length} · solo replay ${soloReplay.length} · solo ledger ${soloReal.length}`);
  console.log(
    `en las compartidas: mismo lado ${mismoLado}/${ambos.length} · etiqueta del replay distinta de la oficial ${etiquetasDistintas} · ` +
      `sin resolucion oficial ${sinOficial}`,
  );
  console.log(`ask bot − ask replay (mediana) ${mediana(difAsk).toFixed(3)} · segundos al cierre bot − replay (mediana) ${mediana(difSegundos).toFixed(1)}\n`);

  const fila = (nombre: string, v: number, acumulado: number): void =>
    console.log(`${nombre.padEnd(48)} ${usd(v).padStart(9)}   → ${usd(acumulado).padStart(9)}`);
  let acc = paso1;
  console.log(`${"1. replay sin frenos".padEnd(48)} ${usd(paso1).padStart(9)}`);
  fila("2. − lo que el replay toma y el bot no", quitaSoloReplay, (acc += quitaSoloReplay));
  fila("3. etiqueta: ganador del replay → oficial", etiqueta, (acc += etiqueta));
  fila("4. precio: ask del replay → ask del bot", precio, (acc += precio));
  fila("5. lado: el del replay → el del bot", lado, (acc += lado));
  fila("   resto (comision real, llenado parcial...)", resto, (acc += resto));
  fila("6. + lo que el bot toma y el replay no", sumaSoloReal, (acc += sumaSoloReal));
  console.log(`${"= ledger real".padEnd(48)} ${usd(totalReal).padStart(9)}`);
  console.log(Math.abs(final - totalReal) < 0.01 ? "cuadra al centimo" : `NO CUADRA: diferencia ${usd(final - totalReal)} — error en la herramienta`);

  // --- Lo que el replay toma y el bot no: ¿por que? ---
  // Las tres causas posibles, de la mas a la menos aburrida: el bot tenia el freno puesto (objetivo,
  // racha), el bot no estaba vivo para decidir, o decidio distinto con los mismos datos.
  const porDia = new Map<string, { n: number; neto: number }>();
  for (const s of soloReplay) {
    const dia = new Date(s.windowStartMs).toISOString().slice(0, 10);
    const p = porDia.get(dia) ?? { n: 0, neto: 0 };
    porDia.set(dia, { n: p.n + 1, neto: p.neto + netoReplay(s) });
  }
  const ganadas = soloReplay.filter((s) => s.won).length;
  console.log(
    `\n=== lo que el replay toma y el bot no: ${soloReplay.length} entradas, ${usd(-quitaSoloReplay)} $, ` +
      `acierto ${((ganadas / Math.max(1, soloReplay.length)) * 100).toFixed(1)}% ===`,
  );
  for (const [dia, v] of [...porDia.entries()].sort()) console.log(`  ${dia}  n=${String(v.n).padStart(3)}  ${usd(v.neto).padStart(8)}`);

  // Lo que el bot toma y el replay no: pocas, pero cada una puede decidir el dia entero (ver diaDivergente.ts).
  console.log(`
=== lo que el bot toma y el replay no: ${soloReal.length} entradas, ${usd(sumaSoloReal)} $ ===`);
  for (const t of [...soloReal].sort((a, b) => a.createdAtMs - b.createdAtMs)) {
    const r = replayPorSlug.get(t.slug);
    console.log(
      `  ${new Date(t.createdAtMs).toISOString().slice(0, 16)}  ${t.slug.padEnd(28)} ${t.outcome.padEnd(4)} ask ${(t.bestAsk ?? 0).toFixed(4)}  ` +
        `a ${((t.endMs - t.createdAtMs) / 1000).toFixed(1).padStart(5)} s del cierre  ${usd(netoReal(t)).padStart(6)}${r ? "" : ""}`,
    );
  }
  console.log(
    `  banda viva: [${(efectiva.favoriteMinAsk ?? DEFAULT_FAVORITE_MIN_ASK).toFixed(2)}, ${(efectiva.favoriteMaxAsk ?? DEFAULT_FAVORITE_MAX_ASK).toFixed(2)}] · ` +
      `ventana de entrada ${efectiva.entryWindowSeconds} s · minimo al cierre ${efectiva.minSecondsToEndForEntry ?? DEFAULT_MIN_SECONDS_TO_END} s`,
  );

  await porQueNoEntro(join(config.dataDir, "ui-console.log"), soloReplay, netoReplay);
  frenosSimuladosContraReales(enPeriodo, cerradas, netoReal, endMsPorSlug, efectiva);
}

/**
 * El simulador aplica la MISMA funcion de freno que el bot. Si las dos cosas fueran fieles, con las
 * mismas entradas saltarian en el mismo instante y el neto de cada dia coincidiria. Aqui se mira dia a
 * dia donde no coinciden.
 */
function frenosSimuladosContraReales(
  señales: readonly FavoriteSignal[],
  cerradas: readonly Real[],
  netoReal: (t: Real) => number,
  endMsPorSlug: ReadonlyMap<string, number>,
  efectiva: BotConfig,
): void {
  const ops = señales.map((s) => {
    const endMs = endMsPorSlug.get(s.slug) ?? s.windowStartMs + 300_000;
    return {
      id: `${s.slug}-${s.outcome}`,
      asset: s.market,
      slug: s.slug,
      mode: "sim",
      outcome: s.outcome,
      amountUsd: STAKE_USD,
      estimatedShares: STAKE_USD / s.ask,
      bestAsk: s.ask,
      createdAtMs: endMs - s.secondsToEnd * 1000,
      endMs,
      resolved: { won: s.won, resolvedAtMs: endMs },
    } as unknown as TradeAttempt;
  });
  const regla: Regla = {
    nombre: "hoy",
    limites: {
      maxConsecutiveLosses: efectiva.maxConsecutiveLosses ?? 0,
      cooldownHours: efectiva.riskHaltCooldownHours ?? 0,
      dailyProfitTargetUsd: efectiva.dailyProfitTargetUsd ?? 0,
      // El periodo entero corrio SIN tope de perdida: el de 12 $ se puso al final.
      maxDailyLossUsd: 0,
    },
    topeGastoDiarioUsd: 0,
    objetivoDiarioUsd: 0,
  };
  const zona = "America/Mexico_City";
  const sim = simular(ops, regla, zona);
  const simPorDia = new Map(sim.dias.map((d) => [d.dia, d]));
  const realPorDia = new Map<string, { n: number; neto: number }>();
  for (const t of cerradas) {
    const dia = dayKeyInTimeZone(tradeClosedAtMs(t) ?? t.createdAtMs, zona);
    const p = realPorDia.get(dia) ?? { n: 0, neto: 0 };
    realPorDia.set(dia, { n: p.n + 1, neto: p.neto + netoReal(t) });
  }
  console.log(`\n=== frenos: simulador sobre el replay contra el bot real, por dia (${zona}) ===`);
  console.log("dia          sim n   sim neto   real n  real neto");
  let simTotal = 0;
  let realTotal = 0;
  for (const dia of [...new Set([...simPorDia.keys(), ...realPorDia.keys()])].sort()) {
    const s = simPorDia.get(dia);
    const r = realPorDia.get(dia);
    simTotal += s?.netoUsd ?? 0;
    realTotal += r?.neto ?? 0;
    console.log(
      `${dia}  ${String(s?.n ?? 0).padStart(6)} ${usd(s?.netoUsd ?? 0).padStart(10)} ${String(r?.n ?? 0).padStart(8)} ${usd(r?.neto ?? 0).padStart(10)}`,
    );
  }
  console.log(`total        ${usd(simTotal).padStart(17)} ${usd(realTotal).padStart(19)}`);
}

/**
 * El motivo que el PROPIO BOT apunto para no entrar, ventana a ventana.
 *
 * El bot registra cada salto una vez por ventana y motivo (`Skipped trade` con `slug` y `reason`). El log
 * nativo existe desde el 2026-10-03; lo anterior vivia en el contenedor y se perdio con el, asi que esto
 * cubre solo esa parte del periodo — y lo dice.
 *
 * Una ventana acumula varios motivos (fuera de ventana, luego por debajo de la banda, luego...). Se
 * clasifica por el de mas peso: un freno manda sobre todo, porque con el freno puesto lo demas da igual;
 * despues los datos, porque sin libro fiable el bot no puede decidir; despues la banda.
 */
async function porQueNoEntro(
  path: string,
  soloReplay: readonly FavoriteSignal[],
  netoReplay: (s: FavoriteSignal) => number,
): Promise<void> {
  const motivos = new Map<string, Set<string>>();
  let primeraMs = Number.POSITIVE_INFINITY;
  try {
    const rl = createInterface({ input: createReadStream(path) });
    for await (const linea of rl) {
      if (!linea.includes("Skipped trade")) continue;
      const slug = /"slug":"([^"]+)"/.exec(linea)?.[1];
      const motivo = /"reason":"([^"]+)"/.exec(linea)?.[1];
      const ts = Date.parse(/^\[([^\]]+)\]/.exec(linea)?.[1] ?? "");
      if (Number.isFinite(ts)) primeraMs = Math.min(primeraMs, ts);
      if (!slug || !motivo) continue;
      // Copia obligatoria: un trozo de regex retiene la linea entera en V8 (ver analyticsStream.ts).
      const clave = Buffer.from(slug, "utf8").toString("utf8");
      const set = motivos.get(clave) ?? new Set<string>();
      set.add(Buffer.from(motivo, "utf8").toString("utf8"));
      motivos.set(clave, set);
    }
  } catch {
    console.log("\n(sin ui-console.log: no hay motivos del bot que cruzar)");
    return;
  }

  const FRENO = ["daily_profit_target", "consecutive_losses", "daily_loss_limit"];
  const DATOS = ["favorite_missing_quote", "favorite_dead_book", "stale_chainlink_tick", "spread_too_wide", "missing_opening_chainlink_tick"];
  const BANDA = ["favorite_below_band", "favorite_above_band", "favorite_no_favorite", "too_close_to_close", "outside_entry_window"];
  const clasifica = (set: Set<string> | undefined): string => {
    if (!set) return "sin registro";
    for (const m of FRENO) if (set.has(m)) return `freno: ${m}`;
    for (const m of DATOS) if (set.has(m)) return `datos: ${m}`;
    for (const m of BANDA) if (set.has(m)) return `decision: ${m}`;
    return `otro: ${[...set].join(",")}`;
  };

  const cubiertas = soloReplay.filter((s) => s.windowStartMs >= primeraMs);
  const grupos = new Map<string, { n: number; neto: number; ganadas: number }>();
  for (const s of cubiertas) {
    const k = clasifica(motivos.get(s.slug));
    const g = grupos.get(k) ?? { n: 0, neto: 0, ganadas: 0 };
    grupos.set(k, { n: g.n + 1, neto: g.neto + netoReplay(s), ganadas: g.ganadas + (s.won ? 1 : 0) });
  }
  console.log(
    `\n=== ¿por que no entro? segun el log del bot, desde ${new Date(primeraMs).toISOString()} ` +
      `(${cubiertas.length} de ${soloReplay.length} entradas cubiertas) ===`,
  );
  for (const [k, g] of [...grupos.entries()].sort((a, b) => b[1].n - a[1].n)) {
    console.log(
      `  ${k.padEnd(44)} n=${String(g.n).padStart(4)}  ${usd(g.neto).padStart(8)} $  acierto ${((g.ganadas / g.n) * 100).toFixed(1)}%`,
    );
  }
}

await main();

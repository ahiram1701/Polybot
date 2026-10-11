/**
 * Un dia concreto, entrada a entrada: lo que el replay queria hacer, lo que hizo el bot, y donde se separan.
 *
 *   npx tsx src/smoke/diaDivergente.ts 2026-10-09
 *
 * Existe porque `brechaReplay.ts` encontro dias en los que el simulador y el bot, con la misma funcion de
 * freno y las mismas operaciones compartidas, acaban en sitios muy distintos (el 9-oct: 10 entradas y
 * +8,62 $ simuladas contra 89 y -5,30 $ reales). Si el freno es el mismo, la diferencia tiene que estar en
 * la SECUENCIA de entradas que ve cada uno, y eso solo se ve fila a fila.
 */
import { createReadStream } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

import { muestrasEnOrden } from "../analyticsStream.js";
import { loadConfig } from "../config.js";
import { crearReplayFavorito } from "../favoriteReplay.js";
import { DEFAULT_FAVORITE_MAX_ASK, DEFAULT_FAVORITE_MIN_ASK, DEFAULT_MAX_ASK_SUM } from "../favoriteSelector.js";
import { DEFAULT_MIN_SECONDS_TO_END } from "../markets.js";
import { calculateTradePnl } from "../pnl.js";
import { dayKeyInTimeZone, resolveTimeZone } from "../timezone.js";
import type { BotConfig, TradeAttempt } from "../types.js";
import { applySettings, UiSettingsStore } from "../ui/settings.js";

const ZONA_POR_DEFECTO = "America/Mexico_City";

async function main(): Promise<void> {
  const dia = process.argv[2];
  if (!dia || !/^\d{4}-\d{2}-\d{2}$/.test(dia)) throw new Error("uso: diaDivergente.ts YYYY-MM-DD");
  const { config } = loadConfig(["--mode", "sim"]);
  const settings = await new UiSettingsStore(config.dataDir).load(config);
  const efectiva: BotConfig = applySettings(config, settings);
  const zona = resolveTimeZone(efectiva.timezone) ?? ZONA_POR_DEFECTO;

  // El ledger del dia, con el ganador oficial.
  const porId = new Map<string, TradeAttempt>();
  const oficial = new Map<string, string>();
  const rl = createInterface({ input: createReadStream(join(config.dataDir, "trades.jsonl")) });
  for await (const linea of rl) {
    if (!linea.trim()) continue;
    let f: { trade?: TradeAttempt & { officialResolution?: { winningOutcome?: string } }; officialResolution?: { winningOutcome?: string } };
    try {
      f = JSON.parse(linea);
    } catch {
      continue;
    }
    if (!f.trade?.id) continue;
    porId.set(f.trade.id, { ...(porId.get(f.trade.id) ?? {}), ...f.trade } as TradeAttempt);
    const w = f.officialResolution?.winningOutcome ?? f.trade.officialResolution?.winningOutcome;
    if (w) oficial.set(f.trade.id, w);
  }
  const reales = [...porId.values()].filter(
    (t) => t.mode === "sim" && t.strategy === "favorito" && dayKeyInTimeZone(t.createdAtMs, zona) === dia,
  );
  const realPorSlug = new Map(reales.map((t) => [t.slug, t]));
  const netoReal = (t: TradeAttempt): number => {
    const o = oficial.get(t.id);
    return calculateTradePnl(o ? ({ ...t, resolved: { ...(t.resolved ?? {}), won: o === t.outcome } } as TradeAttempt) : t).netUsd ?? 0;
  };

  // El replay del dia (con todo lo anterior, porque el historial es walk-forward).
  const replay = crearReplayFavorito({
    entryWindowSeconds: efectiva.entryWindowSeconds,
    minSecondsToEnd: efectiva.minSecondsToEndForEntry ?? DEFAULT_MIN_SECONDS_TO_END,
    minAsk: efectiva.favoriteMinAsk ?? DEFAULT_FAVORITE_MIN_ASK,
    maxAsk: efectiva.favoriteMaxAsk ?? DEFAULT_FAVORITE_MAX_ASK,
    maxAskSum: efectiva.favoriteMaxAskSum ?? DEFAULT_MAX_ASK_SUM,
    maxAskSpread: efectiva.maxAskSpread ?? 0.02,
    minCertainty: efectiva.favoriteMinCertainty ?? 1,
  });
  const endMsPorSlug = new Map<string, number>();
  const fuentes = [join(config.dataDir, "archive", "analytics-archive.jsonl"), join(config.dataDir, "analytics.jsonl")];
  for await (const s of muestrasEnOrden(fuentes, () => true)) {
    endMsPorSlug.set(s.slug, s.endMs);
    replay.observa(s);
  }
  const señales = replay
    .resultado()
    .signals.filter((s) => dayKeyInTimeZone((endMsPorSlug.get(s.slug) ?? s.windowStartMs) - s.secondsToEnd * 1000, zona) === dia);
  const replayPorSlug = new Map(señales.map((s) => [s.slug, s]));

  // Una linea por entrada, de los dos lados, en orden de decision.
  type Fila = { ms: number; texto: string };
  const filas: Fila[] = [];
  let acumReal = 0;
  const hora = (ms: number): string =>
    new Intl.DateTimeFormat("es-MX", { timeZone: zona, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(ms));
  for (const t of [...reales].sort((a, b) => a.createdAtMs - b.createdAtMs)) {
    acumReal += netoReal(t);
    const r = replayPorSlug.get(t.slug);
    filas.push({
      ms: t.createdAtMs,
      texto: `${hora(t.createdAtMs)}  BOT     ${t.slug.padEnd(28)} ${t.outcome.padEnd(4)} ask ${t.bestAsk?.toFixed(3)}  ${netoReal(t) >= 0 ? "+" : ""}${netoReal(t).toFixed(2).padStart(6)}  dia ${acumReal.toFixed(2).padStart(7)}${r ? "" : "   <- el replay NO la tiene"}`,
    });
  }
  for (const s of señales) {
    if (realPorSlug.has(s.slug)) continue;
    const ms = (endMsPorSlug.get(s.slug) ?? s.windowStartMs) - s.secondsToEnd * 1000;
    filas.push({ ms, texto: `${hora(ms)}  replay  ${s.slug.padEnd(28)} ${s.outcome.padEnd(4)} ask ${s.ask.toFixed(3)}  ${s.won ? "gana" : "PIERDE"}   (el bot no entro)` });
  }
  console.log(`${dia} en ${zona}: bot ${reales.length} entradas (${acumReal >= 0 ? "+" : ""}${acumReal.toFixed(2)} $) · replay ${señales.length} señales sin frenos`);
  for (const f of filas.sort((a, b) => a.ms - b.ms)) console.log(f.texto);
}

await main();

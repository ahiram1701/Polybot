/**
 * El universo que comparten las mediciones de frenos: las entradas que el favorito QUERRIA hacer, sin
 * ningun freno, sobre toda la analitica grabada, con la configuracion viva.
 *
 * Una sola copia porque cada detalle cambia la cuenta. Y la zona sale de aqui ya resuelta a un NOMBRE:
 * `simular` no acepta `undefined`, que en este codigo significa dos zonas distintas (ver `simular`).
 */
import { join } from "node:path";

import { muestrasEnOrden } from "../analyticsStream.js";
import { loadConfig } from "../config.js";
import { crearReplayFavorito, type FavoriteSignal } from "../favoriteReplay.js";
import { DEFAULT_FAVORITE_MAX_ASK, DEFAULT_FAVORITE_MIN_ASK, DEFAULT_MAX_ASK_SUM } from "../favoriteSelector.js";
import { DEFAULT_MIN_SECONDS_TO_END } from "../markets.js";
import { dayKeyInTimeZone, resolveTimeZone } from "../timezone.js";
import type { BotConfig, MarketSymbol, TradeAttempt } from "../types.js";
import { applySettings, UiSettingsStore } from "../ui/settings.js";

export const STAKE_USD = 5;
const REGIMEN_TWAP_MS = Date.parse("2026-08-08T00:00:00Z");
const DEFAULT_MAX_ASK_SPREAD = 0.02;

export interface Universo {
  efectiva: BotConfig;
  /** Nombre IANA, nunca `undefined`: "auto" resuelto a la zona del sistema, que es lo que hace el bot. */
  timeZone: string;
  ops: TradeAttempt[];
  ventanas: number;
  /** Los dias del universo en orden, por dia de DECISION. Los cortes de tramo salen de aqui. */
  dias: string[];
}

/** Solo lo que el freno mira. La comision la estima `calculateTradePnl`, igual que en produccion. */
export function comoOperacion(signal: FavoriteSignal, endMs: number): TradeAttempt {
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

export async function cargarUniverso(): Promise<Universo> {
  const { config } = loadConfig(["--mode", "sim"]);
  const settings = await new UiSettingsStore(config.dataDir).load(config);
  const efectiva: BotConfig = applySettings(config, settings);
  const timeZone = resolveTimeZone(efectiva.timezone) ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

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
  const fuentes = [join(config.dataDir, "archive", "analytics-archive.jsonl"), join(config.dataDir, "analytics.jsonl")];
  let ventanas = 0;
  for await (const sample of muestrasEnOrden(fuentes, (u) => u.windowStartMs >= REGIMEN_TWAP_MS)) {
    ventanas += 1;
    endMsPorSlug.set(sample.slug, sample.endMs);
    replay.observa(sample);
  }
  const ops = replay.resultado().signals.map((s) => comoOperacion(s, endMsPorSlug.get(s.slug) as number));
  const dias = [...new Set(ops.map((t) => dayKeyInTimeZone(t.createdAtMs, timeZone)))].sort();
  return { efectiva, timeZone, ops, ventanas, dias };
}

/**
 * Seis grupos CRONOLOGICOS de dias enteros, los mismos para todas las reglas. Si los cortes se
 * recalcularan por regla, cada una tendria tramos distintos y no se podrian comparar.
 */
export function tramoPorDia(dias: readonly string[], tramos: number): Map<string, number> {
  return new Map(dias.map((dia, i) => [dia, Math.min(tramos - 1, Math.floor((i * tramos) / dias.length))]));
}

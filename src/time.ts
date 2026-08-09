import { getMarketDefinition, marketSymbolFromSlug } from "./markets.js";
import { dayKeyInTimeZone } from "./timezone.js";
import type { MarketSymbol } from "./types.js";

export const FIVE_MINUTES_MS = 5 * 60 * 1000;

/**
 * Duraciones de ventana que publica Polymarket para los up/down de cripto.
 *
 * La duracion estaba incrustada en los slugs y en el calculo de ventana, asi que el bot no podia ni
 * mirar los mercados de 15m — el parser los rechazaba con "Unsupported crypto 5m slug". Se
 * parametriza con 5m por defecto para no tocar ninguna llamada existente.
 */
export const WINDOW_DURATIONS = { "5m": FIVE_MINUTES_MS, "15m": 15 * 60 * 1000 } as const;

export type WindowDuration = keyof typeof WINDOW_DURATIONS;

export const DEFAULT_WINDOW_DURATION: WindowDuration = "5m";

/** Duracion presente en un slug, o `undefined` si no es un slug up/down reconocible. */
export function windowDurationFromSlug(slug: string): WindowDuration | undefined {
  for (const duration of Object.keys(WINDOW_DURATIONS) as WindowDuration[]) {
    if (slug.includes(`-updown-${duration}-`)) {
      return duration;
    }
  }
  return undefined;
}

export function getWindowStartMs(timeMs = Date.now(), duration: WindowDuration = DEFAULT_WINDOW_DURATION): number {
  const ms = WINDOW_DURATIONS[duration];
  return Math.floor(timeMs / ms) * ms;
}

export function getWindowEndMs(timeMs = Date.now(), duration: WindowDuration = DEFAULT_WINDOW_DURATION): number {
  return getWindowStartMs(timeMs, duration) + WINDOW_DURATIONS[duration];
}

export function getBtcUpDownSlugFromStartMs(windowStartMs: number): string {
  return getUpDownSlugFromStartMs("BTC", windowStartMs);
}

export function getCurrentBtcUpDownSlug(timeMs = Date.now()): string {
  return getBtcUpDownSlugFromStartMs(getWindowStartMs(timeMs));
}

export function getUpDownSlugFromStartMs(
  market: MarketSymbol,
  windowStartMs: number,
  duration: WindowDuration = DEFAULT_WINDOW_DURATION,
): string {
  return `${getMarketDefinition(market).slugPrefix}-updown-${duration}-${Math.floor(windowStartMs / 1000)}`;
}

export function getCurrentUpDownSlug(market: MarketSymbol, timeMs = Date.now()): string {
  return getUpDownSlugFromStartMs(market, getWindowStartMs(timeMs));
}

export function getWindowStartMsFromSlug(slug: string): number {
  const market = marketSymbolFromSlug(slug);
  const match = /^[a-z]+-updown-(?:5m|15m)-(\d+)$/.exec(slug);
  if (!market || !match) {
    throw new Error(`Invalid crypto up/down slug: ${slug}`);
  }
  return Number(match[1]) * 1000;
}

export function secondsToEnd(endMs: number, nowMs = Date.now()): number {
  return (endMs - nowMs) / 1000;
}

/**
 * Calendar-day key for the daily spend limit and circuit breaker. With a configured timezone the day
 * cuts at that zone's midnight ("auto" = system); without one it keeps the legacy UTC cut so old
 * callers/tests are unaffected.
 */
export function dailySpendKey(nowMs = Date.now(), timeZone?: string): string {
  if (timeZone === undefined) {
    return new Date(nowMs).toISOString().slice(0, 10);
  }
  return dayKeyInTimeZone(nowMs, timeZone);
}

export interface LocalDayRange {
  key: string;
  /** Primer instante del dia local, inclusive. */
  startMs: number;
  /** Primer instante del dia SIGUIENTE, exclusive. */
  endMs: number;
}

/** Un dia local nunca dura mas de 26h (cambios de hora incluidos); 36h da margen de sobra. */
const DAY_SEARCH_RADIUS_MS = 36 * 3_600_000;

let rangoCacheado: (LocalDayRange & { timeZone?: string }) | undefined;

/**
 * El dia local como un rango de epoch ms, para poder preguntar "¿este instante cae hoy?" comparando
 * numeros en vez de formateando fechas.
 *
 * Nace de un cuello de botella medido: el cortacircuitos de riesgo llamaba a `dailySpendKey` una vez
 * POR TRADE, y con zona horaria cada llamada cuesta ~0,32 ms de formateo Intl. Con 1.323 trades eso
 * eran 164,7 ms por iteracion del bucle — el 16% de cada segundo, creciendo con el historial.
 *
 * Los limites se buscan por biseccion sobre la propia clave de dia en vez de calcularlos con
 * aritmetica de husos. Es mas lento de escribir pero es CORRECTO en los casos que la aritmetica se
 * come: cambios de hora y zonas con desfase de media hora o de 45 minutos, donde la medianoche local
 * no cae en una hora UTC entera. Y como el resultado se cachea, ese coste se paga una vez al dia.
 */
export function localDayRange(nowMs = Date.now(), timeZone?: string): LocalDayRange {
  if (rangoCacheado && rangoCacheado.timeZone === timeZone && nowMs >= rangoCacheado.startMs && nowMs < rangoCacheado.endMs) {
    return rangoCacheado;
  }

  const key = dailySpendKey(nowMs, timeZone);
  // Primer instante cuya clave ya es la de hoy.
  const startMs = primerInstanteQueCumple(nowMs - DAY_SEARCH_RADIUS_MS, nowMs, (ms) => dailySpendKey(ms, timeZone) >= key);
  // Primer instante cuya clave ya pasó de hoy.
  const endMs = primerInstanteQueCumple(nowMs, nowMs + DAY_SEARCH_RADIUS_MS, (ms) => dailySpendKey(ms, timeZone) > key);

  rangoCacheado = { key, startMs, endMs, timeZone };
  return rangoCacheado;
}

/** Biseccion sobre un predicado monotono: las claves ISO ordenan igual que el tiempo. */
function primerInstanteQueCumple(desdeMs: number, hastaMs: number, cumple: (ms: number) => boolean): number {
  let bajo = desdeMs;
  let alto = hastaMs;
  while (bajo < alto) {
    const medio = bajo + Math.floor((alto - bajo) / 2);
    if (cumple(medio)) {
      alto = medio;
    } else {
      bajo = medio + 1;
    }
  }
  return bajo;
}

/** Solo para los tests: el cache es de proceso y viviria entre casos. */
export function resetLocalDayRangeCache(): void {
  rangoCacheado = undefined;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

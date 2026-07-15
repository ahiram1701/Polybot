import { getMarketDefinition, marketSymbolFromSlug } from "./markets.js";
import { dayKeyInTimeZone } from "./timezone.js";
import type { MarketSymbol } from "./types.js";

export const FIVE_MINUTES_MS = 5 * 60 * 1000;

export function getWindowStartMs(timeMs = Date.now()): number {
  return Math.floor(timeMs / FIVE_MINUTES_MS) * FIVE_MINUTES_MS;
}

export function getWindowEndMs(timeMs = Date.now()): number {
  return getWindowStartMs(timeMs) + FIVE_MINUTES_MS;
}

export function getBtcUpDownSlugFromStartMs(windowStartMs: number): string {
  return getUpDownSlugFromStartMs("BTC", windowStartMs);
}

export function getCurrentBtcUpDownSlug(timeMs = Date.now()): string {
  return getBtcUpDownSlugFromStartMs(getWindowStartMs(timeMs));
}

export function getUpDownSlugFromStartMs(market: MarketSymbol, windowStartMs: number): string {
  return `${getMarketDefinition(market).slugPrefix}-updown-5m-${Math.floor(windowStartMs / 1000)}`;
}

export function getCurrentUpDownSlug(market: MarketSymbol, timeMs = Date.now()): string {
  return getUpDownSlugFromStartMs(market, getWindowStartMs(timeMs));
}

export function getWindowStartMsFromSlug(slug: string): number {
  const market = marketSymbolFromSlug(slug);
  const match = /^[a-z]+-updown-5m-(\d+)$/.exec(slug);
  if (!market || !match) {
    throw new Error(`Invalid crypto 5m slug: ${slug}`);
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

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

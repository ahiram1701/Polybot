import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { writeFileAtomic } from "./atomicWrite.js";

/**
 * USD→MXN FIX rates for the fiscal report. Two sources, in precedence order:
 *  1. Manual rates the user captures in the UI (by exact date "YYYY-MM-DD" or whole month "YYYY-MM").
 *  2. Banxico SIE API (FIX series SF43718) when the user configures their free Bmx token; responses are
 *     cached on disk so each date is fetched at most once.
 * resolveRate falls back from the exact date to the most recent prior cached rate within a few days
 * (FIX is not published on weekends/holidays). If nothing matches, it returns undefined — the report
 * leaves MXN blank rather than inventing a number.
 */

const FX_FILE = "fiscal-fx.json";
// FIX gaps span weekends and long holidays; 5 days covers them without silently using stale rates.
const MAX_FALLBACK_DAYS = 5;
const BANXICO_SERIES = "SF43718";
const BANXICO_HOST = "https://www.banxico.org.mx";

export interface FxStore {
  banxicoToken?: string;
  // "YYYY-MM-DD" or "YYYY-MM" -> USD/MXN rate captured by the user.
  manualRates: Record<string, number>;
  // "YYYY-MM-DD" -> rate fetched from Banxico (cache).
  cachedRates: Record<string, number>;
}

export function emptyFxStore(): FxStore {
  return { manualRates: {}, cachedRates: {} };
}

export async function loadFxStore(dataDir: string): Promise<FxStore> {
  try {
    const raw = JSON.parse(await readFile(join(dataDir, FX_FILE), "utf8")) as Partial<FxStore>;
    return {
      banxicoToken: typeof raw.banxicoToken === "string" && raw.banxicoToken.length > 0 ? raw.banxicoToken : undefined,
      manualRates: sanitizeRates(raw.manualRates),
      cachedRates: sanitizeRates(raw.cachedRates),
    };
  } catch {
    return emptyFxStore();
  }
}

export async function saveFxStore(dataDir: string, store: FxStore): Promise<void> {
  await writeFileAtomic(join(dataDir, FX_FILE), JSON.stringify(store, null, 2));
}

export function resolveRate(store: FxStore, fechaIso: string): number | undefined {
  const manualExact = store.manualRates[fechaIso];
  if (isValidRate(manualExact)) {
    return manualExact;
  }
  const manualMonth = store.manualRates[fechaIso.slice(0, 7)];
  if (isValidRate(manualMonth)) {
    return manualMonth;
  }
  const cachedExact = store.cachedRates[fechaIso];
  if (isValidRate(cachedExact)) {
    return cachedExact;
  }
  for (let daysBack = 1; daysBack <= MAX_FALLBACK_DAYS; daysBack += 1) {
    const previous = store.cachedRates[shiftDateIso(fechaIso, -daysBack)];
    if (isValidRate(previous)) {
      return previous;
    }
  }
  return undefined;
}

/**
 * Fetch the FIX rates covering `dates` from Banxico and merge them into the cache. No-op without a
 * token or when every date already resolves. Returns how many new rates were cached.
 */
export async function ensureBanxicoRates(
  store: FxStore,
  dates: string[],
  fetcher: typeof fetch = fetch,
): Promise<number> {
  const token = store.banxicoToken;
  if (!token) {
    return 0;
  }
  const missing = [...new Set(dates)].filter((date) => resolveRate(store, date) === undefined).sort();
  if (missing.length === 0) {
    return 0;
  }
  // One range request covering all gaps (FIX data is tiny), padded back so fallback days get cached too.
  const start = shiftDateIso(missing[0], -MAX_FALLBACK_DAYS);
  const end = missing[missing.length - 1];
  const url = `${BANXICO_HOST}/SieAPIRest/service/v1/series/${BANXICO_SERIES}/datos/${start}/${end}`;
  const response = await fetcher(url, { headers: { "Bmx-Token": token, Accept: "application/json" } });
  if (!response.ok) {
    throw new Error(`Banxico respondió ${response.status}. Verifica el token.`);
  }
  const payload = (await response.json()) as {
    bmx?: { series?: Array<{ datos?: Array<{ fecha?: string; dato?: string }> }> };
  };
  let added = 0;
  for (const dato of payload.bmx?.series?.[0]?.datos ?? []) {
    const fechaIso = banxicoDateToIso(dato.fecha);
    const rate = Number(dato.dato);
    if (fechaIso && isValidRate(rate) && store.cachedRates[fechaIso] === undefined) {
      store.cachedRates[fechaIso] = rate;
      added += 1;
    }
  }
  return added;
}

function banxicoDateToIso(fecha: string | undefined): string | undefined {
  // Banxico dates come as dd/mm/yyyy.
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(fecha ?? "");
  return match ? `${match[3]}-${match[2]}-${match[1]}` : undefined;
}

function shiftDateIso(fechaIso: string, days: number): string {
  const date = new Date(`${fechaIso}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function sanitizeRates(rates: unknown): Record<string, number> {
  if (typeof rates !== "object" || rates === null) {
    return {};
  }
  const clean: Record<string, number> = {};
  for (const [key, value] of Object.entries(rates)) {
    if (/^\d{4}-\d{2}(-\d{2})?$/.test(key) && isValidRate(value)) {
      clean[key] = value as number;
    }
  }
  return clean;
}

function isValidRate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value < 1000;
}

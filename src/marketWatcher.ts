import type { MarketInfo, Outcome, OutcomeToken } from "./types.js";
import type { MarketSymbol } from "./types.js";
import {
  getUpDownSlugFromStartMs,
  type WindowDuration,
  getWindowEndMs,
  getWindowStartMs,
  getWindowStartMsFromSlug,
} from "./time.js";
import { marketSymbolFromSlug } from "./markets.js";

type FetchLike = typeof fetch;

/** Duracion de una ventana Up/Down. */
const WINDOW_MS = 300_000;

/** Margen a cada lado de la ventana donde el estado del mercado SI cambia (apertura y cierre). */
const BOUNDARY_MS = 30_000;

/** Sin nada cacheado que servir, quedarse sin mercado cuesta la ventana: merece la pena esperar. */
const FIRST_FETCH_TIMEOUT_MS = 5_000;

/** Con una entrada rancia disponible, esperar mas es regalar tiempo del bucle a cambio de nada. */
const REFRESH_TIMEOUT_MS = 1_500;

export class MarketWatcher {
  private readonly cache = new Map<string, { expiresAtMs: number; market: MarketInfo | null }>();

  constructor(
    private readonly gammaHost: string,
    private readonly fetchFn: FetchLike = fetch,
    private readonly cacheTtlMs = 5_000,
    private readonly midWindowCacheTtlMs = 60_000,
  ) {}

  async getCurrentMarket(nowMs = Date.now(), market: MarketSymbol = "BTC"): Promise<MarketInfo | null> {
    return this.getMarketByWindowStartMs(getWindowStartMs(nowMs), nowMs, market);
  }

  /**
   * Los mercados que se hayan podido resolver, NUNCA una excepcion.
   *
   * Estuvo con `Promise.all`, que es falla-rapido: un solo fetch lento a gamma (timeout 5s) rechazaba
   * la promesa entera, la excepcion subia sin captura hasta el bucle y se perdia la iteracion
   * COMPLETA — apertura, muestra de analitica, arbitraje, señal y ejecucion de los TRES mercados, por
   * culpa de uno. Medido: 415 timeouts y ~6s de ceguera cada uno.
   *
   * Con `allSettled` los mercados sanos siguen operando. Los que fallan quedan fuera de la lista, que
   * es exactamente lo que el llamador ya sabe manejar (antes tambien podian faltar por un 404).
   */
  /**
   * Ventanas de OTRA duracion (15m), para el camino de arbitraje.
   *
   * Aparte de `getCurrentMarkets` a proposito: un fallo al pedir los 15m no puede tumbar el camino
   * principal de 5m, que es el que genera señales. Aqui un apagon total devuelve lista vacia en vez
   * de lanzar — quedarse sin arbitraje de 15m es perder una oportunidad, no perder el bot.
   */
  async getCurrentMarketsForDuration(
    markets: readonly MarketSymbol[],
    duration: WindowDuration,
    nowMs = Date.now(),
  ): Promise<MarketInfo[]> {
    const results = await Promise.allSettled(
      markets.map((market) =>
        this.getMarketBySlug(getUpDownSlugFromStartMs(market, getWindowStartMs(nowMs, duration), duration), nowMs),
      ),
    );
    return results.flatMap((result) => (result.status === "fulfilled" && result.value ? [result.value] : []));
  }

  async getCurrentMarkets(markets: MarketSymbol[], nowMs = Date.now()): Promise<MarketInfo[]> {
    const results = await Promise.allSettled(
      markets.map((market) => this.getMarketByWindowStartMs(getWindowStartMs(nowMs), nowMs, market)),
    );
    const rejected = results.filter((result) => result.status === "rejected");
    // Apagon total (todo rechazado) SI es un error: no sabemos nada del mercado, y quien llama en modo
    // one-shot tiene derecho a enterarse. Un fallo PARCIAL, en cambio, se absorbe: los mercados sanos
    // deben seguir operando.
    if (rejected.length === results.length && results.length > 0) {
      throw (rejected[0] as PromiseRejectedResult).reason;
    }
    return results.flatMap((result) =>
      result.status === "fulfilled" && result.value ? [result.value] : [],
    );
  }

  /**
   * Calienta la cache con la ventana SIGUIENTE antes de que llegue.
   *
   * El fetch a gamma resulto ser el 75,6% del tiempo de las iteraciones lentas, y siempre por lo
   * mismo: al cambiar de ventana el slug es nuevo, la cache esta fria y toca esperar hasta 5s por un
   * dato que ademas hace falta ya — es justo el momento en que se captura el precio de apertura.
   *
   * Pero el slug de la ventana siguiente es determinista, asi que se puede pedir con antelacion,
   * durante la parte tranquila de la ventana actual. Cuando llega el cambio, ya esta en cache.
   *
   * No espera ni propaga errores: si falla, el camino normal lo reintenta como siempre. Una mejora de
   * latencia jamas debe poder tumbar la iteracion que intenta acelerar.
   */
  prefetchNextWindow(markets: readonly MarketSymbol[], nowMs = Date.now()): void {
    const nextWindowStartMs = getWindowEndMs(getWindowStartMs(nowMs));
    for (const market of markets) {
      const slug = getUpDownSlugFromStartMs(market, nextWindowStartMs);
      if (this.cache.has(slug)) {
        continue;
      }
      void this.getMarketBySlug(slug, nowMs).catch(() => undefined);
    }
  }

  async getMarketByWindowStartMs(
    windowStartMs: number,
    nowMs = Date.now(),
    market: MarketSymbol = "BTC",
  ): Promise<MarketInfo | null> {
    const slug = getUpDownSlugFromStartMs(market, windowStartMs);
    return this.getMarketBySlug(slug, nowMs);
  }

  /**
   * Cuanto vale un dato cacheado, que depende de DONDE estemos en la ventana.
   *
   * Dentro de una ventana de 5 minutos los metadatos son inmutables — slug, tokenIds y `endMs` no
   * cambian — asi que repreguntar a gamma cada 5s es gasto puro: tres peticiones cada 5 segundos,
   * cada una capaz de bloquear la iteracion. Solo `active`, `closed` y `acceptingOrders` se mueven, y
   * lo hacen en los bordes.
   *
   * Cerca del borde el TTL vuelve a ser corto: ahi SI aparece un mercado nuevo y hay que verlo ya.
   */
  private cacheTtlForSlug(slug: string, nowMs: number): number {
    const windowStartMs = getWindowStartMsFromSlug(slug);
    if (windowStartMs === undefined) {
      return this.cacheTtlMs;
    }
    const msDesdeApertura = nowMs - windowStartMs;
    // Ventana que aun no ha empezado (la trae `prefetchNextWindow`): sus metadatos no pueden haber
    // cambiado todavia, asi que la entrada debe sobrevivir HASTA el cambio de ventana. Con la regla
    // de borde de abajo caducaria a los 5s y el prefetch no habria servido de nada.
    if (msDesdeApertura < 0) {
      // Acotado a una ventana: el prefetch se lanza como mucho con 5 min de antelacion, y sin tope un
      // slug con marca de tiempo incoherente cachearia durante anos.
      return Math.min(-msDesdeApertura + BOUNDARY_MS, WINDOW_MS + BOUNDARY_MS);
    }
    const msAlCierre = getWindowEndMs(windowStartMs) - nowMs;
    const enElBorde = msAlCierre <= BOUNDARY_MS || msDesdeApertura <= BOUNDARY_MS;
    return enElBorde ? this.cacheTtlMs : this.midWindowCacheTtlMs;
  }

  async getMarketBySlug(slug: string, nowMs = Date.now()): Promise<MarketInfo | null> {
    const cached = this.cache.get(slug);
    if (cached && cached.expiresAtMs > nowMs) {
      return cached.market;
    }

    // El timeout refleja lo que se pierde al rendirse, no un numero fijo. Con una entrada rancia que
    // servir no hay razon para esperar cinco segundos: el dato viejo es igual de bueno y el bucle
    // sigue. Sin nada que servir — la primera vez que vemos esta ventana — merece la pena esperar,
    // porque quedarse sin mercado cuesta la ventana de entrada entera.
    const timeoutMs = cached ? REFRESH_TIMEOUT_MS : FIRST_FETCH_TIMEOUT_MS;
    try {
      // Cap the gamma request so a stall can't delay the loop (AbortSignal actually cancels the socket).
      const response = await this.fetchFn(`${this.gammaHost}/events/slug/${slug}`, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.status === 404) {
        this.cache.set(slug, { expiresAtMs: nowMs + this.cacheTtlMs, market: null });
        return null;
      }
      if (!response.ok) {
        throw new Error(`Gamma API ${response.status} while fetching ${slug}: ${await response.text()}`);
      }

      const raw = (await response.json()) as unknown;
      const market = parseGammaEvent(raw, slug);
      this.cache.set(slug, { expiresAtMs: nowMs + this.cacheTtlForSlug(slug, nowMs), market });
      return market;
    } catch (error) {
      // Servir la entrada CADUCADA antes que rendirse. Dentro de una ventana de 5 minutos el slug, los
      // tokenIds y el tick size no cambian, asi que un dato de hace unos segundos es perfectamente
      // utilizable — y muchisimo mejor que quedarse sin mercado y perder la ventana de entrada.
      // Deliberadamente NO se cachea el fallo: el siguiente intento vuelve a la red.
      if (cached) {
        return cached.market;
      }
      throw error;
    }
  }
}

export function parseGammaEvent(raw: unknown, slug: string): MarketInfo {
  const event = asRecord(raw, "event");
  const asset = marketSymbolFromSlug(slug);
  if (!asset) {
    throw new Error(`Unsupported crypto 5m slug: ${slug}`);
  }
  const markets = asArray(event.markets, "event.markets").map((market) => asRecord(market, "market"));
  const rawMarket = markets.find((market) => market.slug === slug) ?? markets[0];
  if (!rawMarket) {
    throw new Error(`Gamma event ${slug} does not contain markets.`);
  }

  const outcomes = parseStringArray(rawMarket.outcomes, "market.outcomes");
  const tokenIds = parseStringArray(rawMarket.clobTokenIds, "market.clobTokenIds");
  const outcomePrices = parseNumberArray(rawMarket.outcomePrices, "market.outcomePrices");
  if (outcomes.length !== tokenIds.length) {
    throw new Error(`Market ${slug} outcome/token count mismatch.`);
  }

  const outcomeTokens = {} as Record<Outcome, OutcomeToken>;
  outcomes.forEach((label, index) => {
    const outcome = normalizeOutcome(label);
    if (outcome) {
      outcomeTokens[outcome] = {
        outcome,
        label,
        tokenId: tokenIds[index],
        impliedPrice: outcomePrices[index],
      };
    }
  });

  if (!outcomeTokens.UP || !outcomeTokens.DOWN) {
    throw new Error(`Market ${slug} does not include Up and Down outcomes.`);
  }

  const windowStartMs = safeDateMs(rawMarket.eventStartTime ?? event.startTime, getWindowStartMsFromSlug(slug));
  const endMs = safeDateMs(rawMarket.endDate ?? event.endDate, getWindowEndMs(windowStartMs));
  const eventStartTimeMs = safeDateMs(rawMarket.eventStartTime ?? event.startTime, windowStartMs);

  return {
    asset,
    slug: String(rawMarket.slug ?? slug),
    title: String(rawMarket.question ?? event.title ?? slug),
    conditionId: String(rawMarket.conditionId ?? ""),
    windowStartMs,
    endMs,
    eventStartTimeMs,
    acceptingOrders: Boolean(rawMarket.acceptingOrders),
    active: Boolean(rawMarket.active),
    closed: Boolean(rawMarket.closed),
    tickSize: String(rawMarket.orderPriceMinTickSize ?? rawMarket.minimum_tick_size ?? "0.01"),
    negRisk: Boolean(rawMarket.negRisk),
    orderMinSize: Number(rawMarket.orderMinSize ?? 5),
    outcomes: outcomeTokens,
  };
}

function normalizeOutcome(label: string): Outcome | null {
  const normalized = label.trim().toUpperCase();
  if (normalized === "UP") {
    return "UP";
  }
  if (normalized === "DOWN") {
    return "DOWN";
  }
  return null;
}

function parseStringArray(value: unknown, label: string): string[] {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  return asArray(parsed, label).map((item) => String(item));
}

function parseNumberArray(value: unknown, label: string): number[] {
  if (value === undefined || value === null || value === "") {
    return [];
  }
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  return asArray(parsed, label).map((item) => Number(item));
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array.`);
  }
  return value;
}

function safeDateMs(value: unknown, fallback: number): number {
  if (typeof value !== "string") {
    return fallback;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

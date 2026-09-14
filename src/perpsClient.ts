import {
  createPublicClient,
  forkEnvironmentConfig,
  production,
  type PerpsBook,
  type PerpsBookDepth,
  type PerpsInstrument,
  type PerpsTicker,
} from "@polymarket/client";

import { withTimeout } from "./orderbookService.js";
import { logger } from "./logger.js";
import type { PerpsBookLevel, PerpsInstrumentInfo, PerpsQuote } from "./perpsTypes.js";

/**
 * Lo MINIMO del SDK que esta capa necesita, como interfaz estructural.
 *
 * Es el mismo truco que `OrderbookService`, que toma `Pick<ClobClient, "getOrderBook">` en vez del
 * cliente entero: los tests inyectan un objeto de tres funciones y no tienen que fingir un SDK
 * completo. Aqui importa mas todavia, porque la API de perps del SDK esta marcada `@experimental` y
 * puede romper en una version de parche — con la superficie acotada a tres metodos, lo que hay que
 * revisar cuando eso pase cabe en una pantalla.
 */
export interface PerpsReader {
  fetchPerpsInstruments(request?: { instrumentId?: number }): Promise<PerpsInstrument[]>;
  fetchPerpsTickers(request?: { instrumentId?: number }): Promise<PerpsTicker[]>;
  fetchPerpsBook(request: { instrumentId: number; depth?: PerpsBookDepth }): Promise<PerpsBook>;
}

const DEFAULT_PERPS_TIMEOUT_MS = 3_000;
/** Catalogo de instrumentos: cambia cuando Polymarket lista algo nuevo, o sea casi nunca. */
const INSTRUMENTS_TTL_MS = 10 * 60 * 1000;
/**
 * TTL de un FALLO, mucho mas corto que el del acierto.
 *
 * "Toda cache con TTL necesita retroceso ante el fallo" (ARQUITECTURA.md): cachear solo el exito hace
 * que, tras el primer fallo, el TTL no frene nada y se reintente en cada pasada. Un servicio sano
 * acaba limitandote y el fallo se vuelve permanente.
 */
const INSTRUMENTS_FAILURE_TTL_MS = 30_000;
/**
 * Edad maxima de un catalogo rancio antes de dejar de servirlo.
 *
 * El gemelo del anterior, y el que se descubrio tarde en el binario: conservar la ultima lectura buena
 * esta bien, pero sin tope de edad "una vez que UNA lectura funciono" el valor no caduca jamas, y el
 * bot dimensiona contra un mundo que puede ya no existir. Ver `BANKROLL_READING_MAX_AGE_MS`.
 */
const INSTRUMENTS_MAX_AGE_MS = 60 * 60 * 1000;

export interface PerpsMarketDataOptions {
  timeoutMs?: number;
  instrumentsTtlMs?: number;
  instrumentsFailureTtlMs?: number;
  instrumentsMaxAgeMs?: number;
  now?: () => number;
}

/**
 * Lectura de mercado de perps: catalogo, tickers y libro.
 *
 * Solo lectura y sin credenciales, igual que `OrderbookService`. Que esto funcione sin clave privada
 * no es casualidad: es lo que permite capturar y medir sin que exista camino tecnico a mover dinero.
 */
export class PerpsMarketData {
  private readonly timeoutMs: number;
  private readonly instrumentsTtlMs: number;
  private readonly instrumentsFailureTtlMs: number;
  private readonly instrumentsMaxAgeMs: number;
  private readonly now: () => number;
  private instrumentsCache?: { atMs: number; value: PerpsInstrumentInfo[] };
  private instrumentsFailureUntilMs = 0;
  private instrumentsInFlight?: Promise<PerpsInstrumentInfo[]>;

  constructor(
    private readonly reader: PerpsReader,
    options: PerpsMarketDataOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_PERPS_TIMEOUT_MS;
    this.instrumentsTtlMs = options.instrumentsTtlMs ?? INSTRUMENTS_TTL_MS;
    this.instrumentsFailureTtlMs = options.instrumentsFailureTtlMs ?? INSTRUMENTS_FAILURE_TTL_MS;
    this.instrumentsMaxAgeMs = options.instrumentsMaxAgeMs ?? INSTRUMENTS_MAX_AGE_MS;
    this.now = options.now ?? Date.now;
  }

  static create(options: { perpsHost?: string; perpsWsUrl?: string } = {}): PerpsMarketData {
    return new PerpsMarketData(createPerpsReader(options));
  }

  /**
   * Catalogo de instrumentos. Devuelve el cacheado mientras sea fresco; ante un fallo sirve el rancio
   * si aun no ha caducado del todo, y `undefined` cuando ni eso.
   *
   * `undefined` NO es una lista vacia, y quien llame debe distinguirlos: "no pude leer el catalogo" y
   * "Polymarket no lista nada" llevan a decisiones opuestas.
   */
  async instruments(): Promise<PerpsInstrumentInfo[] | undefined> {
    const nowMs = this.now();
    const cached = this.instrumentsCache;
    if (cached && nowMs - cached.atMs < this.instrumentsTtlMs) {
      return cached.value;
    }
    if (nowMs < this.instrumentsFailureUntilMs) {
      return this.staleInstruments(nowMs);
    }
    // Una sola peticion en vuelo: dos mercados pidiendo el catalogo a la vez lo pedirian dos veces.
    this.instrumentsInFlight ??= this.loadInstruments().finally(() => {
      this.instrumentsInFlight = undefined;
    });
    try {
      const value = await this.instrumentsInFlight;
      this.instrumentsCache = { atMs: this.now(), value };
      this.instrumentsFailureUntilMs = 0;
      return value;
    } catch (error) {
      this.instrumentsFailureUntilMs = this.now() + this.instrumentsFailureTtlMs;
      logger.warn("No se pudo leer el catalogo de instrumentos de perps.", {
        error: error instanceof Error ? error.message : String(error),
      });
      return this.staleInstruments(this.now());
    }
  }

  /** Ticker de un instrumento: marca, indice, funding y proximo cobro. Sin cache: cambia cada segundo. */
  async ticker(instrumentId: number): Promise<PerpsTicker | undefined> {
    try {
      const tickers = await withTimeout(
        this.reader.fetchPerpsTickers({ instrumentId }),
        this.timeoutMs,
        `perps fetchPerpsTickers(${instrumentId})`,
      );
      return tickers.find((entry) => Number(entry.instrumentId) === instrumentId) ?? tickers[0];
    } catch (error) {
      logger.warn("Fallo al leer el ticker de perps.", {
        instrumentId,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  /**
   * Libro y ticker de un instrumento, fundidos en una `PerpsQuote`.
   *
   * `known` es el ticker que el WebSocket ya tiene en memoria. Cuando llega, la peticion REST del
   * ticker NO se hace: son los datos que mas cambian y el feed los trae mas frescos que cualquier
   * sondeo. Sin `known` —la sonda de diagnostico, por ejemplo— se piden los dos.
   *
   * Se piden con `allSettled` y no con `all`: sin el ticker la cotizacion sigue sirviendo para medir
   * el libro, y abortar las dos porque una fallo es el error que ya se corrigio en el maker (un fallo
   * en UN mercado no debe tumbar la pasada).
   */
  async quote(
    instrument: PerpsInstrumentInfo,
    depth: PerpsBookDepth = 100,
    known?: PerpsTickerLike,
  ): Promise<PerpsQuote | undefined> {
    const [bookResult, tickerResult] = await Promise.allSettled([
      withTimeout(
        this.reader.fetchPerpsBook({ instrumentId: instrument.instrumentId, depth }),
        this.timeoutMs,
        `perps fetchPerpsBook(${instrument.instrumentId})`,
      ),
      known ? Promise.resolve(undefined) : this.ticker(instrument.instrumentId),
    ]);
    if (bookResult.status !== "fulfilled") {
      logger.warn("Fallo al leer el libro de perps.", {
        symbol: instrument.symbol,
        error: bookResult.reason instanceof Error ? bookResult.reason.message : String(bookResult.reason),
      });
      return undefined;
    }
    const ticker =
      known ?? (tickerResult.status === "fulfilled" ? toTickerLike(tickerResult.value) : undefined);
    return summarizePerpsBook(instrument, bookResult.value, ticker, this.now());
  }

  private staleInstruments(nowMs: number): PerpsInstrumentInfo[] | undefined {
    const cached = this.instrumentsCache;
    if (!cached) {
      return undefined;
    }
    if (nowMs - cached.atMs > this.instrumentsMaxAgeMs) {
      return undefined;
    }
    return cached.value;
  }

  private async loadInstruments(): Promise<PerpsInstrumentInfo[]> {
    const raw = await withTimeout(
      this.reader.fetchPerpsInstruments(),
      this.timeoutMs,
      "perps fetchPerpsInstruments()",
    );
    return raw.map(toInstrumentInfo);
  }
}

/**
 * Cliente publico del SDK, con los hosts de perps sobreescribibles.
 *
 * `createPublicClient` no recibe hosts: los saca del `EnvironmentConfig`. Para poder apuntar a otro
 * sitio (un mock, un entorno de pruebas) hay que bifurcar el entorno de produccion. Sin hosts
 * configurados no se bifurca nada — no se quiere que un typo en un `.env` mande las lecturas a un
 * sitio que no es Polymarket sin decirlo.
 */
export function createPerpsReader(options: { perpsHost?: string; perpsWsUrl?: string } = {}): PerpsReader {
  const environment =
    options.perpsHost || options.perpsWsUrl
      ? forkEnvironmentConfig(
          {
            name: "polybot-perps",
            perps: {
              ...(options.perpsHost ? { rest: options.perpsHost } : {}),
              ...(options.perpsWsUrl ? { ws: options.perpsWsUrl } : {}),
            },
          },
          production,
        )
      : production;
  const client = createPublicClient({ environment });
  return {
    fetchPerpsInstruments: (request) => client.fetchPerpsInstruments(request),
    fetchPerpsTickers: (request) => client.fetchPerpsTickers(request),
    fetchPerpsBook: (request) => client.fetchPerpsBook({ instrumentId: request.instrumentId, depth: request.depth }),
  };
}

/**
 * Normaliza un instrumento del SDK.
 *
 * Todo lo numerico llega como `DecimalString` (cadena) para no perder precision en el transporte.
 * Aqui se pasa a `number` porque es lo que comen los helpers del repo, y porque los tamanos con los
 * que opera esta cuenta estan a diez ordenes de magnitud del limite del doble. Si algun dia se opera
 * en tamanos donde el redondeo importe, este es el sitio donde hay que parar y usar decimales de
 * verdad — queda dicho aqui y no en un commit.
 */
export function toInstrumentInfo(raw: PerpsInstrument): PerpsInstrumentInfo {
  return {
    instrumentId: Number(raw.id),
    symbol: raw.symbol,
    category: String(raw.category),
    baseAsset: raw.baseAsset,
    quoteAsset: raw.quoteAsset,
    fundingIntervalHours: parseFundingIntervalHours(raw.fundingInterval),
    priceDecimals: raw.priceDecimals,
    quantityDecimals: raw.quantityDecimals,
    minNotionalUsd: toNumber(raw.minNotional) ?? 0,
    maxMarketNotionalUsd: toNumber(raw.maxMarketNotional) ?? Number.POSITIVE_INFINITY,
    maxLimitNotionalUsd: toNumber(raw.maxLimitNotional) ?? Number.POSITIVE_INFINITY,
    maxLeverage: raw.maxLeverage,
    isolatedOnly: raw.isolatedOnly,
    liquidationFee: toNumber(raw.liquidationFee) ?? 0,
    riskTiers: raw.riskTiers.map((tier) => ({
      lowerBoundUsd: toNumber(tier.lowerBound) ?? 0,
      maxLeverage: tier.maxLeverage,
    })),
  };
}

/**
 * El ticker YA NORMALIZADO a numeros.
 *
 * Existe para que el libro se pueda fundir indistintamente con un ticker leido por REST o con el que
 * el WebSocket tiene en memoria, sin que `summarizePerpsBook` sepa de donde vino. Sin este tipo, la
 * unica forma de usar el feed habria sido fabricar un objeto con la forma del SDK — un `PerpsTicker`
 * falso con campos `DecimalString` inventados — que es como se cuela un dato de mentira en la
 * analitica.
 */
export interface PerpsTickerLike {
  markPrice?: number;
  indexPrice?: number;
  fundingRate?: number;
  nextFundingMs?: number;
  openInterest?: number;
}

export function toTickerLike(ticker: PerpsTicker | undefined): PerpsTickerLike | undefined {
  if (!ticker) {
    return undefined;
  }
  return {
    markPrice: toNumber(ticker.markPrice),
    indexPrice: toNumber(ticker.indexPrice),
    fundingRate: toNumber(ticker.fundingRate),
    nextFundingMs: ticker.nextFunding === undefined ? undefined : Number(ticker.nextFunding),
    openInterest: toNumber(ticker.openInterest),
  };
}

/** El espejo de `summarizeOrderBook`, para perps. Mismo orden de niveles, misma forma de salida. */
export function summarizePerpsBook(
  instrument: PerpsInstrumentInfo,
  book: PerpsBook,
  ticker: PerpsTickerLike | undefined,
  nowMs: number,
): PerpsQuote {
  const asks = normalizeLevels(book.asks).sort((left, right) => left.price - right.price);
  const bids = normalizeLevels(book.bids).sort((left, right) => right.price - left.price);
  const bestAsk = asks[0]?.price;
  const bestBid = bids[0]?.price;
  return {
    instrumentId: instrument.instrumentId,
    symbol: instrument.symbol,
    quotedAtMs: nowMs,
    bestBid,
    bestAsk,
    mid: bestAsk !== undefined && bestBid !== undefined ? (bestAsk + bestBid) / 2 : undefined,
    markPrice: ticker?.markPrice,
    indexPrice: ticker?.indexPrice,
    fundingRate: ticker?.fundingRate,
    nextFundingMs: ticker?.nextFundingMs,
    openInterest: ticker?.openInterest,
    rawAskLevels: asks,
    rawBidLevels: bids,
    availableAskNotionalUsd: asks.reduce((sum, level) => sum + level.price * level.size, 0),
    availableBidNotionalUsd: bids.reduce((sum, level) => sum + level.price * level.size, 0),
  };
}

function normalizeLevels(levels: ReadonlyArray<{ price: string; quantity: string }>): PerpsBookLevel[] {
  const out: PerpsBookLevel[] = [];
  for (const level of levels) {
    const price = toNumber(level.price);
    const size = toNumber(level.quantity);
    if (price === undefined || size === undefined || price <= 0 || size <= 0) {
      continue;
    }
    out.push({ price, size });
  }
  return out;
}

export function toNumber(value: string | number | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** `fundingInterval` llega como "1h". Un formato inesperado cae a 1h, que es lo que publica hoy. */
function parseFundingIntervalHours(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

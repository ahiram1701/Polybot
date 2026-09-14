import { logger } from "./logger.js";
import type { PerpsMarketData } from "./perpsClient.js";
import type { PerpsFeed } from "./perpsFeed.js";
import { DEFAULT_PERPS_INSTRUMENTS, oracleMarketForPerp, selectPerpsInstruments } from "./perpsMarkets.js";
import type { PerpsRecorder } from "./perpsRecorder.js";
import type { PerpsInstrumentInfo, PerpsSample } from "./perpsTypes.js";
import type { MarketSymbol } from "./types.js";

/** Cada cuanto se relee el catalogo de instrumentos. Cambia cuando Polymarket lista algo nuevo. */
const CATALOGO_REFRESCO_MS = 10 * 60 * 1000;

export interface PerpsLoopOptions {
  marketData: PerpsMarketData;
  recorder: PerpsRecorder;
  /** Opcional: sin feed todo se lee por REST. Los tests no lo montan. */
  feed?: PerpsFeed;
  instruments?: readonly string[];
  /**
   * TWAP de Chainlink del activo equivalente, INYECTADO.
   *
   * El bucle de perps no conoce el feed de Chainlink ni debe conocerlo: es una funcion que devuelve un
   * numero. Asi el modulo se prueba sin montar un WebSocket, y el dia que el oraculo cambie de sitio
   * no hay que tocar nada de aqui.
   */
  oracleTwap?: (market: MarketSymbol, nowMs: number) => number | undefined;
  now?: () => number;
}

export interface ResumenPerps {
  /** Instrumentos de los que se consiguio cotizacion en esta pasada. */
  observados: number;
  /** Cubos que se cerraron y se guardaron en esta pasada. */
  cubosCerrados: number;
  /** Simbolos configurados que el catalogo no trae. */
  faltantes: string[];
  /** El catalogo no se pudo leer NI servir rancio. Distinto de "el catalogo esta vacio". */
  sinCatalogo: boolean;
  instrumentos: string[];
}

/**
 * El camino de perps: observar y grabar. En esta entrega NO decide ni ejecuta nada.
 *
 * Corre con su PROPIA cadencia desde `cerrarIteracion`, igual que el maker y por el mismo motivo: no
 * debe retrasar ninguna decision del binario. El bucle del bot es de un solo hilo y todo lo que se
 * meta en el camino caliente deja al bot ciego mientras dura.
 *
 * Lo que hace cada pasada:
 *   1. resuelve el catalogo (cacheado, con retroceso ante fallo)
 *   2. mantiene al feed suscrito a los instrumentos que toca
 *   3. lee el LIBRO por REST y lo funde con el ticker que el feed ya tiene en memoria
 *   4. anota la observacion en el cubo de 5 minutos en curso, cerrando el anterior si toca
 */
export class PerpsLoop {
  private readonly now: () => number;
  private readonly instruments: readonly string[];
  private catalogo?: { atMs: number; value: PerpsInstrumentInfo[] };
  private avisadoSinCatalogo = false;
  private faltantesAvisados = new Set<string>();

  constructor(private readonly options: PerpsLoopOptions) {
    this.now = options.now ?? Date.now;
    this.instruments =
      options.instruments && options.instruments.length > 0 ? options.instruments : DEFAULT_PERPS_INSTRUMENTS;
  }

  async pasada(nowMs = this.now()): Promise<ResumenPerps> {
    const instrumentos = await this.resolverInstrumentos();
    if (!instrumentos) {
      if (!this.avisadoSinCatalogo) {
        this.avisadoSinCatalogo = true;
        logger.warn("Perps: sin catalogo de instrumentos legible; no se observa nada esta pasada.");
      }
      return { observados: 0, cubosCerrados: 0, faltantes: [], sinCatalogo: true, instrumentos: [] };
    }
    this.avisadoSinCatalogo = false;

    const { instruments: seleccionados, missing } = selectPerpsInstruments(instrumentos, this.instruments);
    for (const symbol of missing) {
      // Una sola vez por simbolo: un simbolo mal escrito en la config inundaria el log si no.
      if (!this.faltantesAvisados.has(symbol)) {
        this.faltantesAvisados.add(symbol);
        logger.warn("Perps: el catalogo no trae este instrumento.", { symbol });
      }
    }

    this.options.feed?.start(seleccionados.map((instrument) => instrument.instrumentId));

    // En paralelo y con `allSettled`: un fallo en UN instrumento no debe tumbar la pasada entera. Es
    // literalmente la misma leccion que el maker aprendio con su `Promise.all`.
    const resultados = await Promise.allSettled(
      seleccionados.map((instrument) => this.observar(instrument, nowMs)),
    );

    let observados = 0;
    let cubosCerrados = 0;
    for (const resultado of resultados) {
      if (resultado.status !== "fulfilled" || !resultado.value) {
        continue;
      }
      observados += 1;
      if (resultado.value.cerrada) {
        cubosCerrados += 1;
      }
    }

    return {
      observados,
      cubosCerrados,
      faltantes: missing,
      sinCatalogo: false,
      instrumentos: seleccionados.map((instrument) => instrument.symbol),
    };
  }

  /** Cubos aun abiertos, para que el panel pueda ensenar lo que se observa ahora mismo. */
  activeSamples(): PerpsSample[] {
    return this.options.recorder.activeSamples();
  }

  /**
   * Poda el fichero de cubos si se paso del tope. NUNCA desde `pasada`.
   *
   * Se expone aqui para que el runner la enganche a su temporizador de media hora, que es el sitio
   * donde ya vive la poda del binario. Podar significa leer el fichero entero, y hacerlo dentro de la
   * observacion seria repetir el fallo que congelaba el bucle casi ocho segundos.
   */
  async podar(): Promise<number | undefined> {
    return this.options.recorder.pruneIfNeeded();
  }

  /**
   * Para el feed y guarda los cubos en curso.
   *
   * El `flush` no es cosmetico: sin el, cada reinicio tira el cubo abierto de cada instrumento, y con
   * un watchdog que relanza el proceso eso puede ser una parte nada pequena de la captura.
   */
  async detener(nowMs = this.now()): Promise<number> {
    this.options.feed?.stop();
    return this.options.recorder.flush(nowMs);
  }

  private async observar(
    instrument: PerpsInstrumentInfo,
    nowMs: number,
  ): Promise<{ cerrada?: PerpsSample } | undefined> {
    const desdeElFeed = this.options.feed?.ticker(instrument.instrumentId);
    const quote = await this.options.marketData.quote(
      instrument,
      100,
      desdeElFeed
        ? {
            markPrice: desdeElFeed.markPrice,
            indexPrice: desdeElFeed.indexPrice,
            fundingRate: desdeElFeed.fundingRate,
            nextFundingMs: desdeElFeed.nextFundingMs,
            openInterest: desdeElFeed.openInterest,
          }
        : undefined,
    );
    if (!quote) {
      return undefined;
    }
    const oraculo = oracleMarketForPerp(instrument.symbol);
    const cerrada = await this.options.recorder.observe({
      instrument,
      quote,
      chainlinkTwapPrice: oraculo ? this.options.oracleTwap?.(oraculo, nowMs) : undefined,
      nowMs,
    });
    return { cerrada };
  }

  private async resolverInstrumentos(): Promise<PerpsInstrumentInfo[] | undefined> {
    const nowMs = this.now();
    if (this.catalogo && nowMs - this.catalogo.atMs < CATALOGO_REFRESCO_MS) {
      return this.catalogo.value;
    }
    const catalogo = await this.options.marketData.instruments();
    if (!catalogo) {
      // `undefined` NO es una lista vacia: el cliente ya distingue "no pude leer" de "no hay nada", y
      // aqui esa distincion es la que decide entre conservar lo que habia y quedarse a ciegas.
      return this.catalogo?.value;
    }
    this.catalogo = { atMs: nowMs, value: catalogo };
    return catalogo;
  }
}

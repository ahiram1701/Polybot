import { appendFile, mkdir, open, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

import { averageFillPrice } from "./orderbookService.js";
import { writeFileAtomic } from "./atomicWrite.js";
import { marketSymbolFromSlug } from "./markets.js";
import { secondsToEnd } from "./time.js";
import type {
  AnalyticsQuotePoint,
  AnalyticsSample,
  AnalyticsTickPoint,
  MarketInfo,
  OrderbookQuote,
  Outcome,
  PriceTick,
  TradeAttempt,
  WindowOpening,
} from "./types.js";

// Capture the last 120s of each window (was 60s) so the engine can learn/execute EARLIER entries,
// where the favourite is still cheap — the main lever for more executable coverage on BTC/ETH. Only
// affects newly captured samples; historical 60s samples are used as-is.
export const ANALYTICS_WINDOW_SECONDS = 120;

/**
 * Duracion de una ventana up/down, con holgura por si el tick de apertura llega adelantado.
 *
 * Los ticks se graban de la ventana ENTERA. La primera justificacion que escribi para esto era falsa
 * —decia que el TWAP que resuelve es el promedio de todo el rango— y la documentacion la desmintio:
 * la referencia es una media movil de 30s (60s en los de 15m), publicada por Polymarket y que NO hay
 * que reconstruir.
 *
 * La captura completa sigue siendo correcta, pero por otro motivo: los features de analitica y la
 * distancia se miden sobre la ventana entera, y sin sus primeros minutos no se pueden calcular. Se
 * deja dicho para que nadie la revierta creyendola inutil ni la mantenga por una razon que no existe.
 */
export const WINDOW_DURATION_SECONDS = 310;

/**
 * Fuera de los ultimos `ANALYTICS_WINDOW_SECONDS`, un tick cada tantos segundos en vez de todos.
 *
 * Guardar la ventana entera a un tick por segundo triplicaria el fichero (252 MB -> ~700 MB), y para
 * un TWAP de 300 segundos esa precision no aporta: integrando por trapecios, muestrear cada 5s
 * introduce un error muy por debajo de 1bp. Cerca del cierre SI se guarda todo, porque ahi es donde
 * se decide la entrada y hace falta el detalle.
 */
export const EARLY_TICK_SAMPLE_SECONDS = 5;
// Max time gap allowed when matching a captured quote to a signal tick. Widened from 6s to 12s to
// recover signals whose nearest quote landed slightly outside the old window (more executable
// coverage). Single source of truth: recommendationEngine, strategyAnalysisEngine and the EV-gate
// backtest all import this so they never drift apart.
export const QUOTE_MATCH_WINDOW_MS = 12_000;
const MAX_SAMPLE_RESOLUTION_DELAY_MS = 10 * 60 * 1000;
const ANALYTICS_RECORD_TYPE = "analytics_sample";
/**
 * Muestras que se conservan en disco.
 *
 * Bajado de 20.000 a 10.000. Con la muestra en ~31 KB —crecio desde 12,8 KB al empezar a grabar
 * profundidad del libro, ticks de ventana completa y la serie TWAP— el tope anterior proyectaba un
 * fichero de 608 MB, y podar un fichero asi congela el proceso ~17 segundos.
 *
 * Lo que se pierde es historial, y por una vez es facil: Polymarket cambio la regla de resolucion el
 * 2026-08-07, asi que todo lo anterior describe un juego que ya no se juega. 10.000 muestras siguen
 * siendo ~11 dias, muy por encima de lo que existe de la regla nueva.
 */
const MAX_ANALYTICS_SAMPLES = 10_000;
const ANALYTICS_PRUNE_SLACK = 600;

export interface AnalyticsObservation {
  market: MarketInfo;
  opening?: WindowOpening;
  tick?: PriceTick;
  /** Valor de la serie TWAP en este instante: la que resuelve. Ausente hasta que el feed la entregue. */
  twapTick?: PriceTick;
  /** Ventana en segundos de esa serie. Sin ella la muestra no se puede reinterpretar mas adelante. */
  twapWindowSeconds?: number;
  quotes?: Partial<Record<Outcome, OrderbookQuote>>;
  nowMs: number;
}

export interface AnalyticsImportResult {
  importedCount: number;
  duplicateCount: number;
  skippedInvalidCount: number;
  totalKnownSamples: number;
  firstSampleAtMs?: number;
  lastSampleAtMs?: number;
  validSampleCount: number;
}

export interface ParsedAnalyticsSamples {
  samples: AnalyticsSample[];
  duplicateCount: number;
  skippedInvalidCount: number;
}

export class AnalyticsRecorder {
  private readonly activeSamples = new Map<string, AnalyticsSample>();
  private activeSamplesHydrated = false;
  private analyticsSampleCount?: number;
  /** Guardados desde el ultimo recuento fiable. Evita releer el fichero para saber si toca podar. */
  private appendedSinceCount = 0;

  constructor(
    private readonly dataDir: string,
    private readonly maxSamples = MAX_ANALYTICS_SAMPLES,
    private readonly pruneSlack = ANALYTICS_PRUNE_SLACK,
  ) {}

  get analyticsPath(): string {
    return join(this.dataDir, "analytics.jsonl");
  }

  get activeSamplesPath(): string {
    return join(this.dataDir, "analytics-active.json");
  }

  /**
   * Tick series captured so far for the window being observed. Lets the live gate compute features
   * (velocity) with the SAME definition the historical pool uses.
   */
  getActiveTicks(slug: string): AnalyticsTickPoint[] {
    return this.activeSamples.get(slug)?.ticks ?? [];
  }

  async observeMarket(observation: AnalyticsObservation): Promise<void> {
    await this.hydrateActiveSamples();
    let changed = false;

    if (observation.tick) {
      changed = (await this.resolveClosedSamples(observation.tick, observation.nowMs)) || changed;
      if (observation.tick.timestampMs >= observation.market.endMs) {
        if (changed) {
          await this.persistActiveSamples();
        }
        return;
      }
    }
    if (!observation.opening) {
      if (changed) {
        await this.persistActiveSamples();
      }
      return;
    }

    const { sample, created } = this.getOrCreateSample(observation.market, observation.opening);
    changed = created || changed;
    if (observation.tick) {
      changed = this.recordTick(sample, observation.tick, observation.twapTick) || changed;
    }
    if (observation.quotes) {
      changed = this.recordQuote(sample, observation.quotes, observation.nowMs) || changed;
    }
    if (observation.tick) {
      changed = (await this.resolveSampleIfClosed(sample, observation.tick, observation.nowMs)) || changed;
    }
    if (changed) {
      await this.persistActiveSamples();
    }
  }

  async readSamples(): Promise<AnalyticsSample[]> {
    return readAnalyticsSamples(this.analyticsPath);
  }

  async recordResolvedTrade(trade: TradeAttempt, resolution: NonNullable<TradeAttempt["resolved"]>): Promise<void> {
    await this.hydrateActiveSamples();
    const market = trade.asset ?? marketSymbolFromSlug(trade.slug);
    if (
      !market ||
      !isFiniteNumber(trade.openingPrice) ||
      !isFiniteNumber(trade.entryPrice) ||
      resolution.finalTickTimestampMs - trade.endMs > MAX_SAMPLE_RESOLUTION_DELAY_MS
    ) {
      return;
    }

    const tickTimestampMs = clamp(
      isFiniteNumber(trade.createdAtMs) ? trade.createdAtMs : trade.endMs - 1,
      trade.windowStartMs + 1,
      trade.endMs - 1,
    );
    const quotePoint = isPositiveFiniteNumber(trade.bestAsk)
      ? [{
          timestampMs: tickTimestampMs,
          secondsToEnd: secondsToEnd(trade.endMs, tickTimestampMs),
          upBestAsk: trade.outcome === "UP" ? trade.bestAsk : undefined,
          downBestAsk: trade.outcome === "DOWN" ? trade.bestAsk : undefined,
        } satisfies AnalyticsQuotePoint]
      : [];

    await this.appendSample({
      version: 1,
      market,
      slug: trade.slug,
      windowStartMs: trade.windowStartMs,
      endMs: trade.endMs,
      openingPrice: trade.openingPrice,
      openingTickTimestampMs: trade.windowStartMs,
      ticks: [
        {
          timestampMs: tickTimestampMs,
          secondsToEnd: secondsToEnd(trade.endMs, tickTimestampMs),
          price: trade.entryPrice,
          distanceUsd: trade.entryPrice - trade.openingPrice,
        },
      ],
      quotes: quotePoint,
      finalPrice: resolution.finalPrice,
      finalTickTimestampMs: resolution.finalTickTimestampMs,
      winningOutcome: resolution.winningOutcome,
      resolvedAtMs: resolution.resolvedAtMs,
    });
  }

  private getOrCreateSample(market: MarketInfo, opening: WindowOpening): { sample: AnalyticsSample; created: boolean } {
    const existing = this.activeSamples.get(market.slug);
    if (existing) {
      return { sample: existing, created: false };
    }

    const sample: AnalyticsSample = {
      version: 1,
      market: market.asset,
      slug: market.slug,
      windowStartMs: market.windowStartMs,
      endMs: market.endMs,
      openingPrice: opening.openingPrice,
      openingTickTimestampMs: opening.openingTickTimestampMs,
      // Las dos marcas que hacen la muestra reinterpretable si Polymarket vuelve a cambiar la regla:
      // de que serie salio la apertura, y cual es la ventana que resuelve.
      openingPriceSource: opening.priceSource,
      twapWindowSeconds: market.twapLookbackSeconds,
      ticks: [],
      quotes: [],
    };
    this.activeSamples.set(market.slug, sample);
    return { sample, created: true };
  }

  private recordTick(sample: AnalyticsSample, tick: PriceTick, twapTick?: PriceTick): boolean {
    if (tick.market !== sample.market) {
      return false;
    }
    const remainingSeconds = secondsToEnd(sample.endMs, tick.timestampMs);
    // Los TICKS se guardan de la ventana ENTERA, no solo de los ultimos 120s como las quotes.
    //
    // Con el recorte anterior se descartaba el 63% de cada ventana (cobertura medida: 37%), asi que
    // los features y la distancia solo podian calcularse sobre el ultimo tercio. Y no se reconstruye
    // despues: un tick que no se graba se pierde para siempre.
    //
    // El coste es un fichero mas grande; `maxAnalyticsSamples` lo sigue acotando por numero de
    // muestras. Las quotes SI mantienen su ventana corta: solo hacen falta cerca del cierre.
    if (remainingSeconds < 0 || remainingSeconds > WINDOW_DURATION_SECONDS) {
      return false;
    }
    // Parte temprana de la ventana: submuestreo. Se compara contra el ultimo tick GUARDADO, no contra
    // el reloj, para que un hueco del feed no desplace toda la rejilla.
    if (remainingSeconds > ANALYTICS_WINDOW_SECONDS) {
      const ultimo = sample.ticks[sample.ticks.length - 1];
      if (ultimo && (tick.timestampMs - ultimo.timestampMs) / 1000 < EARLY_TICK_SAMPLE_SECONDS) {
        return false;
      }
    }

    const point: AnalyticsTickPoint = {
      timestampMs: tick.timestampMs,
      secondsToEnd: remainingSeconds,
      price: tick.value,
      distanceUsd: tick.value - sample.openingPrice,
      // `openingPrice` ya sale de la serie TWAP, asi que `distanceUsd` mezcla spot con apertura TWAP.
      // Se conserva por continuidad con el historico, pero la distancia coherente es esta.
      twapPrice: twapTick?.value,
      twapDistanceUsd: twapTick ? twapTick.value - sample.openingPrice : undefined,
    };
    return upsertByTimestamp(sample.ticks, point);
  }

  private recordQuote(
    sample: AnalyticsSample,
    quotes: Partial<Record<Outcome, OrderbookQuote>>,
    nowMs: number,
  ): boolean {
    const remainingSeconds = secondsToEnd(sample.endMs, nowMs);
    // Se graba la ventana ENTERA, no solo los ultimos 120 s.
    //
    // El bot ya cotizaba en toda la ventana y `recordQuote` tiraba lo de fuera de ese tramo. Resultado:
    // no habia precio de mercado de los primeros 180 segundos de NINGUNA ventana, jamas, asi que
    // ninguna estrategia de entrada temprana era backtesteable. Era dato que pasaba por RAM y se
    // descartaba.
    if (remainingSeconds <= 0) {
      return false;
    }

    const point: AnalyticsQuotePoint = {
      timestampMs: nowMs,
      secondsToEnd: remainingSeconds,
      upBestAsk: quotes.UP?.bestAsk,
      upBestBid: quotes.UP?.bestBid,
      downBestAsk: quotes.DOWN?.bestAsk,
      downBestBid: quotes.DOWN?.bestBid,
      // El bot YA tiene la profundidad en la mano aqui y hasta ahora la tiraba.
      upAskAvgFill: quotes.UP ? averageFillPrice(quotes.UP.rawAskLevels) : undefined,
      downAskAvgFill: quotes.DOWN ? averageFillPrice(quotes.DOWN.rawAskLevels) : undefined,
      upAskDepthUsd: quotes.UP?.availableUsdAllLevels,
      downAskDepthUsd: quotes.DOWN?.availableUsdAllLevels,
      // Lado COMPRADOR. Sin el no se puede medir ni una salida ni el coste real de deshacer, y el bot
      // ya lo tenia en la mano: `rawBidLevels` se obtenia y no se escribia.
      upBidDepthUsd: quotes.UP?.availableBidUsdAllLevels,
      downBidDepthUsd: quotes.DOWN?.availableBidUsdAllLevels,
      // Cuando se leyo el libro DE VERDAD, no cuando lo proceso el bucle. La diferencia es la que
      // explica un rechazo del exchange, y hasta ahora se guardaba la hora del bucle.
      quotedAtMs: quotes.UP?.quotedAtMs ?? quotes.DOWN?.quotedAtMs,
    };
    return upsertByTimestamp(sample.quotes, point);
  }

  private async resolveClosedSamples(tick: PriceTick, nowMs: number): Promise<boolean> {
    let changed = false;
    const samples = [...this.activeSamples.values()].filter(
      (sample) => sample.market === tick.market && tick.timestampMs >= sample.endMs,
    );
    for (const sample of samples) {
      changed = (await this.resolveSampleIfClosed(sample, tick, nowMs)) || changed;
    }
    return changed;
  }

  private async resolveSampleIfClosed(sample: AnalyticsSample, tick: PriceTick, nowMs: number): Promise<boolean> {
    if (tick.market !== sample.market || tick.timestampMs < sample.endMs || sample.resolvedAtMs) {
      return false;
    }
    if (tick.timestampMs - sample.endMs > MAX_SAMPLE_RESOLUTION_DELAY_MS) {
      this.activeSamples.delete(sample.slug);
      return true;
    }

    // El cierre de la serie que RESUELVE: el ultimo valor TWAP publicado en o antes del cierre. Sale de
    // los propios ticks de la muestra, donde ya se venia grabando `twapPrice`.
    const cierreTwap = [...sample.ticks]
      .filter((t) => t.twapPrice !== undefined && t.timestampMs <= sample.endMs)
      .sort((l, r) => l.timestampMs - r.timestampMs)
      .pop()?.twapPrice;

    // La etiqueta sale del TWAP cuando lo hay, y SOLO si la apertura tambien salio de esa serie:
    // comparar una apertura spot contra un cierre TWAP es mezclar dos reglas y produce una etiqueta
    // corrupta que despues nadie puede distinguir de una buena. Con spot en cualquiera de los dos
    // extremos se sigue etiquetando por spot, pero la muestra lleva marcado de donde salio cada cosa.
    const etiquetaPorTwap = cierreTwap !== undefined && sample.openingPriceSource === "twap";
    const precioQueDecide = etiquetaPorTwap ? cierreTwap : tick.value;

    const resolved: AnalyticsSample = {
      ...sample,
      finalPrice: tick.value,
      finalTwapPrice: cierreTwap,
      finalTickTimestampMs: tick.timestampMs,
      winningOutcome: precioQueDecide >= sample.openingPrice ? "UP" : "DOWN",
      resolvedAtMs: nowMs,
      ticks: sortByTimestamp(sample.ticks),
      quotes: sortByTimestamp(sample.quotes),
    };
    await this.appendSample(resolved);
    this.activeSamples.delete(sample.slug);
    return true;
  }

  private async appendSample(sample: AnalyticsSample): Promise<void> {
    await mkdir(dirname(this.analyticsPath), { recursive: true });
    await appendFile(this.analyticsPath, `${formatAnalyticsSampleLine(sample)}\n`, "utf8");
    // Aqui SOLO se cuenta. La poda vive en `pruneIfNeeded`, fuera del camino caliente.
    this.appendedSinceCount += 1;
  }

  /**
   * Recorta el fichero si se ha pasado del tope. NUNCA debe llamarse desde `observeMarket`.
   *
   * Antes se podaba dentro del guardado, o sea dentro de la fase de captura del bucle — justo cuando
   * el bot deberia estar mirando el mercado. Podar significa leer el fichero ENTERO: con 288 MB eso
   * asigno ~587 MB de buffers y dejo el bucle de eventos bloqueado 7,85 segundos, medido. Un
   * arbitraje dura segundos, asi que cada uno de esos parones es una oportunidad que no se ve.
   *
   * El problema nunca fue leer el fichero, sino leerlo MIENTRAS se opera.
   *
   * `force` obliga al recuento contra disco. Se usa al arrancar: es la unica forma de saber cuantas
   * muestras hay de verdad, y a partir de ahi basta con contar los guardados nuevos.
   */
  /**
   * Tamaño del fichero en MB. Es la variable que convierte esto en un problema que vuelve: si crece,
   * los congelamientos vuelven con el, y sin verlo nadie se enteraria hasta que el bot se quedase
   * ciego otra vez.
   */
  async analyticsSizeMb(): Promise<number | undefined> {
    try {
      return Math.round((await stat(this.analyticsPath)).size / 1048576);
    } catch {
      return undefined;
    }
  }

  async pruneIfNeeded(force = false): Promise<number | undefined> {
    // Si no se sabe cuantas hay —proceso recien arrancado—, se CUENTAN sin parsear.
    //
    // Antes, no saberlo bastaba para caer en la poda cara: leer 446 MB, construir 4,5 millones de
    // objetos y reescribir el fichero entero. Y como el arranque la forzaba, eso pasaba en CADA
    // arranque. Contando saltos de linea el mismo fichero cuesta E/S y nada mas, asi que la poda cara
    // solo ocurre cuando de verdad se ha pasado del tope.
    if (this.analyticsSampleCount === undefined) {
      this.analyticsSampleCount = await contarMuestrasAnalytics(this.analyticsPath);
      this.appendedSinceCount = 0;
    }
    const estimadas = this.analyticsSampleCount + this.appendedSinceCount;
    if (!force && estimadas <= this.maxSamples + this.pruneSlack) {
      return estimadas;
    }
    this.analyticsSampleCount = await trimAnalyticsFileToMostRecent(this.analyticsPath, this.maxSamples);
    this.appendedSinceCount = 0;
    return this.analyticsSampleCount;
  }

  private async hydrateActiveSamples(): Promise<void> {
    if (this.activeSamplesHydrated) {
      return;
    }
    this.activeSamplesHydrated = true;
    let contents = "";
    try {
      contents = await readFile(this.activeSamplesPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw error;
    }

    const parsed = JSON.parse(contents) as unknown;
    if (!Array.isArray(parsed)) {
      return;
    }
    for (const item of parsed) {
      if (isAnalyticsSample(item) && !item.resolvedAtMs) {
        this.activeSamples.set(item.slug, item);
      }
    }
  }

  private async persistActiveSamples(): Promise<void> {
    await writeFileAtomic(this.activeSamplesPath, `${JSON.stringify([...this.activeSamples.values()], null, 2)}\n`);
  }
}

interface AnalyticsReadCache {
  // Bytes of COMPLETE lines already parsed (always ends right after a "\n", so a resumed read can
  // never split a UTF-8 character or a JSON line).
  byteOffset: number;
  mtimeMs: number;
  latestBySlug: Map<string, AnalyticsSample>;
  sorted: AnalyticsSample[];
  /** Cuando se pidieron por ultima vez. Lo que decide si siguen mereciendo la memoria que ocupan. */
  ultimoAccesoMs: number;
}

/**
 * Cuanto se conservan las muestras parseadas sin que NADIE las pida.
 *
 * Diez minutos. El panel de analisis refresca cada 60 s mientras esta abierto y el gate de EV consulta
 * en cada decision, asi que quien las usa de verdad las mantiene calientes: el coste de volver a
 * leerlas solo lo paga quien dejo de usarlas.
 *
 * Sin esto la retencion era PARA SIEMPRE. Medido el 2026-08-22 en produccion: el proceso vivia con
 * 95 MB de heap, una sola consulta al panel lo subio a 607 MB **en un intervalo de cinco minutos**, y
 * ahi se quedo. En una maquina de 7,76 GB con 31 GB comprometidos, eso son 550 MB que el sistema
 * acaba sacando a disco: la paginacion paso del 7% al 44%, y traerse de vuelta medio heap para un GC
 * son los segundos de bucle bloqueado que matan al proceso.
 */
const TTL_MUESTRAS_EN_MEMORIA_MS = 10 * 60_000;

/** Cada cuanto se revisa. No hace falta afinar: lo que importa es que acabe soltandose. */
const BARRIDO_CACHE_MS = 60_000;

let barredorCache: NodeJS.Timeout | undefined;

/**
 * Suelta lo que lleva rato sin pedirse. Se programa solo cuando hay algo que soltar y se apaga cuando
 * no queda nada, para no dejar un temporizador latiendo de fondo en un proceso que no usa la analitica
 * —la CLI, un test—. Y va sin `ref`: limpiar memoria no es motivo para mantener vivo un proceso.
 */
function programarBarridoCache(): void {
  if (barredorCache) {
    return;
  }
  barredorCache = setInterval(() => {
    const limite = Date.now() - TTL_MUESTRAS_EN_MEMORIA_MS;
    for (const [ruta, entrada] of [...analyticsReadCache]) {
      if (entrada.ultimoAccesoMs <= limite) {
        analyticsReadCache.delete(ruta);
      }
    }
    if (analyticsReadCache.size === 0) {
      pararBarridoCache();
    }
  }, BARRIDO_CACHE_MS);
  barredorCache.unref?.();
}

function pararBarridoCache(): void {
  if (barredorCache) {
    clearInterval(barredorCache);
    barredorCache = undefined;
  }
}

/** Guarda la entrada y deja el barredor en marcha. Unico sitio por el que se puebla la cache. */
function guardarEnCache(path: string, cache: AnalyticsReadCache): void {
  cache.ultimoAccesoMs = Date.now();
  analyticsReadCache.set(path, cache);
  programarBarridoCache();
}

// The analytics ledger is append-only (compactions rewrite it smaller) and grows to >100MB; parsing it
// from scratch on every recommendation tick and EV-gate query burns seconds of CPU every 2 minutes.
// Cache the parsed samples per path and only read the appended tail on subsequent calls. A shrunken or
// replaced file (retention compaction, import) is detected by size/offset and fully reparsed.
const analyticsReadCache = new Map<string, AnalyticsReadCache>();

/** Test hook: forget everything cached for a path (or all paths). */
export function invalidateAnalyticsReadCache(path?: string): void {
  if (path === undefined) {
    analyticsReadCache.clear();
  } else {
    analyticsReadCache.delete(path);
  }
  if (analyticsReadCache.size === 0) {
    pararBarridoCache();
  }
}

/** Solo para pruebas: fuerza el barrido sin esperar al temporizador. Devuelve cuantas entradas solto. */
export function barrerMuestrasEnMemoria(ahoraMs = Date.now()): number {
  const limite = ahoraMs - TTL_MUESTRAS_EN_MEMORIA_MS;
  let soltadas = 0;
  for (const [ruta, entrada] of [...analyticsReadCache]) {
    if (entrada.ultimoAccesoMs <= limite) {
      analyticsReadCache.delete(ruta);
      soltadas += 1;
    }
  }
  if (analyticsReadCache.size === 0) {
    pararBarridoCache();
  }
  return soltadas;
}

/**
 * Cuantas muestras hay en el fichero, contando saltos de linea y SIN parsear ni una.
 *
 * La diferencia no es de matiz: parsear estas 10.000 muestras construye ~4,5 millones de objetos
 * —cada una lleva 260 cotizaciones y 115 ticks por segundo de su ventana, 55 KB de mediana— y bloquea
 * el bucle de eventos varios segundos. Contar es leer por trozos, con una espera entre trozo y trozo
 * en la que el proceso puede atender peticiones. Es lo que hace que `/api/health` siga respondiendo.
 *
 * Un fichero que no existe son cero muestras, no un error: es el primer arranque.
 */
export async function contarMuestrasAnalytics(path: string): Promise<number> {
  let handle;
  try {
    handle = await open(path, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return 0;
    }
    throw error;
  }
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    let lineas = 0;
    let ultimoByte: number | undefined;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) {
        break;
      }
      let desde = 0;
      for (;;) {
        const salto = buffer.indexOf(0x0a, desde);
        if (salto === -1 || salto >= bytesRead) {
          break;
        }
        lineas += 1;
        desde = salto + 1;
      }
      ultimoByte = buffer[bytesRead - 1];
    }
    // Una ultima linea sin salto final cuenta igual: el fichero puede quedar asi tras una escritura
    // a medias, y contar de menos haria creer que cabe una muestra mas de las que caben.
    return ultimoByte !== undefined && ultimoByte !== 0x0a ? lineas + 1 : lineas;
  } finally {
    await handle.close();
  }
}

export async function readAnalyticsSamples(path: string): Promise<AnalyticsSample[]> {
  let fileSize: number;
  let fileMtimeMs: number;
  try {
    const stats = await stat(path);
    fileSize = stats.size;
    fileMtimeMs = stats.mtimeMs;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      analyticsReadCache.delete(path);
      return [];
    }
    throw error;
  }

  const cached = analyticsReadCache.get(path);
  if (cached && fileSize === cached.byteOffset && fileMtimeMs === cached.mtimeMs) {
    cached.ultimoAccesoMs = Date.now();
    return [...cached.sorted];
  }

  // File shrank (compaction/import replaced it): the cached offsets no longer describe this file.
  const cache: AnalyticsReadCache =
    cached && fileSize > cached.byteOffset
      ? cached
      : { byteOffset: 0, mtimeMs: 0, latestBySlug: new Map(), sorted: [], ultimoAccesoMs: 0 };

  const handle = await open(path, "r");
  try {
    // Se lee POR TRAMOS y se decodifica LINEA A LINEA. Nunca existe un string del tamaño del fichero.
    //
    // Antes se traia la cola entera a un Buffer y se hacia `buffer.toString(...)` de una vez. En un
    // arranque en frio la cola ES el fichero entero, y al cruzar los 512 MB —`0x1fffffe8`, el tope de
    // longitud de string de Node— eso lanza y no hay vuelta atras.
    //
    // Medido el 2026-08-26 con `analytics.jsonl` en 514.835.099 bytes: el bot no arrancaba
    // (`UI runner stopped with error: Cannot create a string longer than 0x1fffffe8 characters`), y lo
    // grave es que era un PUNTO MUERTO — la poda es lo unico que puede encoger el fichero y la poda
    // empieza leyendolo, asi que a partir de ese tamaño el fichero solo podia crecer. Llevaba 34 h sin
    // dar la cara porque la cache estaba caliente de antes de cruzar el limite: cualquier reinicio
    // —el watchdog, un arranque de maquina— lo habria destapado igual.
    //
    // Cortar por saltos de linea es seguro con UTF-8 multibyte: `0x0a` no aparece dentro de ningun
    // caracter de mas de un byte, asi que el limite de linea nunca parte un caracter.
    const TRAMO = 8 * 1024 * 1024;
    const tailLength = fileSize - cache.byteOffset;
    const buffer = Buffer.alloc(Math.min(TRAMO, Math.max(tailLength, 1)));
    let posicion = cache.byteOffset;
    let restante = tailLength;
    /** Linea a medias que cruza el corte entre dos tramos. Nunca se consume: se arrastra. */
    let resto = Buffer.alloc(0);
    /** Bytes de lineas COMPLETAS ya procesadas. Cada byte se cuenta exactamente una vez. */
    let consumidos = 0;
    while (restante > 0) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, restante), posicion);
      if (bytesRead === 0) {
        break;
      }
      posicion += bytesRead;
      restante -= bytesRead;
      const leido = buffer.subarray(0, bytesRead);
      const datos = resto.length > 0 ? Buffer.concat([resto, leido]) : leido;
      let desde = 0;
      for (;;) {
        const salto = datos.indexOf(0x0a, desde);
        if (salto === -1) {
          break;
        }
        const linea = datos.toString("utf8", desde, salto + 1).trim();
        consumidos += salto + 1 - desde;
        desde = salto + 1;
        if (!linea) {
          continue;
        }
        const sample = parseAnalyticsLine(linea);
        if (sample && isResolvedAnalyticsSample(sample)) {
          cache.latestBySlug.set(sample.slug, sample);
        }
      }
      // Copia obligatoria: `buffer` se reutiliza en la vuelta siguiente y `datos` puede apuntar a el.
      resto = Buffer.from(datos.subarray(desde));
    }
    // Never consume a trailing partial line: a writer may be mid-append; it will be read next time.
    cache.byteOffset += consumidos;
    cache.mtimeMs = cache.byteOffset === fileSize ? fileMtimeMs : 0;
    cache.sorted = [...cache.latestBySlug.values()].sort((left, right) => left.windowStartMs - right.windowStartMs);
    guardarEnCache(path, cache);
    return [...cache.sorted];
  } finally {
    await handle.close();
  }
}

export function serializeAnalyticsSamples(samples: AnalyticsSample[], at = new Date()): string {
  if (samples.length === 0) {
    return "";
  }
  return `${samples.map((sample) => formatAnalyticsSampleLine(sample, at)).join("\n")}\n`;
}

export function parseAnalyticsSamplesText(contents: string): ParsedAnalyticsSamples {
  const latestBySlug = new Map<string, AnalyticsSample>();
  let duplicateCount = 0;
  let skippedInvalidCount = 0;

  for (const line of contents.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    const sample = parseAnalyticsLine(line);
    if (!sample || !isResolvedAnalyticsSample(sample)) {
      skippedInvalidCount += 1;
      continue;
    }
    if (latestBySlug.has(sample.slug)) {
      duplicateCount += 1;
    }
    latestBySlug.set(sample.slug, sample);
  }

  return {
    samples: [...latestBySlug.values()].sort((left, right) => left.windowStartMs - right.windowStartMs),
    duplicateCount,
    skippedInvalidCount,
  };
}

export async function importAnalyticsSamples(
  path: string,
  contents: string,
  importedAt = new Date(),
  maxSamples = MAX_ANALYTICS_SAMPLES,
): Promise<AnalyticsImportResult> {
  const parsed = parseAnalyticsSamplesText(contents);
  const existingSamples = await readAnalyticsSamples(path);
  const existingSlugs = new Set(existingSamples.map((sample) => sample.slug));
  const samplesToImport: AnalyticsSample[] = [];
  let duplicateCount = parsed.duplicateCount;

  for (const sample of parsed.samples) {
    if (existingSlugs.has(sample.slug)) {
      duplicateCount += 1;
      continue;
    }
    samplesToImport.push(sample);
  }

  if (samplesToImport.length > 0) {
    await appendAnalyticsSamples(path, samplesToImport, importedAt);
    await trimAnalyticsFileToMostRecent(path, maxSamples);
  }

  const knownSamples = samplesToImport.length > 0 ? await readAnalyticsSamples(path) : existingSamples;
  const range = analyticsSampleRange(knownSamples);
  return {
    importedCount: samplesToImport.length,
    duplicateCount,
    skippedInvalidCount: parsed.skippedInvalidCount,
    totalKnownSamples: knownSamples.length,
    ...range,
    validSampleCount: parsed.samples.length + parsed.duplicateCount,
  };
}

export function analyticsSampleRange(
  samples: AnalyticsSample[],
): Pick<AnalyticsImportResult, "firstSampleAtMs" | "lastSampleAtMs"> {
  let firstSampleAtMs: number | undefined;
  let lastSampleAtMs: number | undefined;
  for (const sample of samples) {
    const sampleAtMs = sample.resolvedAtMs ?? sample.endMs ?? sample.windowStartMs;
    if (!isFiniteNumber(sampleAtMs)) {
      continue;
    }
    firstSampleAtMs = firstSampleAtMs === undefined ? sampleAtMs : Math.min(firstSampleAtMs, sampleAtMs);
    lastSampleAtMs = lastSampleAtMs === undefined ? sampleAtMs : Math.max(lastSampleAtMs, sampleAtMs);
  }
  return { firstSampleAtMs, lastSampleAtMs };
}

async function appendAnalyticsSamples(path: string, samples: AnalyticsSample[], at: Date): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, serializeAnalyticsSamples(samples, at), "utf8");
}

/**
 * Trim the analytics file so it keeps at most `maxSamples` of the most recent (highest windowStartMs)
 * resolved samples. Reads via readAnalyticsSamples (deduped + sorted ascending), keeps the tail, and
 * rewrites atomically via temp + rename. No-op when already within the limit. Returns the kept count.
 */
export async function trimAnalyticsFileToMostRecent(path: string, maxSamples: number): Promise<number> {
  const samples = await readAnalyticsSamples(path);
  if (samples.length <= maxSamples) {
    return samples.length;
  }
  const kept = samples.slice(-maxSamples);
  await writeFileAtomic(path, serializeAnalyticsSamples(kept));
  return kept.length;
}

function formatAnalyticsSampleLine(sample: AnalyticsSample, at = new Date()): string {
  return JSON.stringify({ at: at.toISOString(), type: ANALYTICS_RECORD_TYPE, sample });
}

function parseAnalyticsLine(line: string): AnalyticsSample | undefined {
  try {
    const parsed = JSON.parse(line) as unknown;
    const sample = isRecord(parsed) && isRecord(parsed.sample) ? parsed.sample : parsed;
    return isAnalyticsSample(sample) ? sample : undefined;
  } catch {
    return undefined;
  }
}

function isAnalyticsSample(value: unknown): value is AnalyticsSample {
  if (!isRecord(value)) {
    return false;
  }
  return (
    value.version === 1 &&
    typeof value.slug === "string" &&
    isMarketSymbol(value.market) &&
    isFiniteNumber(value.windowStartMs) &&
    isFiniteNumber(value.endMs) &&
    isFiniteNumber(value.openingPrice) &&
    isFiniteNumber(value.openingTickTimestampMs) &&
    Array.isArray(value.ticks) &&
    value.ticks.every(isAnalyticsTickPoint) &&
    Array.isArray(value.quotes) &&
    value.quotes.every(isAnalyticsQuotePoint) &&
    (value.finalPrice === undefined || isFiniteNumber(value.finalPrice)) &&
    (value.finalTickTimestampMs === undefined || isFiniteNumber(value.finalTickTimestampMs)) &&
    (value.winningOutcome === undefined || isOutcome(value.winningOutcome)) &&
    (value.resolvedAtMs === undefined || isFiniteNumber(value.resolvedAtMs))
  );
}

function isResolvedAnalyticsSample(value: AnalyticsSample): boolean {
  return isFiniteNumber(value.resolvedAtMs) && isOutcome(value.winningOutcome);
}

function isAnalyticsTickPoint(value: unknown): value is AnalyticsTickPoint {
  return (
    isRecord(value) &&
    isFiniteNumber(value.timestampMs) &&
    isFiniteNumber(value.secondsToEnd) &&
    isFiniteNumber(value.price) &&
    isFiniteNumber(value.distanceUsd) &&
    // Ausentes en las muestras anteriores a 2026-08-08, que deben seguir leyendose. Presentes, tienen
    // que ser numeros: un valor corrupto en la serie que decide envenena en silencio todo el analisis.
    (value.twapPrice === undefined || isFiniteNumber(value.twapPrice)) &&
    (value.twapDistanceUsd === undefined || isFiniteNumber(value.twapDistanceUsd))
  );
}

function isAnalyticsQuotePoint(value: unknown): value is AnalyticsQuotePoint {
  return (
    isRecord(value) &&
    isFiniteNumber(value.timestampMs) &&
    isFiniteNumber(value.secondsToEnd) &&
    (value.upBestAsk === undefined || isFiniteNumber(value.upBestAsk)) &&
    (value.upBestBid === undefined || isFiniteNumber(value.upBestBid)) &&
    (value.downBestAsk === undefined || isFiniteNumber(value.downBestAsk)) &&
    (value.downBestBid === undefined || isFiniteNumber(value.downBestBid)) &&
    // Ausentes en las ~20k muestras anteriores a 2026-08-06, que deben seguir leyendose. Presentes,
    // tienen que ser numeros: un valor corrupto aqui envenena en silencio el analisis que decide la
    // ventana de ask, y ese camino ya mueve dinero.
    (value.upAskAvgFill === undefined || isFiniteNumber(value.upAskAvgFill)) &&
    (value.downAskAvgFill === undefined || isFiniteNumber(value.downAskAvgFill)) &&
    (value.upAskDepthUsd === undefined || isFiniteNumber(value.upAskDepthUsd)) &&
    (value.downAskDepthUsd === undefined || isFiniteNumber(value.downAskDepthUsd))
  );
}

function isMarketSymbol(value: unknown): value is AnalyticsSample["market"] {
  return value === "BTC" || value === "ETH" || value === "DOGE";
}

function isOutcome(value: unknown): value is Outcome {
  return value === "UP" || value === "DOWN";
}

function upsertByTimestamp<T extends { timestampMs: number }>(items: T[], item: T): boolean {
  const existingIndex = items.findIndex((existing) => existing.timestampMs === item.timestampMs);
  if (existingIndex >= 0) {
    items[existingIndex] = item;
    return true;
  }
  items.push(item);
  items.sort((left, right) => left.timestampMs - right.timestampMs);
  return true;
}

function sortByTimestamp<T extends { timestampMs: number }>(items: T[]): T[] {
  return [...items].sort((left, right) => left.timestampMs - right.timestampMs);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value > 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

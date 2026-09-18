import { appendFile, mkdir, open, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

import { contarMuestrasAnalytics } from "./analyticsRecorder.js";
import { writeFileAtomic } from "./atomicWrite.js";
import { averageFillPrice } from "./orderbookService.js";
import { FIVE_MINUTES_MS, getWindowStartMs } from "./time.js";
import type { PerpsInstrumentInfo, PerpsQuote, PerpsSample } from "./perpsTypes.js";

const PERPS_RECORD_TYPE = "perps_sample";

/**
 * Tamano de sonda con el que se mide la profundidad del libro, en dolares de nocional.
 *
 * Constante DELIBERADA, igual que `DEPTH_PROBE_USD` en el binario y por el mismo motivo: se graba en
 * el historico y ese historico se lee meses despues. Si dependiera de un ajuste, las muestras viejas
 * y las nuevas medirian cosas distintas y dejarian de ser comparables entre si.
 *
 * $100 y no los $5 del binario porque el nocional minimo de una orden de perps esta en ese orden y
 * una sonda por debajo del minimo no responde a ninguna pregunta real.
 */
export const PERPS_DEPTH_PROBE_USD = 100;

/**
 * Muestras que se conservan en disco.
 *
 * Conservador a proposito. `data/analytics.jsonl` del binario esta muy por encima de lo que su propia
 * documentacion proyectaba, y ahi la poda se volvio un problema que congelaba el bucle. Empezar bajo
 * y subirlo con el tamano medido delante es barato; el orden inverso no.
 */
export const MAX_PERPS_SAMPLES = 5_000;
const PERPS_PRUNE_SLACK = 300;

export interface PerpsObservation {
  instrument: PerpsInstrumentInfo;
  quote: PerpsQuote;
  /** TWAP de Chainlink del activo equivalente, cuando lo hay. El contraste independiente. */
  chainlinkTwapPrice?: number;
  nowMs: number;
}

/**
 * Acumula cubos de 5 minutos por instrumento y los guarda al cerrarse.
 *
 * Los cubos viven en MEMORIA hasta que cierran, igual que `activeSamples` del binario. A diferencia de
 * aquel, aqui no se rehidratan desde disco al arrancar: un cubo dura 5 minutos y un reinicio pierde
 * como mucho uno por instrumento. Persistirlo costaria un fichero mas, escrituras en el camino
 * caliente y una ruta de migracion, a cambio de recuperar cinco minutos de datos de medicion que no
 * deciden nada. No compensa, y se deja escrito para que no se lea como un olvido.
 */
export class PerpsRecorder {
  private readonly activos = new Map<number, PerpsSample>();
  private sampleCount?: number;
  private appendedSinceCount = 0;

  constructor(
    private readonly dataDir: string,
    private readonly maxSamples = MAX_PERPS_SAMPLES,
    private readonly pruneSlack = PERPS_PRUNE_SLACK,
  ) {}

  get perpsAnalyticsPath(): string {
    return join(this.dataDir, "perps-analytics.jsonl");
  }

  /**
   * Anota una observacion y, si el cubo anterior ya cerro, lo guarda.
   *
   * Devuelve la muestra cerrada cuando la hay. El orden importa: primero se cierra el cubo viejo con
   * los datos que ya tenia, y solo despues se abre el nuevo. Al reves, el ultimo tick del cubo viejo
   * caeria en el nuevo y su `closeMarkPrice` — la verdad con la que se puntua — saldria de un instante
   * que pertenece al siguiente periodo.
   */
  async observe(observation: PerpsObservation): Promise<PerpsSample | undefined> {
    const bucketStartMs = getWindowStartMs(observation.nowMs);
    const activo = this.activos.get(observation.instrument.instrumentId);
    let cerrada: PerpsSample | undefined;

    if (activo && activo.bucketStartMs !== bucketStartMs) {
      cerrada = cerrarCubo(activo, observation.nowMs);
      await this.appendSample(cerrada);
      this.activos.delete(observation.instrument.instrumentId);
    }

    const sample = this.activos.get(observation.instrument.instrumentId) ?? crearCubo(observation, bucketStartMs);
    this.activos.set(observation.instrument.instrumentId, sample);
    anotar(sample, observation);
    return cerrada;
  }

  /** Cubos aun abiertos. Para que el panel pueda ensenar lo que se esta observando ahora mismo. */
  activeSamples(): PerpsSample[] {
    return [...this.activos.values()];
  }

  /**
   * Cierra y guarda todo lo abierto. Se llama al parar el bot.
   *
   * Sin esto, el cubo en curso de cada instrumento se perderia en cada reinicio, y con un watchdog que
   * relanza cada pocos minutos eso puede ser una fraccion nada despreciable de la captura.
   */
  async flush(nowMs = Date.now()): Promise<number> {
    let guardadas = 0;
    for (const [instrumentId, sample] of [...this.activos.entries()]) {
      if (sample.ticks.length === 0) {
        this.activos.delete(instrumentId);
        continue;
      }
      await this.appendSample(cerrarCubo(sample, nowMs));
      this.activos.delete(instrumentId);
      guardadas += 1;
    }
    return guardadas;
  }

  async perpsAnalyticsSizeMb(): Promise<number | undefined> {
    try {
      return Math.round((await stat(this.perpsAnalyticsPath)).size / 1048576);
    } catch {
      return undefined;
    }
  }

  /**
   * Recorta el fichero si se paso del tope. NUNCA desde el camino de observacion.
   *
   * Misma disciplina que `pruneIfNeeded` del binario, y por la misma lesion: podar significa leer el
   * fichero entero, y hacerlo dentro de la captura deja al bot ciego los segundos que dure.
   */
  async pruneIfNeeded(force = false): Promise<number | undefined> {
    if (this.sampleCount === undefined) {
      // Se CUENTAN sin parsear: contar saltos de linea cuesta E/S y nada mas, mientras que parsear el
      // fichero entero en cada arranque es justo la poda cara que se quiere evitar.
      this.sampleCount = await contarMuestrasAnalytics(this.perpsAnalyticsPath);
      this.appendedSinceCount = 0;
    }
    const estimadas = this.sampleCount + this.appendedSinceCount;
    if (!force && estimadas <= this.maxSamples + this.pruneSlack) {
      return estimadas;
    }
    this.sampleCount = await trimPerpsFileToMostRecent(this.perpsAnalyticsPath, this.maxSamples);
    this.appendedSinceCount = 0;
    return this.sampleCount;
  }

  private async appendSample(sample: PerpsSample): Promise<void> {
    await mkdir(dirname(this.perpsAnalyticsPath), { recursive: true });
    await appendFile(this.perpsAnalyticsPath, `${formatPerpsSampleLine(sample)}\n`, "utf8");
    this.appendedSinceCount += 1;
  }
}

function crearCubo(observation: PerpsObservation, bucketStartMs: number): PerpsSample {
  return {
    version: 1,
    instrumentId: observation.instrument.instrumentId,
    symbol: observation.instrument.symbol,
    bucketStartMs,
    bucketEndMs: bucketStartMs + FIVE_MINUTES_MS,
    openMarkPrice: observation.quote.markPrice,
    fundingIntervalHours: observation.instrument.fundingIntervalHours,
    ticks: [],
    quotes: [],
  };
}

function anotar(sample: PerpsSample, observation: PerpsObservation): void {
  const { quote, nowMs } = observation;
  sample.ticks.push({
    timestampMs: nowMs,
    markPrice: quote.markPrice,
    indexPrice: quote.indexPrice,
    fundingRate: quote.fundingRate,
    chainlinkTwapPrice: observation.chainlinkTwapPrice,
  });
  sample.quotes.push({
    timestampMs: nowMs,
    bestBid: quote.bestBid,
    bestAsk: quote.bestAsk,
    mid: quote.mid,
    // Precio MEDIO real de mover el tamano de sonda, no el mejor precio. Es la misma correccion que
    // `averageFillPrice` trajo al binario: un historico con solo el mejor precio hace que cualquier
    // backtest sobre el asuma relleno perfecto y salga optimista justo donde el libro esta mas fino.
    askAvgFill: averageFillPrice(quote.rawAskLevels, PERPS_DEPTH_PROBE_USD),
    bidAvgFill: averageFillPrice(quote.rawBidLevels, PERPS_DEPTH_PROBE_USD),
    askNotionalUsd: quote.availableAskNotionalUsd,
    bidNotionalUsd: quote.availableBidNotionalUsd,
  });
  if (sample.openMarkPrice === undefined) {
    sample.openMarkPrice = quote.markPrice;
  }
}

/**
 * Cierra el cubo. El funding NO se resume aqui, a proposito.
 *
 * Aqui vivia un `fundingRateSum` que sumaba cada cambio de la tasa publicada, y estaba mal dos veces:
 * la tasa es HORARIA (con una sola tasa en el cubo ya guardaba la hora entera para cinco minutos, 12x
 * de mas) y es una PREVISION que se actualiza sin parar (cada actualizacion contaba como otro cobro,
 * hasta ~400x). Inflaba el ingreso del carry y hacia que la estrategia pareciera mejor de lo que era.
 *
 * Ahora no se guarda ningun resumen: el funding se calcula de los TICKS en `summarizePerpsBucket`.
 * Guardar un derivado junto a los datos crudos es lo que permitio el fallo —el derivado mentia y los
 * ticks, que decian la verdad, no los leia nadie—. Los ticks son la fuente de verdad; se calcula de
 * ellos cada vez.
 */
function cerrarCubo(sample: PerpsSample, nowMs: number): PerpsSample {
  const ultimoConMarca = [...sample.ticks].reverse().find((tick) => tick.markPrice !== undefined);
  return {
    ...sample,
    closeMarkPrice: ultimoConMarca?.markPrice,
    closedAtMs: nowMs,
  };
}

export function formatPerpsSampleLine(sample: PerpsSample, at = new Date()): string {
  return JSON.stringify({ at: at.toISOString(), type: PERPS_RECORD_TYPE, sample });
}

export function serializePerpsSamples(samples: PerpsSample[], at = new Date()): string {
  return samples.map((sample) => `${formatPerpsSampleLine(sample, at)}\n`).join("");
}

interface PerpsReadCache {
  byteOffset: number;
  mtimeMs: number;
  samples: PerpsSample[];
}

const perpsReadCache = new Map<string, PerpsReadCache>();

export function invalidatePerpsReadCache(path?: string): void {
  if (path === undefined) {
    perpsReadCache.clear();
  } else {
    perpsReadCache.delete(path);
  }
}

/**
 * Lee las muestras de perps del fichero, INCREMENTALMENTE: solo parsea la cola nueva.
 *
 * Se lee por tramos y se decodifica linea a linea, sin construir nunca un string del tamano del
 * fichero. No es prudencia teorica: en el binario, traer la cola entera a un string reventaba al
 * cruzar los 512 MB (`0x1fffffe8`, el tope de longitud de string de Node) y dejaba un PUNTO MUERTO —
 * la poda es lo unico que encoge el fichero y la poda empieza leyendolo. El fichero de perps es mas
 * pequeno hoy, pero el fallo es del patron, no del tamano.
 */
export async function readPerpsSamples(path: string): Promise<PerpsSample[]> {
  let fileSize: number;
  let fileMtimeMs: number;
  try {
    const stats = await stat(path);
    fileSize = stats.size;
    fileMtimeMs = stats.mtimeMs;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      perpsReadCache.delete(path);
      return [];
    }
    throw error;
  }

  const cached = perpsReadCache.get(path);
  if (cached && fileSize === cached.byteOffset && fileMtimeMs === cached.mtimeMs) {
    return [...cached.samples];
  }
  // El fichero ENCOGIO (una poda lo reescribio): los desplazamientos cacheados ya no describen este
  // fichero y arrastrarlos daria lineas cortadas por la mitad.
  const cache: PerpsReadCache =
    cached && fileSize > cached.byteOffset ? cached : { byteOffset: 0, mtimeMs: 0, samples: [] };

  const handle = await open(path, "r");
  try {
    const TRAMO = 4 * 1024 * 1024;
    let restante = fileSize - cache.byteOffset;
    const buffer = Buffer.alloc(Math.min(TRAMO, Math.max(restante, 1)));
    let posicion = cache.byteOffset;
    let resto = Buffer.alloc(0);
    let consumidos = 0;
    while (restante > 0) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, restante), posicion);
      if (bytesRead === 0) {
        break;
      }
      posicion += bytesRead;
      restante -= bytesRead;
      let trozo = resto.length > 0 ? Buffer.concat([resto, buffer.subarray(0, bytesRead)]) : buffer.subarray(0, bytesRead);
      let desde = 0;
      for (;;) {
        // Cortar por `0x0a` es seguro con UTF-8 multibyte: ese byte no aparece dentro de ningun
        // caracter de mas de un byte, asi que el limite de linea nunca parte un caracter.
        const salto = trozo.indexOf(0x0a, desde);
        if (salto === -1) {
          break;
        }
        const linea = trozo.subarray(desde, salto).toString("utf8");
        consumidos += salto - desde + 1;
        desde = salto + 1;
        const sample = parsePerpsLine(linea);
        if (sample) {
          cache.samples.push(sample);
        }
      }
      resto = Buffer.from(trozo.subarray(desde));
      trozo = Buffer.alloc(0);
    }
    cache.byteOffset += consumidos;
    cache.mtimeMs = fileMtimeMs;
    // Ordenadas por cubo: el replay parte el historico en tramos cronologicos y un fichero con dos
    // instrumentos intercalados no llega ordenado por si solo.
    cache.samples.sort((left, right) => left.bucketStartMs - right.bucketStartMs);
    perpsReadCache.set(path, cache);
    return [...cache.samples];
  } finally {
    await handle.close();
  }
}

/** Deja en el fichero como mucho `maxSamples` cubos, los mas recientes. Reescritura atomica. */
export async function trimPerpsFileToMostRecent(path: string, maxSamples: number): Promise<number> {
  const samples = await readPerpsSamples(path);
  if (samples.length <= maxSamples) {
    return samples.length;
  }
  const kept = samples.slice(-maxSamples);
  await writeFileAtomic(path, serializePerpsSamples(kept));
  invalidatePerpsReadCache(path);
  return kept.length;
}

export function parsePerpsLine(line: string): PerpsSample | undefined {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const sample = isRecord(parsed) && isRecord(parsed.sample) ? parsed.sample : parsed;
    return isPerpsSample(sample) ? sample : undefined;
  } catch {
    return undefined;
  }
}

export function isPerpsSample(value: unknown): value is PerpsSample {
  if (!isRecord(value)) {
    return false;
  }
  return (
    value.version === 1 &&
    typeof value.symbol === "string" &&
    isFiniteNumber(value.instrumentId) &&
    isFiniteNumber(value.bucketStartMs) &&
    isFiniteNumber(value.bucketEndMs) &&
    Array.isArray(value.ticks) &&
    Array.isArray(value.quotes)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

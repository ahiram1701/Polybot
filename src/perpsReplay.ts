import { carryOutcome, fundingReceiverSide, summarizePerpsBucket, type PerpsBucketMetrics } from "./perpsSignal.js";
import { PERPS_BASE_TAKER_RATE } from "./perpsFees.js";
import { bootstrapCIPorBloques, trimmedNet, type BootstrapPorBloques } from "./tradeStats.js";
import type { PerpsSample, PerpsSide } from "./perpsTypes.js";

/**
 * Replay del carry de funding sobre los cubos ya grabados.
 *
 * Se escribe con la MISMA regla dura que `favoriteReplay.ts`: no reimplementa ninguna decision, llama
 * a las de produccion (`summarizePerpsBucket`, `fundingReceiverSide`, `carryOutcome`). Un replay que
 * reimplementa la politica acaba midiendo el replay en vez del bot, y este proyecto ya tiene dos
 * tablas que enganaron por medir sobre un universo distinto del que se opera.
 *
 * ## El invariante: NO MIRAR EL FUTURO
 *
 * Es la parte facil de romper y la que invalidaria todo. La tasa de funding y el rendimiento de un
 * cubo solo se conocen cuando el cubo ha TERMINADO, asi que elegir lado con el funding del propio
 * cubo seria decidir con el resultado en la mano — y daria una ventaja espectacular y falsa.
 *
 * Aqui el lado de cada cubo se decide con el funding del cubo ANTERIOR, y el resultado se mide en el
 * cubo actual. Es lo mismo que podria hacer el bot en vivo: al abrir el periodo N solo ha visto hasta
 * el final del N-1.
 */

export interface PerpsReplayParams {
  /** Nocional de cada posicion simulada, en dolares. */
  notionalUsd: number;
  /**
   * Tasa minima (en valor absoluto) del cubo anterior para molestarse en operar el siguiente.
   *
   * Con cero se opera todo cubo con funding distinto de cero, comisiones incluidas. Es un parametro y
   * no una constante porque es exactamente la palanca que el barrido tiene que recorrer.
   */
  minFundingRate: number;
  /**
   * Cuantos cubos se mantiene la posicion. Uno = cinco minutos.
   *
   * Existe por una cuenta que la primera sonda contra la API real dejo clarisima: el funding medido
   * estaba en 0,0013% por hora y la ida y vuelta al tramo base cuesta 0,0800% del nocional. O sea que
   * una posicion de cinco minutos cobra ~0,0001% y paga 800 veces mas en comisiones. **Un carry de un
   * cubo no puede salir a cuenta, y no por falta de ventaja sino por aritmetica.**
   *
   * Sin este parametro el arnes solo sabria contestar "no" a una pregunta que no se ha hecho todavia.
   * Con el, la pregunta que si se puede probar es la de verdad: cuantas horas hay que aguantar para
   * que el funding cubra las comisiones, y cuanto movimiento de precio te comes mientras tanto.
   */
  holdBuckets?: number;
  feeRate?: number;
}

export interface PerpsReplayTrade {
  instrumentId: number;
  symbol: string;
  /** Primer cubo de la posicion. El lado salio del cubo inmediatamente anterior. */
  bucketStartMs: number;
  /** Cuantos cubos se mantuvo. Uno = cinco minutos. */
  heldBuckets: number;
  side: PerpsSide;
  fundingUsd: number;
  priceUsd: number;
  feeUsd: number;
  netUsd: number;
}

export interface PerpsReplaySummary {
  trades: PerpsReplayTrade[];
  netUsd: number;
  /** Neto con recorte simetrico: quita el peso de las dos colas antes de juzgar. */
  trimmedNetUsd: number;
  perTradeUsd: number;
  /** Cuantos cubos se pudieron puntuar frente a cuantos habia. Un desfase grande es una senal. */
  scoredBuckets: number;
  totalBuckets: number;
  bootstrap: BootstrapPorBloques;
  /** Neto de cada uno de los 6 tramos cronologicos. La regla elige por el PEOR de estos. */
  tramos: number[];
  peorTramo: number;
}

/**
 * Recorre los cubos y devuelve las operaciones que la hipotesis de carry habria hecho.
 *
 * Los cubos se agrupan por instrumento y se ordenan en el tiempo antes de emparejarlos: el fichero
 * lleva varios instrumentos intercalados, y emparejar cubos consecutivos del FICHERO en vez del
 * instrumento cruzaria el funding de BTC con el rendimiento de ETH.
 */
export function replayCarry(samples: readonly PerpsSample[], params: PerpsReplayParams): PerpsReplayTrade[] {
  const porInstrumento = new Map<number, PerpsSample[]>();
  for (const sample of samples) {
    const lista = porInstrumento.get(sample.instrumentId) ?? [];
    lista.push(sample);
    porInstrumento.set(sample.instrumentId, lista);
  }

  const feeRate = params.feeRate ?? PERPS_BASE_TAKER_RATE;
  const hold = Math.max(1, Math.floor(params.holdBuckets ?? 1));
  const trades: PerpsReplayTrade[] = [];

  for (const lista of porInstrumento.values()) {
    const ordenados = [...lista].sort((left, right) => left.bucketStartMs - right.bucketStartMs);
    // `i` avanza de `hold` en `hold`: las posiciones NO se solapan. Solapandolas, el mismo movimiento
    // de precio entraria en varias operaciones y el bootstrap por bloques dejaria de proteger de nada
    // — seria contar el mismo sorteo varias veces, que es el error que ese bootstrap existe para
    // evitar.
    for (let i = 1; i + hold - 1 < ordenados.length; i += hold) {
      const previo = ordenados[i - 1];
      const tramo = ordenados.slice(i, i + hold);
      // Cubos NO consecutivos: hubo un hueco (el bot parado, el feed caido). Se saltan en vez de
      // encadenarlos, porque una posicion no puede atravesar un periodo que nadie observo — y contarla
      // como si lo hubiera hecho es inventarse el resultado de ese hueco.
      if (!sonConsecutivos(previo, tramo)) {
        continue;
      }
      const metricasPrevias = summarizePerpsBucket(previo);
      const metricas = tramo.map(summarizePerpsBucket);
      if (!metricasPrevias || metricas.some((metrica) => metrica === undefined)) {
        continue;
      }
      // AQUI vive el invariante: el lado sale de `metricasPrevias`, nunca de los cubos que se van a
      // mantener.
      const side = fundingReceiverSide(metricasPrevias.fundingRateSum);
      if (!side || Math.abs(metricasPrevias.fundingRateSum) < params.minFundingRate) {
        continue;
      }
      const agregado = agregarTramo(metricas as PerpsBucketMetrics[]);
      const resultado = carryOutcome({
        metrics: agregado,
        side,
        notionalUsd: params.notionalUsd,
        feeRate,
        entryPrice: previo.closeMarkPrice,
      });
      trades.push({
        instrumentId: tramo[0].instrumentId,
        symbol: tramo[0].symbol,
        bucketStartMs: tramo[0].bucketStartMs,
        heldBuckets: hold,
        side,
        fundingUsd: resultado.fundingUsd,
        priceUsd: resultado.priceUsd,
        feeUsd: resultado.feeUsd,
        netUsd: resultado.netUsd,
      });
    }
  }

  return trades.sort((left, right) => left.bucketStartMs - right.bucketStartMs);
}

/** El tramo empieza justo donde acaba `previo` y no tiene huecos por dentro. */
function sonConsecutivos(previo: PerpsSample, tramo: readonly PerpsSample[]): boolean {
  let esperado = previo.bucketEndMs;
  for (const sample of tramo) {
    if (sample.bucketStartMs !== esperado) {
      return false;
    }
    esperado = sample.bucketEndMs;
  }
  return true;
}

/**
 * Funde varios cubos en uno para poder puntuar la posicion entera con `carryOutcome`.
 *
 * El funding SE SUMA (cada periodo cobra) y el rendimiento se COMPONE (un +1% seguido de otro +1% no
 * es un +2%). Sumar los rendimientos seria la aproximacion de siempre, y a estos tamanos la diferencia
 * es despreciable — pero componer no cuesta nada y evita que la aproximacion se herede a un tamano
 * donde si importe.
 */
function agregarTramo(metricas: readonly PerpsBucketMetrics[]): PerpsBucketMetrics {
  let compuesto = 1;
  let funding = 0;
  for (const metrica of metricas) {
    compuesto *= 1 + metrica.markReturn;
    funding += metrica.fundingRateSum;
  }
  return {
    ...metricas[0],
    markReturn: compuesto - 1,
    fundingRateSum: funding,
  };
}

/** Cuantos tramos cronologicos parte el historico. Seis, como en el replay del favorito. */
export const TRAMOS = 6;

export function summarizeReplay(
  trades: readonly PerpsReplayTrade[],
  totalBuckets: number,
  options: { seed?: number } = {},
): PerpsReplaySummary {
  const nets = trades.map((trade) => trade.netUsd);
  // El BLOQUE es el cubo, no la operacion.
  //
  // Dos instrumentos que comparten el mismo cubo de cinco minutos no son dos sorteos independientes:
  // BTC y ETH se mueven juntos, exactamente igual que los tres mercados binarios que cierran a la vez.
  // Remuestrear operaciones sueltas estrecharia el intervalo y volveria a producir un "positivo el
  // 100%" para algo que no lo esta.
  const bloques = trades.map((trade) => trade.bucketStartMs);
  const bootstrap = bootstrapCIPorBloques(nets, bloques, { seed: options.seed ?? 12345 });
  const tramos = partirEnTramos(trades, TRAMOS).map((tramo) =>
    tramo.reduce((sum, trade) => sum + trade.netUsd, 0),
  );
  const netUsd = nets.reduce((sum, value) => sum + value, 0);
  return {
    trades: [...trades],
    netUsd: round(netUsd),
    trimmedNetUsd: round(trimmedNet(nets).netUsd),
    perTradeUsd: trades.length > 0 ? round(netUsd / trades.length) : 0,
    scoredBuckets: new Set(bloques).size,
    totalBuckets,
    bootstrap,
    tramos: tramos.map(round),
    // La regla de eleccion del proyecto: gana la configuracion con MEJOR PEOR TRAMO, nunca la del
    // mejor neto medio. Elegir por la media premia las casillas pequenas que salieron bien, que es
    // como se fabrico la configuracion del 8 de septiembre que luego perdio hacia delante.
    peorTramo: tramos.length > 0 ? round(Math.min(...tramos)) : 0,
  };
}

/** Parte en `n` tramos cronologicos de tamano parecido. Con menos operaciones que tramos, devuelve menos. */
export function partirEnTramos<T>(items: readonly T[], n: number): T[][] {
  if (items.length === 0 || n <= 0) {
    return [];
  }
  const tramos: T[][] = [];
  const porTramo = items.length / n;
  for (let i = 0; i < n; i += 1) {
    const desde = Math.floor(i * porTramo);
    const hasta = i === n - 1 ? items.length : Math.floor((i + 1) * porTramo);
    if (hasta > desde) {
      tramos.push(items.slice(desde, hasta));
    }
  }
  return tramos;
}

/** Metricas de todos los cubos puntuables. Para el barrido y para el panel. */
export function bucketMetrics(samples: readonly PerpsSample[]): PerpsBucketMetrics[] {
  const out: PerpsBucketMetrics[] = [];
  for (const sample of samples) {
    const metrics = summarizePerpsBucket(sample);
    if (metrics) {
      out.push(metrics);
    }
  }
  return out.sort((left, right) => left.bucketStartMs - right.bucketStartMs);
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

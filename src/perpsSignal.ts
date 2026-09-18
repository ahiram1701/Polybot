import { calculateFundingCostUsd, calculatePerpsFeeUsd, PERPS_BASE_TAKER_RATE } from "./perpsFees.js";
import type { PerpsSample, PerpsSide } from "./perpsTypes.js";

/**
 * Observables derivados de un cubo. NO deciden nada.
 *
 * Todo lo de este modulo son funciones puras sobre una muestra ya grabada: no leen red, no leen
 * reloj y no miran el futuro. Esa disciplina es la que permite que el replay las llame sin poder
 * hacer trampa, igual que `favoriteReplay.ts` llama a los modulos de produccion en vez de
 * reimplementarlos.
 *
 * Se separan de cualquier politica a proposito. Aqui se mide; quien decida vendra despues y con
 * evidencia delante.
 */

export interface PerpsBucketMetrics {
  instrumentId: number;
  symbol: string;
  bucketStartMs: number;
  /** Rendimiento del precio de marca dentro del cubo, en tanto por uno. */
  markReturn: number;
  /**
   * Tasa de funding HORARIA media durante el cubo, en tanto por uno. Positiva = los largos pagan.
   *
   * Es una TASA, no un pago: dice cuanto de caro esta el funding ahora, y por eso es lo que decide el
   * lado y lo que se compara con un umbral. NO sirve para el P&L — para eso esta `fundingAccrued`.
   * Confundir las dos cosas en un solo campo es exactamente el fallo que tuvo este modulo.
   */
  fundingRate: number;
  /**
   * Lo que de verdad se DEVENGA en el cubo, como fraccion del nocional. Es lo que va al P&L.
   *
   *   devengado = tasa horaria media x (duracion del cubo / intervalo de funding)
   *
   * Para un cubo de 5 minutos y funding horario, la doceava parte de la tasa.
   */
  fundingAccrued: number;
  /** (marca - indice) / indice, promediado. Mide si el perpetuo cotiza caro o barato contra su indice. */
  basisVsIndex?: number;
  /**
   * (marca - TWAP de Chainlink) / TWAP, promediado.
   *
   * El unico numero de esta lista que NO sale del propio exchange. Todo lo demas —marca, indice,
   * funding— lo publica Polymarket, asi que comparar entre si solo dice si Polymarket es coherente
   * consigo mismo. Ausente en instrumentos sin oraculo propio.
   */
  basisVsOracle?: number;
  /** Desviacion tipica de los rendimientos de marca, normalizada por segundo. */
  volPerSecond?: number;
  /** Spread medio en puntos basicos del medio. En bps y no en dolares: BTC y DOGE no son comparables. */
  meanSpreadBps?: number;
  meanAskNotionalUsd?: number;
  meanBidNotionalUsd?: number;
  /** Cuantos ticks tenian precio de marca. Un cubo con dos ticks no mide lo mismo que uno con cien. */
  markTickCount: number;
}

/**
 * Resume un cubo, o `undefined` si no es puntuable.
 *
 * Un cubo sin `closeMarkPrice` o sin apertura NO se resume: es un cubo que el feed no vio entero.
 * Devolver ceros en su lugar lo metaria en la muestra como si fuera un periodo plano, que es
 * exactamente como se fabrican los backtests que miden el feed en vez del mercado.
 */
export function summarizePerpsBucket(sample: PerpsSample): PerpsBucketMetrics | undefined {
  const apertura = sample.openMarkPrice;
  const cierre = sample.closeMarkPrice;
  if (!isPositive(apertura) || !isPositive(cierre)) {
    return undefined;
  }

  const marcas = sample.ticks.filter((tick) => isPositive(tick.markPrice));
  const basisIndice = promedio(
    sample.ticks
      .filter((tick) => isPositive(tick.markPrice) && isPositive(tick.indexPrice))
      .map((tick) => (tick.markPrice as number) / (tick.indexPrice as number) - 1),
  );
  const basisOraculo = promedio(
    sample.ticks
      .filter((tick) => isPositive(tick.markPrice) && isPositive(tick.chainlinkTwapPrice))
      .map((tick) => (tick.markPrice as number) / (tick.chainlinkTwapPrice as number) - 1),
  );

  const spreads = sample.quotes
    .filter((quote) => isPositive(quote.bestAsk) && isPositive(quote.bestBid) && isPositive(quote.mid))
    .map((quote) => (((quote.bestAsk as number) - (quote.bestBid as number)) / (quote.mid as number)) * 10_000);

  const funding = fundingDelCubo(sample);

  return {
    instrumentId: sample.instrumentId,
    symbol: sample.symbol,
    bucketStartMs: sample.bucketStartMs,
    markReturn: cierre / apertura - 1,
    fundingRate: funding.rate,
    fundingAccrued: funding.accrued,
    basisVsIndex: basisIndice,
    basisVsOracle: basisOraculo,
    volPerSecond: volatilidadPorSegundo(marcas),
    meanSpreadBps: promedio(spreads),
    meanAskNotionalUsd: promedio(sample.quotes.map((quote) => quote.askNotionalUsd).filter(isPositive) as number[]),
    meanBidNotionalUsd: promedio(sample.quotes.map((quote) => quote.bidNotionalUsd).filter(isPositive) as number[]),
    markTickCount: marcas.length,
  };
}

/** Intervalo de funding que se asume si la muestra no lo trae: el de BTC-USD y ETH-USD. */
const INTERVALO_FUNDING_POR_DEFECTO_H = 1;

/**
 * Tasa horaria media y funding devengado de un cubo, calculados de los TICKS.
 *
 * Aqui y solo aqui. Antes este dato se resumia al grabar, en un `fundingRateSum` que sumaba cada
 * cambio de la tasa, y salio inflado dos veces:
 *
 * - **La tasa es horaria.** Con una sola tasa en todo el cubo, ese resumen guardaba la hora entera
 *   para cinco minutos: 12x de mas. Era la MEDIANA de los 2.282 cubos medidos el 2026-09-18.
 * - **La tasa es una PREVISION que se actualiza sin parar**, no un cobro por cada valor. Sumar cada
 *   actualizacion contaba como otro pago lo que era la misma tasa corrigiendose: ~400x en el p90.
 *
 * Y el error iba en la direccion peligrosa: el carry COBRA funding, asi que inflarlo hacia parecer
 * rentable lo que no lo era. Por eso se calcula de los ticks, que son la fuente de verdad y estaban
 * intactos, y se promedia la tasa en vez de sumarla — que es lo que de verdad liquida el exchange:
 * la tasa vigente, una vez por intervalo.
 */
export function fundingDelCubo(sample: PerpsSample): { rate: number; accrued: number } {
  const tasas = sample.ticks
    .map((tick) => tick.fundingRate)
    .filter((valor): valor is number => typeof valor === "number" && Number.isFinite(valor));
  if (tasas.length === 0) {
    return { rate: 0, accrued: 0 };
  }
  const rate = tasas.reduce((sum, valor) => sum + valor, 0) / tasas.length;
  const intervaloH =
    typeof sample.fundingIntervalHours === "number" && sample.fundingIntervalHours > 0
      ? sample.fundingIntervalHours
      : INTERVALO_FUNDING_POR_DEFECTO_H;
  const duracionH = (sample.bucketEndMs - sample.bucketStartMs) / 3_600_000;
  return { rate, accrued: rate * (duracionH / intervaloH) };
}

export interface CarryOutcome {
  side: PerpsSide;
  notionalUsd: number;
  /** Lo que el funding dio o quito. Negativo = lo cobro esta posicion. */
  fundingUsd: number;
  /** Lo que hizo el precio. Es el riesgo que se corre por cobrar el funding. */
  priceUsd: number;
  /** Comisiones de abrir Y cerrar. Dos operaciones, no una: olvidar la segunda dobla la ventaja. */
  feeUsd: number;
  netUsd: number;
}

/**
 * Que habria dado mantener una posicion durante UN cubo para cobrar el funding.
 *
 * Es la hipotesis mecanica que este trabajo viene a medir: el funding es un flujo de caja observable y
 * publicado, no una prediccion. Cobrarlo exige quedarse del lado que cobra y aguantar el movimiento
 * del precio mientras tanto, y esta funcion pone las dos cosas en la misma cuenta.
 *
 * Tres cosas que se hacen mal si no se dicen:
 *
 * - **Se cobran DOS comisiones**, la de abrir y la de cerrar. Contar una sola es el error mas barato
 *   de cometer y el que mas infla el resultado: al tramo base son 0,04% x 2 sobre el nocional, y el
 *   funding tipico de un periodo esta en ese mismo orden de magnitud.
 * - **El riesgo de precio va dentro.** Separarlo seria contar el ingreso sin el riesgo que se corre
 *   para conseguirlo, que es como el maker parecia gratis hasta que se midio que te llenan.
 * - **Devuelve dolares, no ROI.** El denominador de un ROI aqui seria el margen, y el margen depende
 *   del apalancamiento elegido — o sea que el mismo resultado economico daria ROIs distintos segun un
 *   ajuste. Los dolares por cubo son comparables entre configuraciones; el ROI no.
 */
export function carryOutcome(args: {
  metrics: PerpsBucketMetrics;
  side: PerpsSide;
  notionalUsd: number;
  feeRate?: number;
  /** Precio de referencia para las comisiones. Por defecto se usa el nocional tal cual. */
  entryPrice?: number;
}): CarryOutcome {
  const feeRate = args.feeRate ?? PERPS_BASE_TAKER_RATE;
  const signo = args.side === "LONG" ? 1 : -1;
  const priceUsd = signo * args.notionalUsd * args.metrics.markReturn;
  // `calculateFundingCostUsd` devuelve el COSTE (positivo = se paga), asi que aqui se resta.
  // Lo DEVENGADO, no la tasa. Pasar la tasa horaria aqui es cobrar una hora entera por cada cubo de
  // cinco minutos, que es el 12x que tuvo este calculo hasta el 2026-09-18.
  const fundingUsd = calculateFundingCostUsd({
    side: args.side,
    notionalUsd: args.notionalUsd,
    fundingRate: args.metrics.fundingAccrued,
  });
  const precioRef = isPositive(args.entryPrice) ? (args.entryPrice as number) : 1;
  const cantidadRef = args.notionalUsd / precioRef;
  const feeUsd =
    calculatePerpsFeeUsd({ price: precioRef, quantity: cantidadRef, feeRate }) * 2;
  return {
    side: args.side,
    notionalUsd: args.notionalUsd,
    fundingUsd,
    priceUsd,
    feeUsd,
    netUsd: round(priceUsd - fundingUsd - feeUsd),
  };
}

/**
 * El lado que COBRA el funding en este cubo, o `undefined` si no hay funding que cobrar.
 *
 * Con la tasa positiva pagan los largos, asi que quien cobra es el corto. Un cero exacto no tiene
 * lado: devolverlo como "LONG" por defecto meteria en la muestra operaciones que no persiguen ninguna
 * ventaja y diluiria lo que se quiere medir.
 */
export function fundingReceiverSide(fundingRate: number): PerpsSide | undefined {
  if (!Number.isFinite(fundingRate) || fundingRate === 0) {
    return undefined;
  }
  return fundingRate > 0 ? "SHORT" : "LONG";
}

/**
 * Volatilidad por segundo de la serie de marca.
 *
 * Mismo criterio que `readWindowCertainty` del binario —saltos normalizados por la raiz del tiempo—
 * pero sin su `z`: aqui no hay strike al que medir distancia ni cierre al que faltarle tiempo, asi
 * que la parte de la formula que convertia esto en una certeza no tiene traduccion. Lo que si viaja
 * es la disciplina de normalizar por `dt`, porque el muestreo no es regular.
 */
function volatilidadPorSegundo(ticks: Array<{ timestampMs: number; markPrice?: number }>): number | undefined {
  const saltos: number[] = [];
  for (let i = 1; i < ticks.length; i += 1) {
    const previo = ticks[i - 1];
    const actual = ticks[i];
    const dt = (actual.timestampMs - previo.timestampMs) / 1000;
    if (!(dt > 0) || !isPositive(previo.markPrice) || !isPositive(actual.markPrice)) {
      continue;
    }
    saltos.push(Math.log((actual.markPrice as number) / (previo.markPrice as number)) / Math.sqrt(dt));
  }
  if (saltos.length < 6) {
    return undefined;
  }
  const media = saltos.reduce((sum, value) => sum + value, 0) / saltos.length;
  const varianza = saltos.reduce((sum, value) => sum + (value - media) ** 2, 0) / (saltos.length - 1);
  const sigma = Math.sqrt(varianza);
  // Una sigma de cero NO es certeza infinita: es un feed congelado. Devolverla dejaria que una averia
  // se leyera como la senal mas fuerte posible, que es el fallo que documenta `windowCertainty.ts`.
  return sigma > 0 ? sigma : undefined;
}

function promedio(values: number[]): number | undefined {
  if (values.length === 0) {
    return undefined;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function isPositive(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

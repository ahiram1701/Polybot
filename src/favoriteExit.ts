import { proceedsFromSelling } from "./orderbookService.js";
import { DEFAULT_MAX_ASK_SUM } from "./favoriteSelector.js";
import type { OrderbookQuote, Outcome } from "./types.js";

/**
 * Decide si una posicion del favorito se CIERRA antes de que el mercado resuelva.
 *
 * Hasta ahora el bot solo compraba: toda posicion se mantenia hasta la redencion, gane o pierda. Esto
 * es lo contrario — acotar la perdida cuando el precio deja de estar en el tramo en el que se compra.
 *
 * Vive aparte de `favoriteSelector` porque responde otra pregunta. El selector responde "¿de que lado
 * me pongo?" mirando los dos asks; esto responde "¿sigo aqui?" mirando el ask del lado que YA se tiene
 * y la profundidad de los compradores. Mezclarlos obligaria a que una sola funcion devolviera dos
 * decisiones distintas sobre el mismo libro, y el motivo de descarte dejaria de ser atribuible.
 *
 * Lo que este modulo NO decide es que comprar despues. Eso lo resuelve `selectFavoriteOutcome` sobre
 * los mismos libros, con sus bandas y su tramo de conviccion: una sola fuente de verdad para
 * "¿compro esto?".
 */

/**
 * Cuanto por debajo del suelo de la banda cae el stop cuando NO hay umbral absoluto configurado.
 *
 * Un centimo, no cero, porque `stopAsk` es "el ask mas alto al que todavia se vende" (la comparacion
 * es inclusiva): con cero, el stop coincidiria con el suelo de la banda y se vendera a un precio al
 * que la estrategia todavia COMPRA. Un tick de separacion es lo minimo coherente.
 *
 * Medido sobre 705 ventanas de `data/analytics.jsonl`: este stop pegado a la banda es el PEOR de todos
 * los probados —cuesta 105$ frente a no vender— porque el ask baja un par de centimos por ruido, se
 * vende contra el bid y se recompra mas caro. De 15 salidas reales, 5 recompraron el MISMO lado 7-10
 * centimos peor. Por eso existe `favoriteExitStopAsk`: para poner el stop donde el ruido ya no llega.
 */
export const DEFAULT_EXIT_STOP_MARGIN = 0.01;

/**
 * Segundos minimos al cierre para vender. Dos razones distintas, y las dos importan:
 *
 * 1. El CLOB pasa a POST-ONLY en los ultimos segundos de la ventana (ver `isPostOnlyRejection` en
 *    botRunner): una orden de venta taker se rechazaria justo cuando mas falta hace.
 * 2. Una reentrada sin tiempo para acertar no es una reentrada: es pagar el spread por nada.
 *
 * Muy por encima de los 10 s de `DEFAULT_MIN_SECONDS_TO_END` de la ENTRADA, a proposito. Entrar tarde
 * solo desperdicia una oportunidad; salir tarde deja la posicion sin cerrar Y sin poder recomprar.
 */
export const DEFAULT_EXIT_MIN_SECONDS_TO_END = 45;

/**
 * Suelo duro del mejor bid. Por debajo, vender no acota la perdida: la regala.
 *
 * A 0,03 lo que queda de la posicion vale menos que el ancho del libro que hay que pagar para
 * soltarla, y ademas es justo donde el valor residual de un binario todavia paga a veces. Cerrar ahi
 * convierte una perdida casi total en una perdida total mas comision.
 */
export const DEFAULT_EXIT_MIN_BID = 0.05;

/**
 * Fraccion minima de la posicion que los compradores tienen que absorber para que la venta valga.
 *
 * Espejo de `DEFAULT_MIN_FILL_RATIO` de la entrada, y por la razon inversa: una salida PARCIAL paga el
 * spread entero y te deja con la mayor parte de la perdida encima. Mas exigente que el 0,5 de la
 * entrada porque una compra parcial deja una posicion pequeña —incomodo— mientras que una venta
 * parcial deja una posicion perdedora abierta y el dinero ya gastado en comisiones.
 */
export const DEFAULT_EXIT_MIN_FILL_RATIO = 0.9;

/**
 * Spread maximo del libro PROPIO para fiarse de su ask.
 *
 * Cubre el hueco que `dead_book` no puede cubrir: al final de la ventana el lado ganador se queda SIN
 * asks (nadie vende barato un ganador ya hecho, ver el comentario de `selectFavoriteOutcome`), asi que
 * exigir los dos asks como hace el selector dejaria la posicion atrapada justo cuando se derrumba y el
 * contrario deja de cotizar. Sin el ask del contrario, la realidad del precio se confirma con lo
 * ancho que este el libro propio: un ask de 0,70 con el bid en 0,55 no dice "ha caido al 70%", dice
 * que no hay mercado.
 */
export const DEFAULT_EXIT_MAX_SPREAD = 0.1;

/**
 * Cuanto tiene que vivir una posicion antes de poder cerrarse.
 *
 * Impide que la misma oscilacion del libro que produjo la compra produzca la venta. Con el stop pegado
 * al suelo de la banda es un riesgo concreto, no teorico: comprar a 0,79 y vender a 0,788 un segundo
 * despues es un pago de spread puro, sin haber tenido nunca una posicion.
 */
export const DEFAULT_EXIT_MIN_HOLD_MS = 10_000;

/**
 * Motivos que NO son salida. Separados del exito para que el llamador pueda componer
 * `favorite_exit_${reason}` sin que el tipo le cuele el caso bueno: esas etiquetas van a
 * `SKIP_REASON_LABELS`, y una sin traducir sale como codigo crudo en las tres pantallas.
 */
export type FavoriteExitSkipReason =
  | "missing_quote"
  | "extreme_price"
  | "dead_book"
  | "libro_ancho"
  | "en_banda"
  | "demasiado_pronto"
  | "demasiado_tarde"
  | "sin_bid"
  | "bid_bajo_suelo"
  | "liquidez_insuficiente";

/** El unico motivo que SI cierra. */
export type FavoriteExitReason = "stop_bajo_banda";

export interface FavoriteExitPlan {
  /** El lado que se VENDE. */
  outcome: Outcome;
  /** Participaciones que se piden vender. */
  shares: number;
  /** Las que los bids absorben de verdad, bajando por el libro. */
  sharesVendibles: number;
  askNuestro: number;
  stopAsk: number;
  bestBid: number;
  proceedsUsd: number;
  precioMedioSalida: number;
  /**
   * El nivel mas bajo al que hay que llegar para colocar todo. Es el limite que debe llevar la orden:
   * cualquier cosa por encima deja parte sin ejecutar.
   */
  peorPrecio: number;
}

/** Contexto para el log de descarte. Redondeado: es para leerlo, no para calcular con ello. */
type FavoriteExitDetail = Record<string, number>;

/** Union discriminada: comprobar `plan` estrecha `reason` al subconjunto de descartes. */
export type FavoriteExitDecision =
  | { reason: FavoriteExitReason; plan: FavoriteExitPlan; detail: FavoriteExitDetail }
  | { reason: FavoriteExitSkipReason; plan?: undefined; detail: FavoriteExitDetail };

export function decideFavoriteExit(args: {
  posicion: { outcome: Outcome; shares: number; createdAtMs: number };
  quotes: Partial<Record<Outcome, OrderbookQuote>>;
  nowMs: number;
  endMs: number;
  /** El ask mas alto al que TODAVIA se vende. La comparacion es inclusiva: ask <= stopAsk cierra. */
  stopAsk: number;
  minSecondsToEnd?: number;
  minBid?: number;
  minSellFillRatio?: number;
  maxAskSum?: number;
  maxSpread?: number;
  minHoldMs?: number;
}): FavoriteExitDecision {
  const minSecondsToEnd = resolveNonNegative(args.minSecondsToEnd, DEFAULT_EXIT_MIN_SECONDS_TO_END);
  const minBid = resolvePrice(args.minBid, DEFAULT_EXIT_MIN_BID);
  const minSellFillRatio = resolveRatio(args.minSellFillRatio, DEFAULT_EXIT_MIN_FILL_RATIO);
  const maxAskSum = resolvePositive(args.maxAskSum, DEFAULT_MAX_ASK_SUM);
  const maxSpread = resolvePositive(args.maxSpread, DEFAULT_EXIT_MAX_SPREAD);
  const minHoldMs = resolveNonNegative(args.minHoldMs, DEFAULT_EXIT_MIN_HOLD_MS);

  const nuestro = args.quotes[args.posicion.outcome];
  const contrario = args.quotes[opuesto(args.posicion.outcome)];
  const askNuestro = nuestro?.bestAsk;

  // Solo se exige el ask del lado que se TIENE. El del contrario es opcional a proposito: es el que
  // desaparece al final de la ventana cuando el contrario va ganando, que es justo el momento en el
  // que esta posicion mas necesita poder salir.
  if (askNuestro === undefined) {
    return { reason: "missing_quote", detail: {} };
  }

  if (!esPrecioOperable(askNuestro)) {
    return { reason: "extreme_price", detail: { askNuestro: redondear(askNuestro) } };
  }

  // Libro muerto: los dos "mejores asks" son ofertas anchas y sueltas, asi que el precio no es una
  // probabilidad y la caida que se estaria leyendo es el ancho moviendose. Misma guarda que protege la
  // entrada; aqui protege de vender por una lectura que no significa nada.
  const askContrario = contrario?.bestAsk;
  if (askContrario !== undefined && esPrecioOperable(askContrario)) {
    const sumaAsks = askNuestro + askContrario;
    if (sumaAsks > maxAskSum) {
      return {
        reason: "dead_book",
        detail: {
          askNuestro: redondear(askNuestro),
          askContrario: redondear(askContrario),
          sumaAsks: redondear(sumaAsks),
          maxAskSum,
        },
      };
    }
  }

  const bestBid = nuestro?.bestBid;
  const detalleBase: FavoriteExitDetail = {
    askNuestro: redondear(askNuestro),
    stopAsk: redondear(args.stopAsk),
    ...(bestBid === undefined ? {} : { bestBid: redondear(bestBid) }),
  };

  // Sin el ask del contrario esta es la unica confirmacion de que el libro propio es real. Se aplica
  // siempre —tambien con el contrario presente— porque un libro propio anchisimo hace inutil el precio
  // aunque la suma cuadre.
  if (bestBid !== undefined && askNuestro - bestBid > maxSpread) {
    return {
      reason: "libro_ancho",
      detail: { ...detalleBase, spread: redondear(askNuestro - bestBid), maxSpread },
    };
  }

  const vividoMs = args.nowMs - args.posicion.createdAtMs;
  if (vividoMs < minHoldMs) {
    return { reason: "demasiado_pronto", detail: { ...detalleBase, vividoMs, minHoldMs } };
  }

  const segundosAlCierre = (args.endMs - args.nowMs) / 1000;
  if (segundosAlCierre < minSecondsToEnd) {
    return {
      reason: "demasiado_tarde",
      detail: { ...detalleBase, segundosAlCierre: Math.round(segundosAlCierre), minSecondsToEnd },
    };
  }

  // El caso NORMAL, y el unico que no es una anomalia: la posicion sigue por encima del stop.
  //
  // La comparacion es contra el ASK, no contra el bid, y no es un detalle. La banda de compra es de
  // asks, asi que el ask es la misma vara con la que se decidio entrar. Medir el stop sobre el bid
  // dispararia en la iteracion siguiente a CUALQUIER compra: con spreads de 1,5 a 4,5 centimos, un ask
  // de 0,82 lleva el bid ya por debajo del suelo de 0,79.
  //
  // INCLUSIVA: `stopAsk` es el ask mas alto al que todavia se vende. Asi el ajuste dice literalmente lo
  // que hace —"vende con el ask en 0,69 o menos" es `stopAsk: 0.69`— en vez de obligar a configurar el
  // primer precio que NO vende, que es como se cuelan los errores de un tick.
  if (askNuestro > args.stopAsk) {
    return { reason: "en_banda", detail: detalleBase };
  }

  if (bestBid === undefined) {
    return { reason: "sin_bid", detail: detalleBase };
  }

  if (bestBid < minBid) {
    return { reason: "bid_bajo_suelo", detail: { ...detalleBase, minBid } };
  }

  // Solo los niveles que pagan al menos el suelo. Los de debajo existen en el libro pero venderles es
  // exactamente lo que `bid_bajo_suelo` acaba de rechazar, asi que tampoco pueden contar como
  // profundidad disponible.
  const nivelesUtiles = (nuestro?.rawBidLevels ?? []).filter((nivel) => nivel.price >= minBid);
  const { proceedsUsd, sharesSold, worstPrice } = proceedsFromSelling(nivelesUtiles, args.posicion.shares);
  const ratio = args.posicion.shares > 0 ? sharesSold / args.posicion.shares : 0;
  if (ratio < minSellFillRatio || sharesSold <= 0 || worstPrice === undefined) {
    return {
      reason: "liquidez_insuficiente",
      detail: {
        ...detalleBase,
        shares: redondear(args.posicion.shares),
        sharesVendibles: redondear(sharesSold),
        ratio: redondear(ratio),
        minSellFillRatio,
      },
    };
  }

  const precioMedioSalida = proceedsUsd / sharesSold;
  return {
    reason: "stop_bajo_banda",
    plan: {
      outcome: args.posicion.outcome,
      shares: args.posicion.shares,
      sharesVendibles: sharesSold,
      askNuestro,
      stopAsk: args.stopAsk,
      bestBid,
      proceedsUsd,
      precioMedioSalida,
      peorPrecio: worstPrice,
    },
    detail: {
      ...detalleBase,
      shares: redondear(args.posicion.shares),
      sharesVendibles: redondear(sharesSold),
      proceedsUsd: redondear(proceedsUsd),
      precioMedioSalida: redondear(precioMedioSalida),
      peorPrecio: redondear(worstPrice),
    },
  };
}

/**
 * El ask mas alto al que todavia se vende.
 *
 * Dos formas, y la absoluta manda cuando esta puesta:
 *
 * - `stopAsk` ABSOLUTO. El criterio es un suelo de precio propio, independiente de donde se compre.
 *   Es lo que hace falta cuando el stop tiene que estar LEJOS de la banda: medido sobre 705 ventanas,
 *   un stop pegado al suelo de la banda vende por ruido —264 de 373 salidas fueron a lados que
 *   acabaron ganando— y derivarlo de la banda obligaria a expresarlo como una resta que se desplaza
 *   sola en cuanto alguien mueve la banda.
 * - Derivado de la banda, para el caso en que no se configure nada: "ya no cotiza donde compre".
 */
export function resolveStopAsk(
  favoriteMinAsk: number,
  stopMargin: number | undefined,
  stopAsk?: number,
): number {
  if (typeof stopAsk === "number" && Number.isFinite(stopAsk) && stopAsk > 0 && stopAsk < 1) {
    return stopAsk;
  }
  const margen = typeof stopMargin === "number" && Number.isFinite(stopMargin) && stopMargin >= 0
    ? stopMargin
    : DEFAULT_EXIT_STOP_MARGIN;
  return Math.max(0, favoriteMinAsk - margen);
}

function opuesto(outcome: Outcome): Outcome {
  return outcome === "UP" ? "DOWN" : "UP";
}

function esPrecioOperable(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value < 1;
}

function resolvePrice(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value < 1 ? value : fallback;
}

function resolveRatio(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : fallback;
}

function resolvePositive(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function resolveNonNegative(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function redondear(value: number): number {
  return Math.round(value * 1000) / 1000;
}

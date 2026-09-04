import type { OrderbookQuote, Outcome } from "./types.js";

/**
 * Selector de "favorito": elige lado por el PRECIO del libro, no por el movimiento del oraculo.
 *
 * Es la estrategia manual del operador —"me subo al que ya va ganando cuando cotiza ~0,80"— y es
 * deliberadamente distinta de `getWinningOutcome`, que mira la distancia de Chainlink respecto a la
 * apertura. Aqui no se predice nada: se lee a quien el libro ya ha declarado favorito.
 *
 * Vive aparte y no como una rama dentro de `signalEngine` porque son dos criterios de seleccion
 * incompatibles sobre el mismo mercado. Mezclarlos haria imposible atribuir cada muestra del ledger
 * a uno de los dos, y toda la analitica del bot se puntua por estrategia.
 */

export const DEFAULT_FAVORITE_MIN_ASK = 0.76;
export const DEFAULT_FAVORITE_MAX_ASK = 0.85;

/**
 * Tope de la SUMA de los dos asks.
 *
 * Un binario sano cotiza los dos lados en torno a 1 + spread. Una suma muy por encima de 1 significa
 * que nadie esta cotizando de verdad: los dos "mejores asks" son ofertas anchas y sueltas. Y entonces
 * un ask de 0,80 NO quiere decir "el mercado le da un 80%" — quiere decir que no hay mercado.
 *
 * Importa porque toda la premisa de esta estrategia es que el precio ES la probabilidad implicita.
 * En un libro muerto esa premisa es falsa y la entrada se convierte en pagar el ancho del libro
 * creyendo que compras un favorito.
 */
export const DEFAULT_MAX_ASK_SUM = 1.15;

/** Motivos que NO son entrada. Separados del exito para que el llamador pueda componer `favorite_${reason}`
 * sin que el tipo le cuele el caso bueno: esas etiquetas van a `SKIP_REASON_LABELS`, y una sin traducir
 * sale como codigo crudo en las tres pantallas. */
export type FavoriteSkipReason =
  | "missing_quote"
  | "extreme_price"
  | "dead_book"
  | "no_favorite"
  | "below_band"
  | "above_band";

export type FavoriteReason = "in_band" | FavoriteSkipReason;

export interface FavoriteSelection {
  outcome: Outcome;
  askPrice: number;
  /** El ask del lado contrario. Viaja con la seleccion para poder auditar luego que el libro era real. */
  oppositeAskPrice: number;
}

/** Contexto para el log de descarte. Redondeado: es para leerlo, no para calcular con ello. */
type FavoriteDetail = Record<string, number>;

/** Union discriminada: comprobar `selection` estrecha `reason` al subconjunto de descartes. */
export type FavoriteDecision =
  | { reason: "in_band"; selection: FavoriteSelection; detail: FavoriteDetail }
  | { reason: FavoriteSkipReason; selection?: undefined; detail: FavoriteDetail };

export function selectFavoriteOutcome(args: {
  quotes: Partial<Record<Outcome, OrderbookQuote>>;
  minAsk?: number;
  maxAsk?: number;
  maxAskSum?: number;
}): FavoriteDecision {
  const minAsk = resolveBound(args.minAsk, DEFAULT_FAVORITE_MIN_ASK);
  const maxAsk = resolveBound(args.maxAsk, DEFAULT_FAVORITE_MAX_ASK);
  const maxAskSum = resolveSum(args.maxAskSum, DEFAULT_MAX_ASK_SUM);

  const upAsk = args.quotes.UP?.bestAsk;
  const downAsk = args.quotes.DOWN?.bestAsk;

  // Se exigen LOS DOS lados aunque solo se vaya a comprar uno: sin el contrario no se puede separar
  // un favorito real de un libro muerto, y esa separacion es toda la guardia de abajo.
  // "Falta el ask" y "el ask esta fuera de (0,1)" se separan a proposito: los dos rechazan, pero no
  // son el mismo suceso y juntos el log era ilegible — decia "falta el libro" enseñando un ask al lado.
  //
  // Medido observando el contenedor: al final de la ventana lo NORMAL es que el lado casi seguro se
  // quede SIN asks (nadie vende barato un ganador ya hecho) mientras el perdedor cotiza a 0,01. Eso es
  // `missing_quote` y no es ninguna averia. `extreme_price` es el caso raro de un ask en 0 o >=1.
  if (upAsk === undefined || downAsk === undefined) {
    return {
      reason: "missing_quote",
      detail: {
        ...(upAsk === undefined ? {} : { upAsk: round(upAsk) }),
        ...(downAsk === undefined ? {} : { downAsk: round(downAsk) }),
      },
    };
  }

  if (!isTradeablePrice(upAsk) || !isTradeablePrice(downAsk)) {
    return { reason: "extreme_price", detail: { upAsk: round(upAsk), downAsk: round(downAsk) } };
  }

  const askSum = upAsk + downAsk;
  if (askSum > maxAskSum) {
    return {
      reason: "dead_book",
      detail: { upAsk: round(upAsk), downAsk: round(downAsk), askSum: round(askSum), maxAskSum },
    };
  }

  // Empate exacto: el libro no ha declarado favorito, asi que no hay nada que replicar.
  if (upAsk === downAsk) {
    return { reason: "no_favorite", detail: { upAsk: round(upAsk), downAsk: round(downAsk) } };
  }

  const outcome: Outcome = upAsk > downAsk ? "UP" : "DOWN";
  const askPrice = Math.max(upAsk, downAsk);
  const oppositeAskPrice = Math.min(upAsk, downAsk);
  const detail = { outcomeAsk: round(askPrice), oppositeAsk: round(oppositeAskPrice), minAsk, maxAsk };

  // Todavia no hay un favorito lo bastante claro: el mercado sigue repartido.
  if (askPrice < minAsk) {
    return { reason: "below_band", detail };
  }

  // Demasiado caro. No es que la comision muerda mas (muerde menos en centimos), es que el premio se
  // encoge mas rapido que el riesgo: a 0,90 una perdida borra 8,5 aciertos.
  if (askPrice > maxAsk) {
    return { reason: "above_band", detail };
  }

  return { reason: "in_band", selection: { outcome, askPrice, oppositeAskPrice }, detail };
}

function isTradeablePrice(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value < 1;
}

function resolveBound(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value < 1 ? value : fallback;
}

function resolveSum(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

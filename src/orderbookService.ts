import { Chain, ClobClient, type OrderBookSummary } from "@polymarket/clob-client-v2";

import type { OrderbookQuote } from "./types.js";

// Orderbook HTTP calls had no timeout, so an occasional network stall froze the whole capture phase
// (a 46s hang was observed in the loop-latency instrumentation, leaving the bot blind and missing
// entries). A healthy orderbook responds in <500ms, so a 2s cap is ample headroom; beyond it the call
// is treated as a normal skip (callers already handle a quote failure as "no quote this tick") and the
// next tick retries ~1-2s later. Tighter than 2s risks dropping merely-slow-but-working quotes; the
// residual multi-second tail is Polymarket's CLOB API, not our loop.
const DEFAULT_QUOTE_TIMEOUT_MS = 2_000;

export class OrderbookService {
  constructor(
    private readonly client: Pick<ClobClient, "getOrderBook">,
    private readonly quoteTimeoutMs = DEFAULT_QUOTE_TIMEOUT_MS,
  ) {}

  static create(clobHost: string): OrderbookService {
    return new OrderbookService(
      new ClobClient({
        host: clobHost,
        chain: Chain.POLYGON,
        throwOnError: true,
      }),
    );
  }

  async getQuote(tokenId: string, amountUsd: number, maxAskPrice: number): Promise<OrderbookQuote> {
    const book = await withTimeout(
      this.client.getOrderBook(tokenId),
      this.quoteTimeoutMs,
      `orderbook getQuote(${tokenId})`,
    );
    return summarizeOrderBook(book, amountUsd, maxAskPrice);
  }
}

/**
 * Rejects if the promise does not settle within `timeoutMs`. The underlying request may keep running
 * (the third-party CLOB client exposes no abort signal), but the loop is freed immediately.
 */
export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`Timeout tras ${timeoutMs}ms: ${label}`)), timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export function summarizeOrderBook(
  book: OrderBookSummary,
  amountUsd: number,
  maxAskPrice: number,
): OrderbookQuote {
  const asks = book.asks
    .map((level) => ({ price: Number(level.price), size: Number(level.size) }))
    .filter((level) => Number.isFinite(level.price) && Number.isFinite(level.size) && level.size > 0)
    .sort((left, right) => left.price - right.price);

  const bids = book.bids
    .map((level) => ({ price: Number(level.price), size: Number(level.size) }))
    .filter((level) => Number.isFinite(level.price) && Number.isFinite(level.size) && level.size > 0)
    .sort((left, right) => right.price - left.price);

  let remainingUsd = amountUsd;
  let filledUsd = 0;
  let estimatedSharesForAmount = 0;

  for (const ask of asks) {
    if (ask.price > maxAskPrice || remainingUsd <= 0) {
      break;
    }

    const levelUsdCapacity = ask.price * ask.size;
    const usedUsd = Math.min(remainingUsd, levelUsdCapacity);
    filledUsd += usedUsd;
    estimatedSharesForAmount += usedUsd / ask.price;
    remainingUsd -= usedUsd;
  }

  const availableUsdUnderCap = asks
    .filter((ask) => ask.price <= maxAskPrice)
    .reduce((sum, ask) => sum + ask.price * ask.size, 0);
  // Profundidad SIN el tope de ask. El tope es un control de riesgo DIRECCIONAL ("no pagues mas de
  // 60 centavos por una apuesta"), y el arbitraje de set completo no corre ese riesgo: compra ambos
  // lados y el par redime exactamente $1 gane quien gane. Su unica condicion es up+down<1 tras
  // comisiones. Medido sobre el historico, exigirle el tope direccional al arbitraje bloqueaba el 78%
  // de las oportunidades (BTC 84%, ETH 73%, DOGE 60%) — y son justo las que lo definen, porque un
  // arbitraje aparece cuando UN lado se encarece.
  const availableUsdAllLevels = asks.reduce((sum, ask) => sum + ask.price * ask.size, 0);

  return {
    tokenId: book.asset_id,
    bestAsk: asks[0]?.price,
    bestBid: bids[0]?.price,
    availableUsdUnderCap,
    availableUsdAllLevels,
    estimatedSharesForAmount,
    estimatedAveragePrice: estimatedSharesForAmount > 0 ? filledUsd / estimatedSharesForAmount : undefined,
    rawAskLevels: asks,
    rawBidLevels: bids,
    availableBidUsdAllLevels: bids.reduce((sum, bid) => sum + bid.price * bid.size, 0),
  };
}

/**
 * Ingresos reales de vender `shares` contra los bids, bajando por el libro. Devuelve tambien cuantas
 * se pudieron colocar: si el libro no da para todas, vender a ciegas dejaria parte sin ejecutar.
 *
 * Se usa para dimensionar el MINT-arb. El error que evita es cobrar todas las participaciones al mejor
 * bid: en un libro fino los niveles de abajo pagan bastante menos, y esa diferencia puede convertir un
 * arbitraje aparente en una perdida.
 */
/**
 * Tamaño de referencia para el resumen de profundidad que se graba en la analitica.
 *
 * Es una constante DELIBERADA, no el tamaño de operacion configurado. Se graba en el historico y ese
 * historico se lee meses despues: si dependiera de un ajuste que el usuario cambia, las muestras
 * viejas y las nuevas medirian cosas distintas y no serian comparables entre si.
 */
export const DEPTH_PROBE_USD = 5;

/**
 * Precio MEDIO REAL de comprar `amountUsd` bajando por el libro, o `undefined` si el libro no da.
 *
 * Existe para cerrar el agujero que documenta `realizedGuard.ts` y que ya costo dinero: la analitica
 * solo guardaba el MEJOR precio, asi que cualquier backtest sobre ella asumia relleno perfecto y
 * gratis. Cerca del cierre el libro se adelgaza y el precio cotizado no es el que se consigue — o sea
 * que el simulador era mas optimista justo donde la realidad es peor, y empujaba hacia ahi.
 *
 * Grabar esto convierte ese sesgo en un dato medible en vez de una advertencia en un comentario.
 */
export function averageFillPrice(
  levels: Array<{ price: number; size: number }>,
  amountUsd = DEPTH_PROBE_USD,
): number | undefined {
  let restanteUsd = amountUsd;
  let shares = 0;
  for (const level of levels) {
    if (restanteUsd <= 0) {
      break;
    }
    if (!(level.price > 0) || !(level.size > 0)) {
      continue;
    }
    const usdEnEsteNivel = Math.min(restanteUsd, level.price * level.size);
    shares += usdEnEsteNivel / level.price;
    restanteUsd -= usdEnEsteNivel;
  }
  // Relleno PARCIAL devuelve undefined a proposito: un precio medio sobre media compra no responde la
  // pregunta que se le hace ("¿cuanto pagaria por este tamaño?") y leerlo como si si es como se cuelan
  // los backtests optimistas.
  if (restanteUsd > 1e-9 || shares <= 0) {
    return undefined;
  }
  return (amountUsd - restanteUsd) / shares;
}

export function proceedsFromSelling(
  levels: Array<{ price: number; size: number }>,
  shares: number,
): { proceedsUsd: number; sharesSold: number; worstPrice?: number } {
  let restantes = shares;
  let proceedsUsd = 0;
  let worstPrice: number | undefined;
  for (const level of levels) {
    if (restantes <= 0) {
      break;
    }
    const usadas = Math.min(restantes, level.size);
    proceedsUsd += usadas * level.price;
    restantes -= usadas;
    worstPrice = level.price;
  }
  return { proceedsUsd, sharesSold: shares - restantes, worstPrice };
}

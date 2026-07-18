import { Chain, ClobClient, type OrderBookSummary } from "@polymarket/clob-client-v2";

import type { OrderbookQuote } from "./types.js";

// Orderbook HTTP calls had no timeout, so an occasional network stall froze the whole capture phase
// (a 46s hang was observed in the loop-latency instrumentation, leaving the bot blind and missing
// entries). A tight cap turns a hang into a normal skip: callers already treat a quote failure as
// "no quote this tick".
const DEFAULT_QUOTE_TIMEOUT_MS = 3_000;

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

  return {
    tokenId: book.asset_id,
    bestAsk: asks[0]?.price,
    bestBid: bids[0]?.price,
    availableUsdUnderCap,
    estimatedSharesForAmount,
    estimatedAveragePrice: estimatedSharesForAmount > 0 ? filledUsd / estimatedSharesForAmount : undefined,
    rawAskLevels: asks,
  };
}

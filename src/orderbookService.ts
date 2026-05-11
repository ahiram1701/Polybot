import { Chain, ClobClient, type OrderBookSummary } from "@polymarket/clob-client-v2";

import type { OrderbookQuote } from "./types.js";

export class OrderbookService {
  constructor(
    private readonly client: Pick<ClobClient, "getOrderBook">,
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
    const book = await this.client.getOrderBook(tokenId);
    return summarizeOrderBook(book, amountUsd, maxAskPrice);
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

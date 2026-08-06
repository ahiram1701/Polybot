import { describe, expect, it } from "vitest";

import {
  OrderbookService,
  proceedsFromSelling,
  summarizeOrderBook,
  withTimeout,
} from "../src/orderbookService.js";

const book = {
  asset_id: "token-1",
  asks: [
    { price: "0.55", size: "100" },
    { price: "0.60", size: "50" },
  ],
  bids: [{ price: "0.53", size: "80" }],
} as unknown as Parameters<typeof summarizeOrderBook>[0];

describe("OrderbookService timeout", () => {
  it("returns the quote when getOrderBook resolves in time", async () => {
    const service = new OrderbookService({ getOrderBook: async () => book }, 1_000);
    const quote = await service.getQuote("token-1", 10, 0.65);
    expect(quote.bestAsk).toBe(0.55);
    expect(quote.bestBid).toBe(0.53);
  });

  it("rejects instead of hanging when getOrderBook stalls past the timeout", async () => {
    const service = new OrderbookService(
      { getOrderBook: () => new Promise(() => {}) }, // never resolves
      20,
    );
    await expect(service.getQuote("token-1", 10, 0.65)).rejects.toThrow(/Timeout/);
  });

  it("withTimeout clears its timer on success (no dangling handle)", async () => {
    await expect(withTimeout(Promise.resolve("ok"), 50, "x")).resolves.toBe("ok");
  });
});

/**
 * El MINT-arb vende contra los bids, no compra contra los asks. Sin los niveles del lado comprador el
 * dimensionado supondria que todo entra al mejor bid, que es justo el error que convierte un
 * arbitraje aparente en una perdida cuando el libro es fino.
 */
describe("profundidad del lado comprador", () => {
  const libro = {
    asset_id: "token-1",
    asks: [{ price: "0.55", size: "100" }],
    bids: [
      { price: "0.53", size: "10" },
      { price: "0.50", size: "40" },
      { price: "0.30", size: "1000" },
    ],
  } as unknown as Parameters<typeof summarizeOrderBook>[0];

  it("expone los niveles del bid ordenados de mejor a peor", () => {
    const quote = summarizeOrderBook(libro, 10, 0.65);
    expect(quote.rawBidLevels.map((level) => level.price)).toEqual([0.53, 0.5, 0.3]);
    // 0.53*10 + 0.50*40 + 0.30*1000 = 5.3 + 20 + 300
    expect(quote.availableBidUsdAllLevels).toBeCloseTo(325.3, 4);
  });

  it("los ingresos bajan por el libro en vez de cobrarlo todo al mejor bid", () => {
    const quote = summarizeOrderBook(libro, 10, 0.65);
    const { proceedsUsd, sharesSold, worstPrice } = proceedsFromSelling(quote.rawBidLevels, 30);
    // 10 a 0.53 + 20 a 0.50 = 15.30, NO 30 x 0.53 = 15.90.
    expect(proceedsUsd).toBeCloseTo(15.3, 6);
    expect(sharesSold).toBe(30);
    expect(worstPrice).toBe(0.5);
  });

  it("dice cuantas participaciones se quedaron sin colocar si el libro no da", () => {
    const { proceedsUsd, sharesSold } = proceedsFromSelling([{ price: 0.5, size: 4 }], 10);
    expect(sharesSold).toBe(4);
    expect(proceedsUsd).toBeCloseTo(2, 6);
  });

  it("un libro comprador vacio no inventa ingresos", () => {
    const quote = summarizeOrderBook(
      { asset_id: "t", asks: [{ price: "0.5", size: "10" }], bids: [] } as unknown as Parameters<
        typeof summarizeOrderBook
      >[0],
      10,
      0.65,
    );
    expect(quote.bestBid).toBeUndefined();
    expect(quote.availableBidUsdAllLevels).toBe(0);
    expect(proceedsFromSelling(quote.rawBidLevels, 5)).toEqual({
      proceedsUsd: 0,
      sharesSold: 0,
      worstPrice: undefined,
    });
  });
});

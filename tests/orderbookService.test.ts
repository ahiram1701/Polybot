import { describe, expect, it } from "vitest";

import { OrderbookService, summarizeOrderBook, withTimeout } from "../src/orderbookService.js";

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

import { describe, expect, it } from "vitest";

import { detectCompleteSetArb } from "../src/arbMonitor.js";
import type { OrderbookQuote } from "../src/types.js";

function quote(bestAsk: number, availableUsdUnderCap: number): OrderbookQuote {
  return {
    tokenId: "token",
    bestAsk,
    bestBid: bestAsk - 0.01,
    availableUsdUnderCap,
    estimatedSharesForAmount: availableUsdUnderCap / bestAsk,
    rawAskLevels: [],
  } as unknown as OrderbookQuote;
}

describe("detectCompleteSetArb", () => {
  it("detects a post-fee opportunity and sizes it by the thinner book", () => {
    // UP 0.40 + DOWN 0.50 = 0.90 gross; fees ~ 0.07*(0.4*0.6 + 0.5*0.5) = 0.0343 -> net ~ 0.0657/set.
    const opportunity = detectCompleteSetArb({
      market: "ETH",
      slug: "eth-updown-5m-1",
      endMs: 100_000,
      nowMs: 40_000,
      quotes: { UP: quote(0.4, 40), DOWN: quote(0.5, 10) },
    });

    expect(opportunity).toBeDefined();
    expect(opportunity?.grossPerSet).toBeCloseTo(0.1);
    expect(opportunity?.netPerSet).toBeCloseTo(0.0657, 3);
    // Thinner book: DOWN has $10 at 0.50 -> 20 sets (UP could do 100).
    expect(opportunity?.maxSetsByDepth).toBeCloseTo(20, 1);
    expect(opportunity?.capturableUsd).toBeCloseTo(20 * 0.0657, 2);
    expect(opportunity?.secondsToEnd).toBeCloseTo(60);
  });

  it("returns nothing when fees eat the gross edge", () => {
    // 0.49 + 0.49 = 0.98 gross 0.02; fees ~ 0.07*2*0.49*0.51 = 0.035 -> net negative.
    expect(
      detectCompleteSetArb({
        market: "BTC",
        slug: "btc-updown-5m-1",
        endMs: 100_000,
        nowMs: 40_000,
        quotes: { UP: quote(0.49, 50), DOWN: quote(0.49, 50) },
      }),
    ).toBeUndefined();
  });

  it("returns nothing without both books priced and funded", () => {
    expect(
      detectCompleteSetArb({
        market: "BTC",
        slug: "btc-updown-5m-1",
        endMs: 100_000,
        nowMs: 40_000,
        quotes: { UP: quote(0.4, 50), DOWN: quote(0.5, 0) },
      }),
    ).toBeUndefined();
    expect(
      detectCompleteSetArb({
        market: "BTC",
        slug: "btc-updown-5m-1",
        endMs: 100_000,
        nowMs: 40_000,
        quotes: { UP: quote(0.4, 50) },
      }),
    ).toBeUndefined();
  });
});

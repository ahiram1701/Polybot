import { describe, expect, it } from "vitest";

import { ChainlinkPriceFeed, parseChainlinkTick, parseChainlinkTicks } from "../src/chainlinkPriceFeed.js";
import type { PriceTick } from "../src/types.js";

function feedWith(ticks: PriceTick[]): ChainlinkPriceFeed {
  const feed = new ChainlinkPriceFeed("wss://unused.example");
  const internals = feed as unknown as { rememberTick(tick: PriceTick): void };
  for (const tick of ticks) {
    internals.rememberTick(tick);
  }
  return feed;
}

function tick(timestampMs: number, value: number): PriceTick {
  return { market: "ETH", symbol: "eth/usd", value, timestampMs, receivedAtMs: timestampMs };
}

describe("getOpeningTick", () => {
  const START = 1_784_300_000_000;
  const GRACE = 15_000;

  it("prefers the last tick at-or-before the window start (official criterion)", () => {
    // A post-open spike must NOT become the opening reference when a pre-open tick exists.
    const feed = feedWith([tick(START - 3_000, 1830.2), tick(START + 5_000, 1832.0)]);
    expect(feed.getOpeningTick("ETH", START, GRACE)).toMatchObject({ value: 1830.2 });
  });

  it("accepts a tick exactly at the boundary", () => {
    const feed = feedWith([tick(START - 8_000, 1829.9), tick(START, 1830.5)]);
    expect(feed.getOpeningTick("ETH", START, GRACE)).toMatchObject({ value: 1830.5 });
  });

  it("falls back to the first post-open tick within grace on cold start", () => {
    const feed = feedWith([tick(START + 4_000, 1831.1), tick(START + 9_000, 1833.0)]);
    expect(feed.getOpeningTick("ETH", START, GRACE)).toMatchObject({ value: 1831.1 });
  });

  it("returns undefined when nothing falls inside the grace window", () => {
    const feed = feedWith([tick(START - 60_000, 1820.0)]);
    expect(feed.getOpeningTick("ETH", START, GRACE)).toBeUndefined();
  });
});

describe("Chainlink RTDS parser", () => {
  it("parses the legacy crypto_prices_chainlink tick format", () => {
    expect(
      parseChainlinkTick({
        topic: "crypto_prices_chainlink",
        payload: {
          symbol: "eth/usd",
          value: "2290.5",
          timestamp: "1778197500000",
        },
      }),
    ).toMatchObject({
      market: "ETH",
      symbol: "eth/usd",
      value: 2290.5,
      timestampMs: 1778197500000,
    });
  });

  it("parses the current crypto_prices history payload and keeps the latest point", () => {
    const message = {
      topic: "crypto_prices",
      payload: {
        symbol: "doge/usd",
        data: [
          { timestamp: 1778197499000, value: 0.1077501274199228 },
          { timestamp: 1778197500000, value: 0.1077480926584616 },
        ],
      },
    };

    expect(parseChainlinkTicks(message)).toHaveLength(2);
    expect(parseChainlinkTick(message)).toMatchObject({
      market: "DOGE",
      symbol: "doge/usd",
      value: 0.1077480926584616,
      timestampMs: 1778197500000,
    });
  });

  it("ignores unsupported symbols", () => {
    expect(
      parseChainlinkTick({
        topic: "crypto_prices",
        payload: {
          symbol: "sol/usd",
          data: [{ timestamp: 1778197500000, value: 150 }],
        },
      }),
    ).toBeNull();
  });
});

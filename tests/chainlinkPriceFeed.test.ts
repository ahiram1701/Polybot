import { describe, expect, it } from "vitest";

import { parseChainlinkTick, parseChainlinkTicks } from "../src/chainlinkPriceFeed.js";

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

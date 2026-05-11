import { describe, expect, it } from "vitest";

import { parseGammaEvent } from "../src/marketWatcher.js";

describe("Gamma market parser", () => {
  it("maps Up/Down outcomes to CLOB token IDs", () => {
    const market = parseGammaEvent(
      {
        title: "Bitcoin Up or Down",
        markets: [
          {
            slug: "btc-updown-5m-1778127900",
            question: "Bitcoin Up or Down - test",
            conditionId: "0xabc",
            outcomes: JSON.stringify(["Up", "Down"]),
            clobTokenIds: JSON.stringify(["up-token", "down-token"]),
            outcomePrices: JSON.stringify(["0.51", "0.49"]),
            endDate: "2026-05-07T04:30:00Z",
            eventStartTime: "2026-05-07T04:25:00Z",
            acceptingOrders: true,
            active: true,
            closed: false,
            orderPriceMinTickSize: 0.01,
            orderMinSize: 5,
            negRisk: false,
          },
        ],
      },
      "btc-updown-5m-1778127900",
    );

    expect(market.outcomes.UP.tokenId).toBe("up-token");
    expect(market.outcomes.DOWN.tokenId).toBe("down-token");
    expect(market.asset).toBe("BTC");
    expect(market.tickSize).toBe("0.01");
    expect(market.orderMinSize).toBe(5);
  });

  it("detects DOGE markets from the slug prefix", () => {
    const market = parseGammaEvent(
      {
        title: "Dogecoin Up or Down",
        markets: [
          {
            slug: "doge-updown-5m-1778127900",
            question: "Dogecoin Up or Down - test",
            conditionId: "0xdoge",
            outcomes: JSON.stringify(["Up", "Down"]),
            clobTokenIds: JSON.stringify(["doge-up", "doge-down"]),
            outcomePrices: JSON.stringify(["0.51", "0.49"]),
            endDate: "2026-05-07T04:30:00Z",
            eventStartTime: "2026-05-07T04:25:00Z",
            acceptingOrders: true,
            active: true,
            closed: false,
            orderPriceMinTickSize: 0.01,
            orderMinSize: 5,
            negRisk: false,
          },
        ],
      },
      "doge-updown-5m-1778127900",
    );

    expect(market.asset).toBe("DOGE");
    expect(market.outcomes.UP.tokenId).toBe("doge-up");
  });
});

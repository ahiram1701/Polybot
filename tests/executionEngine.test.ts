import { describe, expect, it } from "vitest";

import { resolveTradeAmountUsd } from "../src/executionEngine.js";

describe("execution sizing", () => {
  it("keeps simulation at the requested $1 size", () => {
    expect(
      resolveTradeAmountUsd({
        mode: "sim",
        requestedUsd: 1,
        orderMinSize: 5,
        autoMinLive: true,
      }),
    ).toBe(1);
  });

  it("uses the market minimum for live orders when auto-min is enabled (below the min)", () => {
    expect(
      resolveTradeAmountUsd({
        mode: "live",
        requestedUsd: 1,
        orderMinSize: 5,
        autoMinLive: true,
      }),
    ).toBe(5);
  });

  it("uses the market minimum even when the configured live amount is higher", () => {
    // The whole point of "auto minimum": $7 configured must still trade the $5 exchange minimum.
    expect(
      resolveTradeAmountUsd({
        mode: "live",
        requestedUsd: 7,
        orderMinSize: 5,
        autoMinLive: true,
      }),
    ).toBe(5);
  });

  it("falls back to the requested size when the market minimum is unknown", () => {
    expect(
      resolveTradeAmountUsd({
        mode: "live",
        requestedUsd: 7,
        orderMinSize: 0,
        autoMinLive: true,
      }),
    ).toBe(7);
  });

  it("keeps strict live sizing when auto-min is disabled", () => {
    expect(
      resolveTradeAmountUsd({
        mode: "live",
        requestedUsd: 1,
        orderMinSize: 5,
        autoMinLive: false,
      }),
    ).toBe(1);
  });
});

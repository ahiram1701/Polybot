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

  it("raises live orders to the market minimum when auto-min is enabled", () => {
    expect(
      resolveTradeAmountUsd({
        mode: "live",
        requestedUsd: 1,
        orderMinSize: 5,
        autoMinLive: true,
      }),
    ).toBe(5);
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

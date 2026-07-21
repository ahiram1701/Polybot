import { describe, expect, it } from "vitest";

import { resolveLiveOrderPrice, resolveTradeAmountUsd } from "../src/executionEngine.js";

describe("execution sizing", () => {
  it("aplica el minimo del exchange tambien en sim (sim debe dimensionar como live)", () => {
    // Antes sim ignoraba autoMinLive: live operaba al minimo del exchange y sim al monto pedido, asi
    // que el sim no reproducia el tamano real. Ahora el flag es politica pura, igual en ambos modos.
    expect(resolveTradeAmountUsd({ mode: "sim", requestedUsd: 1, orderMinSize: 5, autoMinLive: true })).toBe(5);
    // Con el flag apagado, ambos modos respetan el monto pedido.
    expect(resolveTradeAmountUsd({ mode: "sim", requestedUsd: 1, orderMinSize: 5, autoMinLive: false })).toBe(1);
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

describe("live order pricing (anti-slippage)", () => {
  it("prices near the best-ask instead of walking up to the cap", () => {
    // The real bug: best-ask 0.65 but the order was priced at the 0.80 cap and filled ~0.76.
    expect(resolveLiveOrderPrice({ bestAsk: 0.65, maxAskPrice: 0.8, maxSlippage: 0.02, tickSize: 0.01 })).toBe(0.67);
  });

  it("never exceeds the max cap even with a big slippage tolerance", () => {
    expect(resolveLiveOrderPrice({ bestAsk: 0.79, maxAskPrice: 0.8, maxSlippage: 0.1, tickSize: 0.01 })).toBe(0.8);
  });

  it("falls back to the cap when the best-ask is unknown", () => {
    expect(resolveLiveOrderPrice({ bestAsk: undefined, maxAskPrice: 0.8, maxSlippage: 0.02, tickSize: 0.01 })).toBe(0.8);
  });

  it("rounds to the tick and does not overshoot the cap on rounding", () => {
    expect(resolveLiveOrderPrice({ bestAsk: 0.795, maxAskPrice: 0.8, maxSlippage: 0.02, tickSize: 0.01 })).toBe(0.8);
  });
});

import { describe, expect, it } from "vitest";

import { resolveLiveExitPrice, resolveLiveOrderPrice, resolveTradeAmountUsd } from "../src/executionEngine.js";

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

describe("precio limite de una VENTA", () => {
  // Espejo del de compra, y escrito aparte por lo mismo: un signo mal puesto aqui no da un error, da
  // una orden que no se llena nunca o que barre el libro hasta el fondo.
  it("se pega al mejor bid, un poco por debajo para que llene", () => {
    expect(resolveLiveExitPrice({ bestBid: 0.68, minBidPrice: 0.05, maxSlippage: 0.02, tickSize: 0.01 })).toBe(0.66);
  });

  it("nunca baja del suelo, por mucha tolerancia que se le de", () => {
    expect(resolveLiveExitPrice({ bestBid: 0.08, minBidPrice: 0.05, maxSlippage: 0.5, tickSize: 0.01 })).toBe(0.05);
  });

  it("el redondeo a tick tampoco puede cruzar el suelo", () => {
    expect(resolveLiveExitPrice({ bestBid: 0.061, minBidPrice: 0.06, maxSlippage: 0.002, tickSize: 0.01 })).toBe(0.06);
  });

  it("sin bid conocido cae al suelo, que es el lado prudente", () => {
    expect(resolveLiveExitPrice({ bestBid: undefined, minBidPrice: 0.05, maxSlippage: 0.02, tickSize: 0.01 })).toBe(0.05);
  });
});

describe("venta simulada", () => {
  async function vender(rawBidLevels: Array<{ price: number; size: number }>, shares: number) {
    const { SimulationExecutionEngine } = await import("../src/executionEngine.js");
    const engine = new SimulationExecutionEngine({ liveMaxSlippage: 0.02 } as never);
    return engine.sell({
      market: {
        asset: "ETH",
        tickSize: "0.01",
        negRisk: false,
        outcomes: { UP: { tokenId: "up" }, DOWN: { tokenId: "down" } },
      } as never,
      outcome: "UP",
      shares,
      quote: {
        tokenId: "up",
        bestAsk: 0.7,
        bestBid: rawBidLevels[0]?.price,
        availableUsdUnderCap: 0,
        availableUsdAllLevels: 0,
        estimatedSharesForAmount: 0,
        rawAskLevels: [],
        rawBidLevels,
        availableBidUsdAllLevels: 0,
      },
      minBidPrice: 0.05,
      reason: "stop_bajo_banda",
    });
  }

  it("baja por el libro en vez de cobrarlo todo al mejor bid", async () => {
    // Un sim optimista en la salida haria creer que cerrar es gratis justo donde la realidad es peor
    // (libro fino al cierre, que es cuando esto se dispara).
    const exit = await vender(
      [
        { price: 0.68, size: 40 },
        { price: 0.66, size: 100 },
      ],
      100,
    );

    // 40*0,68 + 60*0,66 = 27,2 + 39,6 = 66,8. Al mejor bid habrian salido $68.
    expect(exit.soldShares).toBe(100);
    expect(exit.proceedsUsd).toBeCloseTo(66.8, 6);
    expect(exit.averageExitPrice).toBeCloseTo(0.668, 6);
  });

  it("se para en el precio limite: los niveles peores no cuentan", async () => {
    // Limite = 0,68 - 0,02 = 0,66. El nivel de 0,60 esta por debajo y la orden no llegaria a el.
    const exit = await vender(
      [
        { price: 0.68, size: 40 },
        { price: 0.6, size: 1_000 },
      ],
      100,
    );

    expect(exit.soldShares).toBe(40);
    expect(exit.proceedsUsd).toBeCloseTo(27.2, 6);
  });

  it("cobra comision, porque un sim gratis no predice el live", async () => {
    const exit = await vender([{ price: 0.68, size: 1_000 }], 100);

    expect(exit.feeUsd).toBeGreaterThan(0);
  });

  it("un libro sin compradores devuelve una venta vacia, no un error", async () => {
    const exit = await vender([], 100);

    expect(exit.soldShares).toBe(0);
    expect(exit.proceedsUsd).toBe(0);
    expect(exit.feeUsd).toBe(0);
  });
});

describe("cada motor etiqueta la operacion con SU modo", () => {
  it("el de simulacion marca sim aunque la config global diga live", async () => {
    const { SimulationExecutionEngine } = await import("../src/executionEngine.js");
    // Desde que cada estrategia elige su modo, los dos motores existen a la vez. Si el de simulacion
    // leyera `config.mode`, con el bot arrancado en live etiquetaria de LIVE operaciones de papel: el
    // P&L se agrupa por este campo, asi que serian ganancias o perdidas inventadas sobre dinero real.
    const engine = new SimulationExecutionEngine({
      mode: "live",
      simTradeAmountUsd: 1,
      liveTradeAmountUsd: 1,
      autoMinLive: false,
    } as never);
    const trade = await engine.execute(executionInput());
    expect(trade.mode).toBe("sim");
  });
});

function executionInput() {
  return {
    market: {
      asset: "ETH",
      slug: "eth-up-or-down",
      windowStartMs: 1_000,
      endMs: 301_000,
      orderMinSize: 5,
      tickSize: "0.01",
      outcomes: { UP: { tokenId: "up" }, DOWN: { tokenId: "down" } },
    },
    outcome: "UP",
    amountUsd: 5,
    maxAskPrice: 0.9,
    quote: { tokenId: "up", bestAsk: 0.8, bestBid: 0.79, estimatedSharesForAmount: 6.25 },
    opening: { asset: "ETH", slug: "eth-up-or-down", windowStartMs: 1_000, openingPrice: 100 },
    tick: { asset: "ETH", price: 100.5, timestampMs: 2_000 },
    distanceUsd: 0.5,
    entryWindowSeconds: 20,
  } as never;
}

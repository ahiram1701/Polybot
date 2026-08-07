import { describe, expect, it } from "vitest";

import {
  hasResolvablePosition,
  resolveTradeFromTick,
  summarizeLiveOrderFill,
} from "../src/tradeResolution.js";
import type { AnalyticsTickPoint, BtcPriceTick, TradeAttempt } from "../src/types.js";

describe("trade resolution", () => {
  it("resolves simulated trades after the market end tick", () => {
    const trade = tradeAttempt({ mode: "sim", outcome: "UP", openingPrice: 100, endMs: 2_000 });
    const resolution = resolveTradeFromTick(trade, tick({ value: 121, timestampMs: 2_001 }), 2_001);

    expect(resolution).toMatchObject({
      winningOutcome: "UP",
      won: true,
      finalPrice: 121,
    });
  });

  it("resolves filled live trades with the same Chainlink final-price rule", () => {
    const trade = tradeAttempt({
      mode: "live",
      outcome: "DOWN",
      openingPrice: 100,
      endMs: 2_000,
      fillDetected: true,
    });
    const resolution = resolveTradeFromTick(trade, tick({ value: 75, timestampMs: 2_010 }), 2_010);

    expect(resolution).toMatchObject({
      winningOutcome: "DOWN",
      won: true,
      finalPrice: 75,
    });
  });

  it("judges photo-finishes by the tick AT the close, not the first tick after it", () => {
    // Opening 100. Price closed at 99.995 (DOWN) but ticked to 100.005 one second AFTER the boundary.
    // The official resolution pays DOWN; scoring by the post-close tick flipped it.
    const trade = tradeAttempt({ mode: "sim", outcome: "DOWN", openingPrice: 100, endMs: 2_000 });
    const latestAfterClose = tick({ value: 100.005, timestampMs: 2_001 });
    const lastTickAtClose = tick({ value: 99.995, timestampMs: 1_999 });

    const resolution = resolveTradeFromTick(trade, latestAfterClose, 2_001, lastTickAtClose);

    expect(resolution).toMatchObject({
      winningOutcome: "DOWN",
      won: true,
      finalPrice: 99.995,
      finalTickTimestampMs: 1_999,
    });
  });

  it("ignores a closeTick that is actually after the boundary and falls back to latest", () => {
    const trade = tradeAttempt({ mode: "sim", outcome: "UP", openingPrice: 100, endMs: 2_000 });
    const resolution = resolveTradeFromTick(
      trade,
      tick({ value: 101, timestampMs: 2_005 }),
      2_005,
      tick({ value: 99, timestampMs: 2_002 }), // not a valid close tick (after endMs)
    );

    expect(resolution).toMatchObject({ winningOutcome: "UP", won: true, finalPrice: 101 });
  });

  it("does not resolve live orders that did not fill", () => {
    const trade = tradeAttempt({
      mode: "live",
      outcome: "UP",
      openingPrice: 100,
      endMs: 2_000,
      fillDetected: false,
    });

    expect(resolveTradeFromTick(trade, tick({ value: 125, timestampMs: 2_010 }), 2_010)).toBeUndefined();
  });

  it("extracts CLOB fill amounts from raw order response units", () => {
    expect(
      summarizeLiveOrderFill({
        status: "matched",
        makingAmount: "5000000",
        takingAmount: "5494500",
        tradeIDs: ["trade-1"],
      }),
    ).toEqual({
      fillDetected: true,
      filledAmountUsd: 5,
      filledShares: 5.4945,
    });
  });

  it("extracts CLOB fill amounts from decimal order response strings", () => {
    expect(
      summarizeLiveOrderFill({
        status: "matched",
        makingAmount: "4.999999",
        takingAmount: "5.0505",
        transactionsHashes: ["0xhash"],
      }),
    ).toMatchObject({
      fillDetected: true,
      filledAmountUsd: 4.999999,
      filledShares: 5.0505,
    });
  });

  it("infers older stored live matched orders as resolvable", () => {
    expect(hasResolvablePosition(tradeAttempt({ mode: "live", status: "matched" }))).toBe(true);
  });
});

function tradeAttempt(overrides: Partial<TradeAttempt> = {}): TradeAttempt {
  return {
    id: "trade-1",
    asset: "BTC",
    slug: "btc-updown-5m-1778143500",
    mode: "sim",
    outcome: "UP",
    tokenId: "token",
    amountUsd: 1,
    maxAskPrice: 0.98,
    bestAsk: 0.5,
    estimatedShares: 2,
    openingPrice: 100,
    entryPrice: 125,
    distanceUsd: 25,
    windowStartMs: 1_700,
    endMs: 2_000,
    createdAtMs: 1_800,
    ...overrides,
  };
}

function tick(overrides: Partial<BtcPriceTick> = {}): BtcPriceTick {
  return {
    market: overrides.market ?? "BTC",
    symbol: overrides.symbol ?? "btc/usd",
    value: overrides.value ?? 100,
    timestampMs: overrides.timestampMs ?? 2_000,
    receivedAtMs: overrides.receivedAtMs ?? 2_000,
  };
}

/**
 * Desde el 2026-08-07 Polymarket resuelve por TWAP: gana "Up" si el promedio ponderado por tiempo de
 * la ventana supera el precio de APERTURA. Comparar el ultimo precio —la regla anterior— cambia el
 * ganador en al menos el 11% de las ventanas medidas sobre el historico.
 */
describe("resolucion por TWAP", () => {
  const windowStartMs = Date.UTC(2026, 7, 7, 12, 0, 0);
  const endMs = windowStartMs + 300_000;

  function ticksDe(precios: Array<[number, number]>): AnalyticsTickPoint[] {
    return precios.map(([seg, price]) => ({
      timestampMs: windowStartMs + seg * 1000,
      secondsToEnd: 300 - seg,
      price,
      distanceUsd: 0,
    }));
  }

  const trade = {
    id: "t",
    asset: "BTC",
    slug: "btc-updown-5m-1",
    mode: "sim",
    outcome: "UP",
    tokenId: "tok",
    amountUsd: 5,
    maxAskPrice: 0.9,
    bestAsk: 0.8,
    estimatedShares: 6.25,
    fillDetected: true,
    openingPrice: 100,
    entryPrice: 100,
    distanceUsd: 0,
    windowStartMs,
    endMs,
    createdAtMs: windowStartMs + 260_000,
  } as unknown as TradeAttempt;

  const tickEn = (ms: number, value: number) =>
    ({ market: "BTC", symbol: "btc/usd", value, timestampMs: ms, receivedAtMs: ms }) as BtcPriceTick;

  it("el TWAP manda sobre el precio de cierre cuando difieren", () => {
    // Casi toda la ventana por DEBAJO de la apertura y un repunte final por encima: la regla vieja
    // diria UP, el TWAP dice DOWN. Es exactamente el caso que el cambio de Polymarket introduce.
    const ticks = ticksDe([
      [0, 100], [60, 99], [120, 99], [180, 99], [240, 99], [299, 101],
    ]);
    const r = resolveTradeFromTick(trade, tickEn(endMs + 1000, 101), endMs + 2000, tickEn(endMs - 1000, 101), ticks)!;
    expect(r.winningOutcome).toBe("DOWN");
    expect(r.twapPrice).toBeLessThan(100);
    // El precio de cierre se conserva como dato crudo aunque no sea quien juzga.
    expect(r.finalPrice).toBe(101);
  });

  it("sin cobertura suficiente cae a la regla vieja en vez de fingir un TWAP", () => {
    // Un promedio sobre medio rango no es el promedio del rango, y usarlo como si lo fuera es peor
    // que la regla vieja porque parece correcto.
    const soloElFinal = ticksDe([[280, 101], [299, 101]]);
    const r = resolveTradeFromTick(trade, tickEn(endMs + 1000, 101), endMs + 2000, tickEn(endMs - 1000, 101), soloElFinal)!;
    expect(r.twapPrice).toBeUndefined();
    expect(r.winningOutcome).toBe("UP");
  });

  it("sin ticks sigue resolviendo: dejar trades colgados seria peor", () => {
    const r = resolveTradeFromTick(trade, tickEn(endMs + 1000, 101), endMs + 2000, tickEn(endMs - 1000, 101))!;
    expect(r.winningOutcome).toBe("UP");
    expect(r.twapPrice).toBeUndefined();
  });

  it("deja auditable que regla se aplico", () => {
    const ticks = ticksDe([[0, 100], [150, 101], [299, 101]]);
    const r = resolveTradeFromTick(trade, tickEn(endMs + 1000, 101), endMs + 2000, tickEn(endMs - 1000, 101), ticks)!;
    expect(r.twapCoverage).toBeGreaterThan(0.8);
    expect(r.twapPrice).toBeDefined();
  });
});

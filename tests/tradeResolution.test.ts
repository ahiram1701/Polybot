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
 * Desde el 2026-08-07 estos mercados resuelven por la serie TWAP de Chainlink, y sus reglas son
 * explicitas: "no segun ninguna otra fuente ni mercados spot". Quien elige el precio de referencia es
 * el llamador (`botRunner` pasa el valor TWAP); aqui no se calcula ningun promedio.
 *
 * La documentacion pide expresamente no reconstruirlo — "do not independently reproduce the value
 * without a specification from Chainlink" — porque no publican los limites de muestreo ni el redondeo.
 * Yo lo reconstrui una vez y me equivoque: asumi el promedio de los 300s cuando el lookback son 30.
 */
describe("resolucion por el precio de referencia recibido", () => {
  const windowStartMs = Date.UTC(2026, 7, 7, 12, 0, 0);
  const endMs = windowStartMs + 300_000;

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

  it("gana UP cuando el precio de cierre supera la apertura", () => {
    const r = resolveTradeFromTick(trade, tickEn(endMs + 1000, 101), endMs + 2000, tickEn(endMs - 1000, 100.5))!;
    expect(r.winningOutcome).toBe("UP");
  });

  it("gana DOWN cuando queda por debajo, aunque el ultimo tick posterior suba", () => {
    // El juez es el valor AL CIERRE, no el primer tick de despues: las ventanas de foto-finish se
    // volteaban por eso.
    const r = resolveTradeFromTick(trade, tickEn(endMs + 1000, 105), endMs + 2000, tickEn(endMs - 1000, 99.5))!;
    expect(r.winningOutcome).toBe("DOWN");
    expect(r.finalPrice).toBe(99.5);
  });

  it("empate exacto cuenta como UP, igual que las reglas del mercado", () => {
    // "greater than or equal to the price at the beginning of that range".
    const r = resolveTradeFromTick(trade, tickEn(endMs + 1000, 100), endMs + 2000, tickEn(endMs - 1000, 100))!;
    expect(r.winningOutcome).toBe("UP");
  });
});

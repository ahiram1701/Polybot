import { describe, expect, it } from "vitest";

import {
  hasResolvablePosition,
  resolveTradeFromTick,
  summarizeLiveOrderFill,
} from "../src/tradeResolution.js";
import type { BtcPriceTick, TradeAttempt } from "../src/types.js";

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

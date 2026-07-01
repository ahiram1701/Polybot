import { describe, expect, it } from "vitest";

import {
  evaluateSignal,
  getWinningOutcome,
  isTickStale,
  isWithinEntryWindow,
  shouldCaptureOpeningTick,
} from "../src/signalEngine.js";
import type { BtcPriceTick, MarketInfo, OrderbookQuote, WindowOpening } from "../src/types.js";

const windowStartMs = Date.UTC(2026, 4, 7, 4, 25, 0, 0);
const endMs = windowStartMs + 300_000;

const market: MarketInfo = {
  asset: "BTC",
  slug: "btc-updown-5m-1778127900",
  title: "Bitcoin Up or Down - test",
  conditionId: "0xcondition",
  windowStartMs,
  endMs,
  eventStartTimeMs: windowStartMs,
  acceptingOrders: true,
  active: true,
  closed: false,
  tickSize: "0.01",
  negRisk: false,
  orderMinSize: 5,
  outcomes: {
    UP: { outcome: "UP", label: "Up", tokenId: "up-token" },
    DOWN: { outcome: "DOWN", label: "Down", tokenId: "down-token" },
  },
};

const opening: WindowOpening = {
  asset: "BTC",
  slug: market.slug,
  windowStartMs,
  openingPrice: 100_000,
  openingTickTimestampMs: windowStartMs + 1_000,
  capturedAtMs: windowStartMs + 1_000,
};

const freshUpTick: BtcPriceTick = {
  market: "BTC",
  symbol: "btc/usd",
  value: 100_020,
  timestampMs: endMs - 10_000,
  receivedAtMs: endMs - 10_000,
};

const quote: OrderbookQuote = {
  tokenId: "up-token",
  bestAsk: 0.92,
  bestBid: 0.91,
  availableUsdUnderCap: 100,
  estimatedSharesForAmount: 1.08,
  estimatedAveragePrice: 0.92,
  rawAskLevels: [{ price: 0.92, size: 100 }],
};

describe("signal engine", () => {
  it("selects UP at the exact $20 threshold", () => {
    expect(getWinningOutcome(100_000, 100_020, 20)).toEqual({ outcome: "UP", distanceUsd: 20 });
  });

  it("selects DOWN at the exact $20 threshold", () => {
    expect(getWinningOutcome(100_000, 99_980, 20)).toEqual({ outcome: "DOWN", distanceUsd: 20 });
  });

  it("does not signal below the BTC distance threshold", () => {
    expect(getWinningOutcome(100_000, 100_019.99, 20)).toBeNull();
  });

  it("only evaluates inside the final entry window", () => {
    expect(isWithinEntryWindow(endMs, endMs - 20_000, 20)).toBe(true);
    expect(isWithinEntryWindow(endMs, endMs - 19_000, 20)).toBe(true);
    expect(isWithinEntryWindow(endMs, endMs - 10_000, 20)).toBe(true);
    expect(isWithinEntryWindow(endMs, endMs - 500, 20)).toBe(true);
    expect(isWithinEntryWindow(endMs, endMs - 20_001, 20)).toBe(false);
    expect(isWithinEntryWindow(endMs, endMs, 20)).toBe(false);
  });

  it("captures only opening ticks near the start of the window", () => {
    expect(
      shouldCaptureOpeningTick({
        market,
        tick: { ...freshUpTick, timestampMs: windowStartMs + 2_000 },
        nowMs: windowStartMs + 2_000,
        openingCaptureGraceMs: 15_000,
      }),
    ).toBe(true);

    expect(
      shouldCaptureOpeningTick({
        market,
        tick: { ...freshUpTick, timestampMs: windowStartMs + 60_000 },
        nowMs: windowStartMs + 60_000,
        openingCaptureGraceMs: 15_000,
      }),
    ).toBe(false);

    // Step-function semantics: the last tick just BEFORE the window start (within grace) is the
    // opening price in effect at the open (matters for sparsely-updated ETH/DOGE feeds).
    expect(
      shouldCaptureOpeningTick({
        market,
        tick: { ...freshUpTick, timestampMs: windowStartMs - 5_000 },
        nowMs: windowStartMs + 2_000,
        openingCaptureGraceMs: 15_000,
      }),
    ).toBe(true);

    expect(
      shouldCaptureOpeningTick({
        market,
        tick: { ...freshUpTick, timestampMs: windowStartMs - 20_000 },
        nowMs: windowStartMs + 2_000,
        openingCaptureGraceMs: 15_000,
      }),
    ).toBe(false);
  });

  it("accepts a historical opening tick even if it is processed after the grace window", () => {
    expect(
      shouldCaptureOpeningTick({
        market,
        tick: { ...freshUpTick, timestampMs: windowStartMs + 1_000 },
        nowMs: windowStartMs + 60_000,
        openingCaptureGraceMs: 15_000,
      }),
    ).toBe(true);
  });

  it("rejects stale Chainlink ticks", () => {
    expect(isTickStale({ ...freshUpTick, timestampMs: endMs - 30_000 }, endMs - 10_000, 10_000)).toBe(true);
  });

  it("returns BUY when all trade conditions are met", () => {
    expect(
      evaluateSignal({
        market,
        opening,
        tick: freshUpTick,
        quote,
        nowMs: endMs - 10_000,
        entryWindowSeconds: 20,
        minBtcDistanceUsd: 20,
        tickStaleMs: 10_000,
        maxAskPrice: 0.98,
        alreadyTraded: false,
        amountUsd: 1,
        dailySpendUsd: 0,
        dailySpendLimitUsd: 50,
      }),
    ).toMatchObject({ action: "BUY", outcome: "UP", reason: "signal_ready" });
  });

  it("skips when opening tick is missing", () => {
    expect(
      evaluateSignal({
        market,
        tick: freshUpTick,
        quote,
        nowMs: endMs - 10_000,
        entryWindowSeconds: 20,
        minBtcDistanceUsd: 20,
        tickStaleMs: 10_000,
        maxAskPrice: 0.98,
        alreadyTraded: false,
        amountUsd: 1,
        dailySpendUsd: 0,
        dailySpendLimitUsd: 50,
      }),
    ).toMatchObject({ action: "SKIP", reason: "missing_opening_chainlink_tick" });
  });

  it("skips when best ask is above cap or daily limit would be exceeded", () => {
    const base = {
      market,
      opening,
      tick: freshUpTick,
      nowMs: endMs - 10_000,
      entryWindowSeconds: 20,
      minBtcDistanceUsd: 20,
      tickStaleMs: 10_000,
      maxAskPrice: 0.98,
      alreadyTraded: false,
    };

    expect(
      evaluateSignal({
        ...base,
        quote: { ...quote, bestAsk: 0.99 },
        amountUsd: 1,
        dailySpendUsd: 0,
        dailySpendLimitUsd: 50,
      }),
    ).toMatchObject({ action: "SKIP", reason: "best_ask_above_cap" });

    expect(
      evaluateSignal({
        ...base,
        quote,
        amountUsd: 5,
        dailySpendUsd: 48,
        dailySpendLimitUsd: 50,
      }),
    ).toMatchObject({ action: "SKIP", reason: "daily_spend_limit_reached" });
  });
});

import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";

import { AnalyticsRecorder } from "../src/analyticsRecorder.js";
import type {
  MarketInfo,
  MarketSymbol,
  OrderbookQuote,
  Outcome,
  PriceTick,
  TradeAttempt,
  WindowOpening,
} from "../src/types.js";

const temps: string[] = [];

afterEach(async () => {
  await Promise.all(temps.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("AnalyticsRecorder", () => {
  it("writes resolved market samples with ticks and quotes", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "polybot-analytics-"));
    temps.push(dataDir);
    const recorder = new AnalyticsRecorder(dataDir);
    const windowStartMs = Date.UTC(2026, 4, 8, 12, 0, 0);
    const market = marketInfo("BTC", windowStartMs);
    const opening = openingInfo(market);
    const tick = priceTick("BTC", windowStartMs + 260_000, 125);

    await recorder.observeMarket({
      market,
      opening,
      tick,
      quotes: quotes(),
      nowMs: tick.timestampMs,
    });
    await recorder.observeMarket({
      market,
      opening,
      tick: priceTick("BTC", market.endMs, 130),
      quotes: {},
      nowMs: market.endMs,
    });

    const samples = await recorder.readSamples();
    expect(samples).toHaveLength(1);
    expect(samples[0]).toMatchObject({
      market: "BTC",
      slug: market.slug,
      openingPrice: 100,
      finalPrice: 130,
      winningOutcome: "UP",
    });
    expect(samples[0].ticks).toHaveLength(1);
    expect(samples[0].quotes[0].upBestAsk).toBe(0.52);
  });

  it("keeps samples grouped by market slug", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "polybot-analytics-"));
    temps.push(dataDir);
    const recorder = new AnalyticsRecorder(dataDir);
    const btc = marketInfo("BTC", Date.UTC(2026, 4, 8, 12, 0, 0));
    const eth = marketInfo("ETH", Date.UTC(2026, 4, 8, 12, 5, 0));

    await resolveSample(recorder, btc);
    await resolveSample(recorder, eth);

    const samples = await recorder.readSamples();
    expect(samples.map((sample) => sample.slug)).toEqual([btc.slug, eth.slug]);
    expect(samples.map((sample) => sample.market)).toEqual(["BTC", "ETH"]);
  });

  it("restores active samples after a recorder restart", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "polybot-analytics-"));
    temps.push(dataDir);
    const windowStartMs = Date.UTC(2026, 4, 8, 12, 0, 0);
    const market = marketInfo("BTC", windowStartMs);
    const opening = openingInfo(market);

    await new AnalyticsRecorder(dataDir).observeMarket({
      market,
      opening,
      tick: priceTick("BTC", market.endMs - 20_000, 125),
      quotes: quotes(),
      nowMs: market.endMs - 20_000,
    });
    await new AnalyticsRecorder(dataDir).observeMarket({
      market,
      opening,
      tick: priceTick("BTC", market.endMs, 130),
      quotes: {},
      nowMs: market.endMs,
    });

    const samples = await new AnalyticsRecorder(dataDir).readSamples();
    expect(samples).toHaveLength(1);
    expect(samples[0]).toMatchObject({
      slug: market.slug,
      finalPrice: 130,
      winningOutcome: "UP",
    });
    expect(samples[0].ticks).toHaveLength(1);
    expect(samples[0].quotes[0].upBestAsk).toBe(0.52);
  });

  it("writes a fallback analytics sample from a resolved trade", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "polybot-analytics-"));
    temps.push(dataDir);
    const windowStartMs = Date.UTC(2026, 4, 8, 12, 0, 0);
    const market = marketInfo("BTC", windowStartMs);
    const trade = tradeAttempt(market, "DOWN");

    await new AnalyticsRecorder(dataDir).recordResolvedTrade(trade, {
      resolvedAtMs: market.endMs + 1_000,
      finalPrice: 88,
      finalTickTimestampMs: market.endMs,
      winningOutcome: "DOWN",
      won: true,
    });

    const samples = await new AnalyticsRecorder(dataDir).readSamples();
    expect(samples).toHaveLength(1);
    expect(samples[0]).toMatchObject({
      slug: market.slug,
      market: "BTC",
      openingPrice: 100,
      finalPrice: 88,
      winningOutcome: "DOWN",
    });
    expect(samples[0].ticks[0]).toMatchObject({
      price: 90,
      distanceUsd: -10,
    });
    expect(samples[0].quotes[0].downBestAsk).toBe(0.47);
  });
});

async function resolveSample(recorder: AnalyticsRecorder, market: MarketInfo): Promise<void> {
  const opening = openingInfo(market);
  await recorder.observeMarket({
    market,
    opening,
    tick: priceTick(market.asset, market.endMs - 30_000, 110),
    quotes: quotes(),
    nowMs: market.endMs - 30_000,
  });
  await recorder.observeMarket({
    market,
    opening,
    tick: priceTick(market.asset, market.endMs, 112),
    quotes: {},
    nowMs: market.endMs,
  });
}

function marketInfo(asset: MarketSymbol, windowStartMs: number): MarketInfo {
  const prefix = asset.toLowerCase();
  return {
    asset,
    slug: `${prefix}-updown-5m-${Math.floor(windowStartMs / 1000)}`,
    title: `${asset} Up or Down`,
    conditionId: `${asset}-condition`,
    windowStartMs,
    endMs: windowStartMs + 300_000,
    eventStartTimeMs: windowStartMs,
    acceptingOrders: true,
    active: true,
    closed: false,
    tickSize: "0.01",
    negRisk: false,
    orderMinSize: 1,
    outcomes: {
      UP: { outcome: "UP", label: "Up", tokenId: `${asset}-up` },
      DOWN: { outcome: "DOWN", label: "Down", tokenId: `${asset}-down` },
    },
  };
}

function openingInfo(market: MarketInfo): WindowOpening {
  return {
    asset: market.asset,
    slug: market.slug,
    windowStartMs: market.windowStartMs,
    openingPrice: 100,
    openingTickTimestampMs: market.windowStartMs,
    capturedAtMs: market.windowStartMs,
  };
}

function priceTick(market: MarketSymbol, timestampMs: number, value: number): PriceTick {
  return {
    market,
    symbol: market === "BTC" ? "btc/usd" : market === "ETH" ? "eth/usd" : "doge/usd",
    value,
    timestampMs,
    receivedAtMs: timestampMs,
  };
}

function quotes(): Partial<Record<Outcome, OrderbookQuote>> {
  return {
    UP: quote("up-token", 0.52),
    DOWN: quote("down-token", 0.48),
  };
}

function quote(tokenId: string, bestAsk: number): OrderbookQuote {
  return {
    tokenId,
    bestAsk,
    bestBid: bestAsk - 0.01,
    availableUsdUnderCap: 100,
    estimatedSharesForAmount: 1 / bestAsk,
    rawAskLevels: [{ price: bestAsk, size: 100 }],
  };
}

function tradeAttempt(market: MarketInfo, outcome: Outcome): TradeAttempt {
  return {
    id: `${market.slug}-trade`,
    asset: market.asset,
    slug: market.slug,
    mode: "sim",
    conditionId: market.conditionId,
    outcome,
    tokenId: market.outcomes[outcome].tokenId,
    amountUsd: 1,
    maxAskPrice: 0.98,
    bestAsk: 0.47,
    estimatedShares: 2.12,
    openingPrice: 100,
    entryPrice: outcome === "UP" ? 110 : 90,
    distanceUsd: 10,
    entryWindowSeconds: 30,
    windowStartMs: market.windowStartMs,
    endMs: market.endMs,
    createdAtMs: market.endMs - 30_000,
  };
}

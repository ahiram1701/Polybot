import { afterEach, describe, expect, it, vi } from "vitest";

import { BotRunner } from "../src/botRunner.js";
import type { ChainlinkPriceFeed } from "../src/chainlinkPriceFeed.js";
import type { ExecutionInput, TradeExecutor } from "../src/executionEngine.js";
import type { TradeReconciler } from "../src/liveTradeReconciler.js";
import type { MarketWatcher } from "../src/marketWatcher.js";
import type { OrderbookService } from "../src/orderbookService.js";
import type { StateStore } from "../src/stateStore.js";
import type { BotConfig, MarketInfo, MarketSymbol, TradeAttempt, WindowOpening } from "../src/types.js";

describe("BotRunner", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps the continuous loop alive after a transient API failure", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    let runner!: BotRunner;
    let calls = 0;
    const watcher = {
      getCurrentMarket: vi.fn(async () => {
        calls += 1;
        if (calls === 1) {
          throw new TypeError("fetch failed");
        }
        runner.stop();
        return null;
      }),
    } as unknown as MarketWatcher;
    const priceFeed = fakePriceFeed();

    runner = new BotRunner(baseConfig(), {
      watcher,
      orderbook: {} as unknown as OrderbookService,
      priceFeed,
      state: fakeState(),
      executor: {} as TradeExecutor,
      reconciler: fakeReconciler(),
    });

    await runner.start();

    expect(watcher.getCurrentMarket).toHaveBeenCalledTimes(2);
    expect(priceFeed.stop).toHaveBeenCalled();
  });

  it("still surfaces one-shot failures to callers", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const watcher = {
      getCurrentMarket: vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    } as unknown as MarketWatcher;
    const priceFeed = fakePriceFeed();
    const runner = new BotRunner(baseConfig(), {
      watcher,
      orderbook: {} as unknown as OrderbookService,
      priceFeed,
      state: fakeState(),
      executor: {} as TradeExecutor,
      reconciler: fakeReconciler(),
    });

    await expect(runner.start({ once: true })).rejects.toThrow("fetch failed");
    expect(priceFeed.stop).toHaveBeenCalledTimes(1);
  });

  it("can trade BTC, ETH, and DOGE in the same iteration", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const windowStartMs = Date.UTC(2026, 4, 7, 4, 25, 0, 0);
    const nowMs = windowStartMs + 290_000;
    const markets: Partial<Record<MarketSymbol, MarketInfo>> = {
      BTC: marketInfo("BTC", "btc", windowStartMs),
      ETH: marketInfo("ETH", "eth", windowStartMs),
      DOGE: marketInfo("DOGE", "doge", windowStartMs),
    };
    const openings = new Map(
      Object.values(markets).map((market) => [
        market.slug,
        {
          asset: market.asset,
          slug: market.slug,
          windowStartMs,
          openingPrice: market.asset === "DOGE" ? 0.1 : 100,
          openingTickTimestampMs: windowStartMs,
          capturedAtMs: windowStartMs,
        },
      ]),
    );
    const trades: TradeAttempt[] = [];
    const watcher = {
      getCurrentMarket: vi.fn(async (_nowMs: number, market: MarketSymbol = "BTC") => markets[market] ?? null),
    } as unknown as MarketWatcher;
    const priceFeed = {
      start: vi.fn(),
      stop: vi.fn(),
      getLatestTick: vi.fn((market: MarketSymbol = "BTC") => ({
        market,
        symbol: priceFeedSymbol(market),
        value: market === "DOGE" ? 0.1007 : 130,
        timestampMs: nowMs,
        receivedAtMs: nowMs,
      })),
    } as unknown as ChainlinkPriceFeed;
    const state = {
      load: vi.fn(async () => undefined),
      listTrades: vi.fn(() => []),
      getOpening: vi.fn((slug: string) => openings.get(slug)),
      hasTraded: vi.fn(() => false),
      getDailySpend: vi.fn(() => 0),
      recordTradeAttempt: vi.fn(async (trade: TradeAttempt) => {
        trades.push(trade);
      }),
    } as unknown as StateStore;
    const executor = {
      execute: vi.fn(async (input: ExecutionInput) => ({
        id: `${input.market.slug}-${input.outcome}`,
        asset: input.market.asset,
        slug: input.market.slug,
        mode: "sim" as const,
        conditionId: input.market.conditionId,
        outcome: input.outcome,
        tokenId: input.market.outcomes[input.outcome].tokenId,
        amountUsd: input.amountUsd,
        maxAskPrice: 0.98,
        bestAsk: input.quote.bestAsk,
        estimatedShares: input.quote.estimatedSharesForAmount,
        openingPrice: input.opening.openingPrice,
        entryPrice: input.tick.value,
        distanceUsd: input.distanceUsd,
        entryWindowSeconds: input.entryWindowSeconds,
        windowStartMs: input.market.windowStartMs,
        endMs: input.market.endMs,
        createdAtMs: nowMs,
      })),
    } satisfies TradeExecutor;

    const runner = new BotRunner(
      {
        ...baseConfig(),
        enabledMarkets: ["BTC", "ETH", "DOGE"],
        minDistanceUsdByMarket: { BTC: 20, ETH: 5, DOGE: 0.0005 },
      },
      {
        watcher,
        orderbook: fakeOrderbook(),
        priceFeed,
        state,
        executor,
        reconciler: fakeReconciler(),
      },
    );

    await runner.runOnce(nowMs);

    expect(executor.execute).toHaveBeenCalledTimes(3);
    expect(trades.map((trade) => trade.asset)).toEqual(["BTC", "ETH", "DOGE"]);
  });

  it("uses the configured entry window for each market", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const windowStartMs = Date.UTC(2026, 4, 7, 4, 25, 0, 0);
    const nowMs = windowStartMs + 270_000;
    const markets: Partial<Record<MarketSymbol, MarketInfo>> = {
      BTC: marketInfo("BTC", "btc", windowStartMs),
      ETH: marketInfo("ETH", "eth", windowStartMs),
    };
    const openings = new Map(
      Object.values(markets).map((market) => [
        market.slug,
        {
          asset: market.asset,
          slug: market.slug,
          windowStartMs,
          openingPrice: 100,
          openingTickTimestampMs: windowStartMs,
          capturedAtMs: windowStartMs,
        },
      ]),
    );
    const watcher = {
      getCurrentMarket: vi.fn(async (_nowMs: number, market: MarketSymbol = "BTC") => markets[market] ?? null),
    } as unknown as MarketWatcher;
    const priceFeed = {
      start: vi.fn(),
      stop: vi.fn(),
      getLatestTick: vi.fn((market: MarketSymbol = "BTC") => ({
        market,
        symbol: priceFeedSymbol(market),
        value: 130,
        timestampMs: nowMs,
        receivedAtMs: nowMs,
      })),
    } as unknown as ChainlinkPriceFeed;
    const state = {
      load: vi.fn(async () => undefined),
      listTrades: vi.fn(() => []),
      getOpening: vi.fn((slug: string) => openings.get(slug)),
      hasTraded: vi.fn(() => false),
      getDailySpend: vi.fn(() => 0),
      recordTradeAttempt: vi.fn(async () => undefined),
    } as unknown as StateStore;
    const executor = {
      execute: vi.fn(async (input: ExecutionInput) => ({
        id: `${input.market.slug}-${input.outcome}`,
        asset: input.market.asset,
        slug: input.market.slug,
        mode: "sim" as const,
        conditionId: input.market.conditionId,
        outcome: input.outcome,
        tokenId: input.market.outcomes[input.outcome].tokenId,
        amountUsd: input.amountUsd,
        maxAskPrice: 0.98,
        bestAsk: input.quote.bestAsk,
        estimatedShares: input.quote.estimatedSharesForAmount,
        openingPrice: input.opening.openingPrice,
        entryPrice: input.tick.value,
        distanceUsd: input.distanceUsd,
        entryWindowSeconds: input.entryWindowSeconds,
        windowStartMs: input.market.windowStartMs,
        endMs: input.market.endMs,
        createdAtMs: nowMs,
      })),
    } satisfies TradeExecutor;

    const runner = new BotRunner(
      {
        ...baseConfig(),
        enabledMarkets: ["BTC", "ETH"],
        entryWindowSecondsByMarket: { BTC: 20, ETH: 35, DOGE: 20 },
      },
      {
        watcher,
        orderbook: fakeOrderbook(),
        priceFeed,
        state,
        executor,
        reconciler: fakeReconciler(),
      },
    );

    await runner.runOnce(nowMs);

    expect(executor.execute).toHaveBeenCalledTimes(1);
    expect(executor.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        market: expect.objectContaining({ asset: "ETH" }),
        entryWindowSeconds: 35,
      }),
    );
  });

  it("uses updated strategy settings on the next iteration", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const windowStartMs = Date.UTC(2026, 4, 7, 4, 25, 0, 0);
    const nowMs = windowStartMs + 270_000;
    const market = marketInfo("BTC", "btc", windowStartMs);
    const openings = new Map([
      [
        market.slug,
        {
          asset: market.asset,
          slug: market.slug,
          windowStartMs,
          openingPrice: 100,
          openingTickTimestampMs: windowStartMs,
          capturedAtMs: windowStartMs,
        },
      ],
    ]);
    const watcher = {
      getCurrentMarket: vi.fn(async () => market),
    } as unknown as MarketWatcher;
    const priceFeed = {
      start: vi.fn(),
      stop: vi.fn(),
      getLatestTick: vi.fn(() => ({
        market: "BTC",
        symbol: "btc/usd",
        value: 115,
        timestampMs: nowMs,
        receivedAtMs: nowMs,
      })),
    } as unknown as ChainlinkPriceFeed;
    const state = {
      load: vi.fn(async () => undefined),
      listTrades: vi.fn(() => []),
      getOpening: vi.fn((slug: string) => openings.get(slug)),
      hasTraded: vi.fn(() => false),
      getDailySpend: vi.fn(() => 0),
      recordTradeAttempt: vi.fn(async () => undefined),
    } as unknown as StateStore;
    const executor = {
      execute: vi.fn(async (input: ExecutionInput) => ({
        id: `${input.market.slug}-${input.outcome}`,
        asset: input.market.asset,
        slug: input.market.slug,
        mode: "sim" as const,
        conditionId: input.market.conditionId,
        outcome: input.outcome,
        tokenId: input.market.outcomes[input.outcome].tokenId,
        amountUsd: input.amountUsd,
        maxAskPrice: 0.98,
        bestAsk: input.quote.bestAsk,
        estimatedShares: input.quote.estimatedSharesForAmount,
        openingPrice: input.opening.openingPrice,
        entryPrice: input.tick.value,
        distanceUsd: input.distanceUsd,
        entryWindowSeconds: input.entryWindowSeconds,
        windowStartMs: input.market.windowStartMs,
        endMs: input.market.endMs,
        createdAtMs: nowMs,
      })),
    } satisfies TradeExecutor;

    const runner = new BotRunner(baseConfig(), {
      watcher,
      orderbook: fakeOrderbook(),
      priceFeed,
      state,
      executor,
      reconciler: fakeReconciler(),
    });

    await runner.runOnce(nowMs);
    expect(executor.execute).not.toHaveBeenCalled();

    runner.updateStrategySettings({
      minDistanceUsdByMarket: { BTC: 10, ETH: 5, DOGE: 0.0005 },
      entryWindowSeconds: 35,
      entryWindowSecondsByMarket: { BTC: 35, ETH: 20, DOGE: 20 },
    });
    await runner.runOnce(nowMs);

    expect(executor.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        distanceUsd: 15,
        entryWindowSeconds: 35,
      }),
    );
  });

  it("keeps trying other markets when one execution fails", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const windowStartMs = Date.UTC(2026, 4, 7, 4, 25, 0, 0);
    const nowMs = windowStartMs + 290_000;
    const markets: Partial<Record<MarketSymbol, MarketInfo>> = {
      BTC: marketInfo("BTC", "btc", windowStartMs),
      DOGE: marketInfo("DOGE", "doge", windowStartMs),
    };
    const openings = new Map(
      Object.values(markets).map((market) => [
        market.slug,
        {
          asset: market.asset,
          slug: market.slug,
          windowStartMs,
          openingPrice: market.asset === "DOGE" ? 0.1 : 100,
          openingTickTimestampMs: windowStartMs,
          capturedAtMs: windowStartMs,
        },
      ]),
    );
    const trades: TradeAttempt[] = [];
    const watcher = {
      getCurrentMarket: vi.fn(async (_nowMs: number, market: MarketSymbol = "BTC") => markets[market] ?? null),
    } as unknown as MarketWatcher;
    const priceFeed = {
      start: vi.fn(),
      stop: vi.fn(),
      getLatestTick: vi.fn((market: MarketSymbol = "BTC") => ({
        market,
        symbol: priceFeedSymbol(market),
        value: market === "DOGE" ? 0.1007 : 130,
        timestampMs: nowMs,
        receivedAtMs: nowMs,
      })),
    } as unknown as ChainlinkPriceFeed;
    const state = {
      load: vi.fn(async () => undefined),
      listTrades: vi.fn(() => []),
      getOpening: vi.fn((slug: string) => openings.get(slug)),
      hasTraded: vi.fn(() => false),
      getDailySpend: vi.fn(() => 0),
      recordTradeAttempt: vi.fn(async (trade: TradeAttempt) => {
        trades.push(trade);
      }),
    } as unknown as StateStore;
    const executor = {
      execute: vi.fn(async (input: ExecutionInput) => {
        if (input.market.asset === "BTC") {
          throw new Error("CLOB rejected BTC");
        }
        return {
          id: `${input.market.slug}-${input.outcome}`,
          asset: input.market.asset,
          slug: input.market.slug,
          mode: "sim" as const,
          conditionId: input.market.conditionId,
          outcome: input.outcome,
          tokenId: input.market.outcomes[input.outcome].tokenId,
          amountUsd: input.amountUsd,
          maxAskPrice: 0.98,
          bestAsk: input.quote.bestAsk,
          estimatedShares: input.quote.estimatedSharesForAmount,
          openingPrice: input.opening.openingPrice,
          entryPrice: input.tick.value,
          distanceUsd: input.distanceUsd,
          entryWindowSeconds: input.entryWindowSeconds,
          windowStartMs: input.market.windowStartMs,
          endMs: input.market.endMs,
          createdAtMs: nowMs,
        };
      }),
    } satisfies TradeExecutor;

    const runner = new BotRunner(
      {
        ...baseConfig(),
        enabledMarkets: ["BTC", "DOGE"],
        minDistanceUsdByMarket: { BTC: 20, ETH: 5, DOGE: 0.0005 },
      },
      {
        watcher,
        orderbook: fakeOrderbook(),
        priceFeed,
        state,
        executor,
        reconciler: fakeReconciler(),
      },
    );

    await runner.runOnce(nowMs);

    expect(executor.execute).toHaveBeenCalledTimes(2);
    expect(trades.map((trade) => trade.asset)).toEqual(["DOGE"]);
  });

  it("uses historical feed ticks to capture an opening processed after the grace window", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const windowStartMs = Date.UTC(2026, 4, 7, 4, 25, 0, 0);
    const nowMs = windowStartMs + 290_000;
    const market = marketInfo("ETH", "eth", windowStartMs);
    const openings = new Map<string, WindowOpening>();
    const watcher = {
      getCurrentMarket: vi.fn(async () => market),
    } as unknown as MarketWatcher;
    const priceFeed = {
      start: vi.fn(),
      stop: vi.fn(),
      getLatestTick: vi.fn(() => ({
        market: "ETH",
        symbol: "eth/usd",
        value: 2297,
        timestampMs: nowMs,
        receivedAtMs: nowMs,
      })),
      getTickInRange: vi.fn(() => ({
        market: "ETH",
        symbol: "eth/usd",
        value: 2290,
        timestampMs: windowStartMs + 1_000,
        receivedAtMs: nowMs,
      })),
    } as unknown as ChainlinkPriceFeed;
    const state = {
      load: vi.fn(async () => undefined),
      listTrades: vi.fn(() => []),
      getOpening: vi.fn((slug: string) => openings.get(slug)),
      saveOpening: vi.fn(async (opening: WindowOpening) => {
        openings.set(opening.slug, opening);
      }),
      hasTraded: vi.fn(() => false),
      getDailySpend: vi.fn(() => 0),
      recordTradeAttempt: vi.fn(async () => undefined),
    } as unknown as StateStore;
    const executor = {
      execute: vi.fn(async (input: ExecutionInput) => ({
        id: `${input.market.slug}-${input.outcome}`,
        asset: input.market.asset,
        slug: input.market.slug,
        mode: "sim" as const,
        conditionId: input.market.conditionId,
        outcome: input.outcome,
        tokenId: input.market.outcomes[input.outcome].tokenId,
        amountUsd: input.amountUsd,
        maxAskPrice: 0.98,
        bestAsk: input.quote.bestAsk,
        estimatedShares: input.quote.estimatedSharesForAmount,
        openingPrice: input.opening.openingPrice,
        entryPrice: input.tick.value,
        distanceUsd: input.distanceUsd,
        entryWindowSeconds: input.entryWindowSeconds,
        windowStartMs: input.market.windowStartMs,
        endMs: input.market.endMs,
        createdAtMs: nowMs,
      })),
    } satisfies TradeExecutor;

    const runner = new BotRunner(
      {
        ...baseConfig(),
        enabledMarkets: ["ETH"],
        minDistanceUsdByMarket: { BTC: 20, ETH: 5, DOGE: 0.0005 },
      },
      {
        watcher,
        orderbook: fakeOrderbook(),
        priceFeed,
        state,
        executor,
        reconciler: fakeReconciler(),
      },
    );

    await runner.runOnce(nowMs);

    expect(state.saveOpening).toHaveBeenCalledWith(
      expect.objectContaining({
        asset: "ETH",
        openingPrice: 2290,
        openingTickTimestampMs: windowStartMs + 1_000,
      }),
    );
    expect(executor.execute).toHaveBeenCalledWith(expect.objectContaining({ opening: expect.objectContaining({ openingPrice: 2290 }) }));
  });
});

function baseConfig(): BotConfig {
  return {
    mode: "sim",
    confirmLive: false,
    minBtcDistanceUsd: 20,
    enabledMarkets: ["BTC"],
    minDistanceUsdByMarket: { BTC: 20, ETH: 5, DOGE: 0.0005 },
    entryWindowSeconds: 20,
    entryWindowSecondsByMarket: { BTC: 20, ETH: 20, DOGE: 20 },
    simTradeAmountUsd: 1,
    liveTradeAmountUsd: 1,
    autoMinLive: true,
    maxAskPrice: 0.98,
    dailySpendLimitUsd: 50,
    tickStaleMs: 10_000,
    pollIntervalMs: 1,
    openingCaptureGraceMs: 15_000,
    dataDir: "data",
    gammaHost: "https://gamma-api.polymarket.com",
    clobHost: "https://clob.polymarket.com",
    rtdsUrl: "wss://ws-live-data.polymarket.com",
    polygonRpcUrl: "https://polygon-rpc.com",
    signatureType: 0,
  };
}

function fakePriceFeed(): ChainlinkPriceFeed {
  return {
    start: vi.fn(),
    stop: vi.fn(),
    getLatestTick: vi.fn(() => undefined),
  } as unknown as ChainlinkPriceFeed;
}

function fakeState(): StateStore {
  return {
    load: vi.fn(async () => undefined),
    listTrades: vi.fn(() => []),
  } as unknown as StateStore;
}

function fakeReconciler(): TradeReconciler {
  return {
    reconcile: vi.fn(async () => undefined),
  };
}

function fakeOrderbook(): OrderbookService {
  return {
    getQuote: vi.fn(async () => ({
      tokenId: "token",
      bestAsk: 0.5,
      bestBid: 0.49,
      availableUsdUnderCap: 100,
      estimatedSharesForAmount: 2,
      rawAskLevels: [],
    })),
  } as unknown as OrderbookService;
}

function marketInfo(asset: MarketSymbol, slugPrefix: string, windowStartMs: number): MarketInfo {
  return {
    asset,
    slug: `${slugPrefix}-updown-5m-${Math.floor(windowStartMs / 1000)}`,
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

function priceFeedSymbol(market: MarketSymbol) {
  if (market === "ETH") {
    return "eth/usd";
  }
  if (market === "DOGE") {
    return "doge/usd";
  }
  return "btc/usd";
}

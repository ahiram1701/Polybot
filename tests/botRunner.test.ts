import { afterEach, describe, expect, it, vi } from "vitest";

import type { AnalyticsRecorder } from "../src/analyticsRecorder.js";
import { BotRunner } from "../src/botRunner.js";
import type { ChainlinkPriceFeed } from "../src/chainlinkPriceFeed.js";
import type { ExecutionInput, TradeExecutor } from "../src/executionEngine.js";
import type { TradeReconciler } from "../src/liveTradeReconciler.js";
import type { MarketWatcher } from "../src/marketWatcher.js";
import type { OrderbookService } from "../src/orderbookService.js";
import type { StateStore } from "../src/stateStore.js";
import type {
  BotConfig,
  MarketInfo,
  MarketSymbol,
  StrategyAnalysisResponse,
  StrategyCandidate,
  TradeAttempt,
  WindowOpening,
} from "../src/types.js";

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

    expect(watcher.getCurrentMarket).toHaveBeenCalledTimes(4);
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

  it("does not stop a borrowed (shared) price feed", () => {
    const priceFeed = fakePriceFeed();
    const runner = BotRunner.create(baseConfig(), { priceFeed });

    runner.stop();

    expect(priceFeed.stop).not.toHaveBeenCalled();
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

  it("records analytics for all supported markets even when trading is disabled", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const windowStartMs = Date.UTC(2026, 4, 7, 4, 25, 0, 0);
    const nowMs = windowStartMs + 290_000;
    const markets: Record<MarketSymbol, MarketInfo> = {
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
    const watcher = {
      getCurrentMarkets: vi.fn(async (requestedMarkets: MarketSymbol[]) =>
        requestedMarkets.map((market) => markets[market]),
      ),
      getCurrentMarket: vi.fn(async () => null),
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
      recordTradeAttempt: vi.fn(async () => undefined),
    } as unknown as StateStore;
    const executor = {
      execute: vi.fn(async () => {
        throw new Error("should not execute");
      }),
    } satisfies TradeExecutor;
    const analyticsRecorder = {
      observeMarket: vi.fn(async () => undefined),
      recordResolvedTrade: vi.fn(async () => undefined),
    } as unknown as AnalyticsRecorder;

    const runner = new BotRunner(
      {
        ...baseConfig(),
        enabledMarkets: [],
        enabledMarketOutcomes: {
          BTC: { UP: false, DOWN: false },
          ETH: { UP: false, DOWN: false },
          DOGE: { UP: false, DOWN: false },
        },
      },
      {
        watcher,
        orderbook: fakeOrderbook(),
        priceFeed,
        state,
        executor,
        reconciler: fakeReconciler(),
        analyticsRecorder,
      },
    );

    await runner.runOnce(nowMs);

    expect(watcher.getCurrentMarkets).toHaveBeenCalledWith(["BTC", "ETH", "DOGE"], nowMs);
    expect(analyticsRecorder.observeMarket).toHaveBeenCalledTimes(3);
    expect(executor.execute).not.toHaveBeenCalled();
  });

  it("halts trading when the risk circuit breaker trips, but keeps recording analytics", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const windowStartMs = Date.UTC(2026, 4, 7, 4, 25, 0, 0);
    const nowMs = windowStartMs + 290_000;
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
    const losingTrade: TradeAttempt = {
      id: "loss-1",
      slug: "btc-updown-5m-prev",
      mode: "sim",
      outcome: "UP",
      tokenId: "token",
      amountUsd: 10,
      maxAskPrice: 0.98,
      bestAsk: 0.5,
      estimatedShares: 20,
      openingPrice: 100,
      entryPrice: 90,
      distanceUsd: -10,
      entryWindowSeconds: 30,
      windowStartMs: 1,
      endMs: 2,
      createdAtMs: nowMs - 60_000,
      resolved: {
        resolvedAtMs: nowMs,
        finalPrice: 90,
        finalTickTimestampMs: nowMs,
        winningOutcome: "DOWN",
        won: false,
      },
    };
    const state = {
      load: vi.fn(async () => undefined),
      listTrades: vi.fn(() => [losingTrade]),
      getOpening: vi.fn((slug: string) => openings.get(slug)),
      hasTraded: vi.fn(() => false),
      getDailySpend: vi.fn(() => 0),
      recordTradeAttempt: vi.fn(async () => undefined),
    } as unknown as StateStore;
    const executor = {
      execute: vi.fn(async () => {
        throw new Error("should not execute while halted");
      }),
    } satisfies TradeExecutor;
    const analyticsRecorder = {
      observeMarket: vi.fn(async () => undefined),
      recordResolvedTrade: vi.fn(async () => undefined),
    } as unknown as AnalyticsRecorder;

    const runner = new BotRunner(
      {
        ...baseConfig(),
        mode: "sim",
        requirePositiveEv: false,
        maxConsecutiveLosses: 1,
      },
      {
        watcher: { getCurrentMarket: vi.fn(async () => market) } as unknown as MarketWatcher,
        orderbook: fakeOrderbook(),
        priceFeed: livePriceFeed("BTC", 130, nowMs),
        state,
        executor,
        reconciler: fakeReconciler(),
        analyticsRecorder,
      },
    );

    await runner.runOnce(nowMs);

    expect(executor.execute).not.toHaveBeenCalled();
    expect(analyticsRecorder.observeMarket).toHaveBeenCalled();
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

  it("uses side-specific window, distance, amount, and ask cap", async () => {
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
        value: 85,
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
    const orderbook = {
      getQuote: vi.fn(async () => ({
        tokenId: "token",
        bestAsk: 0.7,
        bestBid: 0.69,
        availableUsdUnderCap: 100,
        estimatedSharesForAmount: 10,
        rawAskLevels: [],
      })),
    } as unknown as OrderbookService;
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
        maxAskPrice: input.maxAskPrice,
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
        minDistanceUsdByMarketOutcome: {
          BTC: { UP: 10, DOWN: 12 },
          ETH: { UP: 5, DOWN: 5 },
          DOGE: { UP: 0.0005, DOWN: 0.0005 },
        },
        entryWindowSecondsByMarketOutcome: {
          BTC: { UP: 20, DOWN: 35 },
          ETH: { UP: 20, DOWN: 20 },
          DOGE: { UP: 20, DOWN: 20 },
        },
        simTradeAmountUsdByMarketOutcome: {
          BTC: { UP: 1, DOWN: 7 },
          ETH: { UP: 1, DOWN: 1 },
          DOGE: { UP: 1, DOWN: 1 },
        },
        maxAskPriceByMarketOutcome: {
          BTC: { UP: 0.98, DOWN: 0.72 },
          ETH: { UP: 0.98, DOWN: 0.98 },
          DOGE: { UP: 0.98, DOWN: 0.98 },
        },
      },
      {
        watcher,
        orderbook,
        priceFeed,
        state,
        executor,
        reconciler: fakeReconciler(),
      },
    );

    await runner.runOnce(nowMs);

    expect(orderbook.getQuote).toHaveBeenCalledWith("BTC-down", 7, 0.72);
    expect(executor.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "DOWN",
        amountUsd: 7,
        maxAskPrice: 0.72,
        distanceUsd: 15,
        entryWindowSeconds: 35,
      }),
    );
  });

  it("clamps the ask cap to maxAskPriceCeiling for both quoting and trading", async () => {
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
    const watcher = { getCurrentMarket: vi.fn(async () => market) } as unknown as MarketWatcher;
    const priceFeed = {
      start: vi.fn(),
      stop: vi.fn(),
      getLatestTick: vi.fn(() => ({ market: "BTC", symbol: "btc/usd", value: 85, timestampMs: nowMs, receivedAtMs: nowMs })),
    } as unknown as ChainlinkPriceFeed;
    const state = {
      load: vi.fn(async () => undefined),
      listTrades: vi.fn(() => []),
      getOpening: vi.fn((slug: string) => openings.get(slug)),
      hasTraded: vi.fn(() => false),
      getDailySpend: vi.fn(() => 0),
      recordTradeAttempt: vi.fn(async () => undefined),
    } as unknown as StateStore;
    // Quote sits above the 0.80 ceiling but below the configured 0.95 cap.
    const orderbook = {
      getQuote: vi.fn(async () => ({
        tokenId: "token",
        bestAsk: 0.85,
        bestBid: 0.84,
        availableUsdUnderCap: 100,
        estimatedSharesForAmount: 10,
        rawAskLevels: [],
      })),
    } as unknown as OrderbookService;
    const executor = { execute: vi.fn() } as unknown as TradeExecutor;

    const runner = new BotRunner(
      {
        ...baseConfig(),
        maxAskPriceCeiling: 0.8,
        minDistanceUsdByMarketOutcome: { BTC: { UP: 10, DOWN: 12 }, ETH: { UP: 5, DOWN: 5 }, DOGE: { UP: 0.0005, DOWN: 0.0005 } },
        entryWindowSecondsByMarketOutcome: { BTC: { UP: 35, DOWN: 35 }, ETH: { UP: 20, DOWN: 20 }, DOGE: { UP: 20, DOWN: 20 } },
        maxAskPriceByMarketOutcome: { BTC: { UP: 0.95, DOWN: 0.95 }, ETH: { UP: 0.95, DOWN: 0.95 }, DOGE: { UP: 0.95, DOWN: 0.95 } },
      },
      { watcher, orderbook, priceFeed, state, executor, reconciler: fakeReconciler() },
    );

    await runner.runOnce(nowMs);

    // The quote is requested at the clamped ceiling (0.80), not the configured 0.95...
    expect(orderbook.getQuote).toHaveBeenCalledWith(expect.any(String), expect.any(Number), 0.8);
    // ...and since bestAsk (0.85) exceeds the effective cap, no trade is executed.
    expect(executor.execute).not.toHaveBeenCalled();
  });

  it("skips a signal when that market side is disabled", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const windowStartMs = Date.UTC(2026, 4, 7, 4, 25, 0, 0);
    const nowMs = windowStartMs + 290_000;
    const market = marketInfo("BTC", "btc", windowStartMs);
    const watcher = {
      getCurrentMarket: vi.fn(async () => market),
    } as unknown as MarketWatcher;
    const priceFeed = {
      start: vi.fn(),
      stop: vi.fn(),
      getLatestTick: vi.fn(() => ({
        market: "BTC",
        symbol: "btc/usd",
        value: 80,
        timestampMs: nowMs,
        receivedAtMs: nowMs,
      })),
    } as unknown as ChainlinkPriceFeed;
    const state = {
      load: vi.fn(async () => undefined),
      listTrades: vi.fn(() => []),
      getOpening: vi.fn(() => ({
        asset: "BTC",
        slug: market.slug,
        windowStartMs,
        openingPrice: 100,
        openingTickTimestampMs: windowStartMs,
        capturedAtMs: windowStartMs,
      })),
      hasTraded: vi.fn(() => false),
      getDailySpend: vi.fn(() => 0),
      recordTradeAttempt: vi.fn(async () => undefined),
    } as unknown as StateStore;
    const executor = {
      execute: vi.fn(async () => {
        throw new Error("should not execute");
      }),
    } satisfies TradeExecutor;

    const runner = new BotRunner(
      {
        ...baseConfig(),
        enabledMarkets: ["BTC"],
        enabledMarketOutcomes: {
          BTC: { UP: true, DOWN: false },
          ETH: { UP: false, DOWN: false },
          DOGE: { UP: false, DOWN: false },
        },
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

    expect(executor.execute).not.toHaveBeenCalled();
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

  it("blocks live trades that fail the conservative EV gate", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const windowStartMs = Date.UTC(2026, 4, 7, 4, 25, 0, 0);
    const nowMs = windowStartMs + 290_000;
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
    const state = {
      load: vi.fn(async () => undefined),
      listTrades: vi.fn(() => []),
      getOpening: vi.fn((slug: string) => openings.get(slug)),
      hasTraded: vi.fn(() => false),
      getDailySpend: vi.fn(() => 0),
      recordTradeAttempt: vi.fn(async () => undefined),
    } as unknown as StateStore;
    const executor = {
      execute: vi.fn(async () => {
        throw new Error("should not execute");
      }),
    } satisfies TradeExecutor;
    const strategyAnalysisEngine = {
      analyze: vi.fn(async () =>
        strategyAnalysisResponse(bestStrategy("BTC", "UP", 20, 20, 0.98, {
          tradeCount: 20,
          winCount: 15,
          lossCount: 5,
        })),
      ),
      estimateSetupWinRate: vi.fn(
        async () => bestStrategy("BTC", "UP", 20, 20, 0.98, { tradeCount: 20, winCount: 15, lossCount: 5 }).metrics,
      ),
    };

    const runner = new BotRunner(
      {
        ...baseConfig(),
        mode: "live",
        requirePositiveEv: true,
      },
      {
        watcher: { getCurrentMarket: vi.fn(async () => market) } as unknown as MarketWatcher,
        orderbook: fakeOrderbook(0.9),
        priceFeed: livePriceFeed("BTC", 130, nowMs),
        state,
        executor,
        reconciler: fakeReconciler(),
        strategyAnalysisEngine,
      },
    );

    await runner.runOnce(nowMs);

    expect(strategyAnalysisEngine.estimateSetupWinRate).toHaveBeenCalled();
    expect(executor.execute).not.toHaveBeenCalled();
    expect(state.recordTradeAttempt).not.toHaveBeenCalled();
  });

  it("executes live trades when adjusted probability and EV clear the gate", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const windowStartMs = Date.UTC(2026, 4, 7, 4, 25, 0, 0);
    const nowMs = windowStartMs + 290_000;
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
        mode: "live" as const,
        conditionId: input.market.conditionId,
        outcome: input.outcome,
        tokenId: input.market.outcomes[input.outcome].tokenId,
        amountUsd: input.amountUsd,
        maxAskPrice: input.maxAskPrice,
        bestAsk: input.quote.bestAsk,
        expectedValue: input.expectedValue,
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
    const strategyAnalysisEngine = {
      analyze: vi.fn(async () =>
        strategyAnalysisResponse(bestStrategy("BTC", "UP", 20, 20, 0.98, {
          tradeCount: 20,
          winCount: 18,
          lossCount: 2,
        })),
      ),
      estimateSetupWinRate: vi.fn(
        async () => bestStrategy("BTC", "UP", 20, 20, 0.98, { tradeCount: 20, winCount: 18, lossCount: 2 }).metrics,
      ),
    };

    const runner = new BotRunner(
      {
        ...baseConfig(),
        mode: "live",
        requirePositiveEv: true,
      },
      {
        watcher: { getCurrentMarket: vi.fn(async () => market) } as unknown as MarketWatcher,
        orderbook: fakeOrderbook(0.7),
        priceFeed: livePriceFeed("BTC", 130, nowMs),
        state,
        executor,
        reconciler: fakeReconciler(),
        strategyAnalysisEngine,
      },
    );

    await runner.runOnce(nowMs);

    expect(executor.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedValue: expect.objectContaining({
          askPrice: 0.7,
          // Prior anchored to the market (ask 0.7): (18 + 2*0.7) / (20 + 2).
          adjustedWinProbability: 19.4 / 22,
          passesRecommendedEntry: true,
        }),
      }),
    );
    expect(state.recordTradeAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedValue: expect.objectContaining({ passesRecommendedEntry: true }),
      }),
    );
  });

  it("does not block simulation trades with the conservative live gate", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const windowStartMs = Date.UTC(2026, 4, 7, 4, 25, 0, 0);
    const nowMs = windowStartMs + 290_000;
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
        maxAskPrice: input.maxAskPrice,
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
      baseConfig(),
      {
        watcher: { getCurrentMarket: vi.fn(async () => market) } as unknown as MarketWatcher,
        orderbook: fakeOrderbook(0.9),
        priceFeed: livePriceFeed("BTC", 130, nowMs),
        state,
        executor,
        reconciler: fakeReconciler(),
      },
    );

    await runner.runOnce(nowMs);

    expect(executor.execute).toHaveBeenCalled();
    expect(state.recordTradeAttempt).toHaveBeenCalled();
  });

  it("blocks simulation trades that fail the EV gate when requirePositiveEv is on", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const windowStartMs = Date.UTC(2026, 4, 7, 4, 25, 0, 0);
    const nowMs = windowStartMs + 290_000;
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
    const state = {
      load: vi.fn(async () => undefined),
      listTrades: vi.fn(() => []),
      getOpening: vi.fn((slug: string) => openings.get(slug)),
      hasTraded: vi.fn(() => false),
      getDailySpend: vi.fn(() => 0),
      recordTradeAttempt: vi.fn(async () => undefined),
    } as unknown as StateStore;
    const executor = {
      execute: vi.fn(async () => {
        throw new Error("should not execute");
      }),
    } satisfies TradeExecutor;
    const strategyAnalysisEngine = {
      analyze: vi.fn(async () =>
        strategyAnalysisResponse(bestStrategy("BTC", "UP", 20, 20, 0.98, {
          tradeCount: 20,
          winCount: 15,
          lossCount: 5,
        })),
      ),
      estimateSetupWinRate: vi.fn(
        async () => bestStrategy("BTC", "UP", 20, 20, 0.98, { tradeCount: 20, winCount: 15, lossCount: 5 }).metrics,
      ),
    };

    const runner = new BotRunner(
      {
        ...baseConfig(),
        mode: "sim",
        requirePositiveEv: true,
      },
      {
        watcher: { getCurrentMarket: vi.fn(async () => market) } as unknown as MarketWatcher,
        orderbook: fakeOrderbook(0.9),
        priceFeed: livePriceFeed("BTC", 130, nowMs),
        state,
        executor,
        reconciler: fakeReconciler(),
        strategyAnalysisEngine,
      },
    );

    await runner.runOnce(nowMs);

    expect(strategyAnalysisEngine.estimateSetupWinRate).toHaveBeenCalled();
    expect(executor.execute).not.toHaveBeenCalled();
    expect(state.recordTradeAttempt).not.toHaveBeenCalled();
  });

  it("does not trade when the price move is below the distance floor", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const windowStartMs = Date.UTC(2026, 4, 7, 4, 25, 0, 0);
    const nowMs = windowStartMs + 290_000;
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
    const state = {
      load: vi.fn(async () => undefined),
      listTrades: vi.fn(() => []),
      getOpening: vi.fn((slug: string) => openings.get(slug)),
      hasTraded: vi.fn(() => false),
      getDailySpend: vi.fn(() => 0),
      recordTradeAttempt: vi.fn(async () => undefined),
    } as unknown as StateStore;
    const executor = {
      execute: vi.fn(async () => {
        throw new Error("should not execute");
      }),
    } satisfies TradeExecutor;

    const runner = new BotRunner(
      {
        ...baseConfig(),
        mode: "sim",
        requirePositiveEv: false,
        minDistanceUsdByMarket: { BTC: 8, ETH: 5, DOGE: 0.0005 },
        minDistanceUsdByMarketOutcome: {
          BTC: { UP: 8, DOWN: 8 },
          ETH: { UP: 5, DOWN: 5 },
          DOGE: { UP: 0.0005, DOWN: 0.0005 },
        },
        minDistanceFloorUsdByMarket: { BTC: 25, ETH: 1, DOGE: 0.0005 },
      },
      {
        watcher: { getCurrentMarket: vi.fn(async () => market) } as unknown as MarketWatcher,
        orderbook: fakeOrderbook(0.5),
        // Price 115 vs opening 100 => distance 15: above the configured 8 but below the 25 floor.
        priceFeed: livePriceFeed("BTC", 115, nowMs),
        state,
        executor,
        reconciler: fakeReconciler(),
      },
    );

    await runner.runOnce(nowMs);

    expect(executor.execute).not.toHaveBeenCalled();
    expect(state.recordTradeAttempt).not.toHaveBeenCalled();
  });

  it("skips a trade when the book can only fill a fraction below minFillRatio", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const windowStartMs = Date.UTC(2026, 4, 7, 4, 25, 0, 0);
    const nowMs = windowStartMs + 290_000;
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
    const state = {
      load: vi.fn(async () => undefined),
      listTrades: vi.fn(() => []),
      getOpening: vi.fn((slug: string) => openings.get(slug)),
      hasTraded: vi.fn(() => false),
      getDailySpend: vi.fn(() => 0),
      recordTradeAttempt: vi.fn(async () => undefined),
    } as unknown as StateStore;
    const executor = {
      execute: vi.fn(async () => {
        throw new Error("should not execute a thin partial fill");
      }),
    } satisfies TradeExecutor;
    // Requested $1 but the book can only fill $0.30 under the cap => ratio 0.30 < the 0.5 default.
    const thinOrderbook = {
      getQuote: vi.fn(async () => ({
        tokenId: "token",
        bestAsk: 0.7,
        bestBid: 0.69,
        availableUsdUnderCap: 0.3,
        estimatedSharesForAmount: 0.3 / 0.7,
        rawAskLevels: [],
      })),
    } as unknown as OrderbookService;

    const runner = new BotRunner(
      {
        ...baseConfig(),
        mode: "sim",
        requirePositiveEv: false,
      },
      {
        watcher: { getCurrentMarket: vi.fn(async () => market) } as unknown as MarketWatcher,
        orderbook: thinOrderbook,
        // Price 130 vs opening 100 => distance 30, above the configured 20: a valid signal.
        priceFeed: livePriceFeed("BTC", 130, nowMs),
        state,
        executor,
        reconciler: fakeReconciler(),
      },
    );

    await runner.runOnce(nowMs);

    expect(thinOrderbook.getQuote).toHaveBeenCalled();
    expect(executor.execute).not.toHaveBeenCalled();
    expect(state.recordTradeAttempt).not.toHaveBeenCalled();
  });

  it("blocks live trades with no exact strategy history at normal asks", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const windowStartMs = Date.UTC(2026, 4, 7, 4, 25, 0, 0);
    const nowMs = windowStartMs + 290_000;
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
    const state = {
      load: vi.fn(async () => undefined),
      listTrades: vi.fn(() => []),
      getOpening: vi.fn((slug: string) => openings.get(slug)),
      hasTraded: vi.fn(() => false),
      getDailySpend: vi.fn(() => 0),
      recordTradeAttempt: vi.fn(async () => undefined),
    } as unknown as StateStore;
    const executor = {
      execute: vi.fn(async () => {
        throw new Error("should not execute");
      }),
    } satisfies TradeExecutor;
    const strategyAnalysisEngine = {
      analyze: vi.fn(async () =>
        strategyAnalysisResponse(bestStrategy("BTC", "UP", 20, 20, 0.98, {
          tradeCount: 0,
          winCount: 0,
          lossCount: 0,
        })),
      ),
      estimateSetupWinRate: vi.fn(
        async () => bestStrategy("BTC", "UP", 20, 20, 0.98, { tradeCount: 0, winCount: 0, lossCount: 0 }).metrics,
      ),
    };

    const runner = new BotRunner(
      {
        ...baseConfig(),
        mode: "live",
        requirePositiveEv: true,
      },
      {
        watcher: { getCurrentMarket: vi.fn(async () => market) } as unknown as MarketWatcher,
        orderbook: fakeOrderbook(0.9),
        priceFeed: livePriceFeed("BTC", 130, nowMs),
        state,
        executor,
        reconciler: fakeReconciler(),
        strategyAnalysisEngine,
      },
    );

    await runner.runOnce(nowMs);

    expect(executor.execute).not.toHaveBeenCalled();
    expect(state.recordTradeAttempt).not.toHaveBeenCalled();
  });

  it.each([
    { finalPrice: 130, title: "Trade ganado", level: "info" as const, won: true },
    { finalPrice: 90, title: "Trade perdido", level: "warn" as const, won: false },
  ])("notifies Telegram when a trade is resolved as $title", async ({ finalPrice, title, level, won }) => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const nowMs = Date.UTC(2026, 4, 7, 4, 29, 30, 0);
    const windowStartMs = nowMs - 600_000;
    const trade: TradeAttempt = {
      id: `btc-up-${won ? "win" : "loss"}`,
      asset: "BTC",
      slug: `btc-updown-5m-${won ? "win" : "loss"}`,
      mode: "sim",
      conditionId: "BTC-condition",
      outcome: "UP",
      tokenId: "BTC-up",
      amountUsd: 1,
      maxAskPrice: 0.98,
      bestAsk: 0.5,
      estimatedShares: 2,
      openingPrice: 100,
      entryPrice: 120,
      distanceUsd: 20,
      entryWindowSeconds: 20,
      windowStartMs,
      endMs: windowStartMs + 300_000,
      createdAtMs: windowStartMs + 270_000,
    };
    const notifier = {
      notify: vi.fn(async () => undefined),
    };
    const state = {
      load: vi.fn(async () => undefined),
      listTrades: vi.fn(() => [trade]),
      recordTradeResolution: vi.fn(async (_slug: string, resolution: NonNullable<TradeAttempt["resolved"]>) => {
        trade.resolved = resolution;
      }),
      getDailySpend: vi.fn(() => 0),
    } as unknown as StateStore;
    const priceFeed = {
      start: vi.fn(),
      stop: vi.fn(),
      getLatestTick: vi.fn(() => ({
        market: "BTC",
        symbol: "btc/usd",
        value: finalPrice,
        timestampMs: nowMs,
        receivedAtMs: nowMs,
      })),
    } as unknown as ChainlinkPriceFeed;
    const runner = new BotRunner(baseConfig(), {
      watcher: { getCurrentMarket: vi.fn(async () => null) } as unknown as MarketWatcher,
      orderbook: fakeOrderbook(),
      priceFeed,
      state,
      executor: {} as TradeExecutor,
      reconciler: fakeReconciler(),
      notifier,
    });

    await runner.runOnce(nowMs);

    expect(state.recordTradeResolution).toHaveBeenCalledWith(
      trade.slug,
      expect.objectContaining({ won }),
      "sim",
    );
    expect(notifier.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        key: `trade-resolved:${trade.id}`,
        level,
        title,
        body: expect.stringContaining(`Slug: ${trade.slug}.`),
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
    maxAskPriceCeiling: 0.98,
    requirePositiveEv: false,
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

function livePriceFeed(market: MarketSymbol, value: number, nowMs: number): ChainlinkPriceFeed {
  return {
    start: vi.fn(),
    stop: vi.fn(),
    getLatestTick: vi.fn(() => ({
      market,
      symbol: priceFeedSymbol(market),
      value,
      timestampMs: nowMs,
      receivedAtMs: nowMs,
    })),
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

function fakeOrderbook(bestAsk = 0.5): OrderbookService {
  return {
    getQuote: vi.fn(async () => ({
      tokenId: "token",
      bestAsk,
      bestBid: bestAsk - 0.01,
      availableUsdUnderCap: 100,
      estimatedSharesForAmount: 1 / bestAsk,
      rawAskLevels: [],
    })),
  } as unknown as OrderbookService;
}

function bestStrategy(
  market: MarketSymbol,
  outcome: "UP" | "DOWN",
  entryWindowSeconds: number,
  minDistanceUsd: number,
  maxAskPrice: number,
  metricsOverrides: Partial<StrategyCandidate["metrics"]> = {},
): StrategyCandidate {
  const tradeCount = metricsOverrides.tradeCount ?? 5;
  const winCount = metricsOverrides.winCount ?? 4;
  const lossCount = metricsOverrides.lossCount ?? tradeCount - winCount;
  const averageAsk = metricsOverrides.averageAsk ?? 0.5;
  const adjustedWinProbability = metricsOverrides.adjustedWinProbability ?? (winCount + 1) / (tradeCount + 2);
  const edge = metricsOverrides.edge ?? adjustedWinProbability - averageAsk;
  const evRoi = metricsOverrides.evRoi ?? adjustedWinProbability / averageAsk - 1;
  return {
    market,
    outcome,
    entryWindowSeconds,
    minDistanceUsd,
    maxAskPrice,
    isCurrent: false,
    confidence: "medium",
    riskFlags: [],
    qualityScore: 0.5,
    evDeltaVsCurrent: 0.25,
    metrics: {
      sampleCount: 10,
      signalCount: 8,
      tradeCount,
      winCount,
      lossCount,
      quoteCoverage: 1,
      winRate: tradeCount > 0 ? winCount / tradeCount : undefined,
      realWinProbability: tradeCount > 0 ? winCount / tradeCount : undefined,
      adjustedWinProbability,
      averageAsk,
      historicalRoi: 0.6,
      evRoi,
      expectedRoi: evRoi,
      expectedValueUsd: evRoi,
      minExpectedValueUsd: 0.01,
      winProfitUsd: 1 / averageAsk - 1,
      lossUsd: -1,
      breakEvenProbability: averageAsk,
      edge,
      liveTradeAmountUsd: 1,
      askGuidance: "cheap",
      passesBasicEntry: adjustedWinProbability > averageAsk,
      passesSafetyMargin: adjustedWinProbability >= averageAsk + 0.02,
      passesExpectedValue: evRoi >= 0.01,
      passesRecommendedEntry: adjustedWinProbability >= averageAsk + 0.02 && evRoi >= 0.01,
      evDecisionReason: adjustedWinProbability >= averageAsk + 0.02 && evRoi >= 0.01 ? "passes" : "safety_margin",
      maxDrawdown: 1,
      ...metricsOverrides,
    },
  };
}

function strategyAnalysisResponse(strategy: StrategyCandidate): StrategyAnalysisResponse {
  return {
    generatedAtMs: Date.UTC(2026, 4, 7, 4, 25, 0, 0),
    strategies: [strategy],
    currentStrategies: [],
    summary: {
      sampleCount: 10,
      analyzedSampleCount: 10,
      strategyCount: 1,
      currentStrategyCount: 0,
      reliableStrategyCount: 1,
      bestEvRoi: strategy.metrics.evRoi,
      bestTradeCount: strategy.metrics.tradeCount,
      bestReliableEvRoi: strategy.metrics.evRoi,
      bestReliableTradeCount: strategy.metrics.tradeCount,
    },
  };
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

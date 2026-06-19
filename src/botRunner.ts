import { AnalyticsRecorder, ANALYTICS_WINDOW_SECONDS } from "./analyticsRecorder.js";
import { ChainlinkPriceFeed } from "./chainlinkPriceFeed.js";
import { calculateExpectedValue, type ExpectedValueSnapshot } from "./expectedValue.js";
import {
  LiveExecutionEngine,
  resolveTradeAmountUsd,
  SimulationExecutionEngine,
  type TradeExecutor,
} from "./executionEngine.js";
import { logger } from "./logger.js";
import { LiveTradeReconciler, NoopTradeReconciler, type TradeReconciler } from "./liveTradeReconciler.js";
import {
  getEntryWindowSeconds,
  getMarketOutcomeBoolean,
  getMarketOutcomeNumber,
  getMinDistanceUsd,
  marketSymbolFromSlug,
  OUTCOMES,
  SUPPORTED_MARKETS,
} from "./markets.js";
import { MarketWatcher } from "./marketWatcher.js";
import { createDynamicNotifier, type Notifier } from "./notifier.js";
import { OrderbookService } from "./orderbookService.js";
import { calculateTradePnl } from "./pnl.js";
import {
  evaluateFirstTicksSignal,
  getWinningOutcome,
  isTickStale,
  isWithinEntryWindow,
  shouldCaptureOpeningTick,
} from "./signalEngine.js";
import { StateStore } from "./stateStore.js";
import { StrategyAnalysisEngine } from "./strategyAnalysisEngine.js";
import { sleep } from "./time.js";
import { resolveTradeFromTick } from "./tradeResolution.js";
import type {
  BotConfig,
  BtcPriceTick,
  MarketInfo,
  MarketOutcomeNumberSettings,
  MarketSymbol,
  OrderbookQuote,
  Outcome,
  StrategyCandidate,
  TradeAttempt,
  WindowOpening,
} from "./types.js";

const AUTO_ADJUST_LIVE_COOLDOWN_MS = 60_000;

interface MarketWatcherLike {
  getCurrentMarket(nowMs?: number, market?: MarketSymbol): Promise<MarketInfo | null>;
  getCurrentMarkets?(markets: MarketSymbol[], nowMs?: number): Promise<MarketInfo[]>;
}

interface BotDependencies {
  watcher: MarketWatcherLike;
  orderbook: OrderbookService;
  priceFeed: ChainlinkPriceFeed;
  state: StateStore;
  executor: TradeExecutor;
  reconciler: TradeReconciler;
  analyticsRecorder?: AnalyticsRecorder;
  strategyAnalysisEngine?: Pick<StrategyAnalysisEngine, "analyze">;
  notifier?: Notifier;
}

interface TradeSignal {
  market: MarketInfo;
  outcome: Outcome;
  amountUsd: number;
  maxAskPrice: number;
  opening: WindowOpening;
  tick: BtcPriceTick;
  distanceUsd: number;
  minDistanceUsd: number;
  entryWindowSeconds: number;
}

interface TradeCandidate extends TradeSignal {
  quote: OrderbookQuote;
  expectedValue?: ExpectedValueSnapshot;
}

type TradeExecutionResult =
  | { candidate: TradeCandidate; trade: TradeAttempt }
  | { candidate: TradeCandidate; error: unknown };

export class BotRunner {
  private stopped = false;
  private readonly currentSlugs = new Map<MarketSymbol, string>();
  private readonly skipLogKeys = new Set<string>();
  private readonly lastLiveAutoAdjustAtMs = new Map<string, number>();

  constructor(
    private readonly config: BotConfig,
    private readonly deps: BotDependencies,
  ) {}

  static create(config: BotConfig): BotRunner {
    return new BotRunner(config, {
      watcher: new MarketWatcher(config.gammaHost),
      orderbook: OrderbookService.create(config.clobHost),
      priceFeed: new ChainlinkPriceFeed(config.rtdsUrl),
      state: new StateStore(config.dataDir),
      executor: config.mode === "live" ? new LiveExecutionEngine(config) : new SimulationExecutionEngine(config),
      reconciler: config.mode === "live" ? new LiveTradeReconciler(config) : new NoopTradeReconciler(),
      analyticsRecorder: new AnalyticsRecorder(config.dataDir),
      strategyAnalysisEngine: new StrategyAnalysisEngine(config.dataDir),
      notifier: createDynamicNotifier(config),
    });
  }

  updateStrategySettings(
    settings: Pick<
      BotConfig,
      | "minDistanceUsdByMarket"
      | "minDistanceUsdByMarketOutcome"
      | "entryWindowSeconds"
      | "entryWindowSecondsByMarket"
      | "entryWindowSecondsByMarketOutcome"
    >,
  ): void {
    this.config.minDistanceUsdByMarket = settings.minDistanceUsdByMarket;
    this.config.minDistanceUsdByMarketOutcome = settings.minDistanceUsdByMarketOutcome;
    this.config.minBtcDistanceUsd = settings.minDistanceUsdByMarket.BTC;
    this.config.entryWindowSeconds = settings.entryWindowSeconds;
    this.config.entryWindowSecondsByMarket = settings.entryWindowSecondsByMarket;
    this.config.entryWindowSecondsByMarketOutcome = settings.entryWindowSecondsByMarketOutcome;
    logger.info("Runtime strategy settings updated.", {
      minDistanceUsdByMarket: this.config.minDistanceUsdByMarket,
      minDistanceUsdByMarketOutcome: this.config.minDistanceUsdByMarketOutcome,
      entryWindowSecondsByMarket: this.config.entryWindowSecondsByMarket,
      entryWindowSecondsByMarketOutcome: this.config.entryWindowSecondsByMarketOutcome,
    });
  }

  async start(options: { once?: boolean } = {}): Promise<void> {
    await this.deps.state.load();
    this.deps.priceFeed.start();
    logger.info("Bot started.", {
      mode: this.config.mode,
      enabledMarkets: this.config.enabledMarkets,
      minDistanceUsdByMarket: this.config.minDistanceUsdByMarket,
      minDistanceUsdByMarketOutcome: this.config.minDistanceUsdByMarketOutcome,
      entryWindowSeconds: this.config.entryWindowSeconds,
      entryWindowSecondsByMarket: this.config.entryWindowSecondsByMarket,
      entryWindowSecondsByMarketOutcome: this.config.entryWindowSecondsByMarketOutcome,
      maxAskPrice: this.config.maxAskPrice,
      maxAskPriceByMarketOutcome: this.config.maxAskPriceByMarketOutcome,
      dailySpendLimitUsd: this.config.dailySpendLimitUsd,
    });
    await this.deps.notifier?.notify({
      key: `bot-started:${this.config.mode}`,
      title: "Bot iniciado",
      body: `Modo: ${this.config.mode}. Mercados trading: ${this.config.enabledMarkets.join(", ") || "ninguno"}. Analitica: ${SUPPORTED_MARKETS.join(", ")}.`,
    });

    if (options.once) {
      try {
        await this.runOnce();
      } finally {
        this.deps.priceFeed.stop();
        await this.notifyStopped();
      }
      return;
    }

    try {
      while (!this.stopped) {
        await this.runLoopIteration();
        await sleep(this.config.pollIntervalMs);
      }
    } finally {
      this.deps.priceFeed.stop();
      await this.notifyStopped();
    }
  }

  stop(): void {
    this.stopped = true;
    this.deps.priceFeed.stop();
  }

  async runOnce(nowMs = Date.now()): Promise<void> {
    await this.reconcileLiveTrades(nowMs);
    await this.resolveCompletedTrades(nowMs);
    await this.applyLiveAutoAdjustments(nowMs);

    const markets = await this.getCurrentMarkets(SUPPORTED_MARKETS, nowMs);
    if (markets.length === 0) {
      this.logSkipOnce("unknown", "market_not_found", { observedMarkets: SUPPORTED_MARKETS });
      return;
    }

    const tradeSignals: TradeSignal[] = [];
    const analyticsQuotesBySlug = new Map<string, Partial<Record<Outcome, OrderbookQuote>>>();
    const dailySpendUsd = this.deps.state.getDailySpend(nowMs);
    let reservedSpendUsd = 0;

    for (const market of markets) {
      const latestTick = this.deps.priceFeed.getLatestTick(market.asset);
      this.logMarketChange(market);
      const opening = await this.ensureOpening(market, latestTick, nowMs);
      const analyticsQuotes = await this.getAnalyticsQuotes(market, nowMs);
      analyticsQuotesBySlug.set(market.slug, analyticsQuotes);
      await this.recordAnalyticsObservation({
        market,
        opening,
        latestTick,
        quotes: analyticsQuotes,
        nowMs,
      });
      if (!this.isMarketEnabledForTrading(market.asset)) {
        continue;
      }
      const signal = this.buildTradeSignal({
        market,
        opening,
        latestTick,
        nowMs,
        reservedDailySpendUsd: dailySpendUsd + reservedSpendUsd,
      });
      if (signal) {
        reservedSpendUsd += signal.amountUsd;
        tradeSignals.push(signal);
      }
    }

    const candidates = await this.buildTradeCandidates(tradeSignals, analyticsQuotesBySlug);
    await this.executeTradeCandidates(candidates);
  }

  private async getCurrentMarkets(marketsToFetch: readonly MarketSymbol[], nowMs: number): Promise<MarketInfo[]> {
    if (marketsToFetch.length === 0) {
      return [];
    }
    if (this.deps.watcher.getCurrentMarkets) {
      return this.deps.watcher.getCurrentMarkets([...marketsToFetch], nowMs);
    }

    const markets: MarketInfo[] = [];
    for (const market of marketsToFetch) {
      const currentMarket = await this.deps.watcher.getCurrentMarket(nowMs, market);
      if (currentMarket) {
        markets.push(currentMarket);
      }
    }
    return markets;
  }

  private async reconcileLiveTrades(nowMs: number): Promise<void> {
    const trades = this.deps.state
      .listTrades()
      .filter((trade) => trade.mode === "live" && !trade.reconciledAtMs && trade.orderId);

    for (const trade of trades) {
      try {
        const reconciled = await this.deps.reconciler.reconcile(trade, nowMs);
        if (reconciled) {
          await this.deps.state.recordTradeReconciliation(reconciled);
        }
      } catch (error) {
        logger.warn("Live trade reconciliation failed; retrying later.", {
          slug: trade.slug,
          orderId: trade.orderId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private async runLoopIteration(): Promise<void> {
    try {
      await this.runOnce();
    } catch (error) {
      logger.warn("Bot loop iteration failed; retrying.", {
        error: error instanceof Error ? error.message : String(error),
      });
      await this.deps.notifier?.notify({
        key: "bot-loop-error",
        level: "warn",
        title: "Error en loop del bot",
        body: error instanceof Error ? error.message : String(error),
        minIntervalMs: 5 * 60_000,
      });
    }
  }

  private async notifyStopped(): Promise<void> {
    await this.deps.notifier?.notify({
      key: `bot-stopped:${this.config.mode}`,
      title: "Bot detenido",
      body: `Modo: ${this.config.mode}.`,
    });
  }

  private async ensureOpening(
    market: MarketInfo,
    latestTick: BtcPriceTick | undefined,
    nowMs: number,
  ): Promise<WindowOpening | undefined> {
    const existing = this.deps.state.getOpening(market.slug);
    if (existing) {
      return existing;
    }

    const openingTick = this.getOpeningTick(market, latestTick);
    if (!openingTick) {
      return undefined;
    }

    if (!shouldCaptureOpeningTick({
      market,
      tick: openingTick,
      nowMs,
      openingCaptureGraceMs: this.config.openingCaptureGraceMs,
    })) {
      return undefined;
    }

    const opening: WindowOpening = {
      asset: market.asset,
      slug: market.slug,
      windowStartMs: market.windowStartMs,
      openingPrice: openingTick.value,
      openingTickTimestampMs: openingTick.timestampMs,
      capturedAtMs: nowMs,
    };
    await this.deps.state.saveOpening(opening);
    logger.info("Captured Chainlink opening tick.", {
      slug: market.slug,
      openingPrice: opening.openingPrice,
      tickTimestamp: new Date(opening.openingTickTimestampMs).toISOString(),
    });
    return opening;
  }

  private getOpeningTick(market: MarketInfo, latestTick: BtcPriceTick | undefined): BtcPriceTick | undefined {
    const captureDeadlineMs = market.windowStartMs + this.config.openingCaptureGraceMs;
    const priceFeed = this.deps.priceFeed as ChainlinkPriceFeed & {
      getTickInRange?: (market: MarketSymbol, startMs: number, endMs: number) => BtcPriceTick | undefined;
    };
    return priceFeed.getTickInRange?.(market.asset, market.windowStartMs, captureDeadlineMs) ?? latestTick;
  }

  private buildTradeSignal(args: {
    market: MarketInfo;
    opening: WindowOpening | undefined;
    latestTick: BtcPriceTick | undefined;
    nowMs: number;
    reservedDailySpendUsd: number;
  }): TradeSignal | undefined {
    if (this.deps.state.hasTraded(args.market.slug, this.config.mode)) {
      this.logSkipOnce(args.market.slug, "market_already_traded");
      return undefined;
    }

    if (!args.market.active || args.market.closed || !args.market.acceptingOrders) {
      this.logSkipOnce(args.market.slug, "market_not_accepting_orders", {
        active: args.market.active,
        closed: args.market.closed,
        acceptingOrders: args.market.acceptingOrders,
      });
      return undefined;
    }

    if (!args.opening) {
      this.logSkipOnce(args.market.slug, "missing_opening_chainlink_tick");
      return undefined;
    }

    if (!args.latestTick) {
      this.logSkipOnce(args.market.slug, "missing_current_chainlink_tick");
      return undefined;
    }

    if (isTickStale(args.latestTick, args.nowMs, this.config.tickStaleMs)) {
      this.logSkipOnce(args.market.slug, "stale_chainlink_tick", {
        tickTimestamp: new Date(args.latestTick.timestampMs).toISOString(),
      });
      return undefined;
    }

    // --- Estrategia: primeros ticks como señal (firstTicksSignal) ---
    // Intentar primero con señal de primeros 3 ticks (unanimous = ~90% win rate)
    const recentTicks = this.deps.priceFeed.getTicksInRange?.(
      args.market.asset,
      args.opening.openingTickTimestampMs,
      args.nowMs,
    );
    const firstTicksResult = evaluateFirstTicksSignal(
      args.opening.openingPrice,
      recentTicks,
      args.opening.openingTickTimestampMs,
      args.market.endMs,
      { tickCount: 3, mode: "unanimous" },
    );

    let winner: { outcome: Outcome; distanceUsd: number } | null = null;
    const minDistanceUsd = {
      UP: this.resolveConfiguredMinDistance(args.market.asset, "UP"),
      DOWN: this.resolveConfiguredMinDistance(args.market.asset, "DOWN"),
    };

    if (firstTicksResult) {
      winner = { outcome: firstTicksResult.outcome, distanceUsd: firstTicksResult.distanceUsd };
      logger.info("FirstTicks signal detected.", {
        slug: args.market.slug,
        outcome: winner.outcome,
        distanceUsd: winner.distanceUsd,
        confidence: firstTicksResult.confidence,
      });
    } else {
      // Fallback: señal tradicional por distancia mínima
      const fallbackWinner = getWinningOutcome(args.opening.openingPrice, args.latestTick.value, minDistanceUsd);
      if (!fallbackWinner) {
        this.logSkipOnce(args.market.slug, "btc_distance_below_threshold", {
          market: args.market.asset,
          minDistanceUsd,
          openingPrice: args.opening.openingPrice,
          currentPrice: args.latestTick.value,
        });
        return undefined;
      }
      winner = fallbackWinner;
    }

    if (!this.isConfiguredOutcomeEnabled(args.market.asset, winner.outcome)) {
      this.logSkipOnce(args.market.slug, "outcome_disabled", {
        market: args.market.asset,
        outcome: winner.outcome,
      });
      return undefined;
    }

    const entryWindowSeconds = this.resolveConfiguredEntryWindow(args.market.asset, winner.outcome);
    if (!isWithinEntryWindow(args.market.endMs, args.nowMs, entryWindowSeconds)) {
      return undefined;
    }

    const amountUsd = resolveTradeAmountUsd({
      mode: this.config.mode,
      requestedUsd: this.resolveConfiguredTradeAmountUsd(args.market.asset, winner.outcome),
      orderMinSize: args.market.orderMinSize,
      autoMinLive: this.config.autoMinLive,
    });
    const maxAskPrice = this.resolveConfiguredMaxAskPrice(args.market.asset, winner.outcome);

    if (args.reservedDailySpendUsd + amountUsd > this.config.dailySpendLimitUsd) {
      this.logSkipOnce(args.market.slug, "daily_spend_limit_reached", {
        dailySpendUsd: args.reservedDailySpendUsd,
        amountUsd,
        dailySpendLimitUsd: this.config.dailySpendLimitUsd,
      });
      return undefined;
    }

    return {
      market: args.market,
      outcome: winner.outcome,
      amountUsd,
      maxAskPrice,
      opening: args.opening,
      tick: args.latestTick,
      distanceUsd: winner.distanceUsd,
      minDistanceUsd: minDistanceUsd[winner.outcome],
      entryWindowSeconds,
    };
  }

  private async buildTradeCandidates(
    signals: TradeSignal[],
    quoteCache = new Map<string, Partial<Record<Outcome, OrderbookQuote>>>(),
  ): Promise<TradeCandidate[]> {
    const results = await Promise.all(signals.map((signal) => this.buildTradeCandidate(signal, quoteCache)));
    return results.filter((candidate): candidate is TradeCandidate => Boolean(candidate));
  }

  private async buildTradeCandidate(
    signal: TradeSignal,
    quoteCache: Map<string, Partial<Record<Outcome, OrderbookQuote>>>,
  ): Promise<TradeCandidate | undefined> {
    const token = signal.market.outcomes[signal.outcome];
    let quote: OrderbookQuote;
    try {
      quote =
        quoteCache.get(signal.market.slug)?.[signal.outcome] ??
        (await this.deps.orderbook.getQuote(token.tokenId, signal.amountUsd, signal.maxAskPrice));
    } catch (error) {
      this.logSkipOnce(signal.market.slug, "orderbook_quote_failed", {
        outcome: signal.outcome,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }

    if (!quote.price || !quote.size) {
      this.logSkipOnce(signal.market.slug, "orderbook_quote_empty", {
        outcome: signal.outcome,
        quote,
      });
      return undefined;
    }

    const expectedValue = this.deps.strategyAnalysisEngine?.analyze(signal.market, signal.outcome, quote);

    return { ...signal, quote, expectedValue };
  }

  private async executeTradeCandidates(candidates: TradeCandidate[]): Promise<void> {
    if (candidates.length === 0) {
      return;
    }

    const results = await Promise.allSettled(
      candidates.map((candidate) => this.executeTradeCandidate(candidate)),
    );

    for (const result of results) {
      if (result.status === "rejected") {
        logger.error("Trade candidate execution failed.", {
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        });
      }
    }
  }

  private async executeTradeCandidate(candidate: TradeCandidate): Promise<void> {
    const trade = await this.deps.executor.execute(candidate);
    await this.deps.state.recordTrade(trade);
    await this.deps.notifier?.notify({
      key: `trade:${trade.slug}:${trade.outcome}`,
      title: `Trade ${trade.outcome} en ${trade.slug}`,
      body: `Monto: $${trade.amountUsd.toFixed(2)}. Precio: ${trade.price}. Modo: ${trade.mode}.`,
    });
    logger.info("Trade executed.", {
      slug: trade.slug,
      outcome: trade.outcome,
      amountUsd: trade.amountUsd,
      price: trade.price,
      mode: trade.mode,
    });
  }

  private async resolveCompletedTrades(nowMs: number): Promise<void> {
    const trades = this.deps.state.listTrades().filter((trade) => !trade.resolvedAtMs);

    for (const trade of trades) {
      const market = await this.deps.watcher.getCurrentMarket(nowMs, trade.asset);
      if (!market) {
        continue;
      }

      const resolved = resolveTradeFromTick(trade, market, nowMs);
      if (resolved) {
        await this.deps.state.recordTradeResolution(resolved);
        const pnl = calculateTradePnl(resolved);
        await this.deps.notifier?.notify({
          key: `trade-resolved:${resolved.slug}:${resolved.outcome}`,
          title: `Trade resuelto: ${resolved.outcome} en ${resolved.slug}`,
          body: `P&L: ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}. ROI: ${((pnl / resolved.amountUsd) * 100).toFixed(1)}%.`,
        });
        logger.info("Trade resolved.", {
          slug: resolved.slug,
          outcome: resolved.outcome,
          pnl,
          roi: ((pnl / resolved.amountUsd) * 100).toFixed(1),
        });
      }
    }
  }

  private async applyLiveAutoAdjustments(nowMs: number): Promise<void> {
    if (this.config.mode !== "live") {
      return;
    }

    const trades = this.deps.state.listTrades().filter((trade) => trade.mode === "live" && trade.resolvedAtMs);
    if (trades.length < 5) {
      return;
    }

    const recentTrades = trades.slice(-10);
    const wins = recentTrades.filter((t) => t.pnl && t.pnl > 0).length;
    const winRate = wins / recentTrades.length;

    for (const market of SUPPORTED_MARKETS) {
      const lastAdjustMs = this.lastLiveAutoAdjustAtMs.get(market) ?? 0;
      if (nowMs - lastAdjustMs < AUTO_ADJUST_LIVE_COOLDOWN_MS) {
        continue;
      }

      const marketTrades = recentTrades.filter((t) => t.asset === market);
      if (marketTrades.length < 3) {
        continue;
      }

      const marketWins = marketTrades.filter((t) => t.pnl && t.pnl > 0).length;
      const marketWinRate = marketWins / marketTrades.length;

      if (marketWinRate < 0.4) {
        const currentMinDistance = this.resolveConfiguredMinDistance(market, "UP");
        const newMinDistance = Math.min(currentMinDistance * 1.5, 100);
        this.config.minDistanceUsdByMarket[market] = newMinDistance;
        this.lastLiveAutoAdjustAtMs.set(market, nowMs);
        logger.info("Auto-adjusted min distance (low win rate).", {
          market,
          oldMinDistance: currentMinDistance,
          newMinDistance,
          marketWinRate,
        });
      } else if (marketWinRate > 0.7 && winRate > 0.6) {
        const currentMinDistance = this.resolveConfiguredMinDistance(market, "UP");
        const newMinDistance = Math.max(currentMinDistance * 0.8, 1);
        this.config.minDistanceUsdByMarket[market] = newMinDistance;
        this.lastLiveAutoAdjustAtMs.set(market, nowMs);
        logger.info("Auto-adjusted min distance (high win rate).", {
          market,
          oldMinDistance: currentMinDistance,
          newMinDistance,
          marketWinRate,
        });
      }
    }
  }

  private isMarketEnabledForTrading(asset: MarketSymbol): boolean {
    return this.config.enabledMarkets.length === 0 || this.config.enabledMarkets.includes(asset);
  }

  private resolveConfiguredMinDistance(asset: MarketSymbol, outcome: Outcome): number {
    return (
      this.config.minDistanceUsdByMarketOutcome?.[asset]?.[outcome] ??
      this.config.minDistanceUsdByMarket?.[asset] ??
      this.config.minBtcDistanceUsd ??
      0
    );
  }

  private resolveConfiguredEntryWindow(asset: MarketSymbol, outcome: Outcome): number {
    return (
      this.config.entryWindowSecondsByMarketOutcome?.[asset]?.[outcome] ??
      this.config.entryWindowSecondsByMarket?.[asset] ??
      this.config.entryWindowSeconds ??
      0
    );
  }

  private resolveConfiguredTradeAmountUsd(asset: MarketSymbol, outcome: Outcome): number {
    return (
      this.config.tradeAmountUsdByMarketOutcome?.[asset]?.[outcome] ??
      this.config.tradeAmountUsdByMarket?.[asset] ??
      this.config.tradeAmountUsd ??
      10
    );
  }

  private resolveConfiguredMaxAskPrice(asset: MarketSymbol, outcome: Outcome): number {
    return (
      this.config.maxAskPriceByMarketOutcome?.[asset]?.[outcome] ??
      this.config.maxAskPriceByMarket?.[asset] ??
      this.config.maxAskPrice ??
      1.05
    );
  }

  private isConfiguredOutcomeEnabled(asset: MarketSymbol, outcome: Outcome): boolean {
    const outcomeSettings = this.config.outcomeSettingsByMarket?.[asset];
    if (!outcomeSettings) {
      return true;
    }
    return outcomeSettings[outcome]?.enabled ?? true;
  }

  private logMarketChange(market: MarketInfo): void {
    const prevSlug = this.currentSlugs.get(market.asset);
    if (prevSlug !== market.slug) {
      logger.info("Market changed.", {
        asset: market.asset,
        slug: market.slug,
        prevSlug,
      });
      this.currentSlugs.set(market.asset, market.slug);
    }
  }

  private logSkipOnce(slug: string, key: string, extra?: Record<string, unknown>): void {
    const logKey = `${slug}:${key}`;
    if (this.skipLogKeys.has(logKey)) {
      return;
    }
    this.skipLogKeys.add(logKey);
    (logger as Record<string, unknown>).debug?.(`Skip: ${key}`, { slug, ...extra });
  }

  private async getAnalyticsQuotes(
    market: MarketInfo,
    nowMs: number,
  ): Promise<Partial<Record<Outcome, OrderbookQuote>>> {
    const quotes: Partial<Record<Outcome, OrderbookQuote>> = {};
    for (const outcome of OUTCOMES) {
      const token = market.outcomes[outcome];
      if (!token) {
        continue;
      }
      try {
        const quote = await this.deps.orderbook.getQuote(token.tokenId, 10, 1.05);
        if (quote.price && quote.size) {
          quotes[outcome] = quote;
        }
      } catch {
        // skip quote for analytics
      }
    }
    return quotes;
  }

  private async recordAnalyticsObservation(args: {
    market: MarketInfo;
    opening: WindowOpening | undefined;
    latestTick: BtcPriceTick | undefined;
    quotes: Partial<Record<Outcome, OrderbookQuote>>;
    nowMs: number;
  }): Promise<void> {
    if (!this.deps.analyticsRecorder || !args.opening || !args.latestTick) {
      return;
    }

    const minDistanceUsd = {
      UP: this.resolveConfiguredMinDistance(args.market.asset, "UP"),
      DOWN: this.resolveConfiguredMinDistance(args.market.asset, "DOWN"),
    };

    await this.deps.analyticsRecorder.observeMarket({
      market: args.market,
      opening: args.opening,
      tick: args.latestTick,
      quotes: args.quotes,
      nowMs: args.nowMs,
    });
  }
}

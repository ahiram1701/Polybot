import { AnalyticsRecorder, ANALYTICS_WINDOW_SECONDS } from "./analyticsRecorder.js";
import { ChainlinkPriceFeed } from "./chainlinkPriceFeed.js";
import {
  LiveExecutionEngine,
  resolveTradeAmountUsd,
  SimulationExecutionEngine,
  type TradeExecutor,
} from "./executionEngine.js";
import { logger } from "./logger.js";
import { LiveTradeReconciler, NoopTradeReconciler, type TradeReconciler } from "./liveTradeReconciler.js";
import { getEntryWindowSeconds, getMarketOutcomeNumber, getMinDistanceUsd, marketSymbolFromSlug } from "./markets.js";
import { MarketWatcher } from "./marketWatcher.js";
import { createNotifier, type Notifier } from "./notifier.js";
import { OrderbookService } from "./orderbookService.js";
import {
  getWinningOutcome,
  isTickStale,
  isWithinEntryWindow,
  shouldCaptureOpeningTick,
} from "./signalEngine.js";
import { StateStore } from "./stateStore.js";
import { sleep } from "./time.js";
import { resolveTradeFromTick } from "./tradeResolution.js";
import type {
  BotConfig,
  BtcPriceTick,
  MarketInfo,
  MarketSymbol,
  OrderbookQuote,
  Outcome,
  TradeAttempt,
  WindowOpening,
} from "./types.js";

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
  entryWindowSeconds: number;
}

interface TradeCandidate extends TradeSignal {
  quote: OrderbookQuote;
}

type TradeExecutionResult =
  | { candidate: TradeCandidate; trade: TradeAttempt }
  | { candidate: TradeCandidate; error: unknown };

export class BotRunner {
  private stopped = false;
  private readonly currentSlugs = new Map<MarketSymbol, string>();
  private readonly skipLogKeys = new Set<string>();

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
      notifier: createNotifier(config),
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
      body: `Modo: ${this.config.mode}. Mercados: ${this.config.enabledMarkets.join(", ") || "ninguno"}.`,
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

    const markets = await this.getCurrentMarkets(nowMs);
    if (this.config.enabledMarkets.length === 0) {
      this.logSkipOnce("config", "no_markets_enabled");
      return;
    }
    if (markets.length === 0) {
      this.logSkipOnce("unknown", "market_not_found", { enabledMarkets: this.config.enabledMarkets });
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

  private async getCurrentMarkets(nowMs: number): Promise<MarketInfo[]> {
    const enabledMarkets = this.config.enabledMarkets;
    if (enabledMarkets.length === 0) {
      return [];
    }
    if (this.deps.watcher.getCurrentMarkets) {
      return this.deps.watcher.getCurrentMarkets(enabledMarkets, nowMs);
    }

    const markets: MarketInfo[] = [];
    for (const market of enabledMarkets) {
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
    if (this.deps.state.hasTraded(args.market.slug)) {
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

    const minDistanceUsd = {
      UP: this.resolveConfiguredMinDistance(args.market.asset, "UP"),
      DOWN: this.resolveConfiguredMinDistance(args.market.asset, "DOWN"),
    };
    const winner = getWinningOutcome(args.opening.openingPrice, args.latestTick.value, minDistanceUsd);
    if (!winner) {
      this.logSkipOnce(args.market.slug, "btc_distance_below_threshold", {
        market: args.market.asset,
        minDistanceUsd,
        openingPrice: args.opening.openingPrice,
        currentPrice: args.latestTick.value,
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

    if (!quote.bestAsk || quote.availableUsdUnderCap <= 0) {
      this.logSkipOnce(signal.market.slug, "no_ask_liquidity_under_cap", { outcome: signal.outcome });
      return undefined;
    }

    if (quote.bestAsk > signal.maxAskPrice) {
      this.logSkipOnce(signal.market.slug, "best_ask_above_cap", {
        outcome: signal.outcome,
        bestAsk: quote.bestAsk,
        maxAskPrice: signal.maxAskPrice,
      });
      return undefined;
    }

    return { ...signal, quote };
  }

  private async executeTradeCandidates(candidates: TradeCandidate[]): Promise<void> {
    if (candidates.length === 0) {
      return;
    }

    for (const candidate of candidates) {
      const result = await this.executeTradeCandidate(candidate);
      if ("error" in result) {
        logger.warn("Trade execution failed; continuing with other markets.", {
          mode: this.config.mode,
          slug: result.candidate.market.slug,
          market: result.candidate.market.asset,
          outcome: result.candidate.outcome,
          amountUsd: result.candidate.amountUsd,
          error: result.error instanceof Error ? result.error.message : String(result.error),
        });
        continue;
      }

      await this.deps.state.recordTradeAttempt(result.trade);
      logger.info("Trade attempt recorded.", {
        mode: result.trade.mode,
        slug: result.trade.slug,
        outcome: result.trade.outcome,
        amountUsd: result.trade.amountUsd,
        bestAsk: result.trade.bestAsk,
        estimatedShares: result.trade.estimatedShares,
        status: result.trade.status,
        orderId: result.trade.orderId,
      });
    }
  }

  private async executeTradeCandidate(candidate: TradeCandidate): Promise<TradeExecutionResult> {
    try {
      const trade = await this.deps.executor.execute({
        market: candidate.market,
        outcome: candidate.outcome,
        amountUsd: candidate.amountUsd,
        maxAskPrice: candidate.maxAskPrice,
        quote: candidate.quote,
        opening: candidate.opening,
        tick: candidate.tick,
        distanceUsd: candidate.distanceUsd,
        entryWindowSeconds: candidate.entryWindowSeconds,
      });
      return { candidate, trade };
    } catch (error) {
      return { candidate, error };
    }
  }

  private resolveConfiguredTradeAmountUsd(market: MarketSymbol, outcome: Outcome): number {
    if (this.config.mode === "live") {
      return getMarketOutcomeNumber(
        this.config.liveTradeAmountUsdByMarketOutcome,
        market,
        outcome,
        this.config.liveTradeAmountUsd,
      );
    }
    return getMarketOutcomeNumber(
      this.config.simTradeAmountUsdByMarketOutcome,
      market,
      outcome,
      this.config.simTradeAmountUsd,
    );
  }

  private resolveConfiguredMaxAskPrice(market: MarketSymbol, outcome: Outcome): number {
    return getMarketOutcomeNumber(this.config.maxAskPriceByMarketOutcome, market, outcome, this.config.maxAskPrice);
  }

  private resolveConfiguredMinDistance(market: MarketSymbol, outcome: Outcome): number {
    return getMarketOutcomeNumber(
      this.config.minDistanceUsdByMarketOutcome,
      market,
      outcome,
      getMinDistanceUsd(this.config.minDistanceUsdByMarket, market),
    );
  }

  private resolveConfiguredEntryWindow(market: MarketSymbol, outcome: Outcome): number {
    return getMarketOutcomeNumber(
      this.config.entryWindowSecondsByMarketOutcome,
      market,
      outcome,
      getEntryWindowSeconds(this.config.entryWindowSecondsByMarket, market, this.config.entryWindowSeconds),
    );
  }

  private async getAnalyticsQuotes(
    market: MarketInfo,
    nowMs: number,
  ): Promise<Partial<Record<Outcome, OrderbookQuote>>> {
    if (!this.deps.analyticsRecorder || !isWithinEntryWindow(market.endMs, nowMs, ANALYTICS_WINDOW_SECONDS)) {
      return {};
    }

    const [up, down] = await Promise.allSettled([
      this.deps.orderbook.getQuote(
        market.outcomes.UP.tokenId,
        resolveTradeAmountUsd({
          mode: this.config.mode,
          requestedUsd: this.resolveConfiguredTradeAmountUsd(market.asset, "UP"),
          orderMinSize: market.orderMinSize,
          autoMinLive: this.config.autoMinLive,
        }),
        this.resolveConfiguredMaxAskPrice(market.asset, "UP"),
      ),
      this.deps.orderbook.getQuote(
        market.outcomes.DOWN.tokenId,
        resolveTradeAmountUsd({
          mode: this.config.mode,
          requestedUsd: this.resolveConfiguredTradeAmountUsd(market.asset, "DOWN"),
          orderMinSize: market.orderMinSize,
          autoMinLive: this.config.autoMinLive,
        }),
        this.resolveConfiguredMaxAskPrice(market.asset, "DOWN"),
      ),
    ]);
    const quotes: Partial<Record<Outcome, OrderbookQuote>> = {};
    if (up.status === "fulfilled") {
      quotes.UP = up.value;
    }
    if (down.status === "fulfilled") {
      quotes.DOWN = down.value;
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
    if (!this.deps.analyticsRecorder) {
      return;
    }
    try {
      await this.deps.analyticsRecorder.observeMarket({
        market: args.market,
        opening: args.opening,
        tick: args.latestTick,
        quotes: args.quotes,
        nowMs: args.nowMs,
      });
    } catch (error) {
      logger.warn("Analytics sample recording failed; continuing.", {
        market: args.market.asset,
        slug: args.market.slug,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async resolveCompletedTrades(nowMs: number): Promise<void> {
    const trades = this.deps.state.listTrades();
    for (const trade of trades) {
      const market = trade.asset ?? marketSymbolFromSlug(trade.slug) ?? "BTC";
      const latestTick = this.deps.priceFeed.getLatestTick(market);
      if (!latestTick) {
        continue;
      }
      const resolution = resolveTradeFromTick(trade, latestTick, nowMs);
      if (!resolution) {
        continue;
      }
      await this.deps.state.recordTradeResolution(trade.slug, resolution);
      logger.info("Resolved trade.", {
        mode: trade.mode,
        slug: trade.slug,
        outcome: trade.outcome,
        winningOutcome: resolution.winningOutcome,
        won: resolution.won,
        finalPrice: resolution.finalPrice,
      });
    }
  }

  private logMarketChange(market: MarketInfo): void {
    if (this.currentSlugs.get(market.asset) === market.slug) {
      return;
    }
    this.currentSlugs.set(market.asset, market.slug);
    for (const key of [...this.skipLogKeys]) {
      if (key.startsWith(`${market.asset}:`)) {
        this.skipLogKeys.delete(key);
      }
    }
    logger.info("Tracking market.", {
      market: market.asset,
      slug: market.slug,
      title: market.title,
      end: new Date(market.endMs).toISOString(),
      upToken: market.outcomes.UP.tokenId,
      downToken: market.outcomes.DOWN.tokenId,
      orderMinSize: market.orderMinSize,
      tickSize: market.tickSize,
    });
  }

  private logSkipOnce(slug: string, reason: string, meta?: unknown): void {
    const market = marketSymbolFromSlug(slug);
    const key = `${market ?? slug}:${slug}:${reason}`;
    if (this.skipLogKeys.has(key)) {
      return;
    }
    this.skipLogKeys.add(key);
    logger.info("Skipped trade.", { slug, reason, ...(isRecord(meta) ? meta : { meta }) });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

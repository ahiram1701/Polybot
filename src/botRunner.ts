import { AnalyticsRecorder, ANALYTICS_WINDOW_SECONDS } from "./analyticsRecorder.js";
import { ChainlinkPriceFeed } from "./chainlinkPriceFeed.js";
import { calculateExpectedValue, type ExpectedValueSnapshot } from "./expectedValue.js";
import { defaultTakerFeeRateBps } from "./fees.js";
import { evaluateRiskCircuitBreaker, type RiskHaltStatus } from "./riskCircuitBreaker.js";
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
  getWinningOutcome,
  isTickStale,
  isWithinEntryWindow,
  shouldCaptureOpeningTick,
} from "./signalEngine.js";
import { StateStore } from "./stateStore.js";
import { StrategyAnalysisEngine } from "./strategyAnalysisEngine.js";
import { dailySpendKey, sleep } from "./time.js";
import { resolveTradeFromTick } from "./tradeResolution.js";
import type {
  BotConfig,
  BtcPriceTick,
  MarketInfo,
  MarketOutcomeNumberSettings,
  MarketSymbol,
  Mode,
  OrderbookQuote,
  Outcome,
  StrategyCandidate,
  TradeAttempt,
  WindowOpening,
} from "./types.js";

const AUTO_ADJUST_LIVE_COOLDOWN_MS = 60_000;
// Defaults for the expected-value gate when config omits them (config.ts always sets them in prod).
const DEFAULT_REQUIRE_POSITIVE_EV = true;
const DEFAULT_MAX_ASK_PRICE_CEILING = 0.85;
const DEFAULT_EV_SAFETY_MARGIN = 0.03;
const DEFAULT_EV_MIN_EXPECTED_ROI = 0.01;
const DEFAULT_EV_MIN_HISTORY_TRADES = 10;

interface MarketWatcherLike {
  getCurrentMarket(nowMs?: number, market?: MarketSymbol): Promise<MarketInfo | null>;
  getCurrentMarkets?(markets: MarketSymbol[], nowMs?: number): Promise<MarketInfo[]>;
}

export interface RunnerPriceFeed {
  start(): void;
  stop(): void;
  getLatestTick(market?: MarketSymbol): BtcPriceTick | undefined;
  getTickInRange?(market: MarketSymbol, startMs: number, endMs: number): BtcPriceTick | undefined;
  getOpeningTick?(market: MarketSymbol, windowStartMs: number, graceMs: number): BtcPriceTick | undefined;
}

interface BotDependencies {
  watcher: MarketWatcherLike;
  orderbook: OrderbookService;
  priceFeed: RunnerPriceFeed;
  /** When false the price feed is shared/owned externally and must not be stopped by the runner. */
  ownsPriceFeed?: boolean;
  state: StateStore;
  executor: TradeExecutor;
  reconciler: TradeReconciler;
  analyticsRecorder?: AnalyticsRecorder;
  strategyAnalysisEngine?: Pick<StrategyAnalysisEngine, "analyze" | "estimateSetupWinRate">;
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

  static create(config: BotConfig, overrides: { priceFeed?: RunnerPriceFeed } = {}): BotRunner {
    return new BotRunner(config, {
      watcher: new MarketWatcher(config.gammaHost),
      orderbook: OrderbookService.create(config.clobHost),
      priceFeed: overrides.priceFeed ?? new ChainlinkPriceFeed(config.rtdsUrl),
      ownsPriceFeed: overrides.priceFeed === undefined,
      state: new StateStore(config.dataDir),
      executor: config.mode === "live" ? new LiveExecutionEngine(config) : new SimulationExecutionEngine(config),
      reconciler: config.mode === "live" ? new LiveTradeReconciler(config) : new NoopTradeReconciler(),
      analyticsRecorder: new AnalyticsRecorder(config.dataDir, config.maxAnalyticsSamples),
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

  // Reset P&L through the running bot's own state instance so the in-memory state carries the cut,
  // and subsequent saves preserve it (a separate state instance would be clobbered on the next save).
  async resetPnl(mode: Mode): Promise<void> {
    await this.deps.state.resetPnl(mode);
  }

  // Re-arm the risk circuit breaker through the running bot's own state instance so the in-memory
  // state carries the reset and trading resumes immediately (same threshold, not disabled).
  async resetRiskHalt(mode: Mode): Promise<void> {
    await this.deps.state.resetRiskHalt(mode);
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
        this.stopPriceFeed();
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
      this.stopPriceFeed();
      await this.notifyStopped();
    }
  }

  stop(): void {
    this.stopped = true;
    this.stopPriceFeed();
  }

  private stopPriceFeed(): void {
    if (this.deps.ownsPriceFeed ?? true) {
      this.deps.priceFeed.stop();
    }
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
    const riskHalt = evaluateRiskCircuitBreaker(
      this.deps.state.listTrades(),
      this.config.mode,
      { maxDailyLossUsd: this.config.maxDailyLossUsd, maxConsecutiveLosses: this.config.maxConsecutiveLosses },
      nowMs,
      this.deps.state.getRiskHaltResetAtMs?.()?.[this.config.mode] ?? 0,
    );
    if (riskHalt.tripped) {
      this.notifyRiskHalt(riskHalt, nowMs);
    }

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
      // Risk circuit breaker halts trading (never analytics) for the rest of the UTC day.
      if (riskHalt.tripped) {
        this.logSkipOnce(market.slug, "risk_circuit_breaker", {
          reason: riskHalt.reason,
          dailyLossUsd: riskHalt.dailyLossUsd,
          consecutiveLosses: riskHalt.consecutiveLosses,
        });
        continue;
      }
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

  private notifyRiskHalt(status: RiskHaltStatus, nowMs: number): void {
    const body =
      status.reason === "daily_loss_limit"
        ? `Perdida diaria $${status.dailyLossUsd.toFixed(2)} (modo ${this.config.mode}).`
        : `${status.consecutiveLosses} perdidas seguidas (modo ${this.config.mode}).`;
    void this.deps.notifier?.notify({
      key: `risk-halt:${this.config.mode}:${dailySpendKey(nowMs)}:${status.reason}`,
      level: "warn",
      title: "Circuit breaker de riesgo activado",
      body: `${body} Trading detenido hasta el proximo dia UTC.`,
      minIntervalMs: 6 * 60 * 60_000,
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
    const grace = this.config.openingCaptureGraceMs;
    // Prefer the symmetric-grace opening tick (accepts the last price just before window start for
    // sparsely-updated feeds); fall back to the in-window range and finally the latest tick.
    return (
      this.deps.priceFeed.getOpeningTick?.(market.asset, market.windowStartMs, grace) ??
      this.deps.priceFeed.getTickInRange?.(market.asset, market.windowStartMs, market.windowStartMs + grace) ??
      latestTick
    );
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

    const requirePositiveEv = this.config.requirePositiveEv ?? DEFAULT_REQUIRE_POSITIVE_EV;
    const expectedValue = requirePositiveEv ? await this.evaluateExpectedValue(signal, quote.bestAsk) : undefined;
    if (requirePositiveEv && !expectedValue) {
      return undefined;
    }

    return { ...signal, quote, expectedValue };
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

  private async evaluateExpectedValue(
    signal: TradeSignal,
    askPrice: number,
  ): Promise<ExpectedValueSnapshot | undefined> {
    if (!this.deps.strategyAnalysisEngine) {
      this.logSkipOnce(signal.market.slug, "expected_value_analysis_unavailable", {
        market: signal.market.asset,
        outcome: signal.outcome,
      });
      return undefined;
    }

    try {
      // Aggregate win/trade history for THIS exact setup (market/outcome/window/distance/cap),
      // computed directly from recent samples — robust to param churn (no brittle exact-bucket match).
      const metrics = await this.deps.strategyAnalysisEngine.estimateSetupWinRate(
        signal.market.asset,
        signal.outcome,
        {
          entryWindowSeconds: signal.entryWindowSeconds,
          minDistanceUsd: signal.minDistanceUsd,
          maxAskPrice: signal.maxAskPrice,
        },
        signal.amountUsd,
      );
      const minHistoryTrades = this.config.evMinHistoryTrades ?? DEFAULT_EV_MIN_HISTORY_TRADES;
      if (metrics.tradeCount < minHistoryTrades) {
        this.logSkipOnce(signal.market.slug, "expected_value_history_not_found", {
          market: signal.market.asset,
          outcome: signal.outcome,
          entryWindowSeconds: signal.entryWindowSeconds,
          minDistanceUsd: signal.minDistanceUsd,
          maxAskPrice: signal.maxAskPrice,
          tradeCount: metrics.tradeCount,
          minHistoryTrades,
        });
        return undefined;
      }

      // Fee-aware: a trade must clear the round-trip taker fee (which scales with price) plus the
      // configured ROI buffer, on top of the win-probability safety margin.
      const feeFraction = (defaultTakerFeeRateBps(signal.market.asset) / 10_000) * (1 - askPrice);
      const expectedValue = calculateExpectedValue({
        capitalUsd: signal.amountUsd,
        askPrice,
        winCount: metrics.winCount,
        tradeCount: metrics.tradeCount,
        safetyMargin: this.config.evSafetyMargin ?? DEFAULT_EV_SAFETY_MARGIN,
        minExpectedRoi: (this.config.evMinExpectedRoi ?? DEFAULT_EV_MIN_EXPECTED_ROI) + feeFraction,
      });
      if (!expectedValue.passesRecommendedEntry) {
        this.logSkipOnce(signal.market.slug, "expected_value_gate_failed", {
          market: signal.market.asset,
          outcome: signal.outcome,
          askPrice: expectedValue.askPrice,
          winCount: expectedValue.winCount,
          tradeCount: expectedValue.tradeCount,
          realWinProbability: expectedValue.realWinProbability,
          adjustedWinProbability: expectedValue.adjustedWinProbability,
          edge: expectedValue.edge,
          expectedValueUsd: expectedValue.expectedValueUsd,
          minExpectedValueUsd: expectedValue.minExpectedValueUsd,
          decisionReason: expectedValue.decisionReason,
        });
        return undefined;
      }

      return expectedValue;
    } catch (error) {
      this.logSkipOnce(signal.market.slug, "expected_value_analysis_failed", {
        market: signal.market.asset,
        outcome: signal.outcome,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
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
        expectedValue: candidate.expectedValue,
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
    const configured = getMarketOutcomeNumber(this.config.maxAskPriceByMarketOutcome, market, outcome, this.config.maxAskPrice);
    // Hard ceiling: never pay more than this per share regardless of the configured/auto-adjusted cap,
    // so the reward per win stays large enough to recover from losses.
    const ceiling = this.config.maxAskPriceCeiling ?? DEFAULT_MAX_ASK_PRICE_CEILING;
    return Math.min(configured, ceiling);
  }

  private resolveConfiguredMinDistance(market: MarketSymbol, outcome: Outcome): number {
    const configured = getMarketOutcomeNumber(
      this.config.minDistanceUsdByMarketOutcome,
      market,
      outcome,
      getMinDistanceUsd(this.config.minDistanceUsdByMarket, market),
    );
    // Hard floor: the edge comes from strong moves; never trade below the market's distance floor,
    // regardless of config or auto-adjust.
    const floor = this.config.minDistanceFloorUsdByMarket?.[market];
    return floor !== undefined ? Math.max(configured, floor) : configured;
  }

  private resolveConfiguredEntryWindow(market: MarketSymbol, outcome: Outcome): number {
    return getMarketOutcomeNumber(
      this.config.entryWindowSecondsByMarketOutcome,
      market,
      outcome,
      getEntryWindowSeconds(this.config.entryWindowSecondsByMarket, market, this.config.entryWindowSeconds),
    );
  }

  private isConfiguredOutcomeEnabled(market: MarketSymbol, outcome: Outcome): boolean {
    return getMarketOutcomeBoolean(this.config.enabledMarketOutcomes, market, outcome, this.config.enabledMarkets.includes(market));
  }

  private isMarketEnabledForTrading(market: MarketSymbol): boolean {
    return OUTCOMES.some((outcome) => this.isConfiguredOutcomeEnabled(market, outcome));
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
      await this.deps.state.recordTradeResolution(trade.slug, resolution, trade.mode);
      await this.recordResolvedTradeAnalytics(trade, resolution);
      logger.info("Resolved trade.", {
        mode: trade.mode,
        slug: trade.slug,
        outcome: trade.outcome,
        winningOutcome: resolution.winningOutcome,
        won: resolution.won,
        finalPrice: resolution.finalPrice,
      });
      await this.notifyTradeResolved(trade, resolution);
      if (!resolution.won) {
        await this.applyAfterLossAutoAdjustment(trade, nowMs);
      }
    }
  }

  private async recordResolvedTradeAnalytics(
    trade: TradeAttempt,
    resolution: NonNullable<TradeAttempt["resolved"]>,
  ): Promise<void> {
    if (!this.deps.analyticsRecorder) {
      return;
    }
    try {
      await this.deps.analyticsRecorder.recordResolvedTrade(trade, resolution);
    } catch (error) {
      logger.warn("Resolved trade analytics fallback failed; continuing.", {
        mode: trade.mode,
        slug: trade.slug,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async notifyTradeResolved(trade: TradeAttempt, resolution: NonNullable<TradeAttempt["resolved"]>): Promise<void> {
    const pnl = calculateTradePnl({ ...trade, resolved: resolution });
    await this.deps.notifier?.notify({
      key: `trade-resolved:${trade.id ?? trade.slug}`,
      level: resolution.won ? "info" : "warn",
      title: resolution.won ? "Trade ganado" : "Trade perdido",
      body: [
        `Modo: ${trade.mode}. Mercado: ${trade.asset ?? marketSymbolFromSlug(trade.slug) ?? "--"}.`,
        `Comprado: ${trade.outcome}. Ganador: ${resolution.winningOutcome}.`,
        `Stake: ${formatUsd(trade.amountUsd)}. P&L: ${formatSignedUsd(pnl.netUsd)}.`,
        `Precio final: ${formatMarketValue(resolution.finalPrice)}. Distancia: ${formatSignedValue(trade.distanceUsd)}.`,
        `Slug: ${trade.slug}.`,
      ].join("\n"),
      minIntervalMs: 24 * 60 * 60_000,
    });
  }

  private async applyLiveAutoAdjustments(nowMs: number): Promise<void> {
    if (this.config.mode !== "live" || !this.deps.strategyAnalysisEngine) {
      return;
    }

    for (const market of SUPPORTED_MARKETS) {
      for (const outcome of OUTCOMES) {
        if (!getMarketOutcomeBoolean(this.config.autoAdjustLiveByMarketOutcome, market, outcome)) {
          continue;
        }
        const key = strategyKey(market, outcome);
        const lastAppliedAtMs = this.lastLiveAutoAdjustAtMs.get(key) ?? 0;
        if (nowMs - lastAppliedAtMs < AUTO_ADJUST_LIVE_COOLDOWN_MS) {
          continue;
        }
        this.lastLiveAutoAdjustAtMs.set(key, nowMs);
        await this.applyBestStrategyAdjustment(market, outcome, "live", nowMs);
      }
    }
  }

  private async applyAfterLossAutoAdjustment(trade: TradeAttempt, nowMs: number): Promise<void> {
    if (!this.deps.strategyAnalysisEngine) {
      return;
    }
    const market = trade.asset ?? marketSymbolFromSlug(trade.slug);
    if (!market || !getMarketOutcomeBoolean(this.config.autoAdjustAfterLossByMarketOutcome, market, trade.outcome)) {
      return;
    }
    await this.applyBestStrategyAdjustment(market, trade.outcome, "after_loss", nowMs);
  }

  private async applyBestStrategyAdjustment(
    market: MarketSymbol,
    outcome: Outcome,
    trigger: "live" | "after_loss",
    nowMs: number,
  ): Promise<boolean> {
    if (!this.deps.strategyAnalysisEngine) {
      return false;
    }
    try {
      const analysis = await this.deps.strategyAnalysisEngine.analyze(this.config, nowMs);
      const candidate = selectAutoAdjustStrategy(
        analysis.strategies,
        market,
        outcome,
        this.config.maxAskPriceCeiling ?? DEFAULT_MAX_ASK_PRICE_CEILING,
      );
      if (!candidate || !strategyChangesConfig(candidate, this.config)) {
        return false;
      }
      this.applyStrategyCandidate(candidate);
      logger.info("Auto-adjusted strategy settings.", {
        trigger,
        market,
        outcome,
        entryWindowSeconds: candidate.entryWindowSeconds,
        minDistanceUsd: candidate.minDistanceUsd,
        maxAskPrice: candidate.maxAskPrice,
        confidence: candidate.confidence,
        evRoi: candidate.metrics.evRoi,
        evDeltaVsCurrent: candidate.evDeltaVsCurrent,
      });
      return true;
    } catch (error) {
      logger.warn("Strategy auto-adjust failed; continuing.", {
        trigger,
        market,
        outcome,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  private applyStrategyCandidate(candidate: StrategyCandidate): void {
    const minDistanceUsdByMarketOutcome = cloneOutcomeNumbers(this.config.minDistanceUsdByMarketOutcome, {
      BTC: getMinDistanceUsd(this.config.minDistanceUsdByMarket, "BTC"),
      ETH: getMinDistanceUsd(this.config.minDistanceUsdByMarket, "ETH"),
      DOGE: getMinDistanceUsd(this.config.minDistanceUsdByMarket, "DOGE"),
    });
    const entryWindowSecondsByMarketOutcome = cloneOutcomeNumbers(this.config.entryWindowSecondsByMarketOutcome, {
      BTC: getEntryWindowSeconds(this.config.entryWindowSecondsByMarket, "BTC", this.config.entryWindowSeconds),
      ETH: getEntryWindowSeconds(this.config.entryWindowSecondsByMarket, "ETH", this.config.entryWindowSeconds),
      DOGE: getEntryWindowSeconds(this.config.entryWindowSecondsByMarket, "DOGE", this.config.entryWindowSeconds),
    });
    const maxAskPriceByMarketOutcome = cloneOutcomeNumbers(this.config.maxAskPriceByMarketOutcome, {
      BTC: this.config.maxAskPrice,
      ETH: this.config.maxAskPrice,
      DOGE: this.config.maxAskPrice,
    });

    minDistanceUsdByMarketOutcome[candidate.market][candidate.outcome] = candidate.minDistanceUsd;
    entryWindowSecondsByMarketOutcome[candidate.market][candidate.outcome] = candidate.entryWindowSeconds;
    maxAskPriceByMarketOutcome[candidate.market][candidate.outcome] = candidate.maxAskPrice;

    this.config.minDistanceUsdByMarketOutcome = minDistanceUsdByMarketOutcome;
    this.config.entryWindowSecondsByMarketOutcome = entryWindowSecondsByMarketOutcome;
    this.config.maxAskPriceByMarketOutcome = maxAskPriceByMarketOutcome;

    this.config.minDistanceUsdByMarket = {
      ...this.config.minDistanceUsdByMarket,
      [candidate.market]: minDistanceUsdByMarketOutcome[candidate.market].UP,
    };
    this.config.entryWindowSecondsByMarket = {
      ...this.config.entryWindowSecondsByMarket,
      [candidate.market]: entryWindowSecondsByMarketOutcome[candidate.market].UP,
    };
    this.config.minBtcDistanceUsd = this.config.minDistanceUsdByMarket.BTC;
    this.config.entryWindowSeconds = this.config.entryWindowSecondsByMarket.BTC;
    this.config.maxAskPrice = maxAskPriceByMarketOutcome.BTC.UP;
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

function selectAutoAdjustStrategy(
  strategies: StrategyCandidate[],
  market: MarketSymbol,
  outcome: Outcome,
  maxAskPriceCeiling: number,
): StrategyCandidate | undefined {
  return strategies.find((strategy) =>
    strategy.market === market &&
    strategy.outcome === outcome &&
    // Never auto-adjust to a strategy whose ask cap exceeds the ceiling (bad reward/risk).
    strategy.maxAskPrice <= maxAskPriceCeiling &&
    strategy.confidence !== "low" &&
    strategy.metrics.evRoi !== undefined &&
    strategy.metrics.evRoi > 0 &&
    strategy.metrics.passesRecommendedEntry === true &&
    strategy.metrics.tradeCount >= 5 &&
    (strategy.evDeltaVsCurrent === undefined || strategy.evDeltaVsCurrent > 0),
  );
}

function strategyChangesConfig(candidate: StrategyCandidate, config: BotConfig): boolean {
  const currentDistance = getMarketOutcomeNumber(
    config.minDistanceUsdByMarketOutcome,
    candidate.market,
    candidate.outcome,
    getMinDistanceUsd(config.minDistanceUsdByMarket, candidate.market),
  );
  const currentWindow = getMarketOutcomeNumber(
    config.entryWindowSecondsByMarketOutcome,
    candidate.market,
    candidate.outcome,
    getEntryWindowSeconds(config.entryWindowSecondsByMarket, candidate.market, config.entryWindowSeconds),
  );
  const currentAskCap = getMarketOutcomeNumber(
    config.maxAskPriceByMarketOutcome,
    candidate.market,
    candidate.outcome,
    config.maxAskPrice,
  );
  return (
    currentDistance !== candidate.minDistanceUsd ||
    currentWindow !== candidate.entryWindowSeconds ||
    currentAskCap !== candidate.maxAskPrice
  );
}

function cloneOutcomeNumbers(
  settings: MarketOutcomeNumberSettings | undefined,
  fallback: Record<MarketSymbol, number>,
): MarketOutcomeNumberSettings {
  return {
    BTC: { UP: settings?.BTC?.UP ?? fallback.BTC, DOWN: settings?.BTC?.DOWN ?? fallback.BTC },
    ETH: { UP: settings?.ETH?.UP ?? fallback.ETH, DOWN: settings?.ETH?.DOWN ?? fallback.ETH },
    DOGE: { UP: settings?.DOGE?.UP ?? fallback.DOGE, DOWN: settings?.DOGE?.DOWN ?? fallback.DOGE },
  };
}

function strategyKey(market: MarketSymbol, outcome: Outcome): string {
  return `${market}:${outcome}`;
}

function formatUsd(value?: number): string {
  if (value === undefined || !Number.isFinite(value)) {
    return "--";
  }
  return value.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
}

function formatSignedUsd(value?: number): string {
  if (value === undefined || !Number.isFinite(value)) {
    return "--";
  }
  const formatted = formatUsd(value);
  return value > 0 ? `+${formatted}` : formatted;
}

function formatMarketValue(value?: number): string {
  if (value === undefined || !Number.isFinite(value)) {
    return "--";
  }
  return value.toLocaleString("en-US", { maximumFractionDigits: 6 });
}

function formatSignedValue(value?: number): string {
  if (value === undefined || !Number.isFinite(value)) {
    return "--";
  }
  return `${value >= 0 ? "+" : ""}${value.toLocaleString("en-US", { maximumFractionDigits: 6 })}`;
}

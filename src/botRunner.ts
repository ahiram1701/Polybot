import { appendFile } from "node:fs/promises";
import { join } from "node:path";

import { AnalyticsRecorder, ANALYTICS_WINDOW_SECONDS } from "./analyticsRecorder.js";
import { detectCompleteSetArb, type ArbOpportunity } from "./arbMonitor.js";
import { ChainlinkPriceFeed } from "./chainlinkPriceFeed.js";
import { buildCalibrationMap, type CalibrationMap } from "./calibration.js";
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
import { calculatePnlSummaryByMode, calculateTradePnl, estimateTradeFeeUsd } from "./pnl.js";
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
  MarketSymbol,
  Mode,
  OrderbookQuote,
  Outcome,
  TradeAttempt,
  WindowOpening,
} from "./types.js";

// Defaults for the expected-value gate when config omits them (config.ts always sets them in prod).
const DEFAULT_REQUIRE_POSITIVE_EV = true;
const DEFAULT_MAX_ASK_PRICE_CEILING = 0.85;
const DEFAULT_EV_SAFETY_MARGIN = 0.03;
const DEFAULT_EV_MIN_EXPECTED_ROI = 0.01;
// Backtest (evGateBacktest sweep) over all recorded analytics: min history 15 maximized net P&L across
// BTC/ETH/DOGE (+$12/~4% vs 10) with a slightly higher win rate — trusts fewer, better-supported setups.
const DEFAULT_EV_MIN_HISTORY_TRADES = 15;
// Techo a la ventaja que el modelo puede declarar sobre el mercado. El bucket edge>0.20 del ledger
// realizo -17.6pp de discriminacion y -21.8pp de sesgo: era el que perdia. Ver ExpectedValueInput.
const DEFAULT_EV_MAX_CLAIMED_EDGE = 0.2;
// No entrar en los ultimos segundos de la ventana. Medido sobre el ledger (2026-08-01): entrar con
// menos de 10s restantes realizo 32.4% de aciertos y -19.8% de ROI (n=34), contra ~50% del resto. El
// mecanismo se conocia de antes y es lo que lo hace creible mas alla de la muestra: cerca del cierre
// el CLOB bloquea las ordenes taker (post_only_mode), la profundidad se adelgaza y el precio ya esta
// practicamente resuelto. Hasta ahora el bot solo abandonaba la ventana DESPUES de que lo rechazaran.
const DEFAULT_MIN_SECONDS_TO_END = 10;
// Skip a trade when the book can fill less than this fraction of the requested amount under the cap.
// Prevents useless micro-positions (a thin book filling only ~$0.69 of a requested $10).
const DEFAULT_MIN_FILL_RATIO = 0.5;
// Cold-start exploration: a market/setup needs `evMinHistoryTrades` (15) fillable samples to trade
// normally, but a setup with thin quote coverage (BTC/DOGE) can never reach 15 because it never
// trades — a deadlock. Exploration breaks it by allowing a BOUNDED number of probes per market/day on
// short-history setups, but ONLY when the (Bayesian-shrunk, fee-aware) EV is still positive. Shrinkage
// pulls a 5/5 fluke toward the market price so noise rarely passes; the real edge (DOGE ~0.9 win) does.
// The daily cap bounds the exploration cost — these probes are data-gathering, not the profit engine.
const DEFAULT_EXPLORATION_ENABLED = true;
const EXPLORATION_MIN_TRADES = 5;
const EXPLORATION_MAX_PER_MARKET_DAY = 3;
// Official-resolution verification cadence: one sweep every 30s, 2 gamma lookups per sweep. Enough to
// backfill dozens of historical trades within minutes without hammering the API; failed/unresolved
// lookups retry after 5 minutes.
const OFFICIAL_SWEEP_INTERVAL_MS = 30_000;
const OFFICIAL_CHECKS_PER_SWEEP = 2;
const OFFICIAL_RESOLUTION_GRACE_MS = 90_000;
const OFFICIAL_RETRY_INTERVAL_MS = 5 * 60_000;

interface MarketWatcherLike {
  getCurrentMarket(nowMs?: number, market?: MarketSymbol): Promise<MarketInfo | null>;
  getCurrentMarkets?(markets: MarketSymbol[], nowMs?: number): Promise<MarketInfo[]>;
  getMarketBySlug?(slug: string, nowMs?: number): Promise<MarketInfo | null>;
}

export interface RunnerPriceFeed {
  start(): void;
  stop(): void;
  getLatestTick(market?: MarketSymbol): BtcPriceTick | undefined;
  getTickInRange?(market: MarketSymbol, startMs: number, endMs: number): BtcPriceTick | undefined;
  getOpeningTick?(market: MarketSymbol, windowStartMs: number, graceMs: number): BtcPriceTick | undefined;
  getTickAtOrBefore?(market: MarketSymbol, timestampMs: number): BtcPriceTick | undefined;
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
  strategyAnalysisEngine?: Pick<StrategyAnalysisEngine, "analyze" | "estimateSetupWinRate"> &
    Partial<Pick<StrategyAnalysisEngine, "estimateSetupWinRateBySimilarity" | "buildCalibrationSamples">>;
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
  // True when this trade only cleared the gate via the bounded cold-start exploration path (short
  // history but positive shrunk EV). Used to charge the per-market/day exploration budget on fill.
  exploration?: boolean;
}

interface EvGateResult {
  expectedValue: ExpectedValueSnapshot;
  exploration: boolean;
}

type TradeExecutionResult =
  | { candidate: TradeCandidate; trade: TradeAttempt }
  | { candidate: TradeCandidate; error: unknown };

export class BotRunner {
  private stopped = false;
  private readonly currentSlugs = new Map<MarketSymbol, string>();
  private readonly skipLogKeys = new Set<string>();
  // Windows whose CLOB already rejected taker orders ("post-only mode": Polymarket blocks takers in
  // the final seconds before close). Retrying is pointless until the next window — without this the
  // bot hammered the API every poll tick (19 identical rejections in ~30s).
  private readonly postOnlySlugs = new Set<string>();
  private lastOfficialSweepMs = 0;
  private readonly officialCheckAttemptsMs = new Map<string, number>();
  private readonly calibrationCache = new Map<MarketSymbol, { resolvedCount: number; map: CalibrationMap }>();
  private readonly loopDurationsMs: number[] = [];
  private lastLoopStatsLogMs = 0;
  // Cold-start exploration budget: how many exploratory probes have fired per `${dayKey}:${market}`.
  // In-memory on purpose — a restart resets it, which only makes exploration MORE conservative.
  private readonly explorationCountByDayMarket = new Map<string, number>();

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
      state: new StateStore(config.dataDir, config.timezone),
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
    > &
      Partial<Pick<BotConfig, "maxAskPrice" | "maxAskPriceByMarketOutcome" | "minAskPriceByMarketOutcome">>,
  ): void {
    this.config.minDistanceUsdByMarket = settings.minDistanceUsdByMarket;
    this.config.minDistanceUsdByMarketOutcome = settings.minDistanceUsdByMarketOutcome;
    this.config.minBtcDistanceUsd = settings.minDistanceUsdByMarket.BTC;
    this.config.entryWindowSeconds = settings.entryWindowSeconds;
    this.config.entryWindowSecondsByMarket = settings.entryWindowSecondsByMarket;
    this.config.entryWindowSecondsByMarketOutcome = settings.entryWindowSecondsByMarketOutcome;
    if (settings.maxAskPrice !== undefined) {
      this.config.maxAskPrice = settings.maxAskPrice;
    }
    if (settings.maxAskPriceByMarketOutcome !== undefined) {
      this.config.maxAskPriceByMarketOutcome = settings.maxAskPriceByMarketOutcome;
    }
    if (settings.minAskPriceByMarketOutcome !== undefined) {
      this.config.minAskPriceByMarketOutcome = settings.minAskPriceByMarketOutcome;
    }
    logger.info("Runtime strategy settings updated.", {
      minDistanceUsdByMarket: this.config.minDistanceUsdByMarket,
      minDistanceUsdByMarketOutcome: this.config.minDistanceUsdByMarketOutcome,
      entryWindowSecondsByMarket: this.config.entryWindowSecondsByMarket,
      entryWindowSecondsByMarketOutcome: this.config.entryWindowSecondsByMarketOutcome,
      maxAskPriceByMarketOutcome: this.config.maxAskPriceByMarketOutcome,
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
    const startedAt = Date.now();
    let capturePhaseMs = 0;
    let decidePhaseMs = 0;

    await this.reconcileLiveTrades(nowMs);
    await this.resolveCompletedTrades(nowMs);

    const markets = await this.getCurrentMarkets(SUPPORTED_MARKETS, nowMs);
    if (markets.length === 0) {
      this.logSkipOnce("unknown", "market_not_found", { observedMarkets: SUPPORTED_MARKETS });
      // La verificación oficial no depende de mercados abiertos; debe seguir corriendo.
      await this.verifyOfficialResolutions(nowMs);
      return;
    }

    const tradeSignals: TradeSignal[] = [];
    const analyticsQuotesBySlug = new Map<string, Partial<Record<Outcome, OrderbookQuote>>>();
    const dailySpendUsd = this.deps.state.getDailySpend(nowMs);
    let reservedSpendUsd = 0;
    const riskHalt = evaluateRiskCircuitBreaker(
      this.deps.state.listTrades(),
      this.config.mode,
      {
        maxDailyLossUsd: this.config.maxDailyLossUsd,
        maxConsecutiveLosses: this.config.maxConsecutiveLosses,
        cooldownHours: this.config.riskHaltCooldownHours,
        timeZone: this.config.timezone,
      },
      nowMs,
      this.deps.state.getRiskHaltResetAtMs?.()?.[this.config.mode] ?? 0,
    );
    if (riskHalt.tripped) {
      this.notifyRiskHalt(riskHalt, nowMs);
    }

    // FASE 1 — captura, EN PARALELO por mercado: la parte lenta son las llamadas HTTP al orderbook y
    // la persistencia de analytics; en serie sumaban ~2s por iteración (gap de ticks medido p50 2s,
    // 42% >3s). Es seguro: los samples por mercado son disjuntos, writeFileAtomic serializa por path y
    // aquí no se mueve dinero. Todo lo que decide/ejecuta queda en la FASE 2 secuencial.
    const captureStartedAt = Date.now();
    const observations = await Promise.all(
      markets.map(async (market) => {
        const latestTick = this.deps.priceFeed.getLatestTick(market.asset);
        this.logMarketChange(market);
        const opening = await this.ensureOpening(market, latestTick, nowMs);
        const analyticsQuotes = await this.getAnalyticsQuotes(market, nowMs);
        await this.recordAnalyticsObservation({
          market,
          opening,
          latestTick,
          quotes: analyticsQuotes,
          nowMs,
        });
        const arbOpportunity = await this.observeArbOpportunity(market, analyticsQuotes, nowMs);
        return { market, latestTick, opening, analyticsQuotes, arbOpportunity };
      }),
    );
    capturePhaseMs = Date.now() - captureStartedAt;
    const decideStartedAt = Date.now();

    // FASE 2 — decisión y ejecución, secuencial (orden determinista, límites de gasto compartidos).
    for (const { market, latestTick, opening, analyticsQuotes, arbOpportunity } of observations) {
      analyticsQuotesBySlug.set(market.slug, analyticsQuotes);
      if (arbOpportunity && !riskHalt.tripped && opening && latestTick) {
        await this.executeArbOpportunity({
          market,
          quotes: analyticsQuotes,
          opportunity: arbOpportunity,
          opening,
          tick: latestTick,
          nowMs,
        });
      }
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
    decidePhaseMs = Date.now() - decideStartedAt;

    // Fuera del camino caliente: la verificación oficial (2 HTTP a gamma cada 30s) corre al FINAL del
    // tick, después de capturar precios y decidir — su latencia ya no retrasa la lectura del mercado.
    await this.verifyOfficialResolutions(nowMs);

    this.recordLoopTiming(Date.now() - startedAt, capturePhaseMs, decidePhaseMs);
  }

  /** Rolling loop-latency stats: slow iterations are logged with a breakdown; percentiles every 5 min. */
  private recordLoopTiming(totalMs: number, captureMs: number, decideMs: number): void {
    this.loopDurationsMs.push(totalMs);
    if (this.loopDurationsMs.length > 600) {
      this.loopDurationsMs.shift();
    }
    if (totalMs > 2_500) {
      logger.warn("Iteración lenta del loop.", { totalMs, captureMs, decideMs });
    }
    const nowMs = Date.now();
    if (nowMs - this.lastLoopStatsLogMs >= 5 * 60_000 && this.loopDurationsMs.length >= 10) {
      this.lastLoopStatsLogMs = nowMs;
      const sorted = [...this.loopDurationsMs].sort((left, right) => left - right);
      logger.info("Latencia del loop (ventana móvil).", {
        iterations: sorted.length,
        p50Ms: sorted[Math.floor(sorted.length * 0.5)],
        p95Ms: sorted[Math.floor(sorted.length * 0.95)],
        maxMs: sorted[sorted.length - 1],
      });
    }
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
      key: `risk-halt:${this.config.mode}:${dailySpendKey(nowMs, this.config.timezone)}:${status.reason}`,
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
    if (this.postOnlySlugs.has(signal.market.slug)) {
      // The CLOB already rejected takers for this window; don't even quote.
      return undefined;
    }
    const minSecondsToEnd = this.config.minSecondsToEndForEntry ?? DEFAULT_MIN_SECONDS_TO_END;
    // Desde el tick que disparo la senal, no del reloj de pared: es el instante que realmente estamos
    // evaluando (y hace la guardia testeable con un reloj inyectado).
    const secondsToEnd = (signal.market.endMs - signal.tick.timestampMs) / 1000;
    if (minSecondsToEnd > 0 && secondsToEnd < minSecondsToEnd) {
      this.logSkipOnce(signal.market.slug, "too_close_to_close", {
        market: signal.market.asset,
        outcome: signal.outcome,
        secondsToEnd: Math.round(secondsToEnd * 10) / 10,
        minSecondsToEnd,
      });
      return undefined;
    }
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

    // Piso de ask: por debajo de este precio la entrada es una apuesta de reversion barata, que el
    // replay del ledger live mostro perdedora de forma sistematica (ETH <0.30: 23 de 24 perdidas).
    const minAskPrice = this.resolveConfiguredMinAskPrice(signal.market.asset, signal.outcome);
    if (quote.bestAsk < minAskPrice) {
      this.logSkipOnce(signal.market.slug, "best_ask_below_floor", {
        outcome: signal.outcome,
        bestAsk: quote.bestAsk,
        minAskPrice,
      });
      return undefined;
    }

    // Guard against thin-liquidity micro-positions: if the book can only fill a small fraction of the
    // requested amount under the cap, the fill is a useless dust position (and skews per-trade P&L).
    const minFillRatio = this.config.minFillRatio ?? DEFAULT_MIN_FILL_RATIO;
    const fillableRatio = signal.amountUsd > 0 ? quote.availableUsdUnderCap / signal.amountUsd : 0;
    if (minFillRatio > 0 && fillableRatio < minFillRatio) {
      this.logSkipOnce(signal.market.slug, "fillable_below_min_ratio", {
        outcome: signal.outcome,
        amountUsd: signal.amountUsd,
        availableUsdUnderCap: quote.availableUsdUnderCap,
        fillableRatio: Number(fillableRatio.toFixed(3)),
        minFillRatio,
      });
      return undefined;
    }

    const requirePositiveEv = this.config.requirePositiveEv ?? DEFAULT_REQUIRE_POSITIVE_EV;
    if (!requirePositiveEv) {
      return { ...signal, quote };
    }
    const evResult = await this.evaluateExpectedValue(signal, quote.bestAsk);
    if (!evResult) {
      return undefined;
    }
    return { ...signal, quote, expectedValue: evResult.expectedValue, exploration: evResult.exploration };
  }

  private async executeTradeCandidates(candidates: TradeCandidate[]): Promise<void> {
    if (candidates.length === 0) {
      return;
    }

    for (const candidate of candidates) {
      if (this.postOnlySlugs.has(candidate.market.slug)) {
        // A sibling candidate in this same batch already hit the post-only rejection.
        continue;
      }
      const result = await this.executeTradeCandidate(candidate);
      if ("error" in result) {
        const message = result.error instanceof Error ? result.error.message : String(result.error);
        if (isPostOnlyRejection(message)) {
          // Terminal for this window: the CLOB stopped accepting taker orders (final seconds before
          // close). Mark the slug so no further attempts are made until the next window.
          this.postOnlySlugs.add(result.candidate.market.slug);
          this.logSkipOnce(result.candidate.market.slug, "post_only_mode", {
            market: result.candidate.market.asset,
            outcome: result.candidate.outcome,
            secondsToEnd: Math.round((result.candidate.market.endMs - Date.now()) / 100) / 10,
          });
          continue;
        }
        logger.warn("Trade execution failed; continuing with other markets.", {
          mode: this.config.mode,
          slug: result.candidate.market.slug,
          market: result.candidate.market.asset,
          outcome: result.candidate.outcome,
          amountUsd: result.candidate.amountUsd,
          error: message,
        });
        continue;
      }

      await this.deps.state.recordTradeAttempt(result.trade);
      if (candidate.exploration) {
        this.chargeExplorationBudget(candidate.market.asset);
      }
      logger.info("Trade attempt recorded.", {
        mode: result.trade.mode,
        slug: result.trade.slug,
        outcome: result.trade.outcome,
        amountUsd: result.trade.amountUsd,
        bestAsk: result.trade.bestAsk,
        estimatedShares: result.trade.estimatedShares,
        status: result.trade.status,
        orderId: result.trade.orderId,
        exploration: candidate.exploration === true,
      });
    }
  }

  /**
   * Calibration learned from the bot's OWN deployed predictions vs outcomes, **one map per market**.
   *
   * Two corrections over the naive version, both measured on the ledger (2026-07-30):
   *
   * 1. **Per market, not pooled.** Pooling BTC/ETH/DOGE collapsed the model's measured skill from
   *    +13..+30pp of discrimination *within* each market to +5pp overall — Simpson's paradox: the
   *    per-market probabilities are not comparable (ETH ran ~13pp overconfident, BTC ~7pp under), so
   *    mixing them puts ETH's inflated predictions in the "high confidence" bucket where they lose. A
   *    single global map bakes that same mistake into the correction.
   *
   * 2. **Trained on the RAW probability**, not the already-calibrated one. Otherwise the map fits a
   *    target it moves itself and only ever sees the residual error: it was removing ~9pp of a ~26pp
   *    real error and could never close the gap. Legacy trades without `rawWinProbability` fall back
   *    to the stored adjusted value (better than dropping them).
   *
   * Exploration probes are excluded: they are deliberately uninformed bets on thin history (measured
   * 0.0pp discrimination by design), so they are training noise, not signal about the model's skill.
   */
  private getCalibrationMap(market: MarketSymbol): CalibrationMap {
    const trades = this.deps.state.listTrades();
    const minHistory = this.config.evMinHistoryTrades ?? DEFAULT_EV_MIN_HISTORY_TRADES;
    const usable = trades.filter((trade) => {
      const ev = trade.expectedValue;
      if (!ev || trade.kind === "arb" || trade.asset !== market) {
        return false;
      }
      // Skip exploratory probes (short history by construction).
      return (ev.tradeCount ?? Number.POSITIVE_INFINITY) >= minHistory;
    });
    const pairs = usable.flatMap((trade) => {
      const ev = trade.expectedValue;
      const predicted = ev?.rawWinProbability ?? ev?.adjustedWinProbability;
      const won = trade.resolved?.won;
      return typeof predicted === "number" && typeof won === "boolean" ? [{ predicted, won }] : [];
    });
    // NO se siembra con las ventanas observadas, aunque son muchas mas (BTC: 48 ejecutados contra 141
    // observados). Medido 2026-07-30: el sesgo de las observaciones (-3.1pp en BTC) no se parece al de
    // los trades reales (-17pp), porque el gate en produccion estima por k-NN de similitud mientras
    // que la reconstruccion walk-forward usa el agregado simple. Son estimadores distintos: calibrar
    // las predicciones de uno con un mapa ajustado al otro corrige lo que no es. El backtest lo daba
    // como leve mejora (+$3.65) solo porque ahi ambos lados usan el agregado, asi que no transfiere.
    // `buildCalibrationSamples` se conserva como herramienta de investigacion (calibrationBacktest).
    const cached = this.calibrationCache.get(market);
    if (cached?.resolvedCount === pairs.length) {
      return cached.map;
    }
    const map = buildCalibrationMap(pairs);
    this.calibrationCache.set(market, { resolvedCount: pairs.length, map });
    return map;
  }

  private async evaluateExpectedValue(
    signal: TradeSignal,
    askPrice: number | undefined,
  ): Promise<EvGateResult | undefined> {
    if (askPrice === undefined || askPrice <= 0) {
      return undefined;
    }
    if (!this.deps.strategyAnalysisEngine) {
      this.logSkipOnce(signal.market.slug, "expected_value_analysis_unavailable", {
        market: signal.market.asset,
        outcome: signal.outcome,
      });
      return undefined;
    }

    try {
      const params = {
        entryWindowSeconds: signal.entryWindowSeconds,
        minDistanceUsd: signal.minDistanceUsd,
        maxAskPrice: signal.maxAskPrice,
      };
      const minHistoryTrades = this.config.evMinHistoryTrades ?? DEFAULT_EV_MIN_HISTORY_TRADES;

      let winCount: number;
      let tradeCount: number;
      if (this.config.evUseSimilarity && this.deps.strategyAnalysisEngine.estimateSetupWinRateBySimilarity) {
        // Similarity gate: match the live setup against the NEAREST historical setups (not the exact
        // config), so a setup with real edge but few exact analogues can still trade.
        // 2026-07-16 estimatorBacktest: 3 features + prior anclado al ask GANÓ el walk-forward
        // (+$539 vs +$517 exacto, calErr 0.299 vs 0.331); las features ricas (velocity/spread/skew,
        // "knn6") PERDIERON con los quotes actuales — el pool las conserva, pero la query las omite a
        // propósito (knnCore solo compara features presentes en ambos lados). Re-testear cuando el
        // muestreo de quotes sea más denso.
        const secondsRemaining = (signal.market.endMs - signal.tick.timestampMs) / 1000;
        const estimate = await this.deps.strategyAnalysisEngine.estimateSetupWinRateBySimilarity(
          signal.market.asset,
          signal.outcome,
          params,
          {
            secondsToEnd: secondsRemaining,
            favorableDistanceUsd: Math.abs(signal.distanceUsd),
            ask: askPrice,
          },
          { priorProbability: askPrice },
        );
        tradeCount = Math.round(estimate.effectiveSampleSize);
        winCount = Math.round(estimate.winProbability * tradeCount);
      } else {
        // Aggregate win/trade history for THIS exact setup (market/outcome/window/distance/cap),
        // computed directly from recent samples — robust to param churn (no brittle exact-bucket match).
        const metrics = await this.deps.strategyAnalysisEngine.estimateSetupWinRate(
          signal.market.asset,
          signal.outcome,
          params,
          signal.amountUsd,
        );
        tradeCount = metrics.tradeCount;
        winCount = metrics.winCount;
      }

      // Fee-aware: a trade must clear the round-trip taker fee (which scales with price) plus the
      // configured ROI buffer, on top of the win-probability safety margin.
      const feeFraction = (defaultTakerFeeRateBps(signal.market.asset) / 10_000) * (1 - askPrice);
      const expectedValue = calculateExpectedValue({
        capitalUsd: signal.amountUsd,
        askPrice,
        winCount,
        tradeCount,
        safetyMargin: this.config.evSafetyMargin ?? DEFAULT_EV_SAFETY_MARGIN,
        minExpectedRoi: (this.config.evMinExpectedRoi ?? DEFAULT_EV_MIN_EXPECTED_ROI) + feeFraction,
        calibration: this.config.evCalibration ? this.getCalibrationMap(signal.market.asset) : undefined,
        maxClaimedEdge: this.config.evMaxClaimedEdge ?? DEFAULT_EV_MAX_CLAIMED_EDGE,
      });

      if (tradeCount < minHistoryTrades) {
        // Cold-start: not enough fillable history for the normal gate. Allow a bounded exploratory
        // probe ONLY if there is *some* history and the shrunk, fee-aware EV is still positive — so we
        // gather real fills to bootstrap the setup without betting on noise. See EXPLORATION_* consts.
        const exploration = this.considerExploration(signal, tradeCount, expectedValue);
        if (exploration) {
          return exploration;
        }
        this.logSkipOnce(signal.market.slug, "expected_value_history_not_found", {
          market: signal.market.asset,
          outcome: signal.outcome,
          entryWindowSeconds: signal.entryWindowSeconds,
          minDistanceUsd: signal.minDistanceUsd,
          maxAskPrice: signal.maxAskPrice,
          tradeCount,
          minHistoryTrades,
          mode: this.config.evUseSimilarity ? "similarity" : "exact",
        });
        return undefined;
      }

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

      return { expectedValue, exploration: false };
    } catch (error) {
      this.logSkipOnce(signal.market.slug, "expected_value_analysis_failed", {
        market: signal.market.asset,
        outcome: signal.outcome,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  /**
   * Decide whether a short-history setup may fire a bounded exploratory probe. Returns the EV result
   * (tagged exploration) when allowed, else undefined. Guards, in order: feature enabled; enough
   * history to estimate at all (>= EXPLORATION_MIN_TRADES); the shrunk fee-aware EV still passes AND
   * shows positive edge (noise shrinks toward the ask and fails here); daily per-market budget left.
   */
  private considerExploration(
    signal: TradeSignal,
    tradeCount: number,
    expectedValue: ExpectedValueSnapshot,
  ): EvGateResult | undefined {
    const enabled = this.config.explorationEnabled ?? DEFAULT_EXPLORATION_ENABLED;
    if (!enabled || tradeCount < EXPLORATION_MIN_TRADES) {
      return undefined;
    }
    if (!expectedValue.passesRecommendedEntry || expectedValue.edge <= 0) {
      return undefined;
    }
    if (this.explorationBudgetLeft(signal.market.asset) <= 0) {
      this.logSkipOnce(signal.market.slug, "exploration_budget_exhausted", {
        market: signal.market.asset,
        outcome: signal.outcome,
        maxPerMarketDay: EXPLORATION_MAX_PER_MARKET_DAY,
      });
      return undefined;
    }
    logger.info("Exploración: historial corto pero EV positivo tras shrinkage; sondeo acotado.", {
      market: signal.market.asset,
      outcome: signal.outcome,
      tradeCount,
      edge: expectedValue.edge,
      adjustedWinProbability: expectedValue.adjustedWinProbability,
      budgetLeft: this.explorationBudgetLeft(signal.market.asset),
    });
    return { expectedValue, exploration: true };
  }

  private explorationBudgetKey(market: MarketSymbol): string {
    return `${dailySpendKey(Date.now(), this.config.timezone)}:${market}`;
  }

  private explorationBudgetLeft(market: MarketSymbol): number {
    const used = this.explorationCountByDayMarket.get(this.explorationBudgetKey(market)) ?? 0;
    return EXPLORATION_MAX_PER_MARKET_DAY - used;
  }

  private chargeExplorationBudget(market: MarketSymbol): void {
    const key = this.explorationBudgetKey(market);
    this.explorationCountByDayMarket.set(key, (this.explorationCountByDayMarket.get(key) ?? 0) + 1);
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

  /**
   * Monto por trade — MISMA fuente en sim y live. Antes cada modo leia su propio ajuste, asi que el
   * sim podia operar un tamano distinto al que usaria el live y su P&L no era comparable. La fuente
   * unica es el ajuste "live" (el que representa dinero real); los campos sim quedan como legado.
   */
  private resolveConfiguredTradeAmountUsd(market: MarketSymbol, outcome: Outcome): number {
    return getMarketOutcomeNumber(
      this.config.liveTradeAmountUsdByMarketOutcome,
      market,
      outcome,
      this.config.liveTradeAmountUsd,
    );
  }

  private resolveConfiguredMaxAskPrice(market: MarketSymbol, outcome: Outcome): number {
    const configured = getMarketOutcomeNumber(this.config.maxAskPriceByMarketOutcome, market, outcome, this.config.maxAskPrice);
    // Hard ceiling: never pay more than this per share regardless of the configured/auto-adjusted cap,
    // so the reward per win stays large enough to recover from losses.
    const ceiling = this.config.maxAskPriceCeiling ?? DEFAULT_MAX_ASK_PRICE_CEILING;
    return Math.min(configured, ceiling);
  }

  /** Piso de ask configurado (0.01 = sin piso). */
  private resolveConfiguredMinAskPrice(market: MarketSymbol, outcome: Outcome): number {
    return getMarketOutcomeNumber(this.config.minAskPriceByMarketOutcome, market, outcome, 0.01);
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

  /**
   * OBSERVATION ONLY (no orders): append every live complete-set arbitrage moment, with the real
   * depth of both books, to data/arb-opportunities.jsonl. A few days of this answers whether the
   * ~6-7 daily moments the historical scan found are worth an execution phase.
   */
  private async observeArbOpportunity(
    market: MarketInfo,
    quotes: Partial<Record<Outcome, OrderbookQuote>>,
    nowMs: number,
  ): Promise<ArbOpportunity | undefined> {
    const opportunity = detectCompleteSetArb({
      market: market.asset,
      slug: market.slug,
      endMs: market.endMs,
      nowMs,
      quotes,
    });
    if (!opportunity) {
      return undefined;
    }
    try {
      await appendFile(join(this.config.dataDir, "arb-opportunities.jsonl"), `${JSON.stringify(opportunity)}\n`, "utf8");
      // Once per window in the visible log; the JSONL captures every tick of the same opportunity.
      this.logSkipOnce(market.slug, "arb_opportunity_observed", {
        market: market.asset,
        netPerSet: opportunity.netPerSet,
        capturableUsd: opportunity.capturableUsd,
        secondsToEnd: opportunity.secondsToEnd,
      });
    } catch (error) {
      // Logging must never cost the opportunity itself.
      logger.warn("No se pudo registrar la oportunidad de arbitraje; continuando.", {
        slug: market.slug,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return opportunity;
  }

  /**
   * Execute a complete-set arbitrage: buy BOTH sides so the pair redeems $1/set at resolution no
   * matter who wins. Guards: opt-in toggle, minimum net/set (crumbs stay observation-only), one pair
   * per window, budget cap per opportunity, post-only aware, daily spend limit. The pair is stored as
   * ONE synthetic trade (kind "arb", slug "#arb") so P&L/fiscal/breaker flow through the normal
   * pipeline. The THIN side executes first: if the second leg then fails, the naked leg is recorded
   * honestly as a directional position (arbPairComplete=false) and notified.
   */
  private async executeArbOpportunity(args: {
    market: MarketInfo;
    quotes: Partial<Record<Outcome, OrderbookQuote>>;
    opportunity: ArbOpportunity;
    opening: WindowOpening;
    tick: BtcPriceTick;
    nowMs: number;
  }): Promise<void> {
    const { market, quotes, opportunity, opening, tick, nowMs } = args;
    if (!this.config.arbEnabled) {
      return;
    }
    const arbSlug = `${market.slug}#arb`;
    const minNetPerSet = this.config.arbMinNetPerSet ?? 0.02;
    if (opportunity.netPerSet < minNetPerSet || this.postOnlySlugs.has(market.slug)) {
      return;
    }
    if (this.deps.state.hasTraded(arbSlug, this.config.mode)) {
      return;
    }
    if (!market.active || market.closed || !market.acceptingOrders) {
      return;
    }
    const up = quotes.UP;
    const down = quotes.DOWN;
    if (!up?.bestAsk || !down?.bestAsk) {
      return;
    }

    const pairCost = up.bestAsk + down.bestAsk;
    const budget = this.config.arbMaxUsdPerOpportunity ?? 25;
    const sets = Math.floor(Math.min(opportunity.maxSetsByDepth, budget / pairCost) * 100) / 100;
    if (sets < Math.max(market.orderMinSize, 1)) {
      this.logSkipOnce(market.slug, "arb_below_min_size", { sets, orderMinSize: market.orderMinSize });
      return;
    }
    const totalCostUsd = sets * pairCost;
    if (this.deps.state.getDailySpend(nowMs) + totalCostUsd > this.config.dailySpendLimitUsd) {
      this.logSkipOnce(market.slug, "arb_daily_limit", { totalCostUsd });
      return;
    }

    // Thin book first: it is the binding constraint; if it rejects, no position exists yet.
    const thinFirst: Outcome[] =
      up.availableUsdUnderCap / up.bestAsk <= down.availableUsdUnderCap / down.bestAsk ? ["UP", "DOWN"] : ["DOWN", "UP"];
    const legs: Partial<Record<Outcome, TradeAttempt>> = {};
    for (const outcome of thinFirst) {
      const quote = outcome === "UP" ? up : down;
      const result = await this.executeArbLeg({ market, outcome, quote, sets, opening, tick, nowMs });
      if ("error" in result) {
        const message = result.error instanceof Error ? result.error.message : String(result.error);
        if (isPostOnlyRejection(message)) {
          this.postOnlySlugs.add(market.slug);
        }
        const nakedLeg = legs[thinFirst[0]];
        if (nakedLeg) {
          // Second leg failed: hold the first honestly as a directional position.
          await this.deps.state.recordTradeAttempt({
            ...nakedLeg,
            id: `${arbSlug}-${nowMs}`,
            slug: arbSlug,
            kind: "arb",
            arbPairComplete: false,
          });
          logger.warn("Arbitraje incompleto: solo una pata llenó; posición direccional registrada.", {
            slug: market.slug,
            leg: thinFirst[0],
            sets,
            error: message,
          });
          await this.deps.notifier?.notify({
            key: `arb-naked:${arbSlug}`,
            level: "warn",
            title: "Arbitraje incompleto",
            body: `${market.asset}: solo la pata ${thinFirst[0]} llenó (${sets} sets). Queda posición direccional.`,
            minIntervalMs: 60_000,
          });
        } else {
          this.logSkipOnce(market.slug, "arb_execution_failed", { leg: outcome, error: message });
        }
        return;
      }
      legs[outcome] = result.trade;
    }

    const upLeg = legs.UP;
    const downLeg = legs.DOWN;
    if (!upLeg || !downLeg) {
      return;
    }
    const filledSets = Math.min(upLeg.filledShares ?? sets, downLeg.filledShares ?? sets);
    const filledCost = (upLeg.filledAmountUsd ?? upLeg.amountUsd) + (downLeg.filledAmountUsd ?? downLeg.amountUsd);
    const pairTrade: TradeAttempt = {
      ...upLeg,
      id: `${arbSlug}-${nowMs}`,
      slug: arbSlug,
      kind: "arb",
      arbPairComplete: true,
      outcome: thinFirst[0],
      amountUsd: upLeg.amountUsd + downLeg.amountUsd,
      bestAsk: pairCost,
      estimatedShares: sets,
      fillDetected: true,
      filledShares: filledSets,
      filledAmountUsd: filledCost,
      averageFillPrice: filledSets > 0 ? filledCost / filledSets : pairCost,
      feeUsd: estimateTradeFeeUsd(upLeg) + estimateTradeFeeUsd(downLeg),
      // Fills came straight from both execution responses; the per-order reconciler must not
      // reinterpret this synthetic pair from a single legId.
      reconciledAtMs: nowMs,
      response: { arbLegs: { up: upLeg.orderId, down: downLeg.orderId } },
    };
    await this.deps.state.recordTradeAttempt(pairTrade);
    logger.info("Arbitraje ejecutado: par completo bloqueado.", {
      slug: market.slug,
      sets: filledSets,
      pairCost,
      netPerSet: opportunity.netPerSet,
      lockedProfitUsd: Math.round((filledSets - filledCost - pairTrade.feeUsd!) * 100) / 100,
    });
    await this.deps.notifier?.notify({
      key: `arb-executed:${arbSlug}`,
      title: "Arbitraje ejecutado",
      body: [
        `${market.asset}: ${filledSets} sets a $${pairCost.toFixed(3)} el par.`,
        `Ganancia bloqueada ~${formatSignedUsd(filledSets - filledCost - (pairTrade.feeUsd ?? 0))} (paga al cierre, gane quien gane).`,
      ].join("\n"),
      minIntervalMs: 60_000,
    });
  }

  private async executeArbLeg(args: {
    market: MarketInfo;
    outcome: Outcome;
    quote: OrderbookQuote;
    sets: number;
    opening: WindowOpening;
    tick: BtcPriceTick;
    nowMs: number;
  }): Promise<TradeExecutionResult> {
    const candidate: TradeCandidate = {
      market: args.market,
      outcome: args.outcome,
      amountUsd: Math.round(args.sets * args.quote.bestAsk! * 100) / 100,
      // Small buffer over the observed ask so a 1-tick move does not reject the pair mid-flight.
      maxAskPrice: Math.min(args.quote.bestAsk! + 0.02, 0.99),
      opening: args.opening,
      tick: args.tick,
      distanceUsd: 0,
      minDistanceUsd: 0,
      entryWindowSeconds: 0,
      quote: args.quote,
    };
    return this.executeTradeCandidate(candidate);
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
      // Judge the winner by the price AT the window close (last tick <= endMs), not the first tick
      // after it — photo-finish windows flipped otherwise.
      const closeTick = this.deps.priceFeed.getTickAtOrBefore?.(market, trade.endMs);
      const resolution = resolveTradeFromTick(trade, latestTick, nowMs, closeTick);
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
    }
  }

  /**
   * Verify resolutions against Polymarket's OFFICIAL market outcome (gamma reports 1/0 outcome prices
   * once resolved) and correct any mismatch — the source of truth is whoever pays. Our own feed judges
   * the winner from opening vs closing tick, but the opening tick can be captured up to the grace
   * period late (so a brief spike becomes a wrong reference) and photo-finish windows can land on the
   * wrong side of the boundary. Runs for BOTH modes: sim must resolve identically to live for a sim
   * test to faithfully predict live. Throttled (one sweep every 30s, 2 lookups per sweep) so the
   * historical backlog backfills gradually without hammering gamma.
   */
  private async verifyOfficialResolutions(nowMs: number): Promise<void> {
    const getMarketBySlug = this.deps.watcher.getMarketBySlug?.bind(this.deps.watcher);
    if (!getMarketBySlug || nowMs - this.lastOfficialSweepMs < OFFICIAL_SWEEP_INTERVAL_MS) {
      return;
    }
    this.lastOfficialSweepMs = nowMs;

    const candidates = this.deps.state
      .listTrades()
      .filter(
        (trade) =>
          trade.resolved !== undefined &&
          trade.officialResolution === undefined &&
          // Arb pairs pay $1/set regardless of the winner and their "#arb" slug is not a gamma market.
          trade.kind !== "arb" &&
          // Give the official resolution time to land before asking.
          nowMs - trade.endMs > OFFICIAL_RESOLUTION_GRACE_MS &&
          nowMs - (this.officialCheckAttemptsMs.get(`${trade.mode}:${trade.slug}`) ?? 0) > OFFICIAL_RETRY_INTERVAL_MS,
      )
      .slice(0, OFFICIAL_CHECKS_PER_SWEEP);

    for (const trade of candidates) {
      this.officialCheckAttemptsMs.set(`${trade.mode}:${trade.slug}`, nowMs);
      try {
        const market = await getMarketBySlug(trade.slug, nowMs);
        const official = officialWinningOutcome(market);
        if (!official || !trade.resolved) {
          continue;
        }
        const corrected = official !== trade.resolved.winningOutcome;
        await this.deps.state.recordTradeOfficialResolution(trade.slug, trade.mode, {
          winningOutcome: official,
          verifiedAtMs: nowMs,
          corrected,
        });
        if (corrected) {
          logger.warn("Resolución corregida por resultado oficial de Polymarket.", {
            slug: trade.slug,
            outcome: trade.outcome,
            feedWinner: trade.resolved.winningOutcome,
            officialWinner: official,
            wonNow: official === trade.outcome,
          });
          await this.deps.notifier?.notify({
            key: `resolution-corrected:${trade.id ?? trade.slug}`,
            level: "warn",
            title: "Resolución corregida",
            body: [
              `Mercado: ${trade.asset ?? "--"} (${trade.slug}).`,
              `El feed dijo ${trade.resolved.winningOutcome}, Polymarket resolvió ${official}.`,
              `Tu ${trade.outcome} ${official === trade.outcome ? "GANÓ" : "perdió"} oficialmente; P&L ajustado.`,
            ].join("\n"),
            minIntervalMs: 24 * 60 * 60_000,
          });
        }
      } catch (error) {
        logger.warn("No se pudo verificar la resolución oficial; se reintenta.", {
          slug: trade.slug,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private async recordResolvedTradeAnalytics(
    trade: TradeAttempt,
    resolution: NonNullable<TradeAttempt["resolved"]>,
  ): Promise<void> {
    if (!this.deps.analyticsRecorder || trade.kind === "arb") {
      // Arb pairs are direction-neutral: they carry no signal for the momentum models.
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
    // Running P&L of the CURRENT mode since its last reset (the just-resolved trade is already
    // persisted at this point), so every Telegram alert shows how the run is going.
    const resetAtMs = this.deps.state.getPnlResetAtMs?.() ?? {};
    const runPnl = calculatePnlSummaryByMode(this.deps.state.listTrades(), resetAtMs)[trade.mode];
    const runRoi = runPnl.roiPct !== undefined ? ` (${(runPnl.roiPct * 100).toFixed(1)}%)` : "";
    const runResolved = runPnl.wonCount + runPnl.lostCount;
    const runWinRate = runResolved > 0 ? ` (${Math.round((100 * runPnl.wonCount) / runResolved)}% win)` : "";
    // A completed arb pair pays regardless of the winner: never announce it as "lost".
    const arbPair = trade.kind === "arb" && trade.arbPairComplete === true;
    await this.deps.notifier?.notify({
      key: `trade-resolved:${trade.id ?? trade.slug}`,
      category: "trade",
      level: arbPair || resolution.won ? "info" : "warn",
      title: arbPair ? "Arbitraje liquidado" : resolution.won ? "Trade ganado" : "Trade perdido",
      body: [
        `Modo: ${trade.mode}. Mercado: ${trade.asset ?? marketSymbolFromSlug(trade.slug) ?? "--"}.`,
        `Comprado: ${trade.outcome}. Ganador: ${resolution.winningOutcome}.`,
        `Stake: ${formatUsd(trade.amountUsd)}. P&L: ${formatSignedUsd(pnl.netUsd)}.`,
        `P&L corrida ${trade.mode}: ${formatSignedUsd(runPnl.realizedUsd)}${runRoi} · ${runPnl.wonCount}-${runPnl.lostCount}${runWinRate}.`,
        `Precio final: ${formatMarketValue(resolution.finalPrice)}. Distancia: ${formatSignedValue(trade.distanceUsd)}.`,
        `Slug: ${trade.slug}.`,
      ].join("\n"),
      minIntervalMs: 24 * 60 * 60_000,
    });
  }

  private logMarketChange(market: MarketInfo): void {
    if (this.currentSlugs.get(market.asset) === market.slug) {
      return;
    }
    const previousSlug = this.currentSlugs.get(market.asset);
    if (previousSlug !== undefined) {
      this.postOnlySlugs.delete(previousSlug);
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

// Polymarket switches 5-min markets to post-only in the final seconds before close; taker orders are
// rejected with this message until the window ends.
function isPostOnlyRejection(message: string): boolean {
  return /post[- ]?only/i.test(message);
}

// A resolved gamma market reports 1/0 outcome prices. Require a decisive >=0.99 so half-resolved or
// still-trading snapshots (e.g. 0.97/0.03) never count as an official verdict.
function officialWinningOutcome(market: MarketInfo | null): Outcome | undefined {
  if (!market || !market.closed) {
    return undefined;
  }
  const upPrice = market.outcomes.UP?.impliedPrice;
  const downPrice = market.outcomes.DOWN?.impliedPrice;
  if (typeof upPrice === "number" && upPrice >= 0.99 && (downPrice ?? 0) <= 0.01) {
    return "UP";
  }
  if (typeof downPrice === "number" && downPrice >= 0.99 && (upPrice ?? 0) <= 0.01) {
    return "DOWN";
  }
  return undefined;
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

import { EventEmitter } from "node:events";

import { ChainlinkPriceFeed } from "../chainlinkPriceFeed.js";
import { LiveExecutionEngine, resolveTradeAmountUsd, SimulationExecutionEngine } from "../executionEngine.js";
import { type LogEntry, logger } from "../logger.js";
import { getEntryWindowSeconds, getMinDistanceUsd, normalizeEnabledMarkets } from "../markets.js";
import { MarketWatcher } from "../marketWatcher.js";
import { createNotifier, type Notifier } from "../notifier.js";
import { OrderbookService } from "../orderbookService.js";
import { calculatePnlSummary, EMPTY_PNL_SUMMARY } from "../pnl.js";
import { RecommendationEngine } from "../recommendationEngine.js";
import { getWinningOutcome, isTickStale, isWithinEntryWindow } from "../signalEngine.js";
import { StateStore } from "../stateStore.js";
import { secondsToEnd } from "../time.js";
import type { AiRecommendationsResponse, BotConfig, MarketSymbol, Mode, Outcome } from "../types.js";
import { BotRunner } from "../botRunner.js";
import type { MarketStatusSnapshot, SanitizedConfig, UiEvent, UiSettings, UiStatus } from "./shared.js";
import { applySettings, UiSettingsStore } from "./settings.js";

export class ControllerError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
  }
}

export interface RunnerLike {
  start(options?: { once?: boolean }): Promise<void>;
  stop(): void;
  updateStrategySettings?(
    settings: Pick<BotConfig, "minDistanceUsdByMarket" | "entryWindowSeconds" | "entryWindowSecondsByMarket">,
  ): void;
}

export interface BotControllerDeps {
  runnerFactory?: (config: BotConfig) => RunnerLike;
  settingsStore?: UiSettingsStore;
  stateFactory?: () => StateStore;
  watcher?: Pick<MarketWatcher, "getCurrentMarket">;
  orderbook?: Pick<OrderbookService, "getQuote">;
  priceFeed?: Pick<ChainlinkPriceFeed, "start" | "stop" | "getLatestTick">;
  recommendationEngine?: RecommendationEngine;
  notifier?: Notifier;
  snapshotProvider?: () => Promise<Partial<UiStatus>>;
  env?: NodeJS.ProcessEnv;
  startPriceFeed?: boolean;
}

export class BotController {
  private runner?: RunnerLike;
  private runnerPromise?: Promise<void>;
  private mode?: Mode;
  private startedAtMs?: number;
  private lastError?: string;
  private stopped = false;
  private readonly events = new EventEmitter();
  private readonly logs: LogEntry[] = [];
  private readonly settingsStore: UiSettingsStore;
  private readonly stateFactory: () => StateStore;
  private readonly watcher: Pick<MarketWatcher, "getCurrentMarket">;
  private readonly orderbook: Pick<OrderbookService, "getQuote">;
  private readonly priceFeed: Pick<ChainlinkPriceFeed, "start" | "stop" | "getLatestTick">;
  private readonly recommendationEngine: RecommendationEngine;
  private readonly notifier: Notifier;
  private readonly runnerFactory: (config: BotConfig) => RunnerLike;
  private readonly snapshotProvider?: () => Promise<Partial<UiStatus>>;
  private readonly env: NodeJS.ProcessEnv;
  private readonly unsubscribeLogger: () => boolean;
  private lastAutoApplyCheckMs = 0;

  constructor(
    private readonly baseConfig: BotConfig,
    deps: BotControllerDeps = {},
  ) {
    this.env = deps.env ?? process.env;
    this.settingsStore = deps.settingsStore ?? new UiSettingsStore(baseConfig.dataDir);
    this.stateFactory = deps.stateFactory ?? (() => new StateStore(baseConfig.dataDir));
    this.watcher = deps.watcher ?? new MarketWatcher(baseConfig.gammaHost);
    this.orderbook = deps.orderbook ?? OrderbookService.create(baseConfig.clobHost);
    this.priceFeed = deps.priceFeed ?? new ChainlinkPriceFeed(baseConfig.rtdsUrl);
    this.recommendationEngine = deps.recommendationEngine ?? new RecommendationEngine(baseConfig.dataDir);
    this.notifier = deps.notifier ?? createNotifier(baseConfig);
    this.runnerFactory = deps.runnerFactory ?? ((config) => BotRunner.create(config));
    this.snapshotProvider = deps.snapshotProvider;
    this.unsubscribeLogger = logger.subscribe((entry) => this.pushLog(entry));

    if (deps.startPriceFeed !== false) {
      this.priceFeed.start();
    }
  }

  dispose(): void {
    this.stopped = true;
    this.runner?.stop();
    this.priceFeed.stop();
    this.unsubscribeLogger();
  }

  onEvent(listener: (event: UiEvent) => void): () => void {
    this.events.on("event", listener);
    return () => this.events.off("event", listener);
  }

  isRunning(): boolean {
    return this.runnerPromise !== undefined;
  }

  async start(mode: Mode, confirmLive = false): Promise<UiStatus> {
    if (this.runnerPromise) {
      throw new ControllerError("Bot is already running.", 409);
    }

    const settings = await this.settingsStore.load(this.baseConfig);
    const config = this.buildRuntimeConfig(mode, confirmLive, settings);
    if (mode === "live") {
      this.assertLiveAllowed(confirmLive);
    }

    this.runner = this.runnerFactory(config);
    this.mode = mode;
    this.startedAtMs = Date.now();
    this.lastError = undefined;

    this.runnerPromise = this.runner
      .start()
      .catch((error) => {
        this.lastError = error instanceof Error ? error.message : String(error);
        logger.error("UI runner stopped with error.", { error: this.lastError });
        void this.notifier.notify({
          key: "ui-runner-error",
          level: "error",
          title: "Runner detenido con error",
          body: this.lastError,
          minIntervalMs: 5 * 60_000,
        });
      })
      .finally(() => {
        this.runnerPromise = undefined;
        this.runner = undefined;
        this.startedAtMs = undefined;
      });

    return this.getStatus();
  }

  async stop(): Promise<UiStatus> {
    this.runner?.stop();
    this.runner = undefined;
    this.runnerPromise = undefined;
    this.startedAtMs = undefined;
    return this.getStatus();
  }

  async reset(): Promise<UiStatus> {
    if (this.runnerPromise || this.runner) {
      this.runner?.stop();
      this.runner = undefined;
      this.runnerPromise = undefined;
      this.startedAtMs = undefined;
      this.mode = undefined;
    }

    const state = this.stateFactory();
    await state.load();
    await state.reset();
    this.logs.length = 0;
    logger.info("Polybot reset completed.", {
      cleared: ["state", "trades"],
      preserved: ["settings", "env"],
    });
    return this.getStatus();
  }

  async getSettings(): Promise<UiSettings> {
    return this.settingsStore.load(this.baseConfig);
  }

  async patchSettings(patch: Partial<UiSettings>): Promise<UiSettings> {
    if (this.runnerPromise && !isAiToggleOnlyPatch(patch)) {
      throw new ControllerError("Stop the bot before changing settings.", 409);
    }
    const current = await this.settingsStore.load(this.baseConfig);
    const normalizedPatch = { ...patch };
    if (patch.minBtcDistanceUsd !== undefined) {
      normalizedPatch.minDistanceUsdByMarket = {
        ...current.minDistanceUsdByMarket,
        ...patch.minDistanceUsdByMarket,
        BTC: patch.minBtcDistanceUsd,
      };
    }
    if (patch.entryWindowSeconds !== undefined && patch.entryWindowSecondsByMarket === undefined) {
      normalizedPatch.entryWindowSecondsByMarket = {
        BTC: patch.entryWindowSeconds,
        ETH: patch.entryWindowSeconds,
        DOGE: patch.entryWindowSeconds,
      };
    }
    return this.settingsStore.save({ ...current, ...normalizedPatch });
  }

  async getRecommendations(): Promise<AiRecommendationsResponse> {
    const settings = await this.settingsStore.load(this.baseConfig);
    return this.recommendationEngine.recommend(settings);
  }

  async applyRecommendations(markets?: MarketSymbol[]): Promise<{ settings: UiSettings; recommendations: AiRecommendationsResponse }> {
    if (this.runnerPromise) {
      throw new ControllerError("Stop the bot before applying recommendations manually.", 409);
    }
    const settings = await this.settingsStore.load(this.baseConfig);
    const recommendations = await this.recommendationEngine.recommend(settings);
    const selected = filterApplicableRecommendations(recommendations, markets, "manual");
    if (selected.length === 0) {
      throw new ControllerError("No applicable recommendations are available yet.", 409);
    }

    const nextSettings = applySelectedRecommendations(settings, selected, Date.now());
    const saved = await this.settingsStore.save(nextSettings);
    logger.info("AI recommendations applied manually.", {
      markets: selected.map((recommendation) => recommendation.market),
    });
    return {
      settings: saved,
      recommendations: await this.recommendationEngine.recommend(saved),
    };
  }

  async autoApplyRecommendations(markets?: MarketSymbol[]): Promise<{ settings: UiSettings; recommendations: AiRecommendationsResponse }> {
    const settings = await this.settingsStore.load(this.baseConfig);
    const recommendations = await this.recommendationEngine.recommend(settings);
    const selected = filterApplicableRecommendations(recommendations, markets, "auto");
    if (selected.length === 0) {
      throw new ControllerError("No high-confidence recommendations are available for auto-apply.", 409);
    }
    if (!this.runnerPromise || this.mode !== "live") {
      throw new ControllerError("Auto-apply requires the live bot to be running.", 409);
    }
    await this.assertOutsideAutoApplyProtectedWindow(selected);

    const saved = await this.applyAutoRecommendations(settings, selected);
    return {
      settings: saved,
      recommendations: await this.recommendationEngine.recommend(saved),
    };
  }

  async getTrades(limit = 100) {
    const state = this.stateFactory();
    await state.load();
    return state
      .listTrades()
      .sort((left, right) => right.createdAtMs - left.createdAtMs)
      .slice(0, limit);
  }

  async getStatus(): Promise<UiStatus> {
    let settings = await this.settingsStore.load(this.baseConfig);
    if (await this.maybeAutoApplyLiveRecommendations(settings)) {
      settings = await this.settingsStore.load(this.baseConfig);
    }
    const config = this.buildRuntimeConfig(this.mode ?? this.baseConfig.mode, this.mode === "live", settings);
    let snapshot: Partial<UiStatus> = {};
    try {
      snapshot = this.snapshotProvider ? await this.snapshotProvider() : await this.buildSnapshot(settings, config);
    } catch (error) {
      snapshot = {
        signal: { reason: "snapshot_error", inEntryWindow: false },
        markets: [],
        dailySpendUsd: 0,
        pnl: EMPTY_PNL_SUMMARY,
        snapshotError: error instanceof Error ? error.message : String(error),
      };
    }
    const markets = snapshot.markets ?? [];
    const primaryMarket = markets.find((item) => item.market) ?? markets[0];

    return {
      running: this.runnerPromise !== undefined,
      mode: this.mode,
      startedAtMs: this.startedAtMs,
      lastError: this.lastError,
      config: this.sanitizeConfig(config, settings),
      settings,
      liveReadiness: this.getLiveReadiness(),
      markets,
      signal: snapshot.signal ?? primaryMarket?.signal ?? { reason: "no_market", inEntryWindow: false },
      dailySpendUsd: snapshot.dailySpendUsd ?? 0,
      pnl: snapshot.pnl ?? EMPTY_PNL_SUMMARY,
      logs: [...this.logs].reverse(),
      market: primaryMarket?.market ?? snapshot.market,
      opening: primaryMarket?.opening ?? snapshot.opening,
      tick: primaryMarket?.tick ?? snapshot.tick,
      quotes: primaryMarket?.quotes ?? snapshot.quotes,
      snapshotError: snapshot.snapshotError,
    };
  }

  private async maybeAutoApplyLiveRecommendations(settings: UiSettings): Promise<boolean> {
    const nowMs = Date.now();
    if (
      !this.runnerPromise ||
      this.mode !== "live" ||
      !settings.aiAutoApplyLive ||
      nowMs - this.lastAutoApplyCheckMs < 60_000 ||
      (settings.aiLastAppliedAtMs !== undefined && nowMs - settings.aiLastAppliedAtMs < 5 * 60_000)
    ) {
      return false;
    }
    this.lastAutoApplyCheckMs = nowMs;

    const recommendations = await this.recommendationEngine.recommend(settings, nowMs);
    const selected = filterApplicableRecommendations(recommendations, undefined, "auto");
    if (selected.length === 0) {
      return false;
    }
    if (await this.isAutoApplyProtectedWindow(selected)) {
      return false;
    }
    await this.applyAutoRecommendations(settings, selected);
    return true;
  }

  private async assertOutsideAutoApplyProtectedWindow(
    recommendations: AiRecommendationsResponse["recommendations"],
  ): Promise<void> {
    let blocked: { market: MarketSymbol; secondsToEnd: number } | undefined;
    try {
      blocked = await this.findProtectedAutoApplyMarket(recommendations);
    } catch (error) {
      throw new ControllerError(
        `Auto-apply could not verify the active market window: ${
          error instanceof Error ? error.message : String(error)
        }`,
        409,
      );
    }
    if (blocked) {
      throw new ControllerError(
        `Auto-apply paused for ${blocked.market}: ${Math.ceil(blocked.secondsToEnd)}s remain in the active window.`,
        409,
      );
    }
  }

  private async isAutoApplyProtectedWindow(
    recommendations: AiRecommendationsResponse["recommendations"],
  ): Promise<boolean> {
    try {
      const blocked = await this.findProtectedAutoApplyMarket(recommendations);
      if (blocked) {
        logger.info("AI auto-apply paused near market close.", blocked);
        return true;
      }
      return false;
    } catch (error) {
      logger.warn("AI auto-apply skipped because the active window could not be verified.", {
        error: error instanceof Error ? error.message : String(error),
      });
      return true;
    }
  }

  private async findProtectedAutoApplyMarket(
    recommendations: AiRecommendationsResponse["recommendations"],
  ): Promise<{ market: MarketSymbol; secondsToEnd: number } | undefined> {
    const nowMs = Date.now();
    for (const recommendation of recommendations) {
      const market = await this.watcher.getCurrentMarket(nowMs, recommendation.market);
      if (!market) {
        continue;
      }
      const remaining = secondsToEnd(market.endMs, nowMs);
      if (remaining > 0 && remaining <= 65) {
        return { market: recommendation.market, secondsToEnd: remaining };
      }
    }
    return undefined;
  }

  private async applyAutoRecommendations(
    settings: UiSettings,
    recommendations: AiRecommendationsResponse["recommendations"],
  ): Promise<UiSettings> {
    const nextSettings = applySelectedRecommendations(settings, recommendations, Date.now());
    const saved = await this.settingsStore.save(nextSettings);
    const runtimeConfig = this.buildRuntimeConfig(this.mode ?? this.baseConfig.mode, this.mode === "live", saved);
    this.runner?.updateStrategySettings?.({
      minDistanceUsdByMarket: runtimeConfig.minDistanceUsdByMarket,
      entryWindowSeconds: runtimeConfig.entryWindowSeconds,
      entryWindowSecondsByMarket: runtimeConfig.entryWindowSecondsByMarket,
    });
    logger.info("AI recommendations auto-applied.", {
      markets: recommendations.map((recommendation) => recommendation.market),
      minDistanceUsdByMarket: saved.minDistanceUsdByMarket,
      entryWindowSecondsByMarket: saved.entryWindowSecondsByMarket,
    });
    await this.notifier.notify({
      key: `auto-apply:${recommendations.map((recommendation) => recommendation.market).join(",")}`,
      title: "Autoajuste aplicado",
      body: recommendations
        .map((recommendation) => {
          const recommended = recommendation.recommended;
          return recommended
            ? `${recommendation.market}: ventana ${recommended.entryWindowSeconds}s, distancia ${recommended.minDistanceUsd}`
            : recommendation.market;
        })
        .join("\n"),
      minIntervalMs: 5 * 60_000,
    });
    return saved;
  }

  private async buildSnapshot(settings: UiSettings, config: BotConfig): Promise<Partial<UiStatus>> {
    const nowMs = Date.now();
    const state = this.stateFactory();
    await state.load();
    const trades = state.listTrades();
    const pnl = calculatePnlSummary(trades);
    const dailySpendUsd = state.getDailySpend(nowMs);
    const enabledMarkets = normalizeEnabledMarkets(settings.enabledMarkets, []);

    if (enabledMarkets.length === 0) {
      return {
        markets: [],
        dailySpendUsd,
        pnl,
        signal: { reason: "no_markets_enabled", inEntryWindow: false },
      };
    }

    const markets = await Promise.all(
      enabledMarkets.map((market) => this.buildMarketSnapshot(market, settings, config, state, nowMs)),
    );
    const primaryMarket = markets.find((item) => item.market) ?? markets[0];

    return {
      markets,
      market: primaryMarket?.market,
      tick: primaryMarket?.tick,
      opening: primaryMarket?.opening,
      quotes: primaryMarket?.quotes,
      dailySpendUsd,
      pnl,
      signal: primaryMarket?.signal ?? { reason: "market_not_found", inEntryWindow: false },
    };
  }

  private async buildMarketSnapshot(
    marketSymbol: MarketSymbol,
    settings: UiSettings,
    config: BotConfig,
    state: StateStore,
    nowMs: number,
  ): Promise<MarketStatusSnapshot> {
    const market = await this.watcher.getCurrentMarket(nowMs, marketSymbol);
    const tick = this.priceFeed.getLatestTick(marketSymbol);

    if (!market) {
      return {
        marketSymbol,
        tick,
        signal: { market: marketSymbol, reason: "market_not_found", inEntryWindow: false },
      };
    }

    const opening = state.getOpening(market.slug);
    const secondsRemaining = secondsToEnd(market.endMs, nowMs);
    const entryWindowSeconds = getEntryWindowSeconds(
      settings.entryWindowSecondsByMarket,
      marketSymbol,
      settings.entryWindowSeconds,
    );
    const inEntryWindow = isWithinEntryWindow(market.endMs, nowMs, entryWindowSeconds);
    const amountUsd = resolveTradeAmountUsd({
      mode: config.mode,
      requestedUsd: config.mode === "live" ? settings.liveTradeAmountUsd : settings.simTradeAmountUsd,
      orderMinSize: market.orderMinSize,
      autoMinLive: settings.autoMinLive,
    });

    const quotes = await Promise.allSettled([
      this.orderbook.getQuote(market.outcomes.UP.tokenId, amountUsd, settings.maxAskPrice),
      this.orderbook.getQuote(market.outcomes.DOWN.tokenId, amountUsd, settings.maxAskPrice),
    ]);

    const quoteMap: Partial<Record<Outcome, Awaited<ReturnType<OrderbookService["getQuote"]>>>> = {};
    if (quotes[0].status === "fulfilled") {
      quoteMap.UP = quotes[0].value;
    }
    if (quotes[1].status === "fulfilled") {
      quoteMap.DOWN = quotes[1].value;
    }

    return {
      marketSymbol,
      market,
      tick,
      opening,
      quotes: quoteMap,
      signal: this.buildSignalReason({
        market: marketSymbol,
        marketActive: market.active && !market.closed && market.acceptingOrders,
        openingPrice: opening?.openingPrice,
        tickValue: tick?.value,
        tickStale: tick ? isTickStale(tick, nowMs, settings.tickStaleMs) : false,
        inEntryWindow,
        secondsToEnd: secondsRemaining,
        minDistance: getMinDistanceUsd(settings.minDistanceUsdByMarket, marketSymbol),
      }),
    };
  }

  private buildSignalReason(args: {
    market: MarketSymbol;
    marketActive: boolean;
    openingPrice?: number;
    tickValue?: number;
    tickStale: boolean;
    inEntryWindow: boolean;
    secondsToEnd: number;
    minDistance: number;
  }) {
    if (!args.marketActive) {
      return { market: args.market, reason: "market_not_accepting_orders", inEntryWindow: args.inEntryWindow, secondsToEnd: args.secondsToEnd };
    }
    if (args.openingPrice === undefined) {
      return { market: args.market, reason: "missing_opening_chainlink_tick", inEntryWindow: args.inEntryWindow, secondsToEnd: args.secondsToEnd };
    }
    if (args.tickValue === undefined) {
      return { market: args.market, reason: "missing_current_chainlink_tick", inEntryWindow: args.inEntryWindow, secondsToEnd: args.secondsToEnd };
    }
    if (args.tickStale) {
      return { market: args.market, reason: "stale_chainlink_tick", inEntryWindow: args.inEntryWindow, secondsToEnd: args.secondsToEnd };
    }

    const winner = getWinningOutcome(args.openingPrice, args.tickValue, args.minDistance);
    if (!winner) {
      return { market: args.market, reason: "btc_distance_below_threshold", inEntryWindow: args.inEntryWindow, secondsToEnd: args.secondsToEnd };
    }
    if (!args.inEntryWindow) {
      return {
        market: args.market,
        reason: "waiting_entry_window",
        outcome: winner.outcome,
        distanceUsd: winner.distanceUsd,
        inEntryWindow: args.inEntryWindow,
        secondsToEnd: args.secondsToEnd,
      };
    }
    return {
      market: args.market,
      reason: "signal_ready",
      outcome: winner.outcome,
      distanceUsd: winner.distanceUsd,
      inEntryWindow: args.inEntryWindow,
      secondsToEnd: args.secondsToEnd,
    };
  }

  private buildRuntimeConfig(mode: Mode, confirmLive: boolean, settings: UiSettings): BotConfig {
    return applySettings(
      {
        ...this.baseConfig,
        mode,
        confirmLive,
      },
      settings,
    );
  }

  private sanitizeConfig(config: BotConfig, settings: UiSettings): SanitizedConfig {
    return {
      minBtcDistanceUsd: config.minDistanceUsdByMarket.BTC,
      enabledMarkets: config.enabledMarkets,
      minDistanceUsdByMarket: config.minDistanceUsdByMarket,
      entryWindowSeconds: config.entryWindowSeconds,
      entryWindowSecondsByMarket: config.entryWindowSecondsByMarket,
      simTradeAmountUsd: config.simTradeAmountUsd,
      liveTradeAmountUsd: config.liveTradeAmountUsd,
      autoMinLive: config.autoMinLive,
      maxAskPrice: config.maxAskPrice,
      dailySpendLimitUsd: config.dailySpendLimitUsd,
      tickStaleMs: config.tickStaleMs,
      pollIntervalMs: config.pollIntervalMs,
      openingCaptureGraceMs: config.openingCaptureGraceMs,
      aiAutoApplyLive: settings.aiAutoApplyLive,
      aiLastAppliedAtMs: settings.aiLastAppliedAtMs,
      mode: config.mode,
      dataDir: config.dataDir,
      hasPrivateKey: Boolean(config.privateKey),
      hasFunderAddress: Boolean(config.funderAddress),
      hasSignatureType: this.hasConfiguredSignatureType(),
    };
  }

  private getLiveReadiness() {
    const readiness = {
      hasPrivateKey: Boolean(this.baseConfig.privateKey),
      hasFunderAddress: Boolean(this.baseConfig.funderAddress),
      hasSignatureType: this.hasConfiguredSignatureType(),
    };
    const ready = readiness.hasPrivateKey && readiness.hasFunderAddress && readiness.hasSignatureType;
    return {
      ...readiness,
      ready,
      reason: ready ? undefined : "missing_live_configuration",
    };
  }

  private assertLiveAllowed(confirmLive: boolean): void {
    if (!confirmLive) {
      throw new ControllerError("Live mode requires explicit confirmation.", 400);
    }
    const live = this.getLiveReadiness();
    if (!live.ready) {
      throw new ControllerError("Live mode requires private key, funder address, and signature type in .env.", 400);
    }
  }

  private hasConfiguredSignatureType(): boolean {
    return this.env.POLYMARKET_SIGNATURE_TYPE !== undefined && this.env.POLYMARKET_SIGNATURE_TYPE !== "";
  }

  private pushLog(entry: LogEntry): void {
    if (this.stopped) {
      return;
    }
    this.logs.push(entry);
    while (this.logs.length > 300) {
      this.logs.shift();
    }
    this.events.emit("event", { type: "log", log: entry } satisfies UiEvent);
  }
}

function isAiToggleOnlyPatch(patch: Partial<UiSettings>): boolean {
  const keys = Object.keys(patch);
  return keys.length > 0 && keys.every((key) => key === "aiAutoApplyLive");
}

function filterApplicableRecommendations(
  response: AiRecommendationsResponse,
  markets: MarketSymbol[] | undefined,
  mode: "manual" | "auto",
): AiRecommendationsResponse["recommendations"] {
  const marketSet = markets ? new Set(markets) : undefined;
  return response.recommendations.filter((recommendation) => {
    if (marketSet && !marketSet.has(recommendation.market)) {
      return false;
    }
    return mode === "auto" ? recommendation.canAutoApply : recommendation.canApply;
  });
}

function applySelectedRecommendations(
  settings: UiSettings,
  recommendations: AiRecommendationsResponse["recommendations"],
  appliedAtMs: number,
): UiSettings {
  const minDistanceUsdByMarket = { ...settings.minDistanceUsdByMarket };
  const entryWindowSecondsByMarket = { ...settings.entryWindowSecondsByMarket };
  for (const recommendation of recommendations) {
    if (!recommendation.recommended) {
      continue;
    }
    minDistanceUsdByMarket[recommendation.market] = recommendation.recommended.minDistanceUsd;
    entryWindowSecondsByMarket[recommendation.market] = recommendation.recommended.entryWindowSeconds;
  }

  return {
    ...settings,
    minBtcDistanceUsd: minDistanceUsdByMarket.BTC,
    minDistanceUsdByMarket,
    entryWindowSeconds: entryWindowSecondsByMarket.BTC,
    entryWindowSecondsByMarket,
    aiLastAppliedAtMs: appliedAtMs,
  };
}

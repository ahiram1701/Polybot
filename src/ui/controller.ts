import { EventEmitter } from "node:events";
import { join } from "node:path";

import {
  importAnalyticsSamples,
  readAnalyticsSamples,
  serializeAnalyticsSamples,
} from "../analyticsRecorder.js";
import { ChainlinkPriceFeed } from "../chainlinkPriceFeed.js";
import { LiveExecutionEngine, resolveTradeAmountUsd, SimulationExecutionEngine } from "../executionEngine.js";
import { type LogEntry, logger } from "../logger.js";
import {
  defaultEnabledMarketOutcomes,
  getEntryWindowSeconds,
  getEnabledMarketsFromOutcomes,
  getMarketOutcomeBoolean,
  getMarketOutcomeNumber,
  getMinDistanceUsd,
  normalizeEnabledMarkets,
  SUPPORTED_MARKETS,
} from "../markets.js";
import { MarketWatcher } from "../marketWatcher.js";
import {
  createDynamicNotifier,
  TelegramNotificationStore,
  TelegramNotifier,
  type Notifier,
} from "../notifier.js";
import { OrderbookService } from "../orderbookService.js";
import { autoApplyThresholdsForMode, RecommendationEngine, type RecommendationSettings } from "../recommendationEngine.js";
import {
  calculatePnlSummaryByMode,
  calculateResetAwarePnlSummary,
  calculateTradePnl,
  emptyPnlSummaryByMode,
  EMPTY_PNL_SUMMARY,
  type PnlResetAtMsByMode,
  type PnlSummary,
  type PnlSummaryByMode,
} from "../pnl.js";
import { getWinningOutcome, isTickStale, isWithinEntryWindow } from "../signalEngine.js";
import { StateStore } from "../stateStore.js";
import { StrategyAnalysisEngine } from "../strategyAnalysisEngine.js";
import { dailySpendKey, secondsToEnd } from "../time.js";
import type {
  AiRecommendation,
  AiRecommendationsResponse,
  BotConfig,
  MarketInfo,
  MarketOutcomeNumberSettings,
  MarketSymbol,
  Mode,
  OllamaTradeAnalysisResponse,
  Outcome,
  StrategyAnalysisResponse,
  StrategyCandidate,
  StrategyMetrics,
  TradeAttempt,
  WindowOpening,
} from "../types.js";
import { BotRunner } from "../botRunner.js";
import { evaluateRiskCircuitBreaker } from "../riskCircuitBreaker.js";
import type {
  AnalysisImportResponse,
  MarketStatusSnapshot,
  SanitizedConfig,
  TelegramNotificationPatch,
  TelegramNotificationSettings,
  TelegramNotificationTestResponse,
  UiEvent,
  UiSettings,
  UiStatus,
} from "./shared.js";
import { applySettings, UiSettingsStore } from "./settings.js";

const DEFAULT_OLLAMA_HOST = "https://ollama.com";
const DEFAULT_OLLAMA_MODEL = "gpt-oss:120b";
// The predictive autoajuste re-evaluates every 2 minutes: configs don't need per-minute changes, and
// the wider learning window (MAX_RECOMMENDATION_SAMPLES_PER_MARKET) makes each pass heavier, so this
// keeps the CPU duty-cycle low. The compute yields to the event loop, so the bot stays responsive.
const AI_AUTO_APPLY_POLL_MS = 120_000;

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
    settings: Pick<
      BotConfig,
      | "minDistanceUsdByMarket"
      | "minDistanceUsdByMarketOutcome"
      | "entryWindowSeconds"
      | "entryWindowSecondsByMarket"
      | "entryWindowSecondsByMarketOutcome"
    >,
  ): void;
  resetPnl?(mode: Mode): Promise<void>;
  resetRiskHalt?(mode: Mode): Promise<void>;
}

export interface BotControllerDeps {
  runnerFactory?: (config: BotConfig) => RunnerLike;
  settingsStore?: UiSettingsStore;
  stateFactory?: () => StateStore;
  watcher?: Pick<MarketWatcher, "getCurrentMarket">;
  orderbook?: Pick<OrderbookService, "getQuote">;
  priceFeed?: Pick<ChainlinkPriceFeed, "start" | "stop" | "getLatestTick" | "getOpeningTick">;
  strategyAnalysisEngine?: StrategyAnalysisEngine;
  recommendationEngine?: Pick<RecommendationEngine, "recommend">;
  notifier?: Notifier;
  snapshotProvider?: () => Promise<Partial<UiStatus>>;
  fetch?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  startPriceFeed?: boolean;
}

export interface AnalysisExport {
  filename: string;
  contents: string;
  sampleCount: number;
}

interface CachedUiStateSummary {
  signature: string;
  spendKey: string;
  dailySpendUsd: number;
  tradesSorted: TradeAttempt[];
  pnl: PnlSummary;
  pnlByMode: PnlSummaryByMode;
  // All-time PnL ignoring the P&L reset marker, so agents/UI can see lifetime performance
  // alongside the post-reset figures.
  pnlHistoricalByMode: PnlSummaryByMode;
  pnlResetAtMs: PnlResetAtMsByMode;
}

interface UiStateSummary extends CachedUiStateSummary {
  state: StateStore;
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
  private readonly priceFeed: Pick<ChainlinkPriceFeed, "start" | "stop" | "getLatestTick" | "getOpeningTick">;
  private readonly strategyAnalysisEngine: StrategyAnalysisEngine;
  private readonly recommendationEngine: Pick<RecommendationEngine, "recommend">;
  private readonly telegramStore: TelegramNotificationStore;
  private readonly notifier: Notifier;
  private readonly runnerFactory: (config: BotConfig) => RunnerLike;
  private readonly snapshotProvider?: () => Promise<Partial<UiStatus>>;
  private readonly fetchImpl: typeof fetch;
  private readonly env: NodeJS.ProcessEnv;
  private readonly unsubscribeLogger: () => boolean;
  private stateSummaryCache?: CachedUiStateSummary;
  private aiAutoApplyTimer?: ReturnType<typeof setInterval>;
  private aiAutoApplyInFlight = false;

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
    this.strategyAnalysisEngine = deps.strategyAnalysisEngine ?? new StrategyAnalysisEngine(baseConfig.dataDir);
    this.recommendationEngine = deps.recommendationEngine ?? new RecommendationEngine(baseConfig.dataDir);
    this.telegramStore = new TelegramNotificationStore(baseConfig.dataDir, baseConfig, this.env);
    this.notifier = deps.notifier ?? createDynamicNotifier(baseConfig, { fetchFn: deps.fetch, env: this.env });
    this.runnerFactory = deps.runnerFactory ?? ((config) => BotRunner.create(config, { priceFeed: this.priceFeed }));
    this.snapshotProvider = deps.snapshotProvider;
    this.fetchImpl = deps.fetch ?? fetch;
    this.unsubscribeLogger = logger.subscribe((entry) => this.pushLog(entry));

    if (deps.startPriceFeed !== false) {
      this.priceFeed.start();
    }
  }

  dispose(): void {
    this.stopped = true;
    this.stopAiAutoApplyLoop();
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
        this.stopAiAutoApplyLoop();
      });

    this.startAiAutoApplyLoop();
    return this.getStatus();
  }

  async stop(): Promise<UiStatus> {
    this.stopAiAutoApplyLoop();
    this.runner?.stop();
    this.runner = undefined;
    this.runnerPromise = undefined;
    this.startedAtMs = undefined;
    return this.getStatus();
  }

  async reset(): Promise<UiStatus> {
    if (this.runnerPromise || this.runner) {
      this.stopAiAutoApplyLoop();
      this.runner?.stop();
      this.runner = undefined;
      this.runnerPromise = undefined;
      this.startedAtMs = undefined;
      this.mode = undefined;
    }

    const state = this.stateFactory();
    await state.load();
    await state.reset();
    this.stateSummaryCache = undefined;
    this.logs.length = 0;
    logger.info("Polybot reset completed.", {
      cleared: ["state", "trades"],
      preserved: ["settings", "env"],
    });
    return this.getStatus();
  }

  async resetPnl(mode: Mode): Promise<UiStatus> {
    if (this.runner?.resetPnl) {
      // Route through the running bot's own state instance; otherwise its next save would clobber
      // the reset with its stale in-memory state.
      await this.runner.resetPnl(mode);
    } else {
      const state = this.stateFactory();
      await state.load();
      await state.resetPnl(mode);
    }
    this.stateSummaryCache = undefined;
    logger.info("P&L reset completed.", { mode });
    return this.getStatus();
  }

  async resetRiskHalt(mode: Mode): Promise<UiStatus> {
    if (this.runner?.resetRiskHalt) {
      await this.runner.resetRiskHalt(mode);
    } else {
      const state = this.stateFactory();
      await state.load();
      await state.resetRiskHalt(mode);
    }
    this.stateSummaryCache = undefined;
    logger.info("Risk circuit breaker reset.", { mode });
    return this.getStatus();
  }

  async getSettings(): Promise<UiSettings> {
    return this.settingsStore.load(this.baseConfig);
  }

  async patchSettings(patch: Partial<UiSettings>): Promise<UiSettings> {
    if (this.runnerPromise) {
      throw new ControllerError("Stop the bot before changing settings.", 409);
    }
    const current = await this.settingsStore.load(this.baseConfig);
    const normalizedPatch = { ...patch };
    if (patch.enabledMarkets !== undefined && patch.enabledMarketOutcomes === undefined) {
      normalizedPatch.enabledMarketOutcomes = defaultEnabledMarketOutcomes(
        {},
        normalizeEnabledMarkets(patch.enabledMarkets, []),
      );
    }
    if (patch.enabledMarketOutcomes !== undefined) {
      normalizedPatch.enabledMarkets = getEnabledMarketsFromOutcomes(patch.enabledMarketOutcomes);
    }
    if (patch.minBtcDistanceUsd !== undefined) {
      normalizedPatch.minDistanceUsdByMarket = {
        ...current.minDistanceUsdByMarket,
        ...patch.minDistanceUsdByMarket,
        BTC: patch.minBtcDistanceUsd,
      };
    }
    if (normalizedPatch.minDistanceUsdByMarket !== undefined && patch.minDistanceUsdByMarketOutcome === undefined) {
      normalizedPatch.minDistanceUsdByMarketOutcome = mergeMarketValuesIntoOutcomeSettings(
        current.minDistanceUsdByMarketOutcome,
        normalizedPatch.minDistanceUsdByMarket,
      );
    }
    if (patch.minDistanceUsdByMarketOutcome !== undefined && normalizedPatch.minDistanceUsdByMarket === undefined) {
      normalizedPatch.minDistanceUsdByMarket = marketValuesFromOutcomeSettings(
        current.minDistanceUsdByMarket,
        patch.minDistanceUsdByMarketOutcome,
      );
      normalizedPatch.minBtcDistanceUsd = normalizedPatch.minDistanceUsdByMarket.BTC;
    }
    if (patch.entryWindowSeconds !== undefined && patch.entryWindowSecondsByMarket === undefined) {
      normalizedPatch.entryWindowSecondsByMarket = {
        BTC: patch.entryWindowSeconds,
        ETH: patch.entryWindowSeconds,
        DOGE: patch.entryWindowSeconds,
      };
    }
    if (normalizedPatch.entryWindowSecondsByMarket !== undefined && patch.entryWindowSecondsByMarketOutcome === undefined) {
      normalizedPatch.entryWindowSecondsByMarketOutcome = mergeMarketValuesIntoOutcomeSettings(
        current.entryWindowSecondsByMarketOutcome,
        normalizedPatch.entryWindowSecondsByMarket,
      );
    }
    if (patch.entryWindowSecondsByMarketOutcome !== undefined && normalizedPatch.entryWindowSecondsByMarket === undefined) {
      normalizedPatch.entryWindowSecondsByMarket = marketValuesFromOutcomeSettings(
        current.entryWindowSecondsByMarket,
        patch.entryWindowSecondsByMarketOutcome,
      );
      normalizedPatch.entryWindowSeconds = normalizedPatch.entryWindowSecondsByMarket.BTC;
    }
    if (patch.simTradeAmountUsd !== undefined && patch.simTradeAmountUsdByMarketOutcome === undefined) {
      normalizedPatch.simTradeAmountUsdByMarketOutcome = outcomeSettingsForAllMarkets(patch.simTradeAmountUsd);
    }
    if (patch.simTradeAmountUsdByMarketOutcome !== undefined && patch.simTradeAmountUsd === undefined) {
      normalizedPatch.simTradeAmountUsd = patch.simTradeAmountUsdByMarketOutcome.BTC.UP;
    }
    if (patch.liveTradeAmountUsd !== undefined && patch.liveTradeAmountUsdByMarketOutcome === undefined) {
      normalizedPatch.liveTradeAmountUsdByMarketOutcome = outcomeSettingsForAllMarkets(patch.liveTradeAmountUsd);
    }
    if (patch.liveTradeAmountUsdByMarketOutcome !== undefined && patch.liveTradeAmountUsd === undefined) {
      normalizedPatch.liveTradeAmountUsd = patch.liveTradeAmountUsdByMarketOutcome.BTC.UP;
    }
    if (patch.maxAskPrice !== undefined && patch.maxAskPriceByMarketOutcome === undefined) {
      normalizedPatch.maxAskPriceByMarketOutcome = outcomeSettingsForAllMarkets(patch.maxAskPrice);
    }
    if (patch.maxAskPriceByMarketOutcome !== undefined && patch.maxAskPrice === undefined) {
      normalizedPatch.maxAskPrice = patch.maxAskPriceByMarketOutcome.BTC.UP;
    }
    return this.settingsStore.save({ ...current, ...normalizedPatch });
  }

  async getTelegramNotifications(): Promise<TelegramNotificationSettings> {
    return this.telegramStore.loadSanitized();
  }

  async patchTelegramNotifications(patch: TelegramNotificationPatch): Promise<TelegramNotificationSettings> {
    return this.telegramStore.save(patch);
  }

  async testTelegramNotifications(): Promise<TelegramNotificationTestResponse> {
    const config = await this.telegramStore.loadEffective();
    if (!config.enabled) {
      throw new ControllerError("Telegram notifications are disabled.", 409);
    }
    if (!config.botToken || !config.chatId) {
      throw new ControllerError("Telegram bot token and chat id are required.", 409);
    }
    const notifier = new TelegramNotifier({
      botToken: config.botToken,
      chatId: config.chatId,
      publicUrl: config.publicUrl,
      fetchFn: this.fetchImpl,
    });
    await notifier.notify({
      key: `telegram-test:${Date.now()}`,
      title: "Prueba de Telegram",
      body: "Polybot puede enviar notificaciones.",
      minIntervalMs: 0,
    });
    return { ok: true, sentAtMs: Date.now() };
  }

  async getStrategyAnalysis(): Promise<StrategyAnalysisResponse> {
    const settings = await this.settingsStore.load(this.baseConfig);
    return this.strategyAnalysisEngine.analyze(settings);
  }

  async estimateSetupEv(params: {
    market: MarketSymbol;
    outcome: Outcome;
    entryWindowSeconds: number;
    minDistanceUsd: number;
    maxAskPrice: number;
    capitalUsd?: number;
  }): Promise<{ market: MarketSymbol; outcome: Outcome } & StrategyMetrics> {
    const metrics = await this.strategyAnalysisEngine.estimateSetupWinRate(
      params.market,
      params.outcome,
      {
        entryWindowSeconds: params.entryWindowSeconds,
        minDistanceUsd: params.minDistanceUsd,
        maxAskPrice: params.maxAskPrice,
      },
      params.capitalUsd ?? 10,
    );
    return { market: params.market, outcome: params.outcome, ...metrics };
  }

  async getAiRecommendations(nowMs = Date.now()): Promise<AiRecommendationsResponse> {
    const settings = await this.settingsStore.load(this.baseConfig);
    const thresholds = autoApplyThresholdsForMode(this.mode ?? this.baseConfig.mode);
    const response = await this.recommendationEngine.recommend(
      toRecommendationSettings(settings, this.baseConfig.minDistanceFloorUsdByMarket),
      nowMs,
      thresholds,
    );
    // Expose the active thresholds so the Análisis tab can render a pass/fail checklist per market.
    return { ...response, thresholds };
  }

  private startAiAutoApplyLoop(): void {
    if (this.aiAutoApplyTimer || this.stopped) {
      return;
    }
    this.aiAutoApplyTimer = setInterval(() => {
      void this.runAiAutoApplyTick();
    }, AI_AUTO_APPLY_POLL_MS);
    if (typeof this.aiAutoApplyTimer.unref === "function") {
      this.aiAutoApplyTimer.unref();
    }
  }

  private stopAiAutoApplyLoop(): void {
    if (this.aiAutoApplyTimer) {
      clearInterval(this.aiAutoApplyTimer);
      this.aiAutoApplyTimer = undefined;
    }
  }

  async runAiAutoApplyTick(nowMs = Date.now()): Promise<ApplicableRecommendation[]> {
    if (this.aiAutoApplyInFlight || this.stopped || !this.runner || !this.runnerPromise) {
      return [];
    }
    this.aiAutoApplyInFlight = true;
    try {
      const settings = await this.settingsStore.load(this.baseConfig);
      if (!settings.aiAutoApplyLive) {
        return [];
      }
      const response = await this.recommendationEngine.recommend(
        toRecommendationSettings(settings, this.baseConfig.minDistanceFloorUsdByMarket),
        nowMs,
        autoApplyThresholdsForMode(this.mode ?? this.baseConfig.mode),
      );
      const applicable = response.recommendations.filter(isApplicableRecommendation);
      if (applicable.length === 0) {
        return [];
      }
      const nextSettings = applyRecommendationsToSettings(
        settings,
        applicable,
        nowMs,
        this.baseConfig.minDistanceFloorUsdByMarket,
      );
      const saved = await this.settingsStore.save(nextSettings);
      this.stateSummaryCache = undefined;
      this.runner?.updateStrategySettings?.({
        minDistanceUsdByMarket: saved.minDistanceUsdByMarket,
        minDistanceUsdByMarketOutcome: saved.minDistanceUsdByMarketOutcome,
        entryWindowSeconds: saved.entryWindowSeconds,
        entryWindowSecondsByMarket: saved.entryWindowSecondsByMarket,
        entryWindowSecondsByMarketOutcome: saved.entryWindowSecondsByMarketOutcome,
      });
      logger.info("Autoajuste predictivo aplico recomendaciones en tiempo real.", {
        markets: applicable.map((recommendation) => ({
          market: recommendation.market,
          entryWindowSeconds: recommendation.recommended.entryWindowSeconds,
          minDistanceUsd: recommendation.recommended.minDistanceUsd,
          confidence: recommendation.confidence,
          improvementAdjustedRoi: recommendation.improvementAdjustedRoi,
          improvementYield: recommendation.improvementYield,
        })),
      });
      void this.notifier.notify({
        key: "ai-auto-apply",
        title: "Autoajuste predictivo aplicado",
        body: applicable
          .map(
            (recommendation) =>
              `${recommendation.market}: ventana ${recommendation.recommended.entryWindowSeconds}s, distancia ${recommendation.recommended.minDistanceUsd}.`,
          )
          .join("\n"),
        minIntervalMs: 5 * 60_000,
      });
      return applicable;
    } catch (error) {
      logger.warn("Autoajuste predictivo fallo; se reintenta en el proximo ciclo.", {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    } finally {
      this.aiAutoApplyInFlight = false;
    }
  }

  async exportAnalysisSamples(now = new Date()): Promise<AnalysisExport> {
    const samples = await readAnalyticsSamples(this.analyticsPath());
    return {
      filename: analysisExportFilename(now),
      contents: serializeAnalyticsSamples(samples, now),
      sampleCount: samples.length,
    };
  }

  async importAnalysisSamples(contents: string): Promise<AnalysisImportResponse> {
    if (this.runnerPromise || this.runner) {
      throw new ControllerError("Stop the bot before importing analysis data.", 409);
    }
    const result = await importAnalyticsSamples(
      this.analyticsPath(),
      contents,
      undefined,
      this.baseConfig.maxAnalyticsSamples,
    );
    if (result.validSampleCount === 0) {
      throw new ControllerError("Analysis import did not include valid resolved samples.", 400);
    }
    const { validSampleCount: _validSampleCount, ...response } = result;
    return response;
  }

  async analyzeTradesWithOllama(prompt: string): Promise<OllamaTradeAnalysisResponse> {
    const trimmedPrompt = prompt.trim();
    if (!trimmedPrompt) {
      throw new ControllerError("Prompt is required.", 400);
    }
    if (!this.baseConfig.ollamaApiKey) {
      throw new ControllerError("OLLAMA_API_KEY is required to request Ollama Cloud analysis.", 409);
    }

    const settings = await this.settingsStore.load(this.baseConfig);
    const analysis = await this.strategyAnalysisEngine.analyze(settings);
    const stateSummary = await this.getStateSummary();
    const allTrades = stateSummary.tradesSorted;
    const trades = allTrades.slice(0, 50);
    const pnl = stateSummary.pnl;
    const pnlByMode = stateSummary.pnlByMode;
    const model = this.baseConfig.ollamaModel ?? DEFAULT_OLLAMA_MODEL;
    const host = (this.baseConfig.ollamaHost ?? DEFAULT_OLLAMA_HOST).replace(/\/$/, "");
    const contextSummary = `${analysis.summary.sampleCount} muestras, ${analysis.strategies.length} estrategias rankeadas, ${trades.length} trades recientes.`;
    const context = {
      summary: analysis.summary,
      topStrategies: analysis.strategies.slice(0, 12).map(summarizeStrategyCandidate),
      currentStrategies: analysis.currentStrategies.map(summarizeStrategyCandidate),
      pnl,
      pnlByMode,
      recentTrades: trades.slice(0, 25).map(summarizeTrade),
    };

    const response = await this.fetchImpl(`${host}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.baseConfig.ollamaApiKey}`,
      },
      body: JSON.stringify({
        model,
        stream: false,
        messages: [
          {
            role: "system",
            content:
              "Eres un analista de trading cuantitativo. Responde en espanol, separa tesis, riesgos y acciones sugeridas. No recomiendes cambiar settings si los datos son insuficientes.",
          },
          {
            role: "user",
            content: [
              `Prompt del usuario: ${trimmedPrompt}`,
              "Contexto JSON sin credenciales ni respuestas crudas de ordenes:",
              JSON.stringify(context),
            ].join("\n\n"),
          },
        ],
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new ControllerError(
        `Ollama Cloud returned HTTP ${response.status}${body ? `: ${body.slice(0, 200)}` : ""}`,
        502,
      );
    }

    const payload = (await response.json()) as unknown;
    const content = extractOllamaContent(payload);
    if (!content) {
      throw new ControllerError("Ollama Cloud response did not include analysis content.", 502);
    }

    return {
      generatedAtMs: Date.now(),
      model,
      content,
      contextSummary,
    };
  }

  async getTrades(limit = 100) {
    const stateSummary = await this.getStateSummary();
    return stateSummary.tradesSorted.slice(0, limit);
  }

  async getStatus(): Promise<UiStatus> {
    const settings = await this.settingsStore.load(this.baseConfig);
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
        pnlByMode: emptyPnlSummaryByMode(),
        pnlHistoricalByMode: emptyPnlSummaryByMode(),
        pnlResetAtMs: {},
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
      pnlByMode: snapshot.pnlByMode ?? emptyPnlSummaryByMode(),
      pnlHistoricalByMode: snapshot.pnlHistoricalByMode ?? emptyPnlSummaryByMode(),
      pnlResetAtMs: snapshot.pnlResetAtMs ?? {},
      riskHalt: snapshot.riskHalt,
      logs: [...this.logs].reverse(),
      market: primaryMarket?.market ?? snapshot.market,
      opening: primaryMarket?.opening ?? snapshot.opening,
      tick: primaryMarket?.tick ?? snapshot.tick,
      quotes: primaryMarket?.quotes ?? snapshot.quotes,
      snapshotError: snapshot.snapshotError,
    };
  }

  private async buildSnapshot(settings: UiSettings, config: BotConfig): Promise<Partial<UiStatus>> {
    const nowMs = Date.now();
    const stateSummary = await this.getStateSummary(nowMs);
    const { state, tradesSorted, dailySpendUsd, pnl, pnlByMode, pnlHistoricalByMode, pnlResetAtMs } = stateSummary;
    const enabledMarkets = getEnabledMarketsFromOutcomes(settings.enabledMarketOutcomes);
    // Reuse the already-fetched trades (respects the state-summary cache; no extra listTrades call).
    const riskHalt = evaluateRiskCircuitBreaker(
      tradesSorted,
      config.mode,
      { maxDailyLossUsd: config.maxDailyLossUsd, maxConsecutiveLosses: config.maxConsecutiveLosses },
      nowMs,
      state.getRiskHaltResetAtMs()[config.mode] ?? 0,
    );

    if (enabledMarkets.length === 0) {
      return {
        markets: [],
        dailySpendUsd,
        pnl,
        pnlByMode,
        pnlHistoricalByMode,
        pnlResetAtMs,
        riskHalt,
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
      pnlByMode,
      pnlHistoricalByMode,
      pnlResetAtMs,
      riskHalt,
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

    // Fall back to deriving the opening from the price feed's tick history when the persisted state
    // lacks it (e.g. sparsely-updated ETH/DOGE whose opening isn't in this reader's state instance),
    // so the UI reflects the same opening the bot is trading on instead of showing "missing opening".
    const opening = state.getOpening(market.slug) ?? this.deriveOpeningFromFeed(marketSymbol, market, config);
    const secondsRemaining = secondsToEnd(market.endMs, nowMs);
    const entryWindowSecondsByOutcome = {
      UP: this.resolveConfiguredEntryWindow(config, marketSymbol, "UP"),
      DOWN: this.resolveConfiguredEntryWindow(config, marketSymbol, "DOWN"),
    };
    const inEntryWindowByOutcome = {
      UP: isWithinEntryWindow(market.endMs, nowMs, entryWindowSecondsByOutcome.UP),
      DOWN: isWithinEntryWindow(market.endMs, nowMs, entryWindowSecondsByOutcome.DOWN),
    };

    const quotes = await Promise.allSettled([
      this.orderbook.getQuote(
        market.outcomes.UP.tokenId,
        this.resolveRuntimeTradeAmountUsd(config, market, "UP"),
        this.resolveConfiguredMaxAskPrice(config, marketSymbol, "UP"),
      ),
      this.orderbook.getQuote(
        market.outcomes.DOWN.tokenId,
        this.resolveRuntimeTradeAmountUsd(config, market, "DOWN"),
        this.resolveConfiguredMaxAskPrice(config, marketSymbol, "DOWN"),
      ),
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
        inEntryWindowByOutcome,
        enabledByOutcome: {
          UP: this.isConfiguredOutcomeEnabled(config, marketSymbol, "UP"),
          DOWN: this.isConfiguredOutcomeEnabled(config, marketSymbol, "DOWN"),
        },
        secondsToEnd: secondsRemaining,
        minDistance: {
          UP: this.resolveConfiguredMinDistance(config, marketSymbol, "UP"),
          DOWN: this.resolveConfiguredMinDistance(config, marketSymbol, "DOWN"),
        },
      }),
    };
  }

  private deriveOpeningFromFeed(
    marketSymbol: MarketSymbol,
    market: MarketInfo,
    config: BotConfig,
  ): WindowOpening | undefined {
    const tick = this.priceFeed.getOpeningTick?.(marketSymbol, market.windowStartMs, config.openingCaptureGraceMs);
    if (!tick) {
      return undefined;
    }
    return {
      asset: marketSymbol,
      slug: market.slug,
      windowStartMs: market.windowStartMs,
      openingPrice: tick.value,
      openingTickTimestampMs: tick.timestampMs,
      capturedAtMs: Date.now(),
    };
  }

  private async getStateSummary(nowMs = Date.now()): Promise<UiStateSummary> {
    const state = this.stateFactory();
    await state.load();
    const signature = getLoadedStateSignature(state);
    const spendKey = dailySpendKey(nowMs);
    if (signature && this.stateSummaryCache?.signature === signature && this.stateSummaryCache.spendKey === spendKey) {
      return {
        ...this.stateSummaryCache,
        state,
      };
    }

    const trades = state.listTrades();
    const pnlResetAtMs = state.getPnlResetAtMs();
    const summary: CachedUiStateSummary = {
      signature: signature ?? `uncached:${nowMs}`,
      spendKey,
      dailySpendUsd: state.getDailySpend(nowMs),
      tradesSorted: [...trades].sort((left, right) => right.createdAtMs - left.createdAtMs),
      pnl: calculateResetAwarePnlSummary(trades, pnlResetAtMs),
      pnlByMode: calculatePnlSummaryByMode(trades, pnlResetAtMs),
      pnlHistoricalByMode: calculatePnlSummaryByMode(trades),
      pnlResetAtMs,
    };
    if (signature) {
      this.stateSummaryCache = summary;
    }
    return {
      ...summary,
      state,
    };
  }

  private analyticsPath(): string {
    return join(this.baseConfig.dataDir, "analytics.jsonl");
  }

  private buildSignalReason(args: {
    market: MarketSymbol;
    marketActive: boolean;
    openingPrice?: number;
    tickValue?: number;
    tickStale: boolean;
    inEntryWindowByOutcome: Record<Outcome, boolean>;
    enabledByOutcome: Record<Outcome, boolean>;
    secondsToEnd: number;
    minDistance: Record<Outcome, number>;
  }) {
    const anyInEntryWindow = args.inEntryWindowByOutcome.UP || args.inEntryWindowByOutcome.DOWN;
    if (!args.marketActive) {
      return { market: args.market, reason: "market_not_accepting_orders", inEntryWindow: anyInEntryWindow, secondsToEnd: args.secondsToEnd };
    }
    if (args.openingPrice === undefined) {
      return { market: args.market, reason: "missing_opening_chainlink_tick", inEntryWindow: anyInEntryWindow, secondsToEnd: args.secondsToEnd };
    }
    if (args.tickValue === undefined) {
      return { market: args.market, reason: "missing_current_chainlink_tick", inEntryWindow: anyInEntryWindow, secondsToEnd: args.secondsToEnd };
    }
    if (args.tickStale) {
      return { market: args.market, reason: "stale_chainlink_tick", inEntryWindow: anyInEntryWindow, secondsToEnd: args.secondsToEnd };
    }

    const winner = getWinningOutcome(args.openingPrice, args.tickValue, args.minDistance);
    if (!winner) {
      return { market: args.market, reason: "btc_distance_below_threshold", inEntryWindow: anyInEntryWindow, secondsToEnd: args.secondsToEnd };
    }
    if (!args.enabledByOutcome[winner.outcome]) {
      return {
        market: args.market,
        reason: "outcome_disabled",
        outcome: winner.outcome,
        distanceUsd: winner.distanceUsd,
        inEntryWindow: false,
        secondsToEnd: args.secondsToEnd,
      };
    }
    const inEntryWindow = args.inEntryWindowByOutcome[winner.outcome];
    if (!inEntryWindow) {
      return {
        market: args.market,
        reason: "waiting_entry_window",
        outcome: winner.outcome,
        distanceUsd: winner.distanceUsd,
        inEntryWindow,
        secondsToEnd: args.secondsToEnd,
      };
    }
    return {
      market: args.market,
      reason: "signal_ready",
      outcome: winner.outcome,
      distanceUsd: winner.distanceUsd,
      inEntryWindow,
      secondsToEnd: args.secondsToEnd,
    };
  }

  private resolveRuntimeTradeAmountUsd(config: BotConfig, market: { asset: MarketSymbol; orderMinSize: number }, outcome: Outcome): number {
    return resolveTradeAmountUsd({
      mode: config.mode,
      requestedUsd: this.resolveConfiguredTradeAmountUsd(config, market.asset, outcome),
      orderMinSize: market.orderMinSize,
      autoMinLive: config.autoMinLive,
    });
  }

  private resolveConfiguredTradeAmountUsd(config: BotConfig, market: MarketSymbol, outcome: Outcome): number {
    if (config.mode === "live") {
      return getMarketOutcomeNumber(
        config.liveTradeAmountUsdByMarketOutcome,
        market,
        outcome,
        config.liveTradeAmountUsd,
      );
    }
    return getMarketOutcomeNumber(
      config.simTradeAmountUsdByMarketOutcome,
      market,
      outcome,
      config.simTradeAmountUsd,
    );
  }

  private resolveConfiguredMaxAskPrice(config: BotConfig, market: MarketSymbol, outcome: Outcome): number {
    return getMarketOutcomeNumber(config.maxAskPriceByMarketOutcome, market, outcome, config.maxAskPrice);
  }

  private resolveConfiguredMinDistance(config: BotConfig, market: MarketSymbol, outcome: Outcome): number {
    return getMarketOutcomeNumber(
      config.minDistanceUsdByMarketOutcome,
      market,
      outcome,
      getMinDistanceUsd(config.minDistanceUsdByMarket, market),
    );
  }

  private resolveConfiguredEntryWindow(config: BotConfig, market: MarketSymbol, outcome: Outcome): number {
    return getMarketOutcomeNumber(
      config.entryWindowSecondsByMarketOutcome,
      market,
      outcome,
      getEntryWindowSeconds(config.entryWindowSecondsByMarket, market, config.entryWindowSeconds),
    );
  }

  private isConfiguredOutcomeEnabled(config: BotConfig, market: MarketSymbol, outcome: Outcome): boolean {
    return getMarketOutcomeBoolean(config.enabledMarketOutcomes, market, outcome, config.enabledMarkets.includes(market));
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
      enabledMarketOutcomes: config.enabledMarketOutcomes ?? settings.enabledMarketOutcomes,
      minDistanceUsdByMarket: config.minDistanceUsdByMarket,
      minDistanceUsdByMarketOutcome: config.minDistanceUsdByMarketOutcome ?? settings.minDistanceUsdByMarketOutcome,
      entryWindowSeconds: config.entryWindowSeconds,
      entryWindowSecondsByMarket: config.entryWindowSecondsByMarket,
      entryWindowSecondsByMarketOutcome: config.entryWindowSecondsByMarketOutcome ?? settings.entryWindowSecondsByMarketOutcome,
      simTradeAmountUsd: config.simTradeAmountUsd,
      simTradeAmountUsdByMarketOutcome: config.simTradeAmountUsdByMarketOutcome ?? settings.simTradeAmountUsdByMarketOutcome,
      liveTradeAmountUsd: config.liveTradeAmountUsd,
      liveTradeAmountUsdByMarketOutcome: config.liveTradeAmountUsdByMarketOutcome ?? settings.liveTradeAmountUsdByMarketOutcome,
      autoMinLive: config.autoMinLive,
      maxAskPrice: config.maxAskPrice,
      maxAskPriceByMarketOutcome: config.maxAskPriceByMarketOutcome ?? settings.maxAskPriceByMarketOutcome,
      maxAskPriceCeiling: config.maxAskPriceCeiling ?? settings.maxAskPriceCeiling,
      dailySpendLimitUsd: config.dailySpendLimitUsd,
      maxDailyLossUsd: config.maxDailyLossUsd ?? settings.maxDailyLossUsd,
      maxConsecutiveLosses: config.maxConsecutiveLosses ?? settings.maxConsecutiveLosses,
      requirePositiveEv: config.requirePositiveEv ?? settings.requirePositiveEv,
      evSafetyMargin: config.evSafetyMargin ?? settings.evSafetyMargin,
      evMinHistoryTrades: config.evMinHistoryTrades ?? settings.evMinHistoryTrades,
      evMinExpectedRoi: config.evMinExpectedRoi ?? settings.evMinExpectedRoi,
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

function analysisExportFilename(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const hours = pad(date.getHours());
  const minutes = pad(date.getMinutes());
  const seconds = pad(date.getSeconds());
  return `polybot-analysis-${year}${month}${day}-${hours}${minutes}${seconds}.jsonl`;
}

function mergeMarketValuesIntoOutcomeSettings(
  current: MarketOutcomeNumberSettings,
  values: Partial<Record<MarketSymbol, number>>,
): MarketOutcomeNumberSettings {
  const next = cloneOutcomeSettings(current);
  for (const market of SUPPORTED_MARKETS) {
    const value = values[market];
    if (value !== undefined) {
      next[market] = { UP: value, DOWN: value };
    }
  }
  return next;
}

function marketValuesFromOutcomeSettings(
  current: Record<MarketSymbol, number>,
  values: MarketOutcomeNumberSettings,
): Record<MarketSymbol, number> {
  return {
    BTC: values.BTC?.UP ?? current.BTC,
    ETH: values.ETH?.UP ?? current.ETH,
    DOGE: values.DOGE?.UP ?? current.DOGE,
  };
}

type ApplicableRecommendation = AiRecommendation & {
  recommended: NonNullable<AiRecommendation["recommended"]>;
};

function isApplicableRecommendation(recommendation: AiRecommendation): recommendation is ApplicableRecommendation {
  return recommendation.canAutoApply && recommendation.recommended !== undefined;
}

function toRecommendationSettings(
  settings: UiSettings,
  distanceFloors?: Partial<Record<MarketSymbol, number>>,
): RecommendationSettings {
  return {
    minDistanceUsdByMarket: settings.minDistanceUsdByMarket,
    entryWindowSecondsByMarket: settings.entryWindowSecondsByMarket,
    entryWindowSeconds: settings.entryWindowSeconds,
    maxAskPrice: settings.maxAskPrice,
    minDistanceFloorUsdByMarket: distanceFloors,
    aiLastAppliedAtMs: settings.aiLastAppliedAtMs,
  };
}

function applyRecommendationsToSettings(
  settings: UiSettings,
  recommendations: ApplicableRecommendation[],
  nowMs: number,
  distanceFloors?: Partial<Record<MarketSymbol, number>>,
): UiSettings {
  const minDistanceUsdByMarket = { ...settings.minDistanceUsdByMarket };
  const entryWindowSecondsByMarket = { ...settings.entryWindowSecondsByMarket };
  const minDistanceUsdByMarketOutcome = cloneOutcomeSettings(settings.minDistanceUsdByMarketOutcome);
  const entryWindowSecondsByMarketOutcome = cloneOutcomeSettings(settings.entryWindowSecondsByMarketOutcome);

  for (const { market, recommended } of recommendations) {
    // Never let the auto-adjust push distance below the market's edge floor.
    const distance = Math.max(recommended.minDistanceUsd, distanceFloors?.[market] ?? 0);
    minDistanceUsdByMarket[market] = distance;
    entryWindowSecondsByMarket[market] = recommended.entryWindowSeconds;
    minDistanceUsdByMarketOutcome[market] = { UP: distance, DOWN: distance };
    entryWindowSecondsByMarketOutcome[market] = {
      UP: recommended.entryWindowSeconds,
      DOWN: recommended.entryWindowSeconds,
    };
  }

  return {
    ...settings,
    minBtcDistanceUsd: minDistanceUsdByMarket.BTC,
    minDistanceUsdByMarket,
    minDistanceUsdByMarketOutcome,
    entryWindowSeconds: entryWindowSecondsByMarket.BTC,
    entryWindowSecondsByMarket,
    entryWindowSecondsByMarketOutcome,
    aiLastAppliedAtMs: nowMs,
  };
}

function outcomeSettingsForAllMarkets(value: number): MarketOutcomeNumberSettings {
  return {
    BTC: { UP: value, DOWN: value },
    ETH: { UP: value, DOWN: value },
    DOGE: { UP: value, DOWN: value },
  };
}

function cloneOutcomeSettings(settings: MarketOutcomeNumberSettings): MarketOutcomeNumberSettings {
  return {
    BTC: { ...settings.BTC },
    ETH: { ...settings.ETH },
    DOGE: { ...settings.DOGE },
  };
}

function getLoadedStateSignature(state: StateStore): string | undefined {
  const maybeState = state as StateStore & { getLoadedSignature?: () => string };
  return typeof maybeState.getLoadedSignature === "function" ? maybeState.getLoadedSignature() : undefined;
}

function summarizeStrategyCandidate(candidate: StrategyCandidate) {
  return {
    market: candidate.market,
    outcome: candidate.outcome,
    entryWindowSeconds: candidate.entryWindowSeconds,
    minDistanceUsd: candidate.minDistanceUsd,
    maxAskPrice: candidate.maxAskPrice,
    isCurrent: candidate.isCurrent,
    confidence: candidate.confidence,
    riskFlags: candidate.riskFlags,
    qualityScore: candidate.qualityScore,
    evDeltaVsCurrent: candidate.evDeltaVsCurrent,
    metrics: candidate.metrics,
  };
}

function summarizeTrade(trade: TradeAttempt) {
  const pnl = calculateTradePnl(trade);
  return {
    id: trade.id,
    market: trade.asset,
    mode: trade.mode,
    outcome: trade.outcome,
    amountUsd: trade.amountUsd,
    bestAsk: trade.bestAsk,
    expectedValue: trade.expectedValue,
    distanceUsd: trade.distanceUsd,
    entryWindowSeconds: trade.entryWindowSeconds,
    createdAtMs: trade.createdAtMs,
    resolvedWon: trade.resolved?.won,
    pnl,
  };
}

function extractOllamaContent(payload: unknown): string | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }
  const message = payload.message;
  if (isRecord(message) && typeof message.content === "string") {
    return message.content;
  }
  if (typeof payload.response === "string") {
    return payload.response;
  }
  if (typeof payload.content === "string") {
    return payload.content;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

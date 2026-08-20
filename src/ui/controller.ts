import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  importAnalyticsSamples,
  readAnalyticsSamples,
  serializeAnalyticsSamples,
} from "../analyticsRecorder.js";
import {
  reviewArbOpportunities,
  type ArbOpportunity,
  type ArbOpportunitySummary,
} from "../arbMonitor.js";
import { summarizeAskBands, type AskBandSummary } from "../askBands.js";
import { ASK_CAP_TUNER_LOCKS, recommendAskWindow } from "../askCapTuner.js";
import {
  activeProgram,
  decideBandProgram,
  isBandBlacklisted,
  realizedInBand,
  reviewConfirmedProgram,
  startBandProgram,
} from "../bandProbeProgram.js";
import { BandProgramStore } from "../bandProgramStore.js";
import type { BandProgram } from "../bandProbeProgram.js";
import { evaluateBandsCounterfactually, proposeBandsToProbe } from "../counterfactualBands.js";
import { windowAfterConfirmedBand } from "../probeWindow.js";
import { ChainlinkPriceFeed } from "../chainlinkPriceFeed.js";
import { LiveExecutionEngine, resolveTradeAmountUsd, SimulationExecutionEngine } from "../executionEngine.js";
import {
  buildFiscalRows,
  fiscalCsvFilename,
  serializeFiscalCsv,
  summarizeFiscalYear,
  type FiscalRow,
} from "../fiscal.js";
import { ensureBanxicoRates, loadFxStore, resolveRate, saveFxStore } from "../fxRates.js";
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
  filterTradesForPnlReset,
  emptyPnlSummaryByMode,
  isWinningTrade,
  EMPTY_PNL_SUMMARY,
  type PnlResetAtMsByMode,
  type PnlSummary,
  type PnlSummaryByMode,
} from "../pnl.js";
import { getWinningOutcome, isTickStale, isWithinEntryWindow } from "../signalEngine.js";
import { StateStore } from "../stateStore.js";
import { StrategyAnalysisEngine } from "../strategyAnalysisEngine.js";
import { dailySpendKey, secondsToEnd } from "../time.js";
import { shouldSendDailyReport, formatDailyReport } from "../dailyReport.js";
import { dayKeyInTimeZone, resolveTimeZone, yearInTimeZone } from "../timezone.js";
import { validationProgress } from "./client/chartData.js";
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
  FiscalFxPatch,
  FiscalSummaryResponse,
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
// El autoajuste re-evalua cada 10 minutos. Subio desde 2 minutos al ampliar la historia de la rejilla
// (MAX_RECOMMENDATION_SAMPLES_PER_MARKET 900 -> 6.000), que es lo que por fin desbloquea el candado
// pero encarece cada pasada de ~8s a ~57s. Cada 2 minutos eso serian ~48% de CPU disputandosela al
// bucle de trading, y la latencia en el momento de entrar es justo lo que no se puede pagar. A 10
// minutos el ciclo de trabajo queda en ~9%, apenas por encima del 6,5% que costaba antes, con 6,7x
// mas datos. La config de estrategia deriva en horas, no en minutos: no se pierde nada real.
/**
 * Cada cuanto reevalua el autoajuste predictivo.
 *
 * Estaba en 10 min con un coste documentado de ~57s por pasada. Medido en el equipo real (i7-4770,
 * 20.000 muestras) la pasada tarda **~258s**: casi la mitad del intervalo con los cuatro nucleos
 * ocupados. El bucle ya no se queda ciego (la cesion es por tiempo, ver `EventLoopBudget`), pero
 * disputar CPU al camino de trading el 43% del tiempo no aporta nada: como dice el propio motor, "la
 * config de estrategia deriva en horas, no en minutos". A 30 min el ciclo de trabajo baja al ~14% sin
 * perder capacidad de reaccion.
 */
const AI_AUTO_APPLY_POLL_MS = 1_800_000;

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
  /** Fracción de iteraciones del bucle que acabaron lanzando (ventana móvil). */
  getLoopHealth?(): { iterations: number; failed: number; failedPct: number; lagMaxMs?: number };
  /** Capital efectivo de la guardia y su procedencia. */
  getMakerSummary?(): {
    colocadas: number;
    canceladas: number;
    comprometidoUsd: number;
    mercados: Array<{ slug: string; motivo?: string; esperadoUsdDia?: number }>;
  } | undefined;
  getBankroll?(): {
    usd: number;
    source: "onchain" | "declared" | "unknown";
    atMs?: number;
    staleReadingMs?: number;
  };
  /** Programas de sondeo vigentes: el runner los consulta para ensanchar la ventana de ask. */
  setBandPrograms?(programs: readonly BandProgram[]): void;
  updateStrategySettings?(
    settings: Pick<
      BotConfig,
      | "minDistanceUsdByMarket"
      | "minDistanceUsdByMarketOutcome"
      | "entryWindowSeconds"
      | "entryWindowSecondsByMarket"
      | "entryWindowSecondsByMarketOutcome"
    > &
      Partial<Pick<BotConfig, "maxAskPrice" | "maxAskPriceByMarketOutcome" | "minAskPriceByMarketOutcome">>,
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
  priceFeed?: Pick<ChainlinkPriceFeed, "start" | "stop" | "getLatestTick" | "getOpeningTick"> &
    Partial<Pick<ChainlinkPriceFeed, "msSinceLastTick">>;
  strategyAnalysisEngine?: StrategyAnalysisEngine;
  recommendationEngine?: Pick<RecommendationEngine, "recommend">;
  notifier?: Notifier;
  snapshotProvider?: () => Promise<Partial<UiStatus>>;
  fetch?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  startPriceFeed?: boolean;
  // false = sin timer del reporte diario (tests).
  dailyReportTimer?: boolean;
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
  private readonly priceFeed: Pick<ChainlinkPriceFeed, "start" | "stop" | "getLatestTick" | "getOpeningTick"> &
    Partial<Pick<ChainlinkPriceFeed, "msSinceLastTick">>;
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
  // 24h per-market cooldown of the ask-cap tuner (in-memory: a restart re-evaluates, which is fine
  // because the tuner is deterministic over the same ledger).
  private readonly askCapTunedAtMs = new Map<MarketSymbol, number>();
  private bandProgramStoreCache?: BandProgramStore;
  private dailyReportTimer?: NodeJS.Timeout;
  private lastDailyReportDayKey?: string;

  constructor(
    private readonly baseConfig: BotConfig,
    deps: BotControllerDeps = {},
  ) {
    this.env = deps.env ?? process.env;
    this.settingsStore = deps.settingsStore ?? new UiSettingsStore(baseConfig.dataDir);
    this.stateFactory = deps.stateFactory ?? (() => new StateStore(baseConfig.dataDir, baseConfig.timezone));
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

    // Auto-reporte diario: chequeo ligero cada 10 min; envía UNA vez al cruzar la hora configurada.
    // Corre aunque el bot esté detenido (el reporte incluye precisamente ese estado).
    if (deps.dailyReportTimer !== false) {
      this.dailyReportTimer = setInterval(() => void this.runDailyReportTick(), 10 * 60_000);
      this.dailyReportTimer.unref?.();
    }
  }

  dispose(): void {
    this.stopped = true;
    this.stopAiAutoApplyLoop();
    if (this.dailyReportTimer) {
      clearInterval(this.dailyReportTimer);
      this.dailyReportTimer = undefined;
    }
    this.runner?.stop();
    this.priceFeed.stop();
    this.unsubscribeLogger();
  }

  /** Sends the daily Telegram self-report when the configured hour is crossed. Public for tests. */
  async runDailyReportTick(nowMs = Date.now()): Promise<void> {
    try {
      const telegram = await this.telegramStore.loadSanitized();
      if (!telegram.dailyReportEnabled || !telegram.configured) {
        return;
      }
      const settings = await this.settingsStore.load(this.baseConfig);
      const schedule = shouldSendDailyReport({
        nowMs,
        hour: telegram.dailyReportHour,
        timeZone: settings.timezone,
        lastSentDayKey: this.lastDailyReportDayKey,
      });
      if (!schedule.send) {
        return;
      }
      this.lastDailyReportDayKey = schedule.dayKey;

      const stateSummary = await this.getStateSummary(nowMs);
      const config = applySettings(this.baseConfig, settings);
      // El reporte habla del modo que esta corriendo, no de "live" fijo: en sim salia vacio o con
      // historia live vieja.
      const reportMode = this.mode ?? this.baseConfig.mode;
      const postReset = filterTradesForPnlReset(stateSummary.tradesSorted, stateSummary.pnlResetAtMs).filter(
        (trade) => trade.mode === reportMode && trade.resolved,
      );
      const todayKey = dayKeyInTimeZone(nowMs, settings.timezone);
      const today = stateSummary.tradesSorted.filter(
        (trade) =>
          trade.mode === reportMode &&
          trade.resolved &&
          dayKeyInTimeZone(trade.resolved.resolvedAtMs, settings.timezone) === todayKey,
      );
      const progress = validationProgress(postReset);
      const riskHalt = evaluateRiskCircuitBreaker(
        stateSummary.tradesSorted,
        this.mode ?? this.baseConfig.mode,
        {
          maxDailyLossUsd: config.maxDailyLossUsd,
          maxConsecutiveLosses: config.maxConsecutiveLosses,
          cooldownHours: config.riskHaltCooldownHours,
          timeZone: config.timezone,
        },
        nowMs,
        stateSummary.state.getRiskHaltResetAtMs()[this.mode ?? this.baseConfig.mode] ?? 0,
      );
      const capTuner = SUPPORTED_MARKETS.map((market) => {
        const bands = summarizeAskBands(stateSummary.tradesSorted, reportMode, {}, { market });
        const current = settings.maxAskPriceByMarketOutcome[market].UP;
        const floor = settings.minAskPriceByMarketOutcome[market].UP;
        return { market, current, target: recommendAskWindow(bands, { floor, cap: current })?.targetCap };
      });
      let autoAdjust: { market: string; state: string }[] = [];
      try {
        const recommendations = await this.recommendationEngine.recommend(
          toRecommendationSettings(settings, this.baseConfig.minDistanceFloorUsdByMarket, this.baseConfig.minSecondsToEndForEntry, await this.loadResolvedTradesForGuard()),
          nowMs,
          autoApplyThresholdsForMode(this.mode ?? this.baseConfig.mode),
        );
        autoAdjust = recommendations.recommendations.map((recommendation) => ({
          market: recommendation.market,
          state: recommendation.canAutoApply ? "auto-aplicable" : recommendation.canApply ? "aplicable (manual)" : "esperando datos",
        }));
      } catch {
        // El reporte sale igual sin la sección de autoajuste.
      }

      const sumNet = (trades: typeof today) =>
        trades.reduce((sum, trade) => sum + (calculateTradePnl(trade).netUsd ?? 0), 0);
      const report = formatDailyReport({
        dayKey: schedule.dayKey,
        mode: this.mode,
        running: this.isRunning(),
        todayNetUsd: sumNet(today),
        todayTrades: today.length,
        todayWins: today.filter((trade) => isWinningTrade(trade)).length,
        postResetNetUsd: sumNet(postReset),
        postResetTrades: postReset.length,
        validationTarget: progress.target,
        varianceBandUsd: progress.varianceBandUsd,
        withinBand: progress.withinBand,
        riskHalt: { tripped: riskHalt.tripped, reason: riskHalt.reason },
        autoAdjust,
        capTuner,
        memoryRssMb: Math.round(process.memoryUsage().rss / 1_048_576),
      });
      void this.notifier.notify({
        key: `daily-report:${schedule.dayKey}`,
        title: report.title,
        body: report.body,
        minIntervalMs: 0,
      });
      logger.info("Reporte diario enviado.", { dayKey: schedule.dayKey });
    } catch (error) {
      logger.warn("Reporte diario falló; se reintenta en el próximo chequeo.", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Peor bloqueo del bucle de eventos observado. Un bot congelado esta tan ciego como uno sin feed. */
  loopBlockedMs(): number | undefined {
    return this.runner?.getLoopHealth?.()?.lagMaxMs;
  }

  /** Antiguedad del ultimo tick del feed, para que la salud pueda decir la verdad. */
  feedStalenessMs(nowMs = Date.now()): number | undefined {
    return this.priceFeed.msSinceLastTick?.(nowMs);
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
    } else if (config.arbMode === "live" || config.directionalMode === "live") {
      // Una estrategia en live dentro de un arranque en sim. Por decision explicita del usuario el
      // ajuste basta y NO se pide confirmacion aqui: asi el watchdog puede reiniciar solo. Lo que no se
      // salta es la comprobacion de credenciales — sin ellas cada oportunidad fallaria al ejecutar, que
      // es la peor forma de enterarse.
      this.assertLiveReady();
    }

    const runner = this.runnerFactory(config);
    this.runner = runner;
    this.mode = mode;
    this.startedAtMs = Date.now();
    this.lastError = undefined;

    this.runnerPromise = runner
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
        // Solo limpia si este runner SIGUE siendo el vigente.
        //
        // `stop()` borra las referencias en el acto, pero el runner viejo tarda en terminar su
        // iteracion. En un stop -> start seguido, su `finally` llegaba despues de que el nuevo ya se
        // hubiera registrado y le borraba el estado: el bucle nuevo seguia operando mientras la UI
        // decia "detenido" y `this.runner` estaba a undefined, o sea que el boton de parar ya no lo
        // alcanzaba. Un runner huerfano. Con modos por estrategia eso puede ser dinero real operando
        // detras de una insignia que dice lo contrario.
        if (this.runner !== runner) {
          return;
        }
        this.runnerPromise = undefined;
        this.runner = undefined;
        this.startedAtMs = undefined;
        this.stopAiAutoApplyLoop();
      });

    this.startAiAutoApplyLoop();
    // Los sondeos vigentes, al runner YA. El ciclo de autoajuste corre cada 30 min, asi que esperarlo
    // dejaria media hora sin sondear despues de cada arranque — y con el watchdog reiniciando, esa
    // media hora se repite y los programas no avanzan nunca.
    void this.pushBandProgramsToRunner();
    return this.getStatus();
  }

  /** Carga los programas persistidos y se los pasa al runner. Nunca lanza: es una mejora, no un
   * requisito para operar. */
  private async pushBandProgramsToRunner(): Promise<void> {
    try {
      this.bandProgramStoreCache ??= new BandProgramStore(this.baseConfig.dataDir);
      const programas = await this.bandProgramStoreCache.load();
      this.runner?.setBandPrograms?.(programas);
    } catch (error) {
      logger.warn("No se pudieron cargar los sondeos de banda al arrancar.", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
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
      toRecommendationSettings(settings, this.baseConfig.minDistanceFloorUsdByMarket, this.baseConfig.minSecondsToEndForEntry, await this.loadResolvedTradesForGuard()),
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
      let settings = await this.settingsStore.load(this.baseConfig);
      let applicable: ApplicableRecommendation[] = [];

      if (settings.aiAutoApplyLive) {
        const response = await this.recommendationEngine.recommend(
          toRecommendationSettings(settings, this.baseConfig.minDistanceFloorUsdByMarket, this.baseConfig.minSecondsToEndForEntry, await this.loadResolvedTradesForGuard()),
          nowMs,
          autoApplyThresholdsForMode(this.mode ?? this.baseConfig.mode),
        );
        applicable = response.recommendations.filter(isApplicableRecommendation);
        if (applicable.length > 0) {
          const nextSettings = applyRecommendationsToSettings(
            settings,
            applicable,
            nowMs,
            this.baseConfig.minDistanceFloorUsdByMarket,
          );
          const saved = await this.settingsStore.save(nextSettings);
          settings = saved;
          this.stateSummaryCache = undefined;
          this.runner?.updateStrategySettings?.({
            minDistanceUsdByMarket: saved.minDistanceUsdByMarket,
            minDistanceUsdByMarketOutcome: saved.minDistanceUsdByMarketOutcome,
            entryWindowSeconds: saved.entryWindowSeconds,
            entryWindowSecondsByMarket: saved.entryWindowSecondsByMarket,
            entryWindowSecondsByMarketOutcome: saved.entryWindowSecondsByMarketOutcome,
      minAskPriceByMarketOutcome: saved.minAskPriceByMarketOutcome,
      maxAskPriceByMarketOutcome: saved.maxAskPriceByMarketOutcome,
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
        }
      }

      // Dos interruptores, no uno: estrechar y abrir no comparten ni riesgo ni maquinaria.
      if (settings.aiAutoTuneAskCap) {
        await this.runAskCapTuning(settings, nowMs);
      }
      if (settings.aiAutoProbeBands) {
        await this.runBandProbePrograms(settings, nowMs);
      }
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

  /**
   * El ciclo de sondeos: propone, sondea, decide y vigila.
   *
   * Es la parte que puede ABRIR la ventana, y por eso no se fia de una sola fuente. El contrafactual
   * (analitica, ~20k ventanas) propone; los sondeos reales confirman; y despues sigue vigilando por si
   * hay que deshacerlo. Cada paso puede tumbar al anterior.
   */
  private async runBandProbePrograms(settings: UiSettings, nowMs: number): Promise<void> {
    // Perezoso: los campos de clase se inicializan antes que los parametros del constructor.
    this.bandProgramStoreCache ??= new BandProgramStore(this.baseConfig.dataDir);
    const store = this.bandProgramStoreCache;
    await store.load();
    const stateSummary = await this.getStateSummary(nowMs);
    let programas = [...store.list()];
    let cambio = false;

    for (const market of SUPPORTED_MARKETS) {
      const ventana = {
        floor: settings.minAskPriceByMarketOutcome[market].UP,
        cap: settings.maxAskPriceByMarketOutcome[market].UP,
      };
      const enCurso = activeProgram(programas, market);

      // 1) Hay sondeo abierto: ¿ya hay muestra para veredicto?
      if (enCurso) {
        const realizado = realizedInBand(stateSummary.tradesSorted, enCurso);
        const decidido = decideBandProgram(enCurso, realizado, nowMs);
        if (decidido !== enCurso) {
          programas = programas.map((p) => (p === enCurso ? decidido : p));
          cambio = true;
          if (decidido.status === "confirmed") {
            const abierta = windowAfterConfirmedBand(ventana, decidido);
            await this.applyAskWindow(settings, market, abierta, decidido.verdict ?? "sondeo confirmado");
          }
          await this.notifier?.notify({
            key: `band-program:${market}:${decidido.lo}-${decidido.hi}`,
            level: decidido.status === "confirmed" ? "info" : "warn",
            title: decidido.status === "confirmed" ? "Banda confirmada" : "Banda descartada",
            body: `${market} ${decidido.lo}-${decidido.hi}: ${decidido.verdict}`,
            minIntervalMs: 60_000,
          });
        }
        continue;
      }

      // 2) Vigilancia de lo ya confirmado: un cambio aplicado no queda bendecido para siempre.
      for (const confirmado of programas.filter((p) => p.market === market && p.status === "confirmed")) {
        const revisado = reviewConfirmedProgram(confirmado, realizedInBand(stateSummary.tradesSorted, confirmado), nowMs);
        if (revisado !== confirmado) {
          programas = programas.map((p) => (p === confirmado ? revisado : p));
          cambio = true;
          const cerrada = { floor: ventana.floor, cap: Math.min(ventana.cap, confirmado.lo) };
          await this.applyAskWindow(settings, market, cerrada, revisado.verdict ?? "revertido");
        }
      }

      // 3) Sin sondeo en curso: buscar candidata nueva.
      const bandas = await evaluateBandsCounterfactually(
        this.strategyAnalysisEngine,
        market,
        {
          entryWindowSeconds: settings.entryWindowSecondsByMarketOutcome[market].UP,
          minDistanceUsd: settings.minDistanceUsdByMarketOutcome[market].UP,
        },
        {
          safetyMargin: settings.evSafetyMargin,
          minExpectedRoi: settings.evMinExpectedRoi,
          stakeUsd: settings.simTradeAmountUsdByMarketOutcome[market].UP,
        },
      );
      const propuesta = proposeBandsToProbe(bandas, ventana).find(
        (p) => !isBandBlacklisted(programas, market, p.lo, p.hi, nowMs),
      );
      if (!propuesta) {
        continue;
      }
      const nuevo = startBandProgram({
        market,
        lo: propuesta.lo,
        hi: propuesta.hi,
        expectedNetPerTradeUsd: propuesta.expectedNetPerTradeUsd,
        outOfSampleTrades: propuesta.outOfSampleTrades,
        reason: propuesta.reason,
        nowMs,
      });
      programas.push(nuevo);
      cambio = true;
      await this.notifier?.notify({
        key: `band-program-start:${market}:${nuevo.lo}-${nuevo.hi}`,
        level: "info",
        title: "Sondeo de banda iniciado",
        body: `${market} ${nuevo.lo}-${nuevo.hi}: promete $${nuevo.expectedNetPerTradeUsd.toFixed(3)}/trade. ${nuevo.reason}`,
        minIntervalMs: 60_000,
      });
    }

    if (cambio) {
      await store.replaceAll(programas);
    }
    // SIEMPRE, no solo cuando hay cambio. El runner arranca sin programas, asi que tras un reinicio
    // —y el watchdog reinicia— no sondearia; sin sondeos no hay veredicto, y sin veredicto no hay
    // cambio que dispare este envio. Un bloqueo perfecto que ademas no da la cara: se veria como "los
    // sondeos no hacen nada", indistinguible de "todavia no hay muestra".
    this.runner?.setBandPrograms?.(programas);
  }

  /** Escribe una ventana de ask nueva para un mercado, en ambos lados. */
  private async applyAskWindow(
    settings: UiSettings,
    market: MarketSymbol,
    ventana: { floor: number; cap: number },
    motivo: string,
  ): Promise<void> {
    const caps = structuredClone(settings.maxAskPriceByMarketOutcome);
    const floors = structuredClone(settings.minAskPriceByMarketOutcome);
    caps[market] = { UP: ventana.cap, DOWN: ventana.cap };
    floors[market] = { UP: ventana.floor, DOWN: ventana.floor };
    await this.settingsStore.save({ ...settings, maxAskPriceByMarketOutcome: caps, minAskPriceByMarketOutcome: floors });
    this.stateSummaryCache = undefined;
    logger.info("Ventana de ask movida por el ciclo de sondeos.", { market, ...ventana, motivo });
  }

  /**
   * Ask-cap auto-tuning from REALIZED live bands (full live history: fill quality across regimes), with
   * the tuner's pre-committed locks plus a 24h per-market cooldown. Applies to both sides at once and
   * notifies every change — the cap is the highest-impact money knob, so it never moves silently.
   */
  private async runAskCapTuning(settings: UiSettings, nowMs: number): Promise<void> {
    const stateSummary = await this.getStateSummary(nowMs);
    const changes: {
      market: MarketSymbol;
      fromFloor: number;
      toFloor: number;
      from: number;
      to: number;
      target: number;
      reason: string;
    }[] = [];
    const nextCaps = structuredClone(settings.maxAskPriceByMarketOutcome);
    const nextFloors = structuredClone(settings.minAskPriceByMarketOutcome);
    for (const market of SUPPORTED_MARKETS) {
      const lastTunedAtMs = this.askCapTunedAtMs.get(market) ?? 0;
      if (nowMs - lastTunedAtMs < ASK_CAP_TUNER_LOCKS.COOLDOWN_MS) {
        continue;
      }
      // Respeta el marcador de reset, igual que la tabla que ve el usuario (`getAskBandSummary`).
      // Iba con `{}`: tras un reset el usuario veia la tabla limpia mientras el tuner —que es el que
      // ESCRIBE settings— seguia recortando con datos de la etapa anterior. Un reset es el usuario
      // diciendo "eso era otro montaje"; quien decide es justo el que debe hacerle caso.
      const bands = summarizeAskBands(
        stateSummary.tradesSorted,
        this.mode ?? this.baseConfig.mode,
        stateSummary.pnlResetAtMs,
        { market },
      );
      const currentFloor = settings.minAskPriceByMarketOutcome[market].UP;
      const currentCap = settings.maxAskPriceByMarketOutcome[market].UP;
      // Tuner de VENTANA: mueve piso y techo. El de solo-techo no podia excluir la cola barata
      // perdedora — su unica reaccion era apretar el techo y cortaba la parte rentable.
      // La base sale de baseConfig (variables de entorno), que el tuner NUNCA escribe — solo escribe
      // los settings de la UI. Es lo que impide que los recortes se acumulen: cada evaluacion parte de
      // la misma referencia fija y aplica solo lo que la evidencia sostiene AHORA.
      //
      // Sin base no se ajusta nada. Antes esto caia en `?? currentFloor`, y como config.ts ni siquiera
      // definia el suelo, la "base" del suelo acababa siendo el valor ya recortado: el trinquete
      // seguia intacto justo en el borde que mas importa, y en silencio.
      const baseline = this.baseConfig.askWindowBaseline;
      if (!baseline) {
        continue; // sin base no se ajusta nada: recortar contra la ventana actual seria el trinquete
      }
      const recommendation = recommendAskWindow(bands, { floor: currentFloor, cap: currentCap }, baseline);
      if (!recommendation) {
        continue;
      }
      nextFloors[market] = { UP: recommendation.nextFloor, DOWN: recommendation.nextFloor };
      nextCaps[market] = { UP: recommendation.nextCap, DOWN: recommendation.nextCap };
      this.askCapTunedAtMs.set(market, nowMs);
      changes.push({
        market,
        fromFloor: currentFloor,
        toFloor: recommendation.nextFloor,
        from: currentCap,
        to: recommendation.nextCap,
        target: recommendation.targetCap,
        reason: recommendation.reason,
      });
    }
    if (changes.length === 0) {
      return;
    }
    const saved = await this.settingsStore.save({
      ...settings,
      maxAskPriceByMarketOutcome: nextCaps,
      minAskPriceByMarketOutcome: nextFloors,
    });
    this.stateSummaryCache = undefined;
    this.runner?.updateStrategySettings?.({
      minDistanceUsdByMarket: saved.minDistanceUsdByMarket,
      minDistanceUsdByMarketOutcome: saved.minDistanceUsdByMarketOutcome,
      entryWindowSeconds: saved.entryWindowSeconds,
      entryWindowSecondsByMarket: saved.entryWindowSecondsByMarket,
      entryWindowSecondsByMarketOutcome: saved.entryWindowSecondsByMarketOutcome,
      maxAskPrice: saved.maxAskPrice,
      maxAskPriceByMarketOutcome: saved.maxAskPriceByMarketOutcome,
      minAskPriceByMarketOutcome: saved.minAskPriceByMarketOutcome,
    });
    logger.info("Auto-tuning de la ventana de ask aplicado desde bandas realizadas.", { changes });
    void this.notifier.notify({
      key: `ask-cap-tuned:${nowMs}`,
      title: "Ventana de ask auto-ajustada",
      body: changes
        .map(
          (change) =>
            `${change.market}: ventana [${change.fromFloor.toFixed(2)}, ${change.from.toFixed(2)}] -> [${change.toFloor.toFixed(2)}, ${change.to.toFixed(2)}] (objetivo techo ${change.target.toFixed(2)}). ${change.reason}`,
        )
        .join("\n"),
      minIntervalMs: 0,
    });
  }

  async exportAnalysisSamples(now = new Date()): Promise<AnalysisExport> {
    const samples = await readAnalyticsSamples(this.analyticsPath());
    const settings = await this.settingsStore.load(this.baseConfig);
    return {
      filename: analysisExportFilename(now, settings.timezone),
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

  /** Realized net by ask band (post-reset, official resolutions included) — the ask-cap decision table. */
  async getAskBandSummary(mode: Mode = "live"): Promise<AskBandSummary> {
    const stateSummary = await this.getStateSummary();
    return summarizeAskBands(stateSummary.tradesSorted, mode, stateSummary.pnlResetAtMs);
  }

  /**
   * Oportunidades de arbitraje detectadas, con el motivo por el que cada una no se pudo capturar.
   * `data/arb-opportunities.jsonl` se venia grabando sin que nada lo mostrase: con ~0.7 oportunidades
   * validas al dia, perder una por un motivo corregible sale caro y hay que poder verlo.
   */
  async getArbOpportunities(): Promise<ArbOpportunitySummary> {
    const settings = await this.settingsStore.load(this.baseConfig);
    let raw = "";
    try {
      raw = await readFile(join(this.baseConfig.dataDir, "arb-opportunities.jsonl"), "utf8");
    } catch {
      return { detected: 0, executable: 0, blocked: { net_below_threshold: 0, capital_below_min_legs: 0 }, capturableUsd: 0, recent: [] };
    }
    const opportunities = raw
      .split(/\r?\n/)
      .filter((line) => line.trim().length > 0)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as ArbOpportunity];
        } catch {
          return [];
        }
      });
    return reviewArbOpportunities(opportunities, {
      minNetPerSet: settings.arbMinNetPerSet,
      // Mínimo real de estos mercados; gamma lo confirma en cada evento.
      orderMinSize: 5,
      budgetUsd: settings.arbMaxUsdPerOpportunity,
    });
  }

  async getFiscalSummary(year?: number): Promise<FiscalSummaryResponse> {
    const rows = await this.buildFiscalRowsWithRates();
    const settings = await this.settingsStore.load(this.baseConfig);
    const targetYear = year ?? yearInTimeZone(Date.now(), settings.timezone);
    const summary = summarizeFiscalYear(rows, targetYear);
    const store = await loadFxStore(this.baseConfig.dataDir);
    return {
      summary,
      fx: { banxicoTokenConfigured: Boolean(store.banxicoToken), manualRates: store.manualRates },
    };
  }

  async exportFiscalCsv(year?: number, now = new Date()): Promise<{ filename: string; contents: string }> {
    const rows = await this.buildFiscalRowsWithRates();
    const settings = await this.settingsStore.load(this.baseConfig);
    const targetYear = year ?? yearInTimeZone(now.getTime(), settings.timezone);
    const yearRows = rows.filter((row) => row.fechaIso.startsWith(`${targetYear}-`));
    return {
      filename: fiscalCsvFilename(targetYear, now.getTime(), settings.timezone),
      contents: serializeFiscalCsv(yearRows),
    };
  }

  async updateFiscalFxConfig(patch: FiscalFxPatch): Promise<FiscalSummaryResponse> {
    const store = await loadFxStore(this.baseConfig.dataDir);
    if (patch.banxicoToken !== undefined) {
      store.banxicoToken = patch.banxicoToken.trim() || undefined;
    }
    for (const [key, value] of Object.entries(patch.manualRates ?? {})) {
      if (value === null) {
        delete store.manualRates[key];
      } else if (/^\d{4}-\d{2}(-\d{2})?$/.test(key) && Number.isFinite(value) && value > 0) {
        store.manualRates[key] = value;
      }
    }
    await saveFxStore(this.baseConfig.dataDir, store);
    return this.getFiscalSummary(patch.year);
  }

  // Live resolved trades -> fiscal rows, fetching any missing Banxico rates first (best-effort: a
  // Banxico outage or bad token must never break the report — MXN simply stays blank).
  private async buildFiscalRowsWithRates(): Promise<FiscalRow[]> {
    const settings = await this.settingsStore.load(this.baseConfig);
    const timeZone = settings.timezone;
    const stateSummary = await this.getStateSummary();
    const liveResolved = stateSummary.tradesSorted.filter((trade) => trade.mode === "live" && trade.resolved);
    const store = await loadFxStore(this.baseConfig.dataDir);
    const dates = buildFiscalRows(liveResolved, undefined, timeZone).map((row) => row.fechaIso);
    try {
      const added = await ensureBanxicoRates(store, dates, this.fetchImpl);
      if (added > 0) {
        await saveFxStore(this.baseConfig.dataDir, store);
      }
    } catch (error) {
      logger.warn("No se pudieron obtener tipos de cambio de Banxico; el reporte sigue sin MXN.", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return buildFiscalRows(liveResolved, (fechaIso) => resolveRate(store, fechaIso), timeZone);
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

  /**
   * Operaciones resueltas del modo activo, para el veto por rendimiento realizado del autoajuste.
   *
   * Se filtra por modo porque sim y live no son la misma poblacion de rellenos. Si falla la lectura se
   * devuelve vacio y el veto se abstiene: nunca debe tumbar una evaluacion por un problema de E/S.
   */
  private async loadResolvedTradesForGuard(): Promise<TradeAttempt[]> {
    try {
      const stateSummary = await this.getStateSummary();
      const mode = this.mode ?? this.baseConfig.mode;
      return stateSummary.tradesSorted.filter((trade) => trade.mode === mode && trade.resolved);
    } catch {
      return [];
    }
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
      effectiveModes: {
        // Con el bot parado `this.mode` no existe todavia; el heredado es entonces el de la config.
        arb: settings.arbMode === "heredado" ? this.mode ?? config.mode : settings.arbMode,
        directional:
          settings.directionalMode === "heredado" ? this.mode ?? config.mode : settings.directionalMode,
        // El maker NO hereda: cae a "sim" por diseno, porque es el unico que deja ordenes vivas.
        maker: settings.makerMode === "heredado" ? "sim" : settings.makerMode,
      },
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
      loopHealth: this.runner?.getLoopHealth?.(),
      makerSummary: this.runner?.getMakerSummary?.(),
      bankroll: this.runner?.getBankroll?.(),
      bandPrograms: this.bandProgramStoreCache?.list() as never,
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
      {
        maxDailyLossUsd: config.maxDailyLossUsd,
        maxConsecutiveLosses: config.maxConsecutiveLosses,
        cooldownHours: config.riskHaltCooldownHours,
        timeZone: config.timezone,
      },
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
    // One source of truth for the spend-day timezone: every caller shares the same cache key.
    const timeZone = (await this.settingsStore.load(this.baseConfig)).timezone;
    const state = this.stateFactory();
    await state.load();
    const signature = getLoadedStateSignature(state);
    const spendKey = dailySpendKey(nowMs, timeZone);
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
      dailySpendUsd: state.getDailySpend(nowMs, timeZone),
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
      autoStartSimOnBoot: settings.autoStartSimOnBoot,
      watchdogEnabled: settings.watchdogEnabled,
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
      minAskPriceByMarketOutcome: config.minAskPriceByMarketOutcome ?? settings.minAskPriceByMarketOutcome,
      maxAskPriceCeiling: config.maxAskPriceCeiling ?? settings.maxAskPriceCeiling,
      dailySpendLimitUsd: config.dailySpendLimitUsd,
      maxDailyLossUsd: config.maxDailyLossUsd ?? settings.maxDailyLossUsd,
      liveBankrollUsd: config.liveBankrollUsd ?? settings.liveBankrollUsd,
      minBankrollForDirectionalUsd: config.minBankrollForDirectionalUsd ?? settings.minBankrollForDirectionalUsd,
      riskHaltCooldownHours: config.riskHaltCooldownHours ?? settings.riskHaltCooldownHours,
      arbEnabled: config.arbEnabled ?? settings.arbEnabled,
      makerEnabled: config.makerEnabled ?? settings.makerEnabled,
      makerMode: config.makerMode ?? settings.makerMode,
      makerCapitalUsd: config.makerCapitalUsd ?? settings.makerCapitalUsd,
      makerRetireSecondsBeforeClose: config.makerRetireSecondsBeforeClose ?? settings.makerRetireSecondsBeforeClose,
      makerMarketSource: config.makerMarketSource ?? settings.makerMarketSource,
      makerStopBelowUsd: config.makerStopBelowUsd ?? settings.makerStopBelowUsd,
      arbMode: config.arbMode ?? settings.arbMode,
      directionalMode: config.directionalMode ?? settings.directionalMode,
      arb15mEnabled: config.arb15mEnabled ?? settings.arb15mEnabled,
      arbNakedLegHaltStreak: config.arbNakedLegHaltStreak ?? settings.arbNakedLegHaltStreak,
      arbMaxUsdPerOpportunity: config.arbMaxUsdPerOpportunity ?? settings.arbMaxUsdPerOpportunity,
      arbMinNetPerSet: config.arbMinNetPerSet ?? settings.arbMinNetPerSet,
      timezone: config.timezone ?? settings.timezone,
      maxConsecutiveLosses: config.maxConsecutiveLosses ?? settings.maxConsecutiveLosses,
      requirePositiveEv: config.requirePositiveEv ?? settings.requirePositiveEv,
      explorationEnabled: config.explorationEnabled ?? settings.explorationEnabled,
      evUseSimilarity: config.evUseSimilarity ?? settings.evUseSimilarity,
      evCalibration: config.evCalibration ?? settings.evCalibration,
      aiAutoTuneAskCap: config.aiAutoTuneAskCap ?? settings.aiAutoTuneAskCap,
      aiAutoProbeBands: config.aiAutoProbeBands ?? settings.aiAutoProbeBands,
      evSafetyMargin: config.evSafetyMargin ?? settings.evSafetyMargin,
      evMinHistoryTrades: config.evMinHistoryTrades ?? settings.evMinHistoryTrades,
      minFillRatio: config.minFillRatio ?? settings.minFillRatio,
      evMinExpectedRoi: config.evMinExpectedRoi ?? settings.evMinExpectedRoi,
      tickStaleMs: config.tickStaleMs,
      pollIntervalMs: config.pollIntervalMs,
      openingCaptureGraceMs: config.openingCaptureGraceMs,
      minDistanceFloorUsdByMarket: config.minDistanceFloorUsdByMarket ?? settings.minDistanceFloorUsdByMarket,
      liveMaxSlippage: config.liveMaxSlippage ?? settings.liveMaxSlippage,
      maxAnalyticsSamples: config.maxAnalyticsSamples ?? settings.maxAnalyticsSamples,
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
    this.assertLiveReady();
  }

  private assertLiveReady(): void {
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

function analysisExportFilename(date: Date, timeZone?: string): string {
  const day = dayKeyInTimeZone(date.getTime(), timeZone).replaceAll("-", "");
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone: resolveTimeZone(timeZone),
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  })
    .format(date)
    .replaceAll(":", "");
  return `polybot-analysis-${day}-${time}.jsonl`;
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
  minSecondsToEndForEntry?: number,
  resolvedTrades?: TradeAttempt[],
): RecommendationSettings {
  return {
    minDistanceUsdByMarket: settings.minDistanceUsdByMarket,
    entryWindowSecondsByMarket: settings.entryWindowSecondsByMarket,
    entryWindowSeconds: settings.entryWindowSeconds,
    maxAskPrice: settings.maxAskPrice,
    // La ventana de ask que aplica el bot, no solo el techo global. Sin esto el motor puntuaba
    // entradas que produccion rechaza y llegaba a recomendar configuraciones IMPOSIBLES: fijo la
    // distancia de BTC en 49 USD (que empuja el ask a 0.96+) con la ventana en [0.70, 0.80], y el
    // 100% de las señales de BTC murio en `no_ask_liquidity_under_cap` sin que nada lo detectara.
    minAskPriceByMarketOutcome: settings.minAskPriceByMarketOutcome,
    maxAskPriceByMarketOutcome: settings.maxAskPriceByMarketOutcome,
    minDistanceFloorUsdByMarket: distanceFloors,
    // El motor simula con la MISMA guardia de cierre que usa el bot; si no, sobrevalora las ventanas
    // cortas porque cuenta segundos en los que nunca se entra.
    minSecondsToEndForEntry,
    resolvedTrades,
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
    resolvedWon: trade.resolved ? isWinningTrade(trade) : undefined,
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

import { appendFile } from "node:fs/promises";
import { join } from "node:path";

import { AnalyticsRecorder, ANALYTICS_WINDOW_SECONDS } from "./analyticsRecorder.js";
import { detectCompleteSetArb, type ArbOpportunity } from "./arbMonitor.js";
import { detectMintArb } from "./mintMonitor.js";
import { AskWindowDeadlockDetector, describeDeadlock } from "./askWindowDeadlock.js";
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
import {
  OnChainBankrollSource,
  resolveEffectiveBankrollUsd,
  type BankrollReading,
  type BankrollSource,
} from "./liveBalance.js";
import { activeProgram, type BandProgram } from "./bandProbeProgram.js";
import { effectiveAskWindow, isProbeEntry, PROBE_MAX_PER_MARKET_DAY } from "./probeWindow.js";
import { startEventLoopLagMonitor } from "./eventLoopLag.js";
import { logger } from "./logger.js";
import { LOOP_PHASES, PhaseTimer, unaccountedMs, type LoopPhaseMs } from "./loopPhases.js";
import { LiveTradeReconciler, NoopTradeReconciler, type TradeReconciler } from "./liveTradeReconciler.js";
import {
  DEFAULT_MIN_SECONDS_TO_END,
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
// La constante vive en markets.ts porque los simuladores tambien tienen que respetarla.
// Spread maximo (ask - bid) para entrar. Medido sobre 1.742 ventanas candidatas: el resultado se
// degrada de forma MONOTONA con el spread — hasta 0.02 gana 60.8% contra un break-even de 53.0%, y por
// encima de 0.12 gana 50.9% contra 55.0%. Lo que lo hace creible mas alla del patron es el mecanismo:
// un spread ancho significa poca contraparte, asi que el precio cotizado es menos fiable y pagas el
// diferencial completo. Los numeros absolutos de ese analisis son optimistas (asume llenado al ask);
// lo fiable es el ORDEN, comun a todos los tramos.
//
// 2026-08-02, REPLICADO sobre 114 trades REALES ejecutados (no simulados) con el mismo orden
// monotono: 0.000-0.015 gano 56.0% y +$52.45; 0.015-0.030 bajo a 50.0% y -$3.82; 0.030-0.060 a 40.0%
// y -$12.05. El umbral baja de 0.05 a 0.02: por encima de 0.015 el resultado ya es negativo, y esta
// es la unica relacion que ha aparecido dos veces, en datos distintos, en la misma direccion.
const DEFAULT_MAX_ASK_SPREAD = 0.02;
// Cadencia del escaneo de arbitraje FUERA de la ventana de analytics. El arbitraje aparece en
// cualquier momento del ciclo, no solo en los ultimos 120s, pero cotizar cada segundo durante los 300
// degrada el loop. 3s cubre el resto de la ventana sin ahogar el camino caliente.
const ARB_SCAN_INTERVAL_MS = 3_000;

/** Patas sueltas seguidas antes de dejar de intentar arbitrajes. */
const ARB_NAKED_LEG_HALT_STREAK = 2;
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
  /** Opcional: los dobles de test no lo implementan y el bucle funciona igual, solo con la cache fria. */
  prefetchNextWindow?(markets: readonly MarketSymbol[], nowMs?: number): void;
  /** Ventanas de otra duracion, solo para arbitraje. Opcional: los dobles de test no lo implementan. */
  getCurrentMarketsForDuration?(
    markets: readonly MarketSymbol[],
    duration: "5m" | "15m",
    nowMs?: number,
  ): Promise<MarketInfo[]>;
}

export interface RunnerPriceFeed {
  start(): void;
  stop(): void;
  getLatestTick(market?: MarketSymbol): BtcPriceTick | undefined;
  getTickInRange?(market: MarketSymbol, startMs: number, endMs: number): BtcPriceTick | undefined;
  getOpeningTick?(market: MarketSymbol, windowStartMs: number, graceMs: number): BtcPriceTick | undefined;
  getTickAtOrBefore?(market: MarketSymbol, timestampMs: number): BtcPriceTick | undefined;
  /**
   * Serie TWAP publicada, que es la que RESUELVE estos mercados desde el 2026-08-07. Opcional para no
   * romper los dobles de test, pero en produccion es la fuente buena: las reglas del mercado dicen
   * "no segun ninguna otra fuente ni mercados spot".
   */
  getTwapAtOrBefore?(market: MarketSymbol, timestampMs: number, maxAgeMs?: number): BtcPriceTick | undefined;
}

interface BotDependencies {
  watcher: MarketWatcherLike;
  /**
   * Ejecutores por modo. Con estrategias en modos distintos hacen falta los DOS a la vez: el de
   * simulacion para la que aprende y el real para la que gana. Opcional para no romper los dobles de
   * test, que inyectan uno solo.
   */
  executorByMode?: Partial<Record<Mode, TradeExecutor>>;
  reconcilerByMode?: Partial<Record<Mode, TradeReconciler>>;
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
  /** Lee el colateral real on-chain. Ausente = la guardia de capital usa el valor declarado. */
  bankrollSource?: BankrollSource;
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
  /**
   * Que estrategia lo genero. Decide con que modo se ejecuta —y por tanto si mueve dinero real—, asi
   * que no es una etiqueta informativa. Ausente = direccional, que es de donde vienen casi todos.
   */
  strategy?: "arb" | "dir";
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
  /** Paralelo a `loopDurationsMs`: si esa iteración acabó lanzando. */
  private readonly loopFailures: boolean[] = [];
  private readonly loopPhasesMs: Array<LoopPhaseMs & { sinAtribuir: number }> = [];
  /** Última lectura del saldo on-chain; `undefined` mientras no se haya conseguido ninguna. */
  /**
   * Capital comprometido en arbitrajes DENTRO de la iteracion en curso. Los tres mercados comparten
   * la misma ventana de 5 min, asi que sus oportunidades tienden a aparecer a la vez; sin esto cada
   * una se dimensionaria contra el saldo ENTERO, porque la lectura on-chain esta cacheada y no baja
   * al gastar. Dos arbitrajes de $10 con $10 en la cuenta dejan el segundo a medio llenar.
   */
  private arbCommittedUsdThisIteration = 0;

  /**
   * Patas sueltas seguidas. Es el unico riesgo real del arbitraje: si la segunda pata deja de llenar
   * de forma sistematica (libro roto, post-only, saldo mal leido) cada intento abre una posicion
   * direccional que nadie pidio. Dos seguidas ya no es mala suerte.
   */
  private arbNakedLegStreak = 0;

  /**
   * Retraso del bucle de eventos. Distingue "esperando a la red" de "bloqueado", que es la diferencia
   * que hoy no se puede hacer: hay picos de captura de 41 segundos con timeouts de 2s en las
   * peticiones, y un timeout que no salta en 41s solo se explica si nada corria.
   */
  private readonly eventLoopLag = startEventLoopLagMonitor();

  /**
   * Poda periodica, en su PROPIO temporizador y no en el bucle.
   *
   * Separada a proposito: podar lee el fichero entero y bloquea el proceso varios segundos. Mientras
   * eso ocurra el bot esta ciego, asi que lo unico aceptable es que no coincida con la captura.
   */
  private pruneTimer?: NodeJS.Timeout;

  /**
   * Sondeos de banda en curso. El autoajuste no puede ver bandas donde nunca ha operado, asi que para
   * comprobar una candidata hay que dejar entrar unas pocas operaciones a su precio — con presupuesto.
   */
  private bandPrograms: readonly BandProgram[] = [];
  private readonly probeCountByDayMarket = new Map<string, number>();

  private lastBankrollReading?: BankrollReading;
  private readonly askWindowDetector = new AskWindowDeadlockDetector();
  /** Evita encadenar lecturas de saldo si una va lenta. */
  private bankrollRefreshInFlight = false;
  private lastLoopStatsLogMs = 0;
  // Cold-start exploration budget: how many exploratory probes have fired per `${dayKey}:${market}`.
  // In-memory on purpose — a restart resets it, which only makes exploration MORE conservative.
  private readonly explorationCountByDayMarket = new Map<string, number>();
  /** Ultimo escaneo de arbitraje por slug, para la cadencia reducida fuera de la ventana. */
  private readonly lastArbScanMs = new Map<string, number>();

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
      // Los dos disponibles a la vez: con arbitraje en live y direccional en sim hacen falta ambos en la
      // misma iteracion. El motor live se construye siempre, pero solo lo usa quien tenga modo live.
      executorByMode: {
        sim: new SimulationExecutionEngine(config),
        live: new LiveExecutionEngine(config),
      },
      reconcilerByMode: {
        sim: new NoopTradeReconciler(),
        live: new LiveTradeReconciler(config),
      },
      analyticsRecorder: new AnalyticsRecorder(config.dataDir, config.maxAnalyticsSamples),
      strategyAnalysisEngine: new StrategyAnalysisEngine(config.dataDir),
      notifier: createDynamicNotifier(config),
      // Se lee en AMBOS modos aunque la guardia solo actue en live: el saldo real es lo que hay que
      // mirar mientras el arbitraje hace crecer el capital hacia el umbral, y en sim es cuando mas se
      // mira la pantalla. Es una lectura cacheada a 60s, no pesa.
      bankrollSource: config.funderAddress
        ? new OnChainBankrollSource(config.funderAddress, config.polygonRpcUrl)
        : undefined,
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
    // Poda ANTES de que el bucle empiece. Es cara —lee el fichero entero— y por eso no puede correr
    // mientras se opera: bloqueaba el bucle casi 8 segundos, y un arbitraje dura segundos.
    await this.deps.analyticsRecorder?.pruneIfNeeded?.(true);
    const tamanoMb = await this.deps.analyticsRecorder?.analyticsSizeMb?.();
    if (tamanoMb !== undefined) {
      logger.info("Analitica en disco.", { mb: tamanoMb, tope: "10.000 muestras" });
    }
    // A partir de aqui, cada media hora y solo si de verdad hace falta: el recuento ya es conocido,
    // asi que la comprobacion es gratis y la lectura cara solo ocurre al pasarse del tope.
    this.pruneTimer ??= setInterval(
      () => {
        void this.deps.analyticsRecorder?.pruneIfNeeded?.().catch((error) => {
          logger.warn("La poda de analitica fallo; se reintenta en el proximo ciclo.", {
            error: error instanceof Error ? error.message : String(error),
          });
        });
      },
      30 * 60_000,
    );
    this.pruneTimer.unref?.();
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
    if (this.pruneTimer) {
      clearInterval(this.pruneTimer);
      this.pruneTimer = undefined;
    }
    this.stopPriceFeed();
  }

  private stopPriceFeed(): void {
    if (this.deps.ownsPriceFeed ?? true) {
      this.deps.priceFeed.stop();
    }
  }

  /**
   * Una iteracion del bucle, midiendo SIEMPRE — tambien cuando lanza.
   *
   * `recordLoopTiming` era la ultima linea del cuerpo, asi que una iteracion que fallaba no se
   * registraba nunca: los p50/p95 publicados excluian por construccion justo las iteraciones lentas
   * que acababan en timeout, y el percentil salia sano mientras el bot se quedaba ciego 6 segundos.
   */
  async runOnce(nowMs = Date.now()): Promise<void> {
    const startedAt = Date.now();
    // El cronometro se crea AQUI, no dentro de runIteration: si la iteracion lanza, lo medido hasta el
    // fallo se registra igual. Antes una iteracion que reventaba publicaba fases a cero.
    const timer = new PhaseTimer();
    let failed = false;
    try {
      await this.runIteration(nowMs, timer);
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      this.recordLoopTiming(Date.now() - startedAt, timer.phases(), failed);
    }
  }

  private async runIteration(nowMs: number, timer: PhaseTimer): Promise<void> {

    // SIN await: la lectura tiene timeout de 8s y esperarla bloqueaba el bucle entero cada vez que el
    // RPC iba lento — exactamente la clase de parón que este mismo fichero intenta evitar. El saldo no
    // cambia entre iteraciones, asi que se refresca en segundo plano y se usa la ultima lectura buena.
    if (this.deps.bankrollSource && !this.bankrollRefreshInFlight) {
      this.bankrollRefreshInFlight = true;
      void this.deps.bankrollSource
        .read(nowMs)
        .then((reading) => {
          if (reading) {
            this.lastBankrollReading = reading;
          }
        })
        .catch(() => undefined)
        .finally(() => {
          this.bankrollRefreshInFlight = false;
        });
    }

    await timer.time("reconcile", () => this.reconcileLiveTrades(nowMs));
    await timer.time("resolve", () => this.resolveCompletedTrades(nowMs));

    // El aislamiento por mercado vive en el watcher y en `getCurrentMarkets`: un fallo parcial ya no
    // llega hasta aqui. Lo que SI sube es el apagon total, y debe seguir subiendo — el bucle continuo
    // lo captura en `runLoopIteration` y un `start({ once: true })` se lo devuelve a quien llamo.
    // Calienta la ventana siguiente durante la parte tranquila de la actual: el cambio de ventana era
    // el unico sitio donde la cache llegaba fria, y ahi un fetch lento cuesta el precio de apertura.
    // Va SIN await a proposito — no debe sumar ni un milisegundo al bucle.
    this.deps.watcher.prefetchNextWindow?.(SUPPORTED_MARKETS, nowMs);
    const markets = await timer.time("fetch", () => this.getCurrentMarkets(SUPPORTED_MARKETS, nowMs));
    if (markets.length === 0) {
      this.logSkipOnce("unknown", "market_not_found", { observedMarkets: SUPPORTED_MARKETS });
      // La verificación oficial no depende de mercados abiertos; debe seguir corriendo.
      await timer.time("verify", () => this.verifyOfficialResolutions(nowMs));
      return;
    }

    const tradeSignals: TradeSignal[] = [];
    this.arbCommittedUsdThisIteration = 0;
    const analyticsQuotesBySlug = new Map<string, Partial<Record<Outcome, OrderbookQuote>>>();
    const directionalMode = this.modeFor("dir");
    const dailySpendUsd = this.deps.state.getDailySpend(nowMs, undefined, directionalMode);
    let reservedSpendUsd = 0;
    // Cortacircuitos SOLO del direccional, con el modo del direccional y sus propias operaciones.
    //
    // Las dos exclusiones son deliberadas. El arbitraje queda fuera porque un par completo redime $1/set
    // gane quien gane: pararlo por una racha ajena seria dejar de recoger dinero sin riesgo. Y el modo es
    // el suyo, no el global, porque si no una racha de perdidas en papel podria frenar dinero real —o al
    // reves, y eso es peor: unas ganancias simuladas tapando perdidas reales.
    const riskHalt = evaluateRiskCircuitBreaker(
      this.deps.state.listTrades().filter((trade) => trade.kind !== "arb"),
      directionalMode,
      {
        maxDailyLossUsd: this.config.maxDailyLossUsd,
        maxConsecutiveLosses: this.config.maxConsecutiveLosses,
        cooldownHours: this.config.riskHaltCooldownHours,
        timeZone: this.config.timezone,
      },
      nowMs,
      this.deps.state.getRiskHaltResetAtMs?.()?.[directionalMode] ?? 0,
    );
    if (riskHalt.tripped) {
      this.notifyRiskHalt(riskHalt, nowMs);
    }

    // FASE 1 — captura, EN PARALELO por mercado: la parte lenta son las llamadas HTTP al orderbook y
    // la persistencia de analytics; en serie sumaban ~2s por iteración (gap de ticks medido p50 2s,
    // 42% >3s). Es seguro: los samples por mercado son disjuntos, writeFileAtomic serializa por path y
    // aquí no se mueve dinero. Todo lo que decide/ejecuta queda en la FASE 2 secuencial.
    const observations = await timer.time("capture", () =>
      Promise.all(
      markets.map(async (market: MarketInfo) => {
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
        await this.observeMintOpportunity(market, analyticsQuotes, nowMs);
        return { market, latestTick, opening, analyticsQuotes, arbOpportunity };
      }),
      ),
    );

    // FASE 2 — decisión y ejecución, secuencial (orden determinista, límites de gasto compartidos).
    for (const { market, latestTick, opening, analyticsQuotes, arbOpportunity } of observations) {
      analyticsQuotesBySlug.set(market.slug, analyticsQuotes);
      // El cortacircuitos NO frena el arbitraje. Sus dos disparadores — perdida diaria y racha de
      // perdidas — miden riesgo DIRECCIONAL; un par completo redime $1/set gane quien gane, asi que
      // pararlo tras un dia malo quita justo la unica estrategia que recupera capital sin arriesgar.
      // El riesgo propio del arbitraje es otro — que se quede una pata sola — y lo cubre la racha de
      // patas sueltas, que si para.
      const arbBloqueado = this.arbNakedLegStreak >= ARB_NAKED_LEG_HALT_STREAK;
      if (arbOpportunity && arbBloqueado) {
        this.logSkipOnce(market.slug, "arb_naked_leg_halt", { streak: this.arbNakedLegStreak });
      }
      if (arbOpportunity && !arbBloqueado && opening && latestTick) {
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

    const candidates = await timer.time("decide", async () => {
      const built = await this.buildTradeCandidates(tradeSignals, analyticsQuotesBySlug);
      await this.executeTradeCandidates(built);
      return built;
    });
    void candidates;

    // Fuera del camino caliente: la verificación oficial (2 HTTP a gamma cada 30s) corre al FINAL del
    // tick, después de capturar precios y decidir — su latencia ya no retrasa la lectura del mercado.
    // Ventanas de 15m: SOLO arbitraje.
    //
    // El arbitraje no usa ningun ajuste por mercado — distancia, ventana de entrada y banda de ask son
    // todos del camino direccional — asi que soportarlas cuesta esto y no una dimension de duracion en
    // toda la configuracion. Y son tres veces mas ventanas donde puede aparecer un par barato, que es
    // la unica estrategia con ventaja estructural.
    //
    // Va DESPUES del camino de 5m a proposito: la reserva de capital por iteracion ya se ha aplicado,
    // asi que un arbitraje de 15m no puede comprometer un saldo que otro de 5m acaba de gastar.
    if (this.config.arbEnabled === true && this.config.arb15mEnabled === true) {
      await timer.time("capture", () => this.runArb15m(nowMs));
    }

    await timer.time("verify", () => this.verifyOfficialResolutions(nowMs));
  }

  /** Observa y ejecuta arbitraje en las ventanas de 15m. Nunca genera señales direccionales. */
  private async runArb15m(nowMs: number): Promise<void> {
    const fetch15m = this.deps.watcher.getCurrentMarketsForDuration;
    if (!fetch15m) {
      return;
    }
    let markets: MarketInfo[];
    try {
      markets = await fetch15m.call(this.deps.watcher, SUPPORTED_MARKETS, "15m", nowMs);
    } catch (error) {
      // Perder los 15m es perder una oportunidad; tumbar la iteracion seria perder el bot.
      this.logSkipOnce("15m", "arb_15m_fetch_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    for (const market of markets) {
      const latestTick = this.deps.priceFeed.getLatestTick(market.asset);
      const opening = await this.ensureOpening(market, latestTick, nowMs);
      if (!opening || !latestTick) {
        continue;
      }
      const quotes = await this.getAnalyticsQuotes(market, nowMs);
      const opportunity = await this.observeArbOpportunity(market, quotes, nowMs);
      if (!opportunity || this.arbNakedLegStreak >= ARB_NAKED_LEG_HALT_STREAK) {
        continue;
      }
      await this.executeArbOpportunity({ market, quotes, opportunity, opening, tick: latestTick, nowMs });
    }
  }

  /** Rolling loop-latency stats: slow iterations are logged with a breakdown; percentiles every 5 min. */
  private recordLoopTiming(totalMs: number, phases: LoopPhaseMs, failed = false): void {
    this.loopDurationsMs.push(totalMs);
    this.loopFailures.push(failed);
    this.loopPhasesMs.push({ ...phases, sinAtribuir: unaccountedMs(totalMs, phases) });
    if (this.loopDurationsMs.length > 600) {
      this.loopDurationsMs.shift();
      this.loopFailures.shift();
      this.loopPhasesMs.shift();
    }
    if (totalMs > 2_500) {
      // `sinAtribuir` es la pieza que importa: si crece, es que hay trabajo en el bucle que nadie
      // cronometra, que es exactamente como se perdio el 94% del tiempo lento durante meses.
      logger.warn("Iteración lenta del loop.", {
        totalMs,
        ...phases,
        sinAtribuirMs: unaccountedMs(totalMs, phases),
        failed,
      });
    }
    const nowMs = Date.now();
    if (nowMs - this.lastLoopStatsLogMs >= 5 * 60_000 && this.loopDurationsMs.length >= 10) {
      this.lastLoopStatsLogMs = nowMs;
      const sorted = [...this.loopDurationsMs].sort((left, right) => left - right);
      const failures = this.loopFailures.filter(Boolean).length;
      const lag = this.eventLoopLag.read();
      // Se vacia al publicar para que cada ventana sea independiente y un bloqueo viejo no siga
      // apareciendo como maximo para siempre.
      this.eventLoopLag.reset();
      logger.info("Latencia del loop (ventana móvil).", {
        iterations: sorted.length,
        // Si esto sube con la latencia, el culpable es trabajo sincrono. Si no, es espera de red.
        lagP50Ms: lag?.p50Ms,
        lagP99Ms: lag?.p99Ms,
        lagMaxMs: lag?.maxMs,
        p50Ms: sorted[Math.floor(sorted.length * 0.5)],
        p95Ms: sorted[Math.floor(sorted.length * 0.95)],
        maxMs: sorted[sorted.length - 1],
        // Se publica junto a los percentiles a proposito: sin este numero, unos percentiles sanos
        // ocultaban que una de cada tres iteraciones estaba muriendo por timeout.
        failed: failures,
        failedPct: Math.round((1000 * failures) / sorted.length) / 10,
        // Mediana por fase: es lo que convierte "el bucle va lento" en "gamma va lento". El total de
        // arriba no dice donde mirar; esto si.
        ...this.medianPhaseMs(),
      });
    }
  }

  /** Mediana de cada fase sobre la ventana movil, con el prefijo `p50` para leerlo de un vistazo. */
  private medianPhaseMs(): Record<string, number> {
    const salida: Record<string, number> = {};
    for (const fase of [...LOOP_PHASES, "sinAtribuir"] as const) {
      const valores = this.loopPhasesMs.map((entrada) => entrada[fase] ?? 0).sort((x, y) => x - y);
      salida[`p50_${fase}`] = valores[Math.floor(valores.length * 0.5)] ?? 0;
    }
    return salida;
  }

  /**
   * Registra una señal descartada por precio y avisa si ese mercado lleva tantas seguidas que su
   * ventana de ask lo tiene bloqueado. Sin esto, una configuracion imposible se ve exactamente igual
   * que un mercado tranquilo: skips normales, para siempre.
   */
  private noteAskRejected(signal: TradeSignal, bestAsk?: number): void {
    const market = signal.market.asset;
    this.askWindowDetector.recordRejected(market, bestAsk);
    const deadlock = this.askWindowDetector.takeDeadlock(
      market,
      this.resolveConfiguredMinAskPrice(market, signal.outcome),
      signal.maxAskPrice,
    );
    if (deadlock) {
      logger.warn(`Ventana de ask bloqueada. ${describeDeadlock(deadlock)}`, deadlock);
      void this.deps.notifier
        ?.notify({
          key: `ask-deadlock-${market}`,
          level: "warn",
          title: `${market}: ventana de ask bloqueada`,
          body: describeDeadlock(deadlock),
          minIntervalMs: 6 * 60 * 60_000,
        })
        .catch(() => undefined);
    }
  }

  /** Capital efectivo que usa la guardia, y de donde salio. Para que la UI no mienta. */
  getBankroll(): { usd: number; source: "onchain" | "declared" | "unknown"; atMs?: number } {
    const resolved = resolveEffectiveBankrollUsd(this.lastBankrollReading, this.config.liveBankrollUsd);
    return { ...resolved, atMs: this.lastBankrollReading?.atMs };
  }

  /** Fracción de iteraciones fallidas de la ventana móvil, para la UI. */
  getLoopHealth(): { iterations: number; failed: number; failedPct: number; lagMaxMs?: number } {
    const iterations = this.loopFailures.length;
    const failed = this.loopFailures.filter(Boolean).length;
    return {
      iterations,
      failed,
      failedPct: iterations > 0 ? Math.round((1000 * failed) / iterations) / 10 : 0,
      // Un bot con el bucle bloqueado 41 segundos esta tan ciego como uno con el feed caido, y hasta
      // ahora ninguna pantalla podia decirlo: las iteraciones no contaban como "fallidas" porque
      // acababan bien, solo tarde.
      lagMaxMs: this.eventLoopLag.read()?.maxMs,
    };
  }

  private async getCurrentMarkets(marketsToFetch: readonly MarketSymbol[], nowMs: number): Promise<MarketInfo[]> {
    if (marketsToFetch.length === 0) {
      return [];
    }
    if (this.deps.watcher.getCurrentMarkets) {
      return this.deps.watcher.getCurrentMarkets([...marketsToFetch], nowMs);
    }

    // Camino de respaldo (watchers sin `getCurrentMarkets`): aislar mercado a mercado. Sin esto, el
    // primero que falle se lleva por delante a los demas, que es justo el fallo que se esta corrigiendo.
    const markets: MarketInfo[] = [];
    const errors: unknown[] = [];
    for (const market of marketsToFetch) {
      try {
        const currentMarket = await this.deps.watcher.getCurrentMarket(nowMs, market);
        if (currentMarket) {
          markets.push(currentMarket);
        }
      } catch (error) {
        errors.push(error);
        this.logSkipOnce(market, "market_fetch_failed", {
          market,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    // Igual que en el watcher: el apagon total se propaga (one-shot debe enterarse), el parcial no.
    if (errors.length === marketsToFetch.length && errors.length > 0) {
      throw errors[0];
    }
    return markets;
  }

  private async reconcileLiveTrades(nowMs: number): Promise<void> {
    const trades = this.deps.state
      .listTrades()
      .filter((trade) => trade.mode === "live" && !trade.reconciledAtMs && trade.orderId);

    for (const trade of trades) {
      try {
        const reconciled = await (
          this.deps.reconcilerByMode?.[trade.mode] ?? this.deps.reconciler
        ).reconcile(trade, nowMs);
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
      // SIN await: el POST a Telegram no tiene timeout, y esperarlo aqui deja el bucle bloqueado en
      // pleno camino de error — justo cuando ya vamos tarde. Avisar es secundario; seguir operando no.
      void this.deps.notifier
        ?.notify({
          key: "bot-loop-error",
          level: "warn",
          title: "Error en loop del bot",
          body: error instanceof Error ? error.message : String(error),
          minIntervalMs: 5 * 60_000,
        })
        .catch(() => undefined);
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
    // La apertura oficial es el valor de la serie TWAP en el inicio de ventana. Las reglas del mercado
    // son explicitas: "este mercado va del precio segun el data stream TWAP de Chainlink, NO segun
    // ninguna otra fuente ni mercados spot". El spot queda solo como respaldo mientras la serie TWAP
    // no haya llegado — recien arrancado, por ejemplo.
    const twap = this.deps.priceFeed.getTwapAtOrBefore?.(market.asset, market.windowStartMs, grace);
    if (twap) {
      return twap;
    }
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
    if (this.deps.state.hasTraded(args.market.slug, this.modeFor("dir"))) {
      this.logSkipOnce(args.market.slug, "market_already_traded");
      return undefined;
    }

    // Puerta de capital: con un bankroll pequeño el minimo de orden del exchange ($5) obliga a
    // arriesgar una fraccion enorme del capital en cada entrada, y la ruina llega antes que el edge —
    // se pierde dinero teniendo razon (ver `minBankrollForDirectionalUsd`). Solo afecta a LIVE y solo
    // al camino DIRECCIONAL: el arbitraje no puede arruinar (redime $1/set gane quien gane) y es
    // justamente con lo que se hace crecer el capital hasta cruzar el umbral. Sim sigue operando todo
    // para no dejar de generar muestras.
    const minBankrollUsd = this.config.minBankrollForDirectionalUsd ?? 0;
    if (this.modeFor("dir") === "live" && minBankrollUsd > 0) {
      // `source: "unknown"` = ni se pudo leer on-chain ni hay valor declarado. No se bloquea por no
      // saber: bloquear por un RPC caido seria un fallo de red disfrazado de politica de riesgo.
      const bankroll = resolveEffectiveBankrollUsd(this.lastBankrollReading, this.config.liveBankrollUsd);
      if (bankroll.source !== "unknown" && bankroll.usd < minBankrollUsd) {
        this.logSkipOnce(args.market.slug, "bankroll_below_directional_minimum", {
          bankrollUsd: Math.round(bankroll.usd * 100) / 100,
          minBankrollUsd,
          source: bankroll.source,
        });
        return undefined;
      }
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
    // Con un sondeo en curso la ventana se ensancha hasta cubrir la banda en pruebas. Tiene que llegar
    // hasta aqui y no solo al filtro posterior: este tope viaja a `getQuote`, que lo usa para calcular
    // la profundidad disponible bajo el — con el tope viejo, los precios que se quieren sondear
    // saldrian como "sin liquidez" y el sondeo no ocurriria jamas.
    const maxAskPrice = effectiveAskWindow(
      {
        floor: this.resolveConfiguredMinAskPrice(args.market.asset, winner.outcome),
        cap: this.resolveConfiguredMaxAskPrice(args.market.asset, winner.outcome),
      },
      this.probeFor(args.market.asset, args.nowMs),
    ).cap;

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
      this.noteAskRejected(signal, quote.bestAsk);
      return undefined;
    }

    if (quote.bestAsk > signal.maxAskPrice) {
      this.logSkipOnce(signal.market.slug, "best_ask_above_cap", {
        outcome: signal.outcome,
        bestAsk: quote.bestAsk,
        maxAskPrice: signal.maxAskPrice,
      });
      this.noteAskRejected(signal, quote.bestAsk);
      return undefined;
    }

    const maxSpread = this.config.maxAskSpread ?? DEFAULT_MAX_ASK_SPREAD;
    if (maxSpread > 0 && typeof quote.bestBid === "number" && quote.bestBid > 0) {
      const spread = quote.bestAsk - quote.bestBid;
      if (spread > maxSpread) {
        this.logSkipOnce(signal.market.slug, "spread_too_wide", {
          outcome: signal.outcome,
          bestAsk: quote.bestAsk,
          bestBid: quote.bestBid,
          spread: Math.round(spread * 1000) / 1000,
          maxSpread,
        });
        return undefined;
      }
    }

    // Piso de ask: por debajo de este precio la entrada es una apuesta de reversion barata, que el
    // replay del ledger live mostro perdedora de forma sistematica (ETH <0.30: 23 de 24 perdidas).
    const minAskPrice = effectiveAskWindow(
      {
        floor: this.resolveConfiguredMinAskPrice(signal.market.asset, signal.outcome),
        cap: signal.maxAskPrice,
      },
      this.probeFor(signal.market.asset, signal.tick.timestampMs),
    ).floor;
    if (quote.bestAsk < minAskPrice) {
      this.logSkipOnce(signal.market.slug, "best_ask_below_floor", {
        outcome: signal.outcome,
        bestAsk: quote.bestAsk,
        minAskPrice,
      });
      this.noteAskRejected(signal, quote.bestAsk);
      return undefined;
    }

    // Pasó la ventana de precio: la configuración de este mercado es operable.
    this.askWindowDetector.recordAccepted(signal.market.asset);

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
    // El libro del lado CONTRARIO ya viene cotizado en la misma pasada (se piden UP y DOWN en
    // paralelo), asi que `quoteSkew` no cuesta ni una llamada extra en plena ventana de entrada.
    const oppositeQuote = quoteCache.get(signal.market.slug)?.[signal.outcome === "UP" ? "DOWN" : "UP"];
    const evResult = await this.evaluateExpectedValue(signal, quote.bestAsk, {
      bestBid: quote.bestBid,
      oppositeAsk: oppositeQuote?.bestAsk,
    });
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
      // El presupuesto de sondeo se cobra al LLENAR, no al proponer: una señal cara que acaba
      // rechazada por el gate de EV no ha comprobado nada, y cobrarla gastaria el presupuesto sin
      // recoger un solo dato.
      const sondeo = this.probeFor(candidate.market.asset, candidate.tick.timestampMs);
      const askEjecutado = result.trade.bestAsk ?? candidate.quote.bestAsk;
      if (
        sondeo &&
        typeof askEjecutado === "number" &&
        isProbeEntry(
          askEjecutado,
          {
            floor: this.resolveConfiguredMinAskPrice(candidate.market.asset, candidate.outcome),
            cap: this.resolveConfiguredMaxAskPrice(candidate.market.asset, candidate.outcome),
          },
          sondeo,
        )
      ) {
        this.noteProbeUsed(candidate.market.asset, candidate.tick.timestampMs);
        logger.info("Sondeo de banda ejecutado.", {
          market: candidate.market.asset,
          banda: `${sondeo.lo}-${sondeo.hi}`,
          ask: askEjecutado,
          prometido: sondeo.expectedNetPerTradeUsd,
        });
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
    book?: { bestBid?: number; oppositeAsk?: number },
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
        // Features RICAS (velocity/spread/quoteSkew, "knn6") + prior anclado al ask.
        //
        // El barrido de 2026-07-16 concluyó lo contrario (knn3 gana, knn6 pierde), pero se puntuó con
        // `sample.winningOutcome`, que se equivoca un 12.5% y correlacionado con la señal — ver
        // `analyticsTruth`. Rebarrido 2026-08-05 con el juez de mercado, con corte in/out en
        // 2026-07-22 (net $ sobre stake $1, columna fuera de muestra):
        //   knn6 + prior ask   +$41.84 total  |  +$40.21 fuera de muestra (7.9% ROI)
        //   knn3 + prior ask   +$31.55        |  +$25.33                  (4.7%)
        //   knn5 (sin skew)    +$16.11        |  +$15.01                  (2.8%)
        //   exact (baseline)    +$6.60        |   +$8.51                  (1.9%)
        // knn6 gana en AMBAS mitades y todas sus variantes baten a todas las de knn3. Ojo con knn5:
        // añadir velocity y spread SIN quoteSkew es PEOR que knn3 — el trabajo lo hace el skew, y las
        // otras dos solas solo diluyen la distancia del k-NN. Si algun dia el skew deja de estar
        // disponible, hay que volver a knn3, no quedarse a medias.
        const secondsRemaining = (signal.market.endMs - signal.tick.timestampMs) / 1000;
        const previousTick = this.deps.priceFeed.getTickAtOrBefore?.(
          signal.market.asset,
          signal.tick.timestampMs - 1,
        );
        const elapsedSeconds = previousTick ? (signal.tick.timestampMs - previousTick.timestampMs) / 1000 : 0;
        const estimate = await this.deps.strategyAnalysisEngine.estimateSetupWinRateBySimilarity(
          signal.market.asset,
          signal.outcome,
          params,
          {
            secondsToEnd: secondsRemaining,
            favorableDistanceUsd: Math.abs(signal.distanceUsd),
            ask: askPrice,
            velocityUsdPerSecond:
              previousTick && elapsedSeconds > 0
                ? (signal.tick.value - previousTick.value) / elapsedSeconds
                : undefined,
            spread: book?.bestBid != null && book.bestBid > 0 ? askPrice - book.bestBid : undefined,
            quoteSkew: book?.oppositeAsk != null && book.oppositeAsk > 0 ? book.oppositeAsk - askPrice : undefined,
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
      const trade = await this.executorFor(this.modeFor(candidate.strategy ?? "dir")).execute({
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

  /** Programas de sondeo vigentes. Los calcula y persiste el controlador; aqui solo se consultan. */
  setBandPrograms(programs: readonly BandProgram[]): void {
    this.bandPrograms = programs;
  }

  /** Sondeo en curso para un mercado, si queda presupuesto hoy. Sin presupuesto se comporta como si
   * no hubiera sondeo: la ventana vuelve a la configurada y la señal cara se descarta como siempre. */
  private probeFor(market: MarketSymbol, nowMs: number): BandProgram | undefined {
    const program = activeProgram(this.bandPrograms, market);
    if (!program) {
      return undefined;
    }
    const key = `${dailySpendKey(nowMs, this.config.timezone)}:${market}`;
    return (this.probeCountByDayMarket.get(key) ?? 0) < PROBE_MAX_PER_MARKET_DAY ? program : undefined;
  }

  private noteProbeUsed(market: MarketSymbol, nowMs: number): void {
    const key = `${dailySpendKey(nowMs, this.config.timezone)}:${market}`;
    this.probeCountByDayMarket.set(key, (this.probeCountByDayMarket.get(key) ?? 0) + 1);
  }

  /**
   * Modo de una estrategia concreta. Ausente en config = se hereda el global, asi que nada cambia
   * para quien no lo configure.
   *
   * Todo lo que dependa del modo —el ejecutor, el ledger, el limite de gasto, el cortacircuitos— debe
   * pasar por aqui y no por `config.mode`. Si una estrategia opera en live y su P&L se anota en sim,
   * el dinero real desaparece de las cuentas.
   */
  private modeFor(strategy: "arb" | "dir"): Mode {
    return (strategy === "arb" ? this.config.arbMode : this.config.directionalMode) ?? this.config.mode;
  }

  /** Ejecutor del modo pedido. Cae al inyectado cuando no hay uno por modo (dobles de test). */
  private executorFor(mode: Mode): TradeExecutor {
    return this.deps.executorByMode?.[mode] ?? this.deps.executor;
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
    // El arbitraje NO depende de la ventana de entrada: no necesita señal ni momentum, aparece cuando
    // los dos lados juntos cuestan menos de $1 y eso puede pasar en cualquier momento. Limitarlo a la
    // ventana de analytics (120s de 300) nos dejaba CIEGOS el 60% del tiempo, que es la causa de que
    // apenas se detecten oportunidades. Con arbEnabled se cotiza toda la ventana.
    const inAnalyticsWindow = isWithinEntryWindow(market.endMs, nowMs, ANALYTICS_WINDOW_SECONDS);
    if (inAnalyticsWindow) {
      if (!this.deps.analyticsRecorder) {
        return {};
      }
    } else {
      // Fuera de la ventana de analytics solo se cotiza para el ARBITRAJE, y a cadencia reducida.
      // Cotizar en cada iteracion triplicaba las llamadas al orderbook y degrado el loop de p50 56ms
      // a 281ms (con picos de 20s), y un loop lento llega tarde a las entradas — que ya medimos que
      // cuesta dinero. Cada ARB_SCAN_INTERVAL_MS basta: la oportunidad dura segundos, no milisegundos.
      if (this.config.arbEnabled !== true) {
        return {};
      }
      const last = this.lastArbScanMs.get(market.slug) ?? 0;
      if (nowMs - last < ARB_SCAN_INTERVAL_MS) {
        return {};
      }
      this.lastArbScanMs.set(market.slug, nowMs);
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
   * SOLO OBSERVACION (no mueve dinero, ni en cadena ni en el libro): registra los momentos de MINT-arb
   * — acuñar un set por $1 y vender ambos lados contra los bids por mas de $1 tras comisiones — con la
   * profundidad real de los dos libros compradores.
   *
   * Se mide antes de construir la ejecucion porque el barrido historico solo tenia el MEJOR bid, sin
   * profundidad: dice cuantas VECES se abre la puerta, no cuantos dolares caben por ella. Unos dias de
   * esto responden lo segundo, que es lo unico que decide si merece la pena escribir en cadena.
   */
  private async observeMintOpportunity(
    market: MarketInfo,
    quotes: Partial<Record<Outcome, OrderbookQuote>>,
    nowMs: number,
  ): Promise<void> {
    const opportunity = detectMintArb({
      market: market.asset,
      slug: market.slug,
      endMs: market.endMs,
      nowMs,
      quotes,
    });
    if (!opportunity) {
      return;
    }
    try {
      await appendFile(
        join(this.config.dataDir, "mint-opportunities.jsonl"),
        `${JSON.stringify(opportunity)}
`,
        "utf8",
      );
      this.logSkipOnce(market.slug, "mint_opportunity_observed", {
        market: market.asset,
        netPerSet: opportunity.netPerSet,
        netUsdAtDepth: opportunity.netUsdAtDepth,
        sets: opportunity.maxSetsByDepth,
        secondsToEnd: opportunity.secondsToEnd,
      });
    } catch (error) {
      logger.warn("No se pudo registrar la oportunidad de MINT-arb; continuando.", {
        slug: market.slug,
        error: error instanceof Error ? error.message : String(error),
      });
    }
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
    if (this.deps.state.hasTraded(arbSlug, this.modeFor("arb"))) {
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
    const budgetUsd = this.config.arbMaxUsdPerOpportunity ?? 25;
    // El tope diario ACOTA el tamaño en vez de rechazar la oportunidad entera: antes se dimensionaba
    // solo por presupuesto y luego se descartaba si no cabía, tirando arbitrajes que sí cabían más
    // pequeños. Un arbitraje es rentable por set, así que uno pequeño sigue siendo dinero.
    const dailyRoomUsd = Math.max(
      0,
      this.config.dailySpendLimitUsd - this.deps.state.getDailySpend(nowMs, undefined, this.modeFor("arb")),
    );
    let affordableUsd = Math.min(budgetUsd, dailyRoomUsd);

    // En LIVE el tamaño no puede superar el colateral REAL. Intentar un arbitraje que no se puede
    // pagar es el peor resultado posible de esta estrategia: la primera pata llena, la segunda se
    // queda sin fondos, y lo que iba a ser una posicion sin riesgo direccional se convierte en una
    // apuesta desnuda. Con $10 de saldo y un presupuesto de $25, eso pasaria en CADA oportunidad.
    // En sim no aplica: no hay colateral que agotar.
    if (this.modeFor("arb") === "live") {
      const bankroll = resolveEffectiveBankrollUsd(this.lastBankrollReading, this.config.liveBankrollUsd);
      if (bankroll.source === "unknown") {
        // Nunca se pudo leer el saldo NI hay valor declarado: dimensionar a ciegas arriesga
        // exactamente la pata desnuda que esto evita. Mejor perder la oportunidad.
        this.logSkipOnce(market.slug, "arb_bankroll_unknown", { budgetUsd });
        return;
      }
      const sinComprometerUsd = Math.max(0, bankroll.usd - this.arbCommittedUsdThisIteration);
      if (sinComprometerUsd <= 0) {
        this.logSkipOnce(market.slug, "arb_bankroll_exhausted", {
          bankrollUsd: bankroll.usd,
          committedUsd: this.arbCommittedUsdThisIteration,
        });
        return;
      }
      affordableUsd = Math.min(affordableUsd, sinComprometerUsd);
    }
    const sets = Math.floor(Math.min(opportunity.maxSetsByDepth, affordableUsd / pairCost) * 100) / 100;

    // AMBAS patas tienen que superar el mínimo del exchange, que está en DÓLARES. La comprobación
    // anterior (`sets < orderMinSize`) chocaba unidades: comparaba un número de participaciones
    // contra $5. Con precios equilibrados (~0.48) dejaba pasar 5 sets, que son dos órdenes de $2.40
    // — ambas por debajo del mínimo y por tanto rechazadas por el exchange. Es la razón de que el
    // arbitraje tenga 0 ejecuciones en live.
    //
    // Se calcula sobre el importe EXACTO que enviará `executeArbLeg` (mismo redondeo a céntimos),
    // no sobre una aproximación, para que no se cuele nada por el borde.
    const legUsd = (ask: number): number => Math.round(sets * ask * 100) / 100;
    const upLegUsd = legUsd(up.bestAsk);
    const downLegUsd = legUsd(down.bestAsk);
    if (sets <= 0 || upLegUsd < market.orderMinSize || downLegUsd < market.orderMinSize) {
      this.logSkipOnce(market.slug, "arb_below_min_size", {
        sets,
        upLegUsd,
        downLegUsd,
        orderMinSize: market.orderMinSize,
        // Lo que haría falta para que la pata más barata llegue al mínimo.
        setsNeeded: Math.ceil((market.orderMinSize / Math.min(up.bestAsk, down.bestAsk)) * 100) / 100,
        capitalNeededUsd: Math.round((market.orderMinSize / Math.min(up.bestAsk, down.bestAsk)) * pairCost * 100) / 100,
        affordableUsd,
      });
      return;
    }
    const totalCostUsd = sets * pairCost;
    // Se reserva ANTES de mandar nada: el dinero sale en cuanto llena la primera pata, y sigue fuera
    // aunque la segunda falle. Reservar despues del exito dejaria la ventana abierta justo en medio.
    this.arbCommittedUsdThisIteration += totalCostUsd;

    // Thin book first: it is the binding constraint; if it rejects, no position exists yet.
    const thinFirst: Outcome[] =
      up.availableUsdAllLevels / up.bestAsk <= down.availableUsdAllLevels / down.bestAsk ? ["UP", "DOWN"] : ["DOWN", "UP"];
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
          this.arbNakedLegStreak += 1;
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
    this.arbNakedLegStreak = 0;
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
      strategy: "arb",
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
        // La serie que RESUELVE. Se graba junto al spot porque solo vive 10 minutos en memoria del
        // feed, y sin esto todo analisis futuro seguiria midiendo sobre la serie equivocada.
        twapTick: args.latestTick
          ? this.deps.priceFeed.getTwapAtOrBefore?.(args.market.asset, args.latestTick.timestampMs)
          : undefined,
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
      // Cierre por la serie TWAP, que es la que resuelve. El spot solo si aquella no esta.
      const twapClose = this.deps.priceFeed.getTwapAtOrBefore?.(market, trade.endMs);
      const closeTick = twapClose ?? this.deps.priceFeed.getTickAtOrBefore?.(market, trade.endMs);
      const resolution = resolveTradeFromTick(
        trade,
        latestTick,
        nowMs,
        closeTick,
        twapClose ? "twap" : "spot",
      );
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

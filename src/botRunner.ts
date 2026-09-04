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
import { selectFavoriteOutcome, type FavoriteSkipReason } from "./favoriteSelector.js";
import { evaluateDirectionalRiskHalt, type RiskHaltStatus } from "./riskCircuitBreaker.js";
import {
  LiveExecutionEngine,
  LiveOrderError,
  resolveTradeAmountUsd,
  SimulationExecutionEngine,
  type LiveOrderFailureDetails,
  type TradeExecutor,
} from "./executionEngine.js";
import {
  OnChainBankrollSource,
  makerDebeRetirarse,
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
  necesitaMercadosCripto,
  OUTCOMES,
  resolveOpeningTick,
  SUPPORTED_MARKETS,
} from "./markets.js";
import { MarketWatcher } from "./marketWatcher.js";
import { archivadorDesatendido, ultimaPasadaArchivado } from "./archiveAnalytics.js";
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
import { LiveMakerEngine, SimulationMakerEngine } from "./makerEngine.js";
import type { MakerEngine } from "./makerEngine.js";
import { MakerLoop } from "./makerLoop.js";
import { leerPosicionesAbiertas } from "./makerPositions.js";
import type { ResumenPasada } from "./makerLoop.js";
import { RewardMarketScanner } from "./rewardMarketScanner.js";
import type { CandidatoRecompensa } from "./rewardMarketScanner.js";
import { RewardParamsReader } from "./rewardParams.js";
import type { RecompensaMercado } from "./rewardParams.js";
import type { MercadoMaker } from "./makerMarket.js";
import { resolveTradeFromTick } from "./tradeResolution.js";
import type { SkipReason } from "./ui/shared.js";
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
/**
 * Cada cuanto corre una pasada del maker, independiente del ritmo del bucle.
 *
 * 15 s = el mismo freno que tiene la recolocacion, asi que no se pierde ninguna decision: entre pasada
 * y pasada el maker no podria recolocar aunque quisiera. Correr con el bucle (~3 s) multiplicaba por
 * cinco las lecturas de libro para decidir, casi siempre, no hacer nada.
 */
const INTERVALO_MAKER_MS = 15_000;

/**
 * Motivo del selector de favorito -> etiqueta de descarte del panel.
 *
 * Es una tabla explicita y no un `favorite_${reason}` compuesto al vuelo: asi el compilador exige que
 * cada motivo nuevo tenga su etiqueta en `SKIP_REASON_LABELS`, en vez de dejarla salir como codigo
 * crudo en las tres pantallas — que es exactamente como se colaron los siete motivos anteriores.
 */
export const FAVORITE_SKIP_REASONS: Record<FavoriteSkipReason, SkipReason> = {
  missing_quote: "favorite_missing_quote",
  extreme_price: "favorite_extreme_price",
  dead_book: "favorite_dead_book",
  no_favorite: "favorite_no_favorite",
  below_band: "favorite_below_band",
  above_band: "favorite_above_band",
};

/**
 * Cada cuanto se comprueba que el archivador de analitica sigue vivo.
 *
 * Una hora es de sobra para algo que corre dos veces al dia, y son 24 lecturas de un fichero
 * pequeño al dia: nada al lado de lo que cuesta enterarse tarde de que el histórico dejo de
 * acumularse. Ver `vigilarArchivador`.
 */
const INTERVALO_VIGILANCIA_ARCHIVADOR_MS = 3_600_000;

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
/**
 * Cadencia con la que la estrategia "favorito" mira el libro FUERA de la ventana de analytics.
 *
 * La misma razon que `ARB_SCAN_INTERVAL_MS`, y el mismo numero: el favorito elige lado con estos
 * libros, asi que con la ventana de entrada abierta a los 300s los necesita durante todo el ciclo,
 * pero pedirlos cada segundo durante los 300 es exactamente lo que llevo el p50 del loop de 56ms a
 * 281ms. Un ask que entra en la banda 0,76-0,85 no se evapora en 3 segundos; un loop lento si llega
 * tarde a la entrada.
 *
 * En los ultimos `ANALYTICS_WINDOW_SECONDS` NO se aplica: ahi el libro se mueve de verdad (es cuando
 * converge hacia 0/1) y se sigue cotizando en cada iteracion.
 */
const FAVORITE_SCAN_INTERVAL_MS = 3_000;

/**
 * Default de patas sueltas seguidas antes de dejar de intentar arbitrajes. Configurable como
 * `arbNakedLegHaltStreak`; esto es solo el valor de partida.
 *
 * En 1 —no 2— porque el arbitraje en live esta sin estrenar: nunca ha ejecutado contra el exchange
 * real, asi que el rechazo de la segunda pata es justo lo que sim no puede haber probado. Con el freno
 * en 2 el peor caso son dos apuestas desnudas de ~$8.50, o sea practicamente los $17.80 de capital;
 * con 1 se queda en una.
 *
 * El precio es real: un unico rechazo desafortunado deja el arbitraje parado hasta el siguiente
 * reinicio. Se acepta mientras el camino no tenga historial. Subirlo a 2 es cambiar este numero.
 */
const DEFAULT_ARB_NAKED_LEG_HALT_STREAK = 1;
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
  /**
   * `windowSeconds` es obligatorio: identifica QUE serie TWAP se pide. Cuando esta interfaz lo tenia
   * como `maxAgeMs` opcional, el runner pasaba una gracia en milisegundos donde ahora va la ventana en
   * segundos y TypeScript no se quejaba — es un tipo estructural. Un fallo asi no lo ve nadie hasta
   * que el bot lleva dias leyendo la serie que no resuelve.
   */
  getTwapAtOrBefore?(
    market: MarketSymbol,
    timestampMs: number,
    windowSeconds: number,
    maxAgeMs?: number,
  ): BtcPriceTick | undefined;
}

interface BotDependencies {
  watcher: MarketWatcherLike;
  /**
   * Ejecutores por modo. Con estrategias en modos distintos hacen falta los DOS a la vez: el de
   * simulacion para la que aprende y el real para la que gana. Opcional para no romper los dobles de
   * test, que inyectan uno solo.
   */
  executorByMode?: Partial<Record<Mode, TradeExecutor>>;
  /** Lector de parametros de recompensa. Ausente = el maker no corre. */
  rewardParams?: Pick<RewardParamsReader, "paraMercado">;
  /** Busca en todo Polymarket los mercados de recompensa que caben en el capital. */
  rewardScanner?: Pick<RewardMarketScanner, "mejores">;
  makerEngineByMode?: Partial<Record<Mode, MakerEngine>>;
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
  /** Slugs cuya apertura salio de la serie TWAP y no del spot, entre la lectura y el guardado. */
  private readonly aperturasPorTwap = new Set<string>();
  private makerLoopCache?: MakerLoop;
  /** Ultimos mercados vistos, para poder retirar ordenes al parar sin volver a consultarlos. */
  private ultimosMercados: MarketInfo[] = [];

  /**
   * Mercados que cotiza el maker cuando la fuente es `recompensas`, y sus parametros.
   *
   * Se guardan juntos porque el escaner YA leyo los parametros al cribar: volver a pedirlos por mercado
   * serian 25 peticiones por pasada para releer lo que acabamos de tener en la mano.
   */
  private mercadosMaker: MercadoMaker[] = [];

  private readonly paramsMaker = new Map<string, RecompensaMercado>();

  /** Si el suelo de saldo ya esta disparado, para avisar UNA vez y no cada tres segundos. */
  private makerBajoSuelo = false;
  /** Si ya se recupero la posicion que el maker tenia antes de arrancar este proceso. */
  private posicionesSembradas = false;
  private intentosDeSiembra = 0;

  /** Cuando corrio la ultima pasada del maker, que va a su propio ritmo. */
  private ultimaVigilanciaArchivadorMs = 0;

  /** Cuando empezo a correr este bot, para no acusar de nada a un arranque reciente. */
  private arranqueMs = 0;

  private ultimaPasadaMakerMs = 0;
  private ultimaPasadaMaker?: ResumenPasada;

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
  /**
   * Ultimo sondeo del libro para el favorito, por slug. Mapa APARTE del de arbitraje a proposito: si
   * compartieran contador, encender el arbitraje adelantaria el reloj del favorito (y al reves), y
   * cada uno se quedaria sin la mitad de sus sondeos sin que nada lo dijera.
   */
  private readonly lastFavoriteScanMs = new Map<string, number>();

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
      rewardParams: new RewardParamsReader(config.clobHost),
      rewardScanner: new RewardMarketScanner(config.clobHost),
      makerEngineByMode: { sim: new SimulationMakerEngine(), live: new LiveMakerEngine(config) },
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
    // Poda ANTES de que el bucle empiece, pero SIN forzarla.
    //
    // Forzarla convertia cada arranque en una lectura y reescritura del fichero entero. Con 446 MB
    // eso son ~17 segundos con el bucle bloqueado —medido: `lagMaxMs 16919.8` justo despues de un
    // arranque—, y el servidor HTTP ya esta escuchando, asi que `/api/health` no puede contestar. El
    // watchdog lo tomaba por muerto y lo mataba, y el arranque siguiente volvia a podar: un bucle que
    // se alimentaba solo. Encaja con que los reinicios pasaran de 1-3 al dia a 7-11 cuando el fichero
    // crecio.
    //
    // Sin forzar, `pruneIfNeeded` cuenta las muestras sin parsearlas y solo poda si de verdad se ha
    // pasado del tope mas la holgura, que es una vez cada ~600 muestras y no una vez por arranque.
    await this.deps.analyticsRecorder?.pruneIfNeeded?.();
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
    // El feed, solo si alguien va a leer sus ticks — la MISMA pregunta que decide la captura.
    //
    // Este arranque se me escapo al gatear el feed en el controlador y lo dejaba encendido igual: el
    // controlador se cree que esta parado y el runner lo levanta por detras. No es solo gasto de CPU,
    // es peor: con el controlador creyendo que el feed esta apagado, `feedStalenessMs` devuelve
    // `undefined` y `/api/health` deja de poder ver un feed CONGELADO. Justo la vigilancia que existe
    // por las siete horas ciegas del 2026-08-08.
    if (necesitaMercadosCripto(this.config)) {
      this.deps.priceFeed.start();
    }
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
    // Retirar las ordenes maker ANTES de soltar el feed.
    //
    // Sin esto, parar el bot dejaba ordenes reales descansando en el libro sin nadie mirandolas. No es
    // un caso raro: el watchdog reinicia el proceso a diario y la maquina se apaga sin avisar. `stop()`
    // es sincrono por contrato, asi que la retirada se lanza y se deja correr — y si falla, se dice.
    const loop = this.makerLoopCache;
    // Los mercados que hay que retirar son los que el maker COTIZO, que con la fuente `recompensas` no
    // son los de cripto que sigue el bot. Usar `ultimosMercados` dejaria ordenes reales vivas en
    // mercados que nadie volveria a mirar.
    const mercados: MercadoMaker[] = this.mercadosMaker.length > 0 ? this.mercadosMaker : this.ultimosMercados;
    if (loop && mercados.length > 0) {
      void loop.retirarTodo(mercados).catch((error) => {
        logger.error("No se pudieron retirar las ordenes maker al parar. PUEDE HABER ORDENES VIVAS.", {
          error: error instanceof Error ? error.message : String(error),
        });
      });
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
    //
    // Los mercados cripto de 5m solo se leen si alguien los va a usar. Con el maker de recompensas como
    // unica estrategia no los usa NADIE: `mercadosParaMaker` tira del escaner de recompensas y ni mira
    // esta lista. Pero la captura seguia corriendo entera cada iteracion —dentro de la ventana de
    // analitica son 6 lecturas de libro por segundo mas una escritura a disco por mercado— para
    // alimentar un historico que ningun consumidor iba a leer.
    //
    // El gate mira la CONFIG, no una preferencia aparte: encender un mercado o el arbitraje devuelve la
    // captura y la analitica sin tocar codigo. Lo que se apaga se puede volver a encender.
    const necesitaCripto = necesitaMercadosCripto(this.config);
    if (necesitaCripto) {
      // Calienta la ventana siguiente durante la parte tranquila de la actual: el cambio de ventana era
      // el unico sitio donde la cache llegaba fria, y ahi un fetch lento cuesta el precio de apertura.
      // Va SIN await a proposito — no debe sumar ni un milisegundo al bucle.
      this.deps.watcher.prefetchNextWindow?.(SUPPORTED_MARKETS, nowMs);
    }
    const markets = necesitaCripto
      ? await timer.time("fetch", () => this.getCurrentMarkets(SUPPORTED_MARKETS, nowMs))
      : [];
    if (markets.length === 0) {
      // Sin mercados solo se salta la captura de cripto. El maker NO depende de ella y antes se caia
      // aqui con un `return`: una lista vacia —gamma lento, o ahora el gate— le costaba la pasada
      // entera aunque sus mercados vengan de otra fuente. Y la verificacion oficial no depende de
      // mercados abiertos, asi que sigue corriendo igual.
      if (necesitaCripto) {
        this.logSkipOnce("unknown", "market_not_found", { observedMarkets: SUPPORTED_MARKETS });
      }
      await this.cerrarIteracion(markets, nowMs, timer);
      return;
    }

    const tradeSignals: TradeSignal[] = [];
    this.arbCommittedUsdThisIteration = 0;
    const analyticsQuotesBySlug = new Map<string, Partial<Record<Outcome, OrderbookQuote>>>();
    const directionalMode = this.modeFor("dir");
    const dailySpendUsd = this.deps.state.getDailySpend(nowMs, undefined, directionalMode);
    let reservedSpendUsd = 0;
    // Cortacircuitos SOLO del direccional. La politica (fuera el arbitraje, su modo y no el global)
    // vive en `evaluateDirectionalRiskHalt`, compartida con la UI: cuando cada uno la escribia por su
    // cuenta, el chip y el bucle llegaron a decir cosas distintas.
    const riskHalt = evaluateDirectionalRiskHalt({
      trades: this.deps.state.listTrades(),
      directionalMode,
      limits: {
        maxDailyLossUsd: this.config.maxDailyLossUsd,
        maxConsecutiveLosses: this.config.maxConsecutiveLosses,
        cooldownHours: this.config.riskHaltCooldownHours,
        timeZone: this.config.timezone,
      },
      nowMs,
      haltResetAtMsByMode: this.deps.state.getRiskHaltResetAtMs?.(),
    });
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
      const arbBloqueado = this.arbNakedLegStreak >= this.arbNakedLegHaltStreak();
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
        // La estrategia "favorito" elige lado por el ask, asi que necesita los dos libros ya en la
        // seleccion. Son los mismos de la FASE 1: no cuesta ninguna llamada extra.
        quotes: analyticsQuotes,
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

    await this.cerrarIteracion(markets, nowMs, timer);
  }

  /**
   * El cierre de toda iteracion, con mercados cripto o sin ellos.
   *
   * Vive aparte porque la captura de cripto puede saltarse —el gate la apaga cuando no la usa nadie,
   * y gamma puede devolver la lista vacia— y nada de lo que hay aqui depende de ella. Antes esto era
   * la cola de `runIteration` detras de un `return` temprano, asi que una lista vacia se llevaba por
   * delante la pasada del maker, que no tiene ninguna relacion con esos mercados.
   */
  private async cerrarIteracion(markets: MarketInfo[], nowMs: number, timer: PhaseTimer): Promise<void> {
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

    // Maker de recompensas: mantiene ordenes en reposo cobrando el reparto de liquidez. Va al final
    // porque no compite por el mismo capital que el resto — tiene su propio tope — y porque no debe
    // retrasar ninguna decision de entrada.
    if (this.config.makerEnabled === true) {
      // Solo si hay algo que recordar: `ultimosMercados` es el respaldo del que sale la retirada de
      // ordenes en `stop()`, y pisarlo con la lista vacia del gate dejaria ese respaldo en nada.
      if (markets.length > 0) {
        this.ultimosMercados = markets;
      }
      // El maker tiene su PROPIA cadencia, mas lenta que la del bucle.
      //
      // Correr con el bucle significaba releer 6 libros cada ~3 segundos para decidir, casi siempre,
      // no hacer nada: su freno de recolocacion son 15 s y en un mercado de banda ancha la orden
      // aguanta horas. Esa relectura constante saturaba al propio exchange —**1.049 timeouts de 2 s en
      // una hora**, con el endpoint respondiendo en 280 ms al medirlo suelto— y dejaba al maker medio
      // ciego mientras el bot parecia sano.
      //
      // El direccional SI necesita los 3 segundos: entra en los ultimos segundos de una ventana de 5
      // minutos. El maker no decide nada en ese plazo.
      if (nowMs - this.ultimaPasadaMakerMs >= (this.config.makerIntervalMs ?? INTERVALO_MAKER_MS)) {
        this.ultimaPasadaMakerMs = nowMs;
        await timer.time("maker", () => this.runMaker(markets, nowMs));
      }
    }

    await timer.time("verify", () => this.verifyOfficialResolutions(nowMs));

    await this.vigilarArchivador(nowMs);
  }

  /**
   * Avisa si el archivador de analitica lleva demasiado sin dar señales de vida.
   *
   * El archivador ya avisa por su cuenta cuando FALLA, pero eso solo cubre los fallos que ocurren
   * DENTRO de el. Quedaban dos silencios que no puede contar nadie desde ahi: que el proceso de Node no
   * llegue a arrancar, y que la tarea programada no se dispare siquiera. Los dos se ven igual desde
   * fuera —no pasa nada— y el segundo es el peor, porque el silencio no se distingue del exito.
   *
   * Por eso vigila el BOT y no el propio archivador: pedirle a la tarea programada que compruebe si la
   * tarea programada corre es un circulo. Esto es barato —una lectura de fichero cada hora— y va al
   * final del tick para no meterse en el camino de ninguna decision.
   */
  private async vigilarArchivador(nowMs: number): Promise<void> {
    if (nowMs - this.ultimaVigilanciaArchivadorMs < INTERVALO_VIGILANCIA_ARCHIVADOR_MS) {
      return;
    }
    this.ultimaVigilanciaArchivadorMs = nowMs;
    this.arranqueMs ||= nowMs;
    try {
      const veredicto = archivadorDesatendido({
        ultimaPasadaMs: await ultimaPasadaArchivado(this.config.dataDir),
        nowMs,
        msDesdeArranque: nowMs - this.arranqueMs,
      });
      if (!veredicto.avisar) {
        return;
      }
      const cuanto =
        veredicto.motivo === "nunca_corrio"
          ? "no hay constancia de que haya corrido NUNCA"
          : `lleva ${veredicto.horas} horas sin una pasada buena`;
      logger.error("El archivador de analitica esta desatendido.", { motivo: veredicto.motivo, horas: veredicto.horas });
      // `key` + `minIntervalMs` en vez de avisar una sola vez en la transicion: si el aviso se pierde
      // —el movil apagado, Telegram caido— un aviso unico deja el problema tapado para siempre. Asi
      // insiste dos veces al dia mientras siga roto, que es la cadencia de la propia tarea.
      await this.deps.notifier?.notify({
        level: "error",
        category: "system",
        key: "archivador-desatendido",
        minIntervalMs: 12 * 3_600_000,
        title: "Archivador de analitica desatendido",
        body:
          `El archivado de analitica ${cuanto}.\n\n` +
          "Ni siquiera esta fallando: no se esta ejecutando. Mira si la tarea programada " +
          "'PolybotArchivoAnalitica' sigue activa. Mientras tanto NO se acumula histórico, porque el " +
          "fichero vivo recicla las muestras viejas y lo que se cae de el se pierde.",
      });
    } catch (error) {
      // Vigilar no puede tumbar el tick: perder una comprobacion cuesta una hora, no el bot.
      logger.warn("No se pudo comprobar el estado del archivador.", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Una pasada del maker. Nunca tumba la iteracion: perder una pasada cuesta una ventana, no el bot. */
  /**
   * De donde salen los mercados del maker.
   *
   * `cripto5m` usa los que el bot ya sigue. `recompensas` —el que vale para poco capital— busca en todo
   * Polymarket: entrada desde $20 en vez de $50 y banda de 4,5 centavos en vez de 1,5, que multiplica
   * por cinco lo que puntua la misma orden. El escaner cachea, asi que llamarlo cada pasada es barato.
   */
  private async mercadosParaMaker(markets: MarketInfo[]): Promise<MercadoMaker[]> {
    if ((this.config.makerMarketSource ?? "recompensas") === "cripto5m" || !this.deps.rewardScanner) {
      return markets;
    }
    try {
      const candidatos: CandidatoRecompensa[] = await this.deps.rewardScanner.mejores(
        this.config.makerCapitalUsd ?? 40,
      );
      this.paramsMaker.clear();
      for (const c of candidatos) {
        this.paramsMaker.set(c.mercado.slug, c.params);
      }
      this.mercadosMaker = candidatos.map((c) => c.mercado);
    } catch (error) {
      logger.warn("No se pudieron buscar mercados de recompensa.", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    // Si el escaner falla se conserva la lista anterior: quedarse sin mercados retiraria las ordenes
    // vivas por un fallo de red, que es justo lo contrario de lo que conviene.
    return this.mercadosMaker;
  }

  /**
   * Le devuelve al maker la memoria de lo que ya tenia comprado antes de este proceso.
   *
   * Va ANTES del suelo de patrimonio porque es justo lo que el suelo necesita saber: sin esto, un
   * reinicio con posicion abierta hace que el bot se crea mas pobre de lo que es y se detenga solo
   * —medido el 2026-08-28: conto $17,05 teniendo $23,50—. Y en el otro sentido, `gastadoUsd` a cero le
   * devuelve un tope de capital entero teniendo dinero fuera.
   *
   * Solo en LIVE: en simulacion las posiciones de la cuenta real no son suyas y sembrarlas mezclaria
   * dinero de verdad en una prueba de papel.
   *
   * Se intenta unas pocas veces y se deja. Si no se puede leer, el maker sigue con su cuenta de
   * siempre, que subestima y por tanto se para de mas: molesto, pero es el lado seguro.
   */
  private async sembrarPosicionesDelMaker(loop: MakerLoop, nowMs: number): Promise<void> {
    if (this.posicionesSembradas || this.modeFor("maker") !== "live" || !this.config.funderAddress) {
      return;
    }
    if (this.intentosDeSiembra >= 3) {
      return;
    }
    this.intentosDeSiembra += 1;
    try {
      const posiciones = await leerPosicionesAbiertas({ proxyAddress: this.config.funderAddress });
      if (!posiciones) {
        logger.warn("No se pudieron leer las posiciones abiertas; el maker sigue sin memoria de ellas.", {
          intento: this.intentosDeSiembra,
        });
        return;
      }
      this.posicionesSembradas = true;
      const sembradas = loop.sembrarPosiciones(posiciones, nowMs);
      if (sembradas > 0) {
        logger.info("Maker: recuperada la posicion previa al arranque.", {
          mercados: sembradas,
          paresUsd: Math.round(loop.paresUsd() * 100) / 100,
        });
      }
    } catch (error) {
      logger.warn("Fallo al leer las posiciones abiertas del maker.", {
        intento: this.intentosDeSiembra,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async runMaker(markets: MarketInfo[], nowMs: number): Promise<void> {
    const loop = this.makerLoop();
    if (!loop) {
      return;
    }
    try {
      await this.sembrarPosicionesDelMaker(loop, nowMs);

      // SUELO DE SALDO: la unica guarda que acota la perdida en vez del compromiso.
      //
      // `makerCapitalUsd` limita cuanto se pone a la vez, pero no cuanto se puede llegar a perder: una
      // posicion que resuelve a cero libera el tope y la pasada siguiente vuelve a comprometer. Asi se
      // fueron $41,41 en 40 minutos sin que ningun limite saltara. Solo en live: en sim el saldo real
      // no baja, y aplicarlo ahi congelaria las pruebas sin proteger nada.
      //
      // Se comprueba ANTES de buscar mercados, y no despues. El escaneo de recompensas son ~25
      // mercados por red: 9,7 segundos medidos en produccion. Un maker DETENIDO los pagaba igual en
      // cada pasada —53 avisos de iteracion lenta en catorce minutos— para acabar decidiendo que no
      // iba a operar. Ademas de tirar el bucle, es martillear la API de quien no te ha hecho nada, que
      // es como ya nos ganamos timeouts antes. El veredicto no necesita la lista: sale del saldo, de
      // las ordenes vivas y de los pares.
      const suelo = this.config.makerStopBelowUsd ?? 0;
      if (suelo > 0 && this.modeFor("maker") === "live") {
        const saldo = resolveEffectiveBankrollUsd(this.lastBankrollReading, this.config.liveBankrollUsd, nowMs);
        // El patrimonio no es solo el efectivo. Se suma:
        //  - lo inmovilizado en ordenes PROPIAS: una orden en reposo baja el saldo del exchange sin ser
        //    una perdida, el dinero sigue siendo nuestro;
        //  - los PARES COMPLETOS, a $1 el par: redimen esa cantidad gane quien gane.
        // Las participaciones sueltas se valoran a cero, que es lo que pueden llegar a valer.
        //
        // Mirar el saldo desnudo hacia saltar el suelo en cuanto se llenaba un par: el efectivo baja,
        // pero el dinero no se ha perdido, solo ha cambiado de forma.
        //
        // Los pares se leen del BUCLE, no del ultimo resumen: el resumen de una pasada detenida trae
        // ceros, asi que apoyarse en el dejaria la guarda enganchada para siempre.
        // La decision vive en `makerDebeRetirarse`, pura y probada aparte: es sobre DINERO, y esas hay
        // que poder probarlas sin levantar medio bot.
        const veredicto = makerDebeRetirarse({
          saldo,
          ordenesVivasUsd: this.ultimaPasadaMaker?.vivoUsd ?? 0,
          paresUsd: loop.paresUsd(),
          sueloUsd: suelo,
        });
        const nuestro = veredicto.patrimonioUsd;
        const aCiegas = veredicto.motivo === "saldo_a_ciegas";
        if (veredicto.retirar) {
          // La lista de mercados solo hace falta para RETIRAR, y retirar solo hace falta la primera
          // vez: en las pasadas siguientes ya no queda nada puesto. Asi el escaneo caro se paga una
          // vez por parada y no cada quince segundos mientras dure.
          const mercadosParaRetirar = this.makerBajoSuelo ? [] : await this.mercadosParaMaker(markets);
          const retiradas = this.makerBajoSuelo ? 0 : await loop.retirarTodo(mercadosParaRetirar);

          // ANTES de rendirse: cerrar los pares que se puedan cerrar.
          //
          // Parar con una posicion direccional a medias es lo peor de los dos mundos — no cotizas y
          // sigues expuesto. Y cerrar un par no puede empeorar el patrimonio que mide esta misma
          // guarda: convierte sueltas (valen 0 en la cuenta) en pares (valen $1). Sube, nunca baja.
          //
          // No se hace a ciegas: si el saldo no se puede LEER no se compra nada, porque entonces no se
          // sabe si hay con que pagarlo.
          if (!aCiegas) {
            // Sin lista: el bucle recorre sus propias posiciones. Pasarle la del escaner fue un error
            // —llegaba vacia a los 3 segundos del arranque, y el mercado donde te llenaron casi nunca
            // esta entre los candidatos— y ademas no hacia falta.
            const rebalanceo = await loop.rebalancearParaCerrarPares(nowMs);
            if (rebalanceo.cerrados > 0) {
              logger.info("Maker: pares cerrados antes de detenerse.", {
                mercados: rebalanceo.cerrados,
                gastadoUsd: rebalanceo.gastadoUsd,
              });
            }
          }
          // Se avisa en la TRANSICION, no en cada pasada: un error cada tres segundos deja de leerse,
          // y lo que hay que ver es el momento en que paro y por que.
          const avisar = !this.makerBajoSuelo;
          this.makerBajoSuelo = true;
          if (avisar) {
            logger.error(
              aCiegas
                ? "Maker DETENIDO: no se puede leer el saldo, y a ciegas no se arriesga."
                : "Maker DETENIDO: el patrimonio cayo por debajo del suelo.",
              {
                saldoUsd: Math.round(saldo.usd * 100) / 100,
                origenDelSaldo: saldo.source,
                sinLeerDesdeMs: saldo.staleReadingMs,
                masOrdenesVivasUsd: Math.round((this.ultimaPasadaMaker?.vivoUsd ?? 0) * 100) / 100,
                masParesCompletosUsd: Math.round(loop.paresUsd() * 100) / 100,
                patrimonioUsd: Math.round(nuestro * 100) / 100,
                sueloUsd: suelo,
                retiradas,
              },
            );
          }
          // El dinero se reporta COMO ESTA, no en ceros.
          //
          // Estos campos son hechos sobre tu dinero y no dejan de ser ciertos porque el maker se haya
          // parado: `gastadoUsd` es lo que hay fuera en posiciones y `paresUsd` lo que redime $1. Al
          // ponerlos a cero, el panel enseñaba "llenado $0.00" teniendo $9,80 en una posicion
          // direccional — justo la cifra que el panel existe para hacer visible, escondida justo
          // cuando hay algo que ver. Lo unico que si es cero es lo que hay EN EL LIBRO, porque se
          // acaba de retirar.
          this.ultimaPasadaMaker = {
            colocadas: 0,
            canceladas: retiradas,
            comprometidoUsd: 0,
            gastadoUsd: loop.gastadoTotalUsd(),
            vivoUsd: 0,
            paresUsd: loop.paresUsd(),
            mercados: [{ slug: "(todos)", motivo: `saldo_bajo_suelo_${suelo}` }],
          };
          return;
        }
        if (this.makerBajoSuelo) {
          logger.info("Maker reanudado: el patrimonio volvio por encima del suelo.", {
            patrimonioUsd: Math.round(nuestro * 100) / 100,
            sueloUsd: suelo,
          });
          this.makerBajoSuelo = false;
        }
      }

      // Aqui si se va a cotizar, asi que ahora si toca pagar el escaneo.
      this.ultimaPasadaMaker = await loop.runOnce(await this.mercadosParaMaker(markets), nowMs);
    } catch (error) {
      logger.warn("Pasada del maker fallida.", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * El bucle maker, construido perezosamente porque el motor LIVE necesita credenciales y no debe
   * exigirlas a quien corre en sim.
   */
  private makerLoop(): MakerLoop | undefined {
    if (!this.deps.orderbook || !this.deps.rewardParams) {
      return undefined;
    }
    this.makerLoopCache ??= new MakerLoop(
      {
        orderbook: this.deps.orderbook,
        // Con la fuente `recompensas` los parametros ya vienen del escaner: pedirlos otra vez por
        // mercado serian 25 peticiones por pasada para releer lo que ya tenemos.
        rewards:
          (this.config.makerMarketSource ?? "recompensas") === "recompensas"
            ? { paraMercado: async (_id: string, slug?: string) => (slug ? this.paramsMaker.get(slug) : undefined) }
            : this.deps.rewardParams,
        engine:
          this.modeFor("maker") === "live"
            ? (this.deps.makerEngineByMode?.live ?? new LiveMakerEngine(this.config))
            : (this.deps.makerEngineByMode?.sim ?? new SimulationMakerEngine()),
      },
      {
        capitalUsd: this.config.makerCapitalUsd ?? 40,
        retirarSegundosAntesDelCierre: this.config.makerRetireSecondsBeforeClose ?? 30,
        ticksDelMedio: this.config.makerTicksDelMedio,
        // Solo en LIVE hay herencia que limpiar: el libro de simulacion muere con el proceso.
        limpiarHerenciaAlArrancar: this.modeFor("maker") === "live",
      },
    );
    return this.makerLoopCache;
  }

  /** Ultimo resumen del maker, para que la UI pueda mostrar que esta pasando. */
  getMakerSummary(): ResumenPasada | undefined {
    return this.ultimaPasadaMaker;
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
      if (!opportunity || this.arbNakedLegStreak >= this.arbNakedLegHaltStreak()) {
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
  getBankroll(): {
    usd: number;
    source: "onchain" | "declared" | "unknown";
    atMs?: number;
    staleReadingMs?: number;
  } {
    const resolved = resolveEffectiveBankrollUsd(this.lastBankrollReading, this.config.liveBankrollUsd, Date.now());
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
      priceSource: this.aperturasPorTwap.has(market.slug) ? "twap" : "spot",
      capturedAtMs: nowMs,
    };
    this.aperturasPorTwap.delete(market.slug);
    await this.deps.state.saveOpening(opening);
    logger.info("Captured Chainlink opening tick.", {
      slug: market.slug,
      openingPrice: opening.openingPrice,
      tickTimestamp: new Date(opening.openingTickTimestampMs).toISOString(),
    });
    return opening;
  }

  private getOpeningTick(market: MarketInfo, latestTick: BtcPriceTick | undefined): BtcPriceTick | undefined {
    // La cascada TWAP → spot vive en `resolveOpeningTick` (markets.ts) porque el panel necesita la
    // MISMA, y cuando cada uno llevaba la suya se separaron.
    const resuelto = resolveOpeningTick({
      feed: this.deps.priceFeed,
      market: market.asset,
      windowStartMs: market.windowStartMs,
      twapLookbackSeconds: market.twapLookbackSeconds,
      graceMs: this.config.openingCaptureGraceMs,
      latestTick,
    });
    if (!resuelto) {
      return undefined;
    }
    if (resuelto.priceSource === "twap") {
      this.aperturasPorTwap.add(market.slug);
    }
    return resuelto.tick;
  }

  private buildTradeSignal(args: {
    market: MarketInfo;
    opening: WindowOpening | undefined;
    latestTick: BtcPriceTick | undefined;
    quotes: Partial<Record<Outcome, OrderbookQuote>>;
    nowMs: number;
    reservedDailySpendUsd: number;
  }): TradeSignal | undefined {
    if (this.deps.state.hasTraded(args.market.slug, this.modeFor("dir"))) {
      this.logSkipOnce(args.market.slug, "market_already_traded");
      return undefined;
    }

    // Con la estrategia "favorito" encendida pero sin permiso para dinero real NO se cae de vuelta al
    // direccional: se para el camino entero. Un fallback silencioso pondria a operar en live una
    // estrategia distinta de la que el operador acaba de elegir, que es la peor sorpresa posible.
    if (
      this.config.favoriteStrategyEnabled === true &&
      this.modeFor("dir") === "live" &&
      this.config.favoriteAllowLive !== true
    ) {
      this.logSkipOnce(args.market.slug, "favorite_strategy_live_not_allowed");
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
      const bankroll = resolveEffectiveBankrollUsd(this.lastBankrollReading, this.config.liveBankrollUsd, args.nowMs);
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

    const winner = this.selectSignalOutcome(args.market, args.opening, args.latestTick, args.quotes);
    if (!winner) {
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
      this.logSkipOnce(args.market.slug, "outside_entry_window", {
        market: args.market.asset,
        outcome: winner.outcome,
        entryWindowSeconds,
        secondsToEnd: Math.round((args.market.endMs - args.nowMs) / 1000),
      });
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
      minDistanceUsd: winner.minDistanceUsd,
      entryWindowSeconds,
    };
  }

  /**
   * Elige el lado a comprar. Hay DOS criterios y son excluyentes:
   *
   * - **direccional** (por defecto): la distancia del oraculo respecto a la apertura. Predice.
   * - **favorito**: el ask que el libro ya ha puesto mas alto, dentro de una banda. No predice.
   *
   * Son excluyentes y no acumulativos a proposito. Si pudieran disparar los dos, una misma ventana
   * generaria muestras de dos estrategias distintas y el ledger dejaria de poder atribuir el
   * resultado a ninguna — que es justo el error que ya invalido una calibracion entera (ver la
   * trampa del backtest que se puntuaba a si mismo en ARQUITECTURA.md).
   */
  private selectSignalOutcome(
    market: MarketInfo,
    opening: WindowOpening,
    tick: BtcPriceTick,
    quotes: Partial<Record<Outcome, OrderbookQuote>>,
  ): { outcome: Outcome; distanceUsd: number; minDistanceUsd: number } | undefined {
    if (this.config.favoriteStrategyEnabled === true) {
      const decision = selectFavoriteOutcome({
        quotes,
        minAsk: this.config.favoriteMinAsk,
        maxAsk: this.config.favoriteMaxAsk,
        maxAskSum: this.config.favoriteMaxAskSum,
      });
      if (!decision.selection) {
        this.logSkipOnce(market.slug, FAVORITE_SKIP_REASONS[decision.reason], {
          market: market.asset,
          ...decision.detail,
        });
        return undefined;
      }
      // La distancia ya no decide nada, pero se sigue midiendo y guardando con el signo del lado
      // comprado: es lo que despues permite preguntarle al ledger si el favorito del libro coincidia
      // con el movimiento real del oraculo. `minDistanceUsd: 0` = esta estrategia no aplica umbral.
      const distanceUsd =
        decision.selection.outcome === "UP" ? tick.value - opening.openingPrice : opening.openingPrice - tick.value;
      return { outcome: decision.selection.outcome, distanceUsd, minDistanceUsd: 0 };
    }

    const minDistanceUsd = {
      UP: this.resolveConfiguredMinDistance(market.asset, "UP"),
      DOWN: this.resolveConfiguredMinDistance(market.asset, "DOWN"),
    };
    const winner = getWinningOutcome(opening.openingPrice, tick.value, minDistanceUsd);
    if (!winner) {
      this.logSkipOnce(market.slug, "btc_distance_below_threshold", {
        market: market.asset,
        minDistanceUsd,
        openingPrice: opening.openingPrice,
        currentPrice: tick.value,
      });
      return undefined;
    }
    return { outcome: winner.outcome, distanceUsd: winner.distanceUsd, minDistanceUsd: minDistanceUsd[winner.outcome] };
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
  private modeFor(strategy: "arb" | "dir" | "maker"): Mode {
    if (strategy === "maker") {
      // El maker cae a "sim" y NO al modo global: es la estrategia mas nueva y la unica que deja
      // ordenes vivas en el libro, asi que heredar un arranque en live seria empezar a inmovilizar
      // dinero real sin que nadie lo haya pedido.
      return this.config.makerMode ?? "sim";
    }
    return (strategy === "arb" ? this.config.arbMode : this.config.directionalMode) ?? this.config.mode;
  }

  /** Ejecutor del modo pedido. Cae al inyectado cuando no hay uno por modo (dobles de test). */
  private executorFor(mode: Mode): TradeExecutor {
    return this.deps.executorByMode?.[mode] ?? this.deps.executor;
  }

  /**
   * Cotiza las dos patas a la vez. Mismo tamaño y tope que la deteccion, para que lo recotizado sea
   * comparable con lo que disparo la oportunidad.
   */
  private async quoteArbLegs(market: MarketInfo): Promise<Partial<Record<Outcome, OrderbookQuote>>> {
    const pedir = (outcome: Outcome): Promise<OrderbookQuote> =>
      this.deps.orderbook.getQuote(
        market.outcomes[outcome].tokenId,
        resolveTradeAmountUsd({
          mode: this.config.mode,
          requestedUsd: this.resolveConfiguredTradeAmountUsd(market.asset, outcome),
          orderMinSize: market.orderMinSize,
          autoMinLive: this.config.autoMinLive,
        }),
        this.resolveConfiguredMaxAskPrice(market.asset, outcome),
      );
    const [up, down] = await Promise.allSettled([pedir("UP"), pedir("DOWN")]);
    const quotes: Partial<Record<Outcome, OrderbookQuote>> = {};
    if (up.status === "fulfilled") {
      quotes.UP = up.value;
    }
    if (down.status === "fulfilled") {
      quotes.DOWN = down.value;
    }
    return quotes;
  }

  /** Patas sueltas seguidas que paran el arbitraje. */
  private arbNakedLegHaltStreak(): number {
    const configured = this.config.arbNakedLegHaltStreak;
    // `>= 1` y no `> 0`: un 0 o un negativo pararian el arbitraje ANTES del primer intento, que es lo
    // contrario de "sin freno". Un valor invalido cae al default en vez de romper la estrategia.
    return configured !== undefined && Number.isFinite(configured) && configured >= 1
      ? Math.floor(configured)
      : DEFAULT_ARB_NAKED_LEG_HALT_STREAK;
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

  /**
   * Si a esta estrategia le toca sondear el libro, y marca su reloj si es que si.
   *
   * Marcar SIEMPRE que toca (aunque acabe cotizando por la otra estrategia) mantiene las dos cadencias
   * independientes y estables: sin eso, la que no dispara acumularia deuda y sondearia de mas en
   * cuanto la otra se apagara.
   */
  private debeEscanearFueraDeVentana(
    relojes: Map<string, number>,
    slug: string,
    nowMs: number,
    intervaloMs: number,
  ): boolean {
    const ultimo = relojes.get(slug) ?? 0;
    if (nowMs - ultimo < intervaloMs) {
      return false;
    }
    relojes.set(slug, nowMs);
    return true;
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
      // La estrategia "favorito" ELIGE lado con estos libros, asi que para ella no son analitica: son
      // la entrada de la decision. Sin esta condicion quedaba colgando de que hubiera un
      // `analyticsRecorder` montado — y sin el no habria fallado, habria dejado de operar en silencio
      // registrando `favorite_missing_quote` para siempre, que es de los sintomas mas caros de leer.
      if (!this.deps.analyticsRecorder && this.config.favoriteStrategyEnabled !== true) {
        return {};
      }
    } else {
      // Fuera de la ventana de analytics se cotiza a cadencia reducida, y solo para quien lo necesita:
      // el ARBITRAJE (aparece en cualquier momento del ciclo) y la estrategia FAVORITO (elige lado con
      // estos libros, asi que con la ventana de entrada abierta mas alla de los 120s se quedaba ciega
      // y registraba `favorite_missing_quote` en bucle).
      //
      // Cotizar en cada iteracion triplicaba las llamadas al orderbook y degrado el loop de p50 56ms
      // a 281ms (con picos de 20s), y un loop lento llega tarde a las entradas — que ya medimos que
      // cuesta dinero. Unos pocos segundos bastan: la oportunidad dura segundos, no milisegundos.
      //
      // Cada estrategia lleva su PROPIO contador. Con uno compartido, tener las dos encendidas le
      // robaria sondeos a las dos.
      const arbQuiere = this.config.arbEnabled === true;
      const favoritoQuiere = this.config.favoriteStrategyEnabled === true;
      if (!arbQuiere && !favoritoQuiere) {
        return {};
      }
      // `some`, no `every`: basta con que UNA de las dos toque para cotizar, y la otra aprovecha el
      // mismo libro. Los dos relojes se marcan igualmente, para que ninguna se salte su turno.
      const debeEscanear = [
        arbQuiere ? this.debeEscanearFueraDeVentana(this.lastArbScanMs, market.slug, nowMs, ARB_SCAN_INTERVAL_MS) : false,
        favoritoQuiere
          ? this.debeEscanearFueraDeVentana(this.lastFavoriteScanMs, market.slug, nowMs, FAVORITE_SCAN_INTERVAL_MS)
          : false,
      ].some(Boolean);
      if (!debeEscanear) {
        return {};
      }
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

    // Se RECOTIZA justo antes de mandar, y se decide con lo recotizado.
    //
    // Las cotizaciones de `args.quotes` vienen de la fase de captura, con trabajo de por medio. El 81%
    // de los arbitrajes aparecen en los ultimos 2 minutos de la ventana, que es cuando el libro se
    // mueve mas: para cuando llega la orden, el nivel que se vio puede haber desaparecido. Los dos
    // primeros arbitrajes en live murieron asi ("no orders found to match").
    //
    // Recotizar hace DOS cosas, y la segunda importa mas que la primera: manda el precio que de verdad
    // hay, y ABORTA si el arbitraje ya se esfumo, en vez de lanzar una orden contra un libro que ya no
    // ofrece nada. Es mejor incluso si la hipotesis de la latencia resulta falsa.
    const frescas = await this.quoteArbLegs(market);
    const up = frescas.UP;
    const down = frescas.DOWN;
    if (!up?.bestAsk || !down?.bestAsk) {
      this.logSkipOnce(market.slug, "arb_requote_failed", {});
      return;
    }
    // Se reevalua con el MISMO detector que la detecto, no con una cuenta a mano que pueda derivar.
    const vigente = detectCompleteSetArb({
      market: market.asset,
      slug: market.slug,
      endMs: market.endMs,
      nowMs,
      quotes: frescas,
    });
    if (!vigente || vigente.netPerSet < minNetPerSet) {
      logger.info("Arbitraje evaporado entre la cotizacion y la orden.", {
        slug: market.slug,
        netPerSetVisto: opportunity.netPerSet,
        netPerSetAhora: vigente?.netPerSet ?? 0,
        askUpVisto: opportunity.upAsk,
        askUpAhora: up.bestAsk,
        askDownVisto: opportunity.downAsk,
        askDownAhora: down.bestAsk,
        edadCotizacionMs: quotes.UP?.quotedAtMs === undefined ? undefined : nowMs - quotes.UP.quotedAtMs,
      });
      this.logSkipOnce(market.slug, "arb_gone_before_order", {});
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
      const bankroll = resolveEffectiveBankrollUsd(this.lastBankrollReading, this.config.liveBankrollUsd, nowMs);
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
        // Contexto de lo que se mando de verdad. Los dos primeros arbitrajes en live murieron con un
        // "no orders found to match" y el log no permitia distinguir si el libro se habia movido, si el
        // precio iba bajo o si la cotizacion llegaba vieja. Sin esto solo quedan hipotesis.
        const detalle: LiveOrderFailureDetails | undefined =
          result.error instanceof LiveOrderError ? result.error.details : undefined;
        const contexto = {
          leg: outcome,
          error: message,
          sets,
          secondsToEnd: Math.round((market.endMs - nowMs) / 100) / 10,
          ...(detalle
            ? {
                precioEnviado: detalle.orderPrice,
                askCotizado: detalle.quotedBestAsk,
                // Cuanto se movio el techo por encima del ask que vimos. Si el rechazo llega igual, el
                // libro se fue mas alla de esto.
                margenSobreAsk:
                  detalle.quotedBestAsk === undefined
                    ? undefined
                    : Math.round((detalle.orderPrice - detalle.quotedBestAsk) * 1000) / 1000,
                profundidadCotizadaUsd: Math.round(detalle.quotedDepthUsd),
                importeUsd: detalle.amountUsd,
                // La sospecha numero uno: la cotizacion llego vieja a la orden.
                edadCotizacionMs: detalle.quoteAgeMs,
              }
            : {}),
        };
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
            ...contexto,
            legLlenada: thinFirst[0],
          });
          await this.deps.notifier?.notify({
            key: `arb-naked:${arbSlug}`,
            level: "warn",
            title: "Arbitraje incompleto",
            body: `${market.asset}: solo la pata ${thinFirst[0]} llenó (${sets} sets). Queda posición direccional.`,
            minIntervalMs: 60_000,
          });
        } else {
          // `logSkipOnce` colapsa por slug, asi que un rechazo se veria una sola vez por ventana. Este
          // es el suceso que hay que diagnosticar: se registra entero, cada vez.
          logger.warn("Arbitraje rechazado por el exchange en la primera pata.", {
            slug: market.slug,
            ...contexto,
          });
          this.logSkipOnce(market.slug, "arb_execution_failed", contexto);
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
        twapTick:
          args.latestTick && args.market.twapLookbackSeconds
            ? this.deps.priceFeed.getTwapAtOrBefore?.(
                args.market.asset,
                args.latestTick.timestampMs,
                args.market.twapLookbackSeconds,
              )
            : undefined,
        // La ventana que resuelve, junto al dato. Sin ella una muestra vieja no se puede reinterpretar
        // cuando Polymarket vuelva a cambiarla — y ya la ha cambiado de 30 a 60.
        twapWindowSeconds: args.market.twapLookbackSeconds,
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
      // El descarte BARATO va primero. `resolveTradeFromTick` ya comprueba las dos cosas, pero lo hacia
      // DESPUES de que este bucle pagara las busquedas de precio — y esas no son gratis: son dos
      // recorridos del historico del feed por trade.
      //
      // Medido en produccion: 1.362 operaciones en el estado, las 1.362 ya resueltas y ninguna
      // pendiente. O sea ~4.000 busquedas por segundo para no resolver nada. Ese trabajo no se veia
      // como un fallo, se veia como timeouts de 2 s leyendo libros en la pasada del maker: el bucle
      // estaba demasiado ocupado para atender la respuesta antes de que saltara el temporizador.
      // Un maker que no puede leer el libro es un maker que no recoloca.
      //
      // Las dos condiciones son exactamente las que aplica `resolveTradeFromTick`, solo que antes: no
      // cambia lo que se resuelve, solo lo que cuesta no resolver.
      if (trade.resolved || nowMs < trade.endMs) {
        continue;
      }
      const market = trade.asset ?? marketSymbolFromSlug(trade.slug) ?? "BTC";
      const latestTick = this.deps.priceFeed.getLatestTick(market);
      if (!latestTick) {
        continue;
      }
      // Judge the winner by the price AT the window close (last tick <= endMs), not the first tick
      // after it — photo-finish windows flipped otherwise.
      // Cierre por la serie TWAP, que es la que resuelve. El spot solo si aquella no esta.
      const ventanaCierre = trade.twapWindowSeconds;
      const twapClose = ventanaCierre
        ? this.deps.priceFeed.getTwapAtOrBefore?.(market, trade.endMs, ventanaCierre)
        : undefined;
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

  /**
   * `SkipReason` y no `string`: el tipo se deriva del mapa de etiquetas, asi que registrar un motivo
   * sin texto no compila. Es lo que fallo con `arb_execution_failed`, que llevaba dias saliendo como
   * codigo crudo en las tres pantallas.
   */
  private logSkipOnce(slug: string, reason: SkipReason, meta?: unknown): void {
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

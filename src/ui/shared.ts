import type { FiscalYearSummary } from "../fiscal.js";
import type { LogEntry } from "../logger.js";
import type { PnlResetAtMsByMode, PnlSummary, PnlSummaryByMode } from "../pnl.js";
import type { BandProgram } from "../bandProbeProgram.js";
import type { RiskHaltStatus } from "../riskCircuitBreaker.js";
import type {
  MarketDistanceSettings,
  MarketEntryWindowSettings,
  MarketInfo,
  MarketOutcomeBooleanSettings,
  MarketOutcomeNumberSettings,
  MarketSymbol,
  Mode,
  OrderbookQuote,
  Outcome,
  PriceTick,
  TradeAttempt,
  WindowOpening,
} from "../types.js";

export interface UiSettings {
  minBtcDistanceUsd: number;
  enabledMarkets: MarketSymbol[];
  enabledMarketOutcomes: MarketOutcomeBooleanSettings;
  minDistanceUsdByMarket: MarketDistanceSettings;
  minDistanceUsdByMarketOutcome: MarketOutcomeNumberSettings;
  entryWindowSeconds: number;
  entryWindowSecondsByMarket: MarketEntryWindowSettings;
  entryWindowSecondsByMarketOutcome: MarketOutcomeNumberSettings;
  simTradeAmountUsd: number;
  simTradeAmountUsdByMarketOutcome: MarketOutcomeNumberSettings;
  liveTradeAmountUsd: number;
  liveTradeAmountUsdByMarketOutcome: MarketOutcomeNumberSettings;
  autoMinLive: boolean;
  maxAskPrice: number;
  maxAskPriceByMarketOutcome: MarketOutcomeNumberSettings;
  // Piso de ask por mercado/lado (0.01 = sin piso).
  minAskPriceByMarketOutcome: MarketOutcomeNumberSettings;
  // Hard ceiling on the ask price for any trade and for what the auto-adjust may pick (reward/risk).
  maxAskPriceCeiling: number;
  /**
   * Estrategia "favorito": compra el lado cuyo ask ya esta mas alto, dentro de la banda.
   *
   * SUSTITUYE a la seleccion direccional (la distancia de Chainlink), no se suma a ella: son dos
   * criterios incompatibles sobre el mismo mercado y mezclarlos haria imposible atribuir cada muestra
   * del ledger a una de las dos. Ver `selectSignalOutcome` en botRunner.
   */
  favoriteStrategyEnabled: boolean;
  favoriteMinAsk: number;
  favoriteMaxAsk: number;
  /** Tope de la SUMA de los dos asks. Por encima el libro esta muerto y el ask no es probabilidad. */
  favoriteMaxAskSum: number;
  /**
   * Cierre APARTE para dinero real. Sin esto la estrategia solo corre en sim, aunque este encendida.
   *
   * No es un booleano cualquiera: `entraEnLive` lo trata como los modos de estrategia, asi que
   * encenderlo desde la web o la TUI exige teclear `LIVE_PHRASE`.
   */
  favoriteAllowLive: boolean;
  /**
   * Tramo de MAXIMA CONVICCION: por encima de `favoriteMaxSizeAsk` se dimensiona contra el capital
   * disponible (el saldo real de la cuenta), recortado por `favoriteMaxSizeFraction`, en vez de
   * usar el importe configurado.
   *
   * Interruptor propio y apagado por defecto a proposito: multiplica el tamaño de la posicion por dos
   * ordenes de magnitud, y eso no puede ser el efecto colateral de mover una banda.
   */
  favoriteMaxSizeEnabled: boolean;
  favoriteMaxSizeAsk: number;
  /**
   * Que fraccion del capital libre se juega la conviccion. 1 = la cuenta entera.
   *
   * Es el freno del tramo: sin el, "maxima conviccion" significaba all-in en cada entrada, y a 0,98
   * el propio mercado admite fallar una de cada cincuenta veces.
   */
  favoriteMaxSizeFraction: number;
  /**
   * Salida por STOP: cerrar la posicion cuando el ask de su lado cae por debajo del suelo de la banda.
   *
   * Es el PRIMER camino de venta del bot. Hasta aqui toda posicion se mantenia hasta la redencion.
   */
  favoriteExitEnabled: boolean;
  favoriteExitStopMargin: number;
  favoriteExitMinSecondsToEnd: number;
  favoriteExitMinBid: number;
  favoriteExitMinFillRatio: number;
  favoriteExitMaxSpread: number;
  favoriteExitMinHoldSeconds: number;
  /** Cierre APARTE para dinero real, como `favoriteAllowLive`. */
  favoriteExitAllowLive: boolean;
  dailySpendLimitUsd: number;
  maxDailyLossUsd: number;
  liveBankrollUsd: number;
  minBankrollForDirectionalUsd: number;
  maxConsecutiveLosses: number;
  riskHaltCooldownHours: number;
  // Complete-set arbitrage execution (buy both sides when the pair costs < $1 after fees).
  arbEnabled: boolean;
  /** Arbitraje tambien en 15m. Solo arbitraje: el direccional se queda en 5m. */
  makerEnabled: boolean;
  makerMode: "heredado" | "sim" | "live";
  makerCapitalUsd: number;
  makerRetireSecondsBeforeClose: number;
  /**
   * De donde salen los mercados del maker. `recompensas` busca en todo Polymarket lo que mejor paga y
   * cabe en el capital; `cripto5m` se queda en BTC/ETH/DOGE, que es de los peores sitios para poco
   * capital (entrada de $50 y banda de 1,5c, contra $20 y 4,5c de los mejores).
   */
  makerMarketSource: "cripto5m" | "recompensas";
  /** Suelo de saldo: por debajo, el maker retira todo y deja de cotizar. 0 = sin suelo. */
  makerStopBelowUsd: number;
  /** A cuantos ticks del medio coloca el maker. 1 = conservador, 0 = pegado al medio (mas recompensa, mas llenados). */
  makerTicksDelMedio: number;
  arbMode: "heredado" | "sim" | "live";
  directionalMode: "heredado" | "sim" | "live";
  arb15mEnabled: boolean;
  arbNakedLegHaltStreak: number;
  arbMaxUsdPerOpportunity: number;
  arbMinNetPerSet: number;
  // IANA timezone (or "auto" = system) used for display, chart bucketing, fiscal days and the daily
  // risk cutoff.
  timezone: string;
  // EV gate: only trade setups with a positive, fee-aware expected value backed by enough history.
  requirePositiveEv: boolean;
  // Exploración de arranque en frío: sondeos acotados de EV positivo en setups de historial corto.
  explorationEnabled: boolean;
  // Si el PROCESO se reinicia (watchdog, actualizacion, reinicio de Windows), arrancar solo en SIM.
  // Deliberadamente no existe la variante live: esa palanca es del usuario, siempre.
  autoStartSimOnBoot: boolean;
  // Interruptor del watchdog de Windows. No lo lee el proceso Node: lo lee `scripts/watchdog.ps1`
  // desde data/ui-config.json en cada pasada, para poder apagarlo sin tocar el Programador de tareas.
  watchdogEnabled: boolean;
  evUseSimilarity: boolean;
  // Calibracion empirica de la probabilidad del gate desde el propio ledger.
  evCalibration: boolean;
  evSafetyMargin: number;
  evMinHistoryTrades: number;
  minFillRatio: number;
  evMinExpectedRoi: number;
  tickStaleMs: number;
  pollIntervalMs: number;
  openingCaptureGraceMs: number;
  // Piso duro de distancia por mercado: la distancia efectiva es max(configurada, piso).
  minDistanceFloorUsdByMarket: MarketDistanceSettings;
  // Cuanto por encima del best-ask puede llenar una orden live (anti-slippage).
  liveMaxSlippage: number;
  // Retencion de analytics.jsonl (requiere reinicio del proceso para aplicar).
  maxAnalyticsSamples: number;
  aiAutoApplyLive: boolean;
  // Auto-tuning del ask cap por mercado desde bandas realizadas (candados fijos).
  aiAutoTuneAskCap: boolean;
  /** Sondeos de banda: el camino que puede ABRIR la ventana. Interruptor aparte del de estrechar. */
  aiAutoProbeBands: boolean;
  aiLastAppliedAtMs?: number;
}

export interface SanitizedConfig extends UiSettings {
  mode: Mode;
  dataDir: string;
  hasPrivateKey: boolean;
  hasFunderAddress: boolean;
  hasSignatureType: boolean;
}

export interface LiveReadiness {
  ready: boolean;
  hasPrivateKey: boolean;
  hasFunderAddress: boolean;
  hasSignatureType: boolean;
  reason?: string;
}

export interface SignalSnapshot {
  reason: string;
  market?: MarketSymbol;
  outcome?: Outcome;
  distanceUsd?: number;
  inEntryWindow: boolean;
  secondsToEnd?: number;
}

export interface MarketStatusSnapshot {
  marketSymbol: MarketSymbol;
  market?: MarketInfo;
  opening?: WindowOpening;
  /**
   * Tick SPOT de Chainlink. Es el que usa el bot para medir la distancia, y por eso sigue publicandose.
   *
   * No es el precio que Polymarket enseña ni con el que resuelve: eso es `twapTick`. Los dos viajan
   * juntos a proposito — la pantalla tenia un solo numero llamado "Precio" que era el spot mientras la
   * "Apertura" de al lado ya era TWAP, asi que la distancia mezclaba dos series sin decirlo.
   */
  tick?: PriceTick;
  /** Ultimo valor de la serie TWAP que RESUELVE este mercado. Es el precio comparable con la web. */
  twapTick?: PriceTick;
  /** Ventana de esa serie en segundos (30 o 60), de `MarketInfo.twapLookbackSeconds`. */
  twapWindowSeconds?: number;
  quotes?: Partial<Record<Outcome, OrderbookQuote>>;
  signal: SignalSnapshot;
}

/**
 * Modo ya resuelto de cada estrategia: lo que de verdad va a pasar, no lo que dice el ajuste.
 *
 * Se publica resuelto —y no se deja que cada pantalla lo deduzca de `settings` y del modo global— para
 * que ninguna pueda poner una insignia "SIM" sobre una estrategia que esta moviendo dinero real.
 */
export interface EffectiveModes {
  arb: Mode;
  directional: Mode;
  /**
   * El maker se anadio DESPUES de este campo y quedo fuera: la insignia decia "SIM" con el maker
   * moviendo dinero real. Es exactamente la mentira que este tipo existe para impedir.
   *
   * Toda estrategia con modo propio tiene que aparecer aqui. Hay un test que lo comprueba contra las
   * claves `*Mode` de los ajustes, para que la proxima no se olvide.
   */
  maker: Mode;
}

export interface UiStatus {
  running: boolean;
  mode?: Mode;
  effectiveModes: EffectiveModes;
  /**
   * Quien relanza el proceso si muere. Lo declara el entorno; ver `SupervisorKind`.
   *
   * Lo publica el estado —y no lo deduce cada pantalla— porque de el depende si el ajuste
   * `watchdogEnabled` hace algo o es decorativo, y una casilla decorativa que parece un control es
   * peor que no tenerla.
   */
  supervisor: SupervisorKind;
  startedAtMs?: number;
  lastError?: string;
  config: SanitizedConfig;
  settings: UiSettings;
  liveReadiness: LiveReadiness;
  markets: MarketStatusSnapshot[];
  market?: MarketInfo;
  opening?: WindowOpening;
  tick?: PriceTick;
  quotes?: Partial<Record<Outcome, OrderbookQuote>>;
  signal: SignalSnapshot;
  dailySpendUsd: number;
  pnl: PnlSummary;
  pnlByMode: PnlSummaryByMode;
  // Lifetime PnL ignoring the P&L reset marker (post-reset figures are in `pnl`/`pnlByMode`).
  pnlHistoricalByMode: PnlSummaryByMode;
  // When each mode's P&L was last reset (epoch ms). Absent/omitted mode = never reset.
  pnlResetAtMs: PnlResetAtMsByMode;
  riskHalt?: RiskHaltStatus;
  logs: LogEntry[];
  snapshotError?: string;
  /** Salud del bucle: fraccion de iteraciones que acabaron lanzando (ventana movil). */
  loopHealth?: { iterations: number; failed: number; failedPct: number; lagMaxMs?: number };
  /** Capital efectivo de la guardia de riesgo y de donde salio (on-chain vs declarado). */
  /**
   * Que decidio el maker en su ultima pasada. Sin esto, un maker que no coloca es indistinguible de
   * un maker que no se esta ejecutando — y esa ambiguedad ya costo media hora de diagnostico.
   */
  makerSummary?: {
    colocadas: number;
    canceladas: number;
    comprometidoUsd: number;
    /**
     * Los tres numeros de RIESGO, que antes se calculaban y se tiraban aqui.
     *
     * El runner los publica desde el primer dia, pero este tipo solo declaraba lo colocado, asi que
     * nada aguas abajo podia pintarlos. Son justo los que describen la seleccion adversa: `gastadoUsd`
     * es dinero que ya salio a comprar un lado suelto —lo que costo $41,41 en 40 minutos el
     * 2026-08-19— y `llenadas` es el aviso temprano de que esta pasando. `vivoUsd` es lo inmovilizado
     * en ordenes en reposo, que NO es una perdida, y `paresUsd` lo que redime $1 el par gane quien
     * gane. Separarlos es lo que distingue "el dinero cambio de forma" de "el dinero se va".
     */
    gastadoUsd?: number;
    vivoUsd?: number;
    paresUsd?: number;
    llenadas?: number;
    mercados: Array<{ slug: string; motivo?: string; esperadoUsdDia?: number }>;
  };
  bankroll?: {
    usd: number;
    source: "onchain" | "declared" | "unknown";
    atMs?: number;
    /** Presente solo si habia lectura on-chain pero caduco. Distingue "nunca leyo" de "el RPC murio". */
    staleReadingMs?: number;
  };
  /**
   * Decisiones del autoajuste: que banda propuso, que prometio y que esta entregando la realidad.
   *
   * Se publica aunque el ajuste se aplique solo. Auto-aplicar SIN esto seria exactamente "entrar sin
   * que nadie lo vea"; con esto, la autonomia es una comodidad y no una venda en los ojos.
   */
  bandPrograms?: BandProgram[];
}

export type UiEvent =
  | { type: "status"; status: UiStatus }
  | { type: "log"; log: LogEntry };

export interface StartBotRequest {
  mode: Mode;
  confirmLive?: boolean;
}

export interface AnalysisImportResponse {
  importedCount: number;
  duplicateCount: number;
  skippedInvalidCount: number;
  totalKnownSamples: number;
  firstSampleAtMs?: number;
  lastSampleAtMs?: number;
}

export interface TelegramNotificationSettings {
  enabled: boolean;
  configured: boolean;
  hasBotToken: boolean;
  botTokenMasked?: string;
  chatId: string;
  publicUrl?: string;
  source: "env" | "local" | "none";
  // Digest mode: per-trade pings batched into one summary every N minutes.
  digestEnabled: boolean;
  digestIntervalMinutes: number;
  // Reporte diario a la hora configurada (tz-aware).
  dailyReportEnabled: boolean;
  dailyReportHour: number;
}

export interface TelegramNotificationPatch {
  enabled?: boolean;
  botToken?: string;
  chatId?: string;
  publicUrl?: string;
  digestEnabled?: boolean;
  digestIntervalMinutes?: number;
  dailyReportEnabled?: boolean;
  dailyReportHour?: number;
}

export interface TelegramNotificationTestResponse {
  ok: true;
  sentAtMs: number;
}

export interface FiscalFxConfigView {
  banxicoTokenConfigured: boolean;
  manualRates: Record<string, number>;
}

export interface FiscalSummaryResponse {
  summary: FiscalYearSummary;
  fx: FiscalFxConfigView;
}

export interface FiscalFxPatch {
  // Empty string clears the stored token.
  banxicoToken?: string;
  // "YYYY-MM-DD" or "YYYY-MM" -> rate; null deletes the entry.
  manualRates?: Record<string, number | null>;
  // Year whose refreshed summary should be returned after saving.
  year?: number;
}

/**
 * Motivos de skip en castellano. Vive aqui y no en la UI web porque hay TRES superficies que los
 * enseñan — web, TUI y el status compacto que leen los agentes — y con el mapa en el cliente las otras
 * dos pintaban el codigo crudo (`arb_bankroll_exhausted`), que no le dice nada a nadie.
 */
export const SKIP_REASON_LABELS = {
  // Motivos del maker. Son los que explican "por que no esta ganando nada" cuando cotiza en pocos
  // mercados o en ninguno, y sin traducir salian crudos en pantalla.
  capital_dedicado_a_otro_mercado: "Sin capital (va a otro mercado)",
  medio_ambiguo: "Medio ambiguo",
  sin_punto_medio: "Sin punto medio",
  relevado: "Relevado por uno mejor",
  enfriado_tras_cruce: "Apartado (el libro se movia)",
  sin_mercado_real: "Libro vacío (el medio es ficción)",
  retirado_sin_relevo: "Retirado sin relevo",
  btc_distance_below_threshold: "Distancia insuficiente",
  no_ask_liquidity_under_cap: "Sin liquidez bajo el cap",
  best_ask_above_cap: "Ask por encima del cap",
  expected_value_gate_failed: "EV no supera el umbral",
  expected_value_history_not_found: "Historia insuficiente (EV)",
  missing_opening_chainlink_tick: "Sin apertura (feed)",
  missing_current_chainlink_tick: "Sin tick actual (feed)",
  stale_chainlink_tick: "Tick viejo (feed)",
  market_already_traded: "Ya operado",
  // Fuera de la ventana de entrada. Este descarte existia y salia SIN motivo: el runner devolvia
  // `undefined` en silencio, asi que el panel decia "no opera" y no habia forma de saber que la causa
  // era la ventana. Con la ventana abierta a los 300s casi no se dispara, y por eso mismo conviene que
  // hable: si alguien la estrecha, el silencio volveria a ser indistinguible de una averia.
  outside_entry_window: "Fuera de la ventana de entrada",
  market_not_accepting_orders: "Mercado cerrado",
  daily_spend_limit_reached: "Limite de gasto",
  risk_circuit_breaker: "Circuit breaker de riesgo",
  outcome_disabled: "Lado desactivado",
  orderbook_quote_failed: "Fallo al pedir orderbook",
  market_fetch_failed: "Fallo al pedir el mercado (red)",
  bankroll_below_directional_minimum: "Capital por debajo del minimo para direccional",
  arb_below_min_size: "Arbitraje: patas bajo el minimo del exchange",
  arb_daily_limit: "Arbitraje: limite de gasto diario",
  arb_bankroll_unknown: "Arbitraje: no se pudo leer el capital, no opera a ciegas",
  arb_bankroll_exhausted: "Arbitraje: capital ya comprometido en otro mercado",
  arb_requote_failed: "Arbitraje: no se pudo recotizar antes de mandar",
  arb_gone_before_order: "Arbitraje evaporado entre la cotizacion y la orden",
  // Sin el numero: el umbral es configurable, y esta etiqueta ya se quedo obsoleta una vez al
  // cambiarlo. Rearma al reiniciar el bot.
  arb_naked_leg_halt: "Arbitraje detenido por patas sueltas (rearma al reiniciar)",
  // No son motivos de "no opera": son avisos de que la puerta se abrio. Se listan aqui porque el
  // panel muestra cualquier motivo registrado, y sin etiqueta saldrian como codigo crudo.
  arb_opportunity_observed: "Arbitraje detectado (observado)",
  mint_opportunity_observed: "MINT-arb detectado (observado, aun sin ejecutar)",
  best_ask_below_floor: "Ask por debajo del piso",
  spread_too_wide: "Spread demasiado ancho",
  too_close_to_close: "Demasiado cerca del cierre",
  exploration_budget_exhausted: "Presupuesto de exploracion agotado",
  // Estrategia "favorito". `dead_book` es el que hay que mirar si deja de operar sin motivo aparente:
  // significa que habia un ask en banda pero los dos lados sumaban de mas, o sea que no habia mercado.
  favorite_below_band: "Favorito: aun no hay favorito claro",
  favorite_above_band: "Favorito: demasiado caro para el premio",
  favorite_dead_book: "Favorito: libro muerto (el ask no es probabilidad)",
  // El mas frecuente con diferencia, y NO es una averia: al cerrar la ventana el lado casi seguro se
  // queda sin asks (nadie vende barato un ganador ya hecho) mientras el perdedor cotiza a 0,01.
  favorite_missing_quote: "Favorito: un lado se quedo sin asks",
  favorite_extreme_price: "Favorito: ask en el extremo (0 o >=1)",
  favorite_no_favorite: "Favorito: empate, el libro no declara favorito",
  favorite_strategy_live_not_allowed: "Favorito: encendida pero sin permiso para live",
  // Tramo de maxima conviccion. El primero es el estado PERMANENTE mientras falte
  // POLYMARKET_FUNDER_ADDRESS: sin saldo legible el tramo no entra, y tiene que decirlo o parece averia.
  favorite_max_size_bankroll_unknown: "Convicción: no se puede leer el saldo",
  favorite_max_size_below_min: "Convicción: capital bajo el mínimo",
  // La banda tampoco puede comprometer mas de lo que hay en la cuenta desde que los dos tramos entran
  // en la misma ventana: la conviccion puede haberse llevado el saldo unos segundos antes.
  favorite_banda_sin_capital: "Banda: sin capital libre",
  // La conviccion dobla sobre una entrada de banda; sin ella no hay nada sobre lo que doblar.
  favorite_max_size_sin_banda: "Convicción: la banda no operó esta ventana",
  // Los siete siguientes salian como codigo crudo en las tres pantallas hasta que el tipo los delato.
  market_not_found: "No se encontro ningun mercado abierto",
  arb_15m_fetch_failed: "Arbitraje 15m: fallo al consultar los mercados",
  arb_execution_failed: "Arbitraje: el exchange rechazo la orden",
  fillable_below_min_ratio: "Poca liquidez para el monto pedido",
  post_only_mode: "El mercado ya no acepta ordenes taker (ultimos segundos)",
  expected_value_analysis_unavailable: "Gate de EV: motor de analisis no disponible",
  expected_value_analysis_failed: "Gate de EV: el analisis fallo",
  // Salida por stop. `en_banda` es el estado NORMAL de toda posicion sana, asi que aparecera
  // constantemente en el panel: se traduce en positivo ("aguanta") para que no se lea como una averia.
  favorite_exit_en_banda: "Salida: la posición aguanta en el tramo",
  favorite_exit_missing_quote: "Salida: sin ask del lado que se tiene",
  favorite_exit_extreme_price: "Salida: precio fuera de rango",
  favorite_exit_dead_book: "Salida: libro muerto (la caída no es real)",
  favorite_exit_libro_ancho: "Salida: libro demasiado ancho para fiarse",
  favorite_exit_demasiado_pronto: "Salida: la posición es demasiado reciente",
  favorite_exit_demasiado_tarde: "Salida: quedan pocos segundos de ventana",
  favorite_exit_sin_bid: "Salida: nadie compra ese lado",
  favorite_exit_bid_bajo_suelo: "Salida: el bid está por debajo del suelo",
  favorite_exit_liquidez_insuficiente: "Salida: los compradores no absorben la posición",
  favorite_exit_live_not_allowed: "Salida: encendida pero sin permiso para live",
  favorite_exit_sin_motor: "Salida: este motor no sabe vender",
  favorite_exit_failed: "Salida: el exchange rechazó la venta",
} as const;

/**
 * Los motivos que el bot sabe explicar.
 *
 * Se deriva del mapa de etiquetas —y no al reves— para que registrar un motivo sin texto sea un error
 * de COMPILACION. Antes `logSkipOnce` aceptaba cualquier cadena y `arb_execution_failed` llevaba dias
 * saliendo como codigo crudo en la web, la TUI y el MCP sin que nada avisara.
 */
export type SkipReason = keyof typeof SKIP_REASON_LABELS;

export function humanSkipReason(reason: string): string {
  return (SKIP_REASON_LABELS as Record<string, string>)[reason] ?? reason;
}

// ---------------------------------------------------------------------------
// Modos por estrategia
// ---------------------------------------------------------------------------

/**
 * Las estrategias que tienen modo propio.
 *
 * Vive aqui, y no en la TUI, porque hay TRES superficies que deciden sobre estos modos —web, TUI y el
 * controlador— y cuando cada una llevaba su propia lista se desincronizaron: la TUI ya pedia la frase
 * para los tres, la web no la pedia para ninguno, y `controller.ts` solo vigilaba dos de los tres.
 * `makerMode` en live se colaba sin comprobar credenciales, y el maker mueve dinero real.
 */
export const MODE_KEYS = ["arbMode", "directionalMode", "makerMode"] as const;
export type StrategyModeKey = (typeof MODE_KEYS)[number];

/** Orden del ciclo en la TUI y de las opciones en la web. `heredado` = el modo del arranque. */
export const MODE_CYCLE = ["heredado", "sim", "live"] as const;
export type StrategyMode = (typeof MODE_CYCLE)[number];

export function isStrategyModeKey(id: string): id is StrategyModeKey {
  return (MODE_KEYS as readonly string[]).includes(id);
}

/**
 * Cierres booleanos que abren dinero real sin ser un modo.
 *
 * `favoriteAllowLive` no es un `*Mode` —el favorito ES el camino direccional, asi que darle modo
 * propio dejaria dos mandos que se contradicen con `directionalMode`—, pero enciende dinero real
 * igual que uno. Vive en esta lista para que la friccion de `LIVE_PHRASE` lo cubra en las TRES
 * superficies a la vez, que es justo lo que el comentario de `MODE_KEYS` explica que paso cuando
 * cada una llevaba su propia lista.
 */
export const LIVE_GATE_KEYS = ["favoriteAllowLive", "favoriteExitAllowLive"] as const;
export type LiveGateKey = (typeof LIVE_GATE_KEYS)[number];

export function isLiveGateKey(id: string): id is LiveGateKey {
  return (LIVE_GATE_KEYS as readonly string[]).includes(id);
}

/** Las claves que exigen la frase al encenderse: modos de estrategia y cierres booleanos. */
export type LiveSensitiveKey = StrategyModeKey | LiveGateKey;

/**
 * La frase que hay que teclear para poner una estrategia en live.
 *
 * No contradice la decision de "sin confirmacion al arrancar": aquello era el ARRANQUE —que el
 * supervisor debe poder repetir sin un humano delante—, esto es el GESTO DE EDICION que enciende el
 * dinero real por primera vez. Solo se pone friccion al lado que cuesta dinero: salir de live sigue
 * siendo un gesto simple.
 */
export const LIVE_PHRASE = "ARRANCAR LIVE";

/**
 * Si este cambio ENCIENDE el live de una estrategia.
 *
 * Solo la transicion hacia live cuenta. Ya estar en live y tocar otra cosa no vuelve a preguntar, o la
 * frase se convertiria en un tramite que se teclea sin leer.
 */
export function entraEnLive(antes: UiSettings, despues: UiSettings, id: string): boolean {
  if (isStrategyModeKey(id)) {
    return despues[id] === "live" && antes[id] !== "live";
  }
  // Un cierre booleano: abrirlo es la transicion que cuesta dinero. Cerrarlo no pregunta, igual que
  // salir de live en un modo.
  if (isLiveGateKey(id)) {
    return despues[id] === true && antes[id] !== true;
  }
  return false;
}

/** Las estrategias y cierres que este cambio pone en live, si es que alguno. */
export function modosQueEntranEnLive(antes: UiSettings, despues: UiSettings): LiveSensitiveKey[] {
  return [...MODE_KEYS, ...LIVE_GATE_KEYS].filter((key) => entraEnLive(antes, despues, key));
}

// ---------------------------------------------------------------------------
// Supervisor del proceso
// ---------------------------------------------------------------------------

/**
 * Quien relanza el proceso cuando muere. Lo declara el entorno (`POLYBOT_SUPERVISOR`), no se adivina.
 *
 * Se publica porque hay ajustes que solo existen para UN supervisor: `watchdogEnabled` lo lee
 * `scripts/watchdog.ps1` desde `data/ui-config.json`, y bajo Docker ese script no corre. Sin este
 * dato la casilla seguiria en pantalla, marcable y sin efecto — un valor creible pero falso, que es
 * la trampa que este proyecto ya pago varias veces.
 *
 * Deliberadamente NO se detecta mirando `/.dockerenv` o similares: una deteccion que falla en silencio
 * produce exactamente la mentira que este campo viene a evitar.
 */
export type SupervisorKind = "compose" | "windows-watchdog" | "systemd" | "ninguno";

export const SUPERVISOR_LABELS: Record<SupervisorKind, string> = {
  compose: "Docker Compose",
  "windows-watchdog": "Watchdog de Windows",
  systemd: "systemd",
  ninguno: "ninguno (arranque manual)",
};

const SUPERVISORES = new Set<string>(["compose", "windows-watchdog", "systemd", "ninguno"]);

/**
 * Lee el supervisor declarado.
 *
 * Sin variable, o con un valor desconocido, cae a `windows-watchdog`: es el despliegue historico del
 * proyecto, y ausencia de informacion no puede convertirse en "no hay supervisor" — eso desactivaria
 * en la UI un ajuste que si funciona. Tampoco lanza: equivocarse de etiqueta no puede impedir que el
 * bot arranque.
 */
export function resolveSupervisor(raw: string | undefined): SupervisorKind {
  const valor = raw?.trim();
  if (valor && SUPERVISORES.has(valor)) {
    return valor as SupervisorKind;
  }
  return "windows-watchdog";
}

/** Si el toggle `watchdogEnabled` hace algo con este supervisor. */
export function watchdogToggleAplica(supervisor: SupervisorKind): boolean {
  return supervisor === "windows-watchdog";
}

/**
 * Lo que de verdad va a pasar tras salir del proceso, segun quien lo supervise.
 *
 * El mensaje decia siempre «el watchdog relanzara en <=5 min». Bajo compose son segundos, y sin
 * supervisor no vuelve nunca: prometer un relanzamiento que no llega deja al operador esperando una UI
 * que ya no existe.
 */
export function mensajeDeReinicio(supervisor: SupervisorKind): string {
  switch (supervisor) {
    case "compose":
      return "Saliendo; Docker Compose lo relanzara en segundos con el codigo actual.";
    case "systemd":
      return "Saliendo; systemd lo relanzara en segundos con el codigo actual.";
    case "windows-watchdog":
      return "Saliendo; el watchdog relanzara en <=5 min con el codigo actual.";
    case "ninguno":
      return "Saliendo. NO hay supervisor configurado: tendras que arrancarlo tu.";
  }
}

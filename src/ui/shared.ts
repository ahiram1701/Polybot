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
  dailySpendLimitUsd: number;
  maxDailyLossUsd: number;
  liveBankrollUsd: number;
  minBankrollForDirectionalUsd: number;
  maxConsecutiveLosses: number;
  riskHaltCooldownHours: number;
  // Complete-set arbitrage execution (buy both sides when the pair costs < $1 after fees).
  arbEnabled: boolean;
  /** Arbitraje tambien en 15m. Solo arbitraje: el direccional se queda en 5m. */
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
  tick?: PriceTick;
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
}

export interface UiStatus {
  running: boolean;
  mode?: Mode;
  effectiveModes: EffectiveModes;
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
export const SKIP_REASON_LABELS: Record<string, string> = {
  btc_distance_below_threshold: "Distancia insuficiente",
  no_ask_liquidity_under_cap: "Sin liquidez bajo el cap",
  best_ask_above_cap: "Ask por encima del cap",
  expected_value_gate_failed: "EV no supera el umbral",
  expected_value_history_not_found: "Historia insuficiente (EV)",
  missing_opening_chainlink_tick: "Sin apertura (feed)",
  missing_current_chainlink_tick: "Sin tick actual (feed)",
  stale_chainlink_tick: "Tick viejo (feed)",
  market_already_traded: "Ya operado",
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
};


export function humanSkipReason(reason: string): string {
  return SKIP_REASON_LABELS[reason] ?? reason;
}

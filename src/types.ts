import type { AskGuidance, ExpectedValueDecisionReason, ExpectedValueSnapshot } from "./expectedValue.js";

export type Mode = "sim" | "live";
export type Outcome = "UP" | "DOWN";
export type FillSource = "order_response" | "clob_trades";
export type MarketSymbol = "BTC" | "ETH" | "DOGE";
export type PriceFeedSymbol = "btc/usd" | "eth/usd" | "doge/usd";
export type MarketDistanceSettings = Record<MarketSymbol, number>;
export type MarketEntryWindowSettings = Record<MarketSymbol, number>;
export type MarketOutcomeNumberSettings = Record<MarketSymbol, Record<Outcome, number>>;
export type MarketOutcomeBooleanSettings = Record<MarketSymbol, Record<Outcome, boolean>>;
export type RecommendationConfidence = "low" | "medium" | "high";
export type AiRecommendationStatus = "insufficient_data" | "ready";

export interface BotConfig {
  mode: Mode;
  confirmLive: boolean;
  minBtcDistanceUsd: number;
  enabledMarkets: MarketSymbol[];
  enabledMarketOutcomes?: MarketOutcomeBooleanSettings;
  minDistanceUsdByMarket: MarketDistanceSettings;
  minDistanceUsdByMarketOutcome?: MarketOutcomeNumberSettings;
  // Hard per-market distance floor: the edge comes from strong moves, so the effective distance is
  // max(configured, floor). Config always sets it; optional so test/config literals may omit it.
  minDistanceFloorUsdByMarket?: MarketDistanceSettings;
  entryWindowSeconds: number;
  entryWindowSecondsByMarket: MarketEntryWindowSettings;
  entryWindowSecondsByMarketOutcome?: MarketOutcomeNumberSettings;
  simTradeAmountUsd: number;
  simTradeAmountUsdByMarketOutcome?: MarketOutcomeNumberSettings;
  liveTradeAmountUsd: number;
  liveTradeAmountUsdByMarketOutcome?: MarketOutcomeNumberSettings;
  autoMinLive: boolean;
  maxAskPrice: number;
  maxAskPriceByMarketOutcome?: MarketOutcomeNumberSettings;
  // Piso de ask por mercado/lado: descarta entradas por DEBAJO de este precio. El replay del ledger
  // live mostro que las apuestas baratas de reversion (<0.30 en ETH) pierden sistematicamente.
  // Default efectivo 0.01 = sin piso.
  minAskPriceByMarketOutcome?: MarketOutcomeNumberSettings;
  /** Rango dentro del cual puede moverse el tuner de ask. El tuner NUNCA lo escribe: es su referencia fija. */
  askWindowBaseline?: { floor: number; cap: number };
  // Hard ceiling applied on top of the per-market/outcome ask caps: no trade (and no auto-adjust)
  // may use an ask above this, to keep reward/risk sane. Optional; config.ts always sets it.
  maxAskPriceCeiling?: number;
  // Max price a LIVE order may pay above the observed best-ask (limits book walk / slippage).
  liveMaxSlippage?: number;
  // Expected-value gate: only trade when the historical win rate beats the ask by a fee-aware margin.
  // Optional so test/config literals may omit them; config.ts always sets them and botRunner defaults them.
  requirePositiveEv?: boolean;
  // Bounded cold-start exploration: allow a few positive-EV probes/day on short-history setups so
  // thinly-quoted markets can bootstrap enough fills to clear the normal EV history gate.
  explorationEnabled?: boolean;
  evUseSimilarity?: boolean;
  // Empirical calibration of the gate probability from the ledger's own resolved predictions.
  evCalibration?: boolean;
  evSafetyMargin?: number;
  // Techo a la ventaja declarable sobre el ask (los edges enormes eran ruido perdedor).
  evMaxClaimedEdge?: number;
  // Segundos minimos restantes para abrir una entrada (0 = sin guardia). Los ultimos segundos de la
  // ventana pierden: post-only del CLOB, profundidad fina y precio ya resuelto.
  minSecondsToEndForEntry?: number;
  // Spread maximo (ask - bid) para abrir una entrada (0 = sin guardia). Un spread ancho significa poca
  // contraparte: el precio cotizado es menos fiable y pagas el diferencial completo.
  maxAskSpread?: number;
  evMinExpectedRoi?: number;
  evMinHistoryTrades?: number;
  // Minimum fraction of the requested amount that must be fillable under the ask cap for a trade to
  // proceed. Thin books can only partially fill (e.g. $0.69 of a requested $10), leaving a useless
  // micro-position; below this ratio the setup is skipped. Optional; defaults in botRunner/config.
  minFillRatio?: number;
  dailySpendLimitUsd: number;
  // Risk circuit breaker (0 = disabled): halt trading when today's realized loss or consecutive-loss
  // streak crosses these. Optional so config/test literals may omit.
  maxDailyLossUsd?: number;
  maxConsecutiveLosses?: number;
  // Hours a tripped breaker stays halted before auto re-arming with a clean slate. 0 = legacy: halted
  // for the rest of the UTC day.
  riskHaltCooldownHours?: number;
  /**
   * Capital real declarado para LIVE (0 = sin declarar, la guardia queda inactiva).
   *
   * El bot no puede deducirlo: no consulta el saldo de la wallet. Se declara para que la guardia de
   * abajo pueda hacer la aritmetica que decide si operar direccional tiene sentido.
   */
  liveBankrollUsd?: number;
  /**
   * Capital minimo para operar DIRECCIONAL en live (0 = sin guardia).
   *
   * El minimo de orden del exchange es $5, asi que con un bankroll pequeño cada entrada arriesga una
   * fraccion enorme del capital y la ruina llega antes que el edge. Simulado con el edge REAL medido
   * (83% de aciertos, ROI +4.3%/operacion — estrategia GANADORA), a 300 operaciones: con $10 la
   * probabilidad de quedarse sin poder operar es del 67.6% y el capital mediano baja a $4.88; con $50
   * cae al 4.8%; con $100, al 0.1%. Es decir, se pierde dinero TENIENDO RAZON.
   *
   * El arbitraje NO pasa por esta guardia: un par completo redime $1/set gane quien gane, asi que no
   * tiene riesgo direccional ni ruina posible — es precisamente con lo que se hace crecer el capital
   * hasta cruzar este umbral.
   */
  minBankrollForDirectionalUsd?: number;
  // Complete-set arbitrage execution (default OFF): buy both sides when ask(UP)+ask(DOWN)+fees < $1.
  arbEnabled?: boolean;
  // Max USD spent per arbitrage opportunity (both legs combined).
  /**
   * Arbitraje tambien en las ventanas de 15m. SOLO arbitraje: el direccional sigue en 5m, porque
   * necesitaria una dimension de duracion en todos los ajustes por mercado y no hay evidencia de que
   * pague ni en 5m.
   */
  /**
   * Modo de cada estrategia, por separado.
   *
   * Permite lo que de verdad hace falta aqui: arbitraje con dinero real —es lo unico que gana— y
   * direccional en papel, aprendiendo sin costar nada. Sin esto el modo era global y las dos
   * compartian destino, aunque su rentabilidad medida sea opuesta.
   *
   * Ausente = se hereda el modo global, asi que una configuracion antigua se comporta igual que antes.
   */
  arbMode?: Mode;
  directionalMode?: Mode;
  arb15mEnabled?: boolean;
  /**
   * Patas sueltas seguidas antes de dejar de intentar arbitrajes. Rearma al reiniciar el bot.
   *
   * Es un ajuste y no una constante porque es la palanca que se toca cuando cambia la confianza en el
   * camino de ejecucion: apretado mientras no tenga historial contra el exchange, mas holgado despues.
   */
  arbNakedLegHaltStreak?: number;
  arbMaxUsdPerOpportunity?: number;
  // Minimum net profit per set (post-fee) required to execute; crumbs below this are only observed.
  arbMinNetPerSet?: number;
  // IANA timezone (or "auto" = system) driving every hour/day derivation: display, chart bucketing,
  // fiscal calendar days, and the daily risk cutoff (spend limit / circuit breaker).
  timezone?: string;
  // Auto-tuning del ask cap por mercado desde bandas realizadas (candados en askCapTuner.ts).
  aiAutoTuneAskCap?: boolean;
  aiAutoProbeBands?: boolean;
  // Retention cap for analytics.jsonl (most-recent resolved samples kept on disk). More history =
  // better EV-gate win-rate estimates, at the cost of parse time/memory. Optional; defaults in config.
  maxAnalyticsSamples?: number;
  tickStaleMs: number;
  pollIntervalMs: number;
  openingCaptureGraceMs: number;
  dataDir: string;
  gammaHost: string;
  clobHost: string;
  rtdsUrl: string;
  polygonRpcUrl: string;
  ollamaApiKey?: string;
  ollamaHost?: string;
  ollamaModel?: string;
  publicUrl?: string;
  telegramBotToken?: string;
  telegramChatId?: string;
  privateKey?: `0x${string}`;
  signatureType: 0 | 1 | 2 | 3;
  funderAddress?: `0x${string}`;
}

export interface PriceTick {
  market: MarketSymbol;
  symbol: PriceFeedSymbol;
  value: number;
  timestampMs: number;
  receivedAtMs: number;
}

export type BtcPriceTick = PriceTick;

export interface OutcomeToken {
  outcome: Outcome;
  label: string;
  tokenId: string;
  impliedPrice?: number;
}

export interface MarketInfo {
  asset: MarketSymbol;
  slug: string;
  title: string;
  conditionId: string;
  windowStartMs: number;
  endMs: number;
  eventStartTimeMs: number;
  acceptingOrders: boolean;
  active: boolean;
  closed: boolean;
  tickSize: string;
  negRisk: boolean;
  orderMinSize: number;
  outcomes: Record<Outcome, OutcomeToken>;
}

export interface WindowOpening {
  asset?: MarketSymbol;
  slug: string;
  windowStartMs: number;
  openingPrice: number;
  openingTickTimestampMs: number;
  capturedAtMs: number;
}

export interface OrderbookQuote {
  tokenId: string;
  /**
   * Cuando se leyo este libro. Sirve para saber cuanto habia envejecido la cotizacion al mandar la
   * orden: sin este dato, un rechazo del exchange no distingue "el libro se movio mientras tanto" de
   * "el precio estaba mal calculado", y eso es exactamente lo que dejo sin explicar los dos primeros
   * arbitrajes en live.
   */
  quotedAtMs?: number;
  bestAsk?: number;
  bestBid?: number;
  /** Profundidad hasta el tope de ask. Para el camino DIRECCIONAL. */
  availableUsdUnderCap: number;
  /** Profundidad de todo el libro. Para el ARBITRAJE, que no corre riesgo direccional. */
  availableUsdAllLevels: number;
  estimatedSharesForAmount: number;
  estimatedAveragePrice?: number;
  rawAskLevels: Array<{ price: number; size: number }>;
  /**
   * Niveles del lado COMPRADOR, de mejor a peor precio. Necesarios para el MINT-arb: ahi no se compra,
   * se VENDE contra los bids, y los ingresos caen a medida que se baja por el libro. Con solo
   * `bestBid` el dimensionado seria ciego — se supondria que todo el tamaño entra al mejor precio.
   */
  rawBidLevels: Array<{ price: number; size: number }>;
  /** Lo que pagaria el libro comprador entero, sumando precio x tamaño de cada nivel. */
  availableBidUsdAllLevels: number;
}

export interface AnalyticsTickPoint {
  timestampMs: number;
  secondsToEnd: number;
  /** Precio SPOT del oraculo. Util como feature, pero NO es el que resuelve el mercado. */
  price: number;
  distanceUsd: number;
  /**
   * Valor de la serie TWAP publicada por Polymarket en ese instante: la que DECIDE quien gana desde
   * el 2026-08-07.
   *
   * Se graba porque solo vive 10 minutos en memoria del feed, y sin esto cualquier analisis futuro
   * seguiria midiendo sobre spot mientras el dinero se decide con otra serie. Es la tercera vez que
   * aparece el mismo patron: la profundidad del libro y los ticks del arranque de ventana tambien
   * llegaban y se tiraban. El dato que no se graba no se reconstruye.
   *
   * Opcional: las muestras anteriores a 2026-08-08 no lo tienen y deben seguir leyendose.
   */
  twapPrice?: number;
  /** Distancia medida sobre la serie que resuelve, en vez de mezclar spot con apertura TWAP. */
  twapDistanceUsd?: number;
}

export interface AnalyticsQuotePoint {
  timestampMs: number;
  secondsToEnd: number;
  upBestAsk?: number;
  upBestBid?: number;
  downBestAsk?: number;
  downBestBid?: number;
  /**
   * Precio MEDIO real de comprar el tamaño de referencia (`DEPTH_PROBE_USD`) bajando por el libro, y
   * dolares disponibles en todo el lado vendedor. `undefined` cuando el libro no daba para ese tamaño.
   *
   * Se graban porque su ausencia ya costo dinero: sin profundidad, un backtest sobre estas muestras
   * asume relleno perfecto al mejor precio, y cerca del cierre el libro se adelgaza — el simulador
   * salia mas optimista justo donde la realidad es peor. Opcionales porque las ~20k muestras anteriores
   * a 2026-08-06 no los tienen y deben seguir siendo legibles.
   */
  upAskAvgFill?: number;
  downAskAvgFill?: number;
  upAskDepthUsd?: number;
  downAskDepthUsd?: number;
}

export interface AnalyticsSample {
  version: 1;
  market: MarketSymbol;
  slug: string;
  windowStartMs: number;
  endMs: number;
  openingPrice: number;
  openingTickTimestampMs: number;
  ticks: AnalyticsTickPoint[];
  quotes: AnalyticsQuotePoint[];
  finalPrice?: number;
  finalTickTimestampMs?: number;
  winningOutcome?: Outcome;
  resolvedAtMs?: number;
}

export interface RecommendationMetrics {
  sampleCount: number;
  signalCount: number;
  tradeCount: number;
  winCount: number;
  lossCount: number;
  quoteCoverage: number;
  averageRoi?: number;
  adjustedRoi?: number;
  // Realized yield per observed window = adjustedRoi × executionRate (tradeCount/sampleCount). This
  // is the selection objective: it rewards configs that trade often with real edge, not rare
  // high-edge-per-trade configs that barely execute. Undefined when adjustedRoi is undefined.
  yieldPerWindow?: number;
  expectedRoi?: number;
  walkForwardRoi?: number;
  lowerBoundRoi?: number;
  overfitRisk: number;
  predictedWinProbability?: number;
  calibrationError?: number;
  maxDrawdown: number;
}

export interface RecommendationCandidate {
  entryWindowSeconds: number;
  minDistanceUsd: number;
  metrics: RecommendationMetrics;
}

export interface AiRecommendation {
  market: MarketSymbol;
  status: AiRecommendationStatus;
  confidence: RecommendationConfidence;
  generatedAtMs: number;
  current: RecommendationCandidate;
  recommended?: RecommendationCandidate;
  improvementAdjustedRoi?: number;
  // Improvement in realized yield-per-window of the recommended config vs the current one. This is
  // the criterion that actually drives auto-apply (see RecommendationMetrics.yieldPerWindow).
  improvementYield?: number;
  sampleCount: number;
  reason: string;
  canApply: boolean;
  canAutoApply: boolean;
}

export interface AutoApplyThresholds {
  minAutoSamples: number;
  minAutoTrades: number;
  minQuoteCoverage: number;
  // Minimum improvement in realized yield-per-window (edge × execution rate) required to auto-apply.
  minYieldImprovement: number;
  maxOverfitRisk: number;
  // How far a single auto-apply may move from the current settings.
  maxWindowChangeSeconds: number;
  maxDistanceChangeRatio: number;
  // Minimum time between auto-applies. 0 = no time lock; the significance margin (minYieldImprovement)
  // is the anti-thrash guard.
  autoApplyCooldownMs: number;
}

export interface AiRecommendationsResponse {
  generatedAtMs: number;
  recommendations: AiRecommendation[];
  // Active auto-apply thresholds, so the UI can render a pass/fail checklist for each recommendation.
  thresholds?: AutoApplyThresholds;
  // Total analytics samples Polybot has stored (whole history, before the per-market learning cap).
  totalSamples?: number;
}

export interface StrategyMetrics {
  sampleCount: number;
  signalCount: number;
  tradeCount: number;
  winCount: number;
  lossCount: number;
  quoteCoverage: number;
  winRate?: number;
  realWinProbability?: number;
  adjustedWinProbability?: number;
  averageAsk?: number;
  historicalRoi?: number;
  evRoi?: number;
  expectedRoi?: number;
  expectedValueUsd?: number;
  minExpectedValueUsd?: number;
  winProfitUsd?: number;
  lossUsd?: number;
  breakEvenProbability?: number;
  edge?: number;
  liveTradeAmountUsd?: number;
  askGuidance?: AskGuidance;
  passesBasicEntry?: boolean;
  passesSafetyMargin?: boolean;
  passesExpectedValue?: boolean;
  passesRecommendedEntry?: boolean;
  evDecisionReason?: ExpectedValueDecisionReason;
  maxDrawdown: number;
}

export type StrategyConfidence = "low" | "medium" | "high";

export type StrategyRiskFlag =
  | "no_trades"
  | "few_trades"
  | "low_quote_coverage"
  | "negative_ev"
  | "insufficient_history"
  | "unsafe_edge"
  | "below_min_ev"
  | "avoid_ask"
  | "high_drawdown";

export interface StrategyCandidate {
  market: MarketSymbol;
  outcome: Outcome;
  entryWindowSeconds: number;
  minDistanceUsd: number;
  maxAskPrice: number;
  metrics: StrategyMetrics;
  isCurrent: boolean;
  confidence: StrategyConfidence;
  riskFlags: StrategyRiskFlag[];
  qualityScore: number;
  evDeltaVsCurrent?: number;
}

export interface StrategyAnalysisSummary {
  // Total resolved samples retained on disk (what the operator has). The EV gate uses all of them.
  sampleCount: number;
  // Subset actually fed into the (expensive) strategy grid: the most recent per market. May be < sampleCount.
  analyzedSampleCount: number;
  firstSampleAtMs?: number;
  lastSampleAtMs?: number;
  strategyCount: number;
  currentStrategyCount: number;
  reliableStrategyCount: number;
  bestEvRoi?: number;
  bestTradeCount?: number;
  bestReliableEvRoi?: number;
  bestReliableTradeCount?: number;
}

export interface StrategyAnalysisResponse {
  generatedAtMs: number;
  strategies: StrategyCandidate[];
  currentStrategies: StrategyCandidate[];
  summary: StrategyAnalysisSummary;
}

export interface OllamaTradeAnalysisResponse {
  generatedAtMs: number;
  model: string;
  content: string;
  contextSummary: string;
}

export interface TradeAttempt {
  id: string;
  asset?: MarketSymbol;
  slug: string;
  mode: Mode;
  conditionId?: string;
  outcome: Outcome;
  tokenId: string;
  amountUsd: number;
  maxAskPrice: number;
  bestAsk?: number;
  // Liquidez observada AL DECIDIR. Se persiste porque sin ella no se puede diagnosticar la ejecucion
  // despues: el ledger solo guardaba bestAsk, asi que la hipotesis "el precio cotizado no es el que
  // consigues" era intesteable. El spread ya mostro degradacion monotona del resultado.
  bestBid?: number;
  availableUsdUnderCap?: number;
  expectedValue?: ExpectedValueSnapshot;
  estimatedShares: number;
  openingPrice: number;
  entryPrice: number;
  distanceUsd: number;
  entryWindowSeconds?: number;
  windowStartMs: number;
  endMs: number;
  createdAtMs: number;
  orderId?: string;
  status?: string;
  fillDetected?: boolean;
  filledAmountUsd?: number;
  filledShares?: number;
  averageFillPrice?: number;
  feeUsd?: number;
  fillSource?: FillSource;
  tradeIds?: string[];
  reconciledAtMs?: number;
  response?: unknown;
  resolved?: SimResolution;
  // Verification of a LIVE resolution against Polymarket's OFFICIAL market outcome (the source of
  // truth is whoever pays). `corrected` marks trades whose feed-based resolution had to be flipped.
  officialResolution?: OfficialResolution;
  // "arb" = a complete-set arbitrage PAIR stored as one synthetic trade (slug suffixed "#arb" so it
  // never collides with the momentum trade of the same window): amount/fills cover BOTH legs and
  // filledShares is the number of $1-redeeming sets. Absent = normal momentum trade.
  kind?: "arb";
  // False when only one leg filled (the pair could not complete): the position is directional and its
  // P&L follows the winner like a normal trade.
  arbPairComplete?: boolean;
}

export interface SimResolution {
  resolvedAtMs: number;
  /** Precio observado al cierre. Dato crudo: NO es necesariamente el que decidio el ganador. */
  finalPrice: number;
  finalTickTimestampMs: number;
  /**
   * De que serie salio el precio que decidio: la TWAP publicada (la buena) o el spot de respaldo.
   *
   * Sustituye a `twapPrice`/`twapCoverage`, que quedaron muertos al dejar de calcular el TWAP a mano.
   * Un campo llamado `twapPrice` que nunca se rellena es peor que no tenerlo: se lee como "aqui esta
   * el TWAP" cuando no hay nada.
   *
   * No es cosmetico. La tasa de correccion oficial es el unico juez de si la fuente nueva acierta, y
   * sin esto no se pueden separar las operaciones resueltas por TWAP de las de respaldo — que es
   * justo la comparacion que lo demuestra.
   */
  priceSource?: "twap" | "spot";
  winningOutcome: Outcome;
  won: boolean;
}

export interface OfficialResolution {
  winningOutcome: Outcome;
  verifiedAtMs: number;
  corrected: boolean;
}

export interface BotState {
  version: 1;
  openings: Record<string, WindowOpening>;
  tradedMarkets: Record<string, TradeAttempt>;
  dailySpendUsd: Record<string, number>;
  pnlResetAtMs?: Partial<Record<Mode, number>>;
  // When the risk circuit breaker was last manually reset per mode: losses resolved at/before this
  // are ignored by the breaker, so it re-arms with a fresh streak without changing the threshold.
  riskHaltResetAtMs?: Partial<Record<Mode, number>>;
}

export type TradeEvent =
  | { type: "trade_attempt"; trade: TradeAttempt }
  | { type: "trade_reconciliation"; trade: TradeAttempt }
  | { type: "trade_resolution"; trade: TradeAttempt; resolution: SimResolution }
  | { type: "sim_resolution"; trade: TradeAttempt; resolution: SimResolution }
  | { type: "trade_official_resolution"; trade: TradeAttempt; officialResolution: OfficialResolution }
  | { type: "pnl_reset"; mode: Mode; resetAtMs: number };

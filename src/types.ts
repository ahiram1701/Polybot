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
  autoAdjustLiveByMarketOutcome?: MarketOutcomeBooleanSettings;
  autoAdjustAfterLossByMarketOutcome?: MarketOutcomeBooleanSettings;
  maxAskPrice: number;
  maxAskPriceByMarketOutcome?: MarketOutcomeNumberSettings;
  // Hard ceiling applied on top of the per-market/outcome ask caps: no trade (and no auto-adjust)
  // may use an ask above this, to keep reward/risk sane. Optional; config.ts always sets it.
  maxAskPriceCeiling?: number;
  // Max price a LIVE order may pay above the observed best-ask (limits book walk / slippage).
  liveMaxSlippage?: number;
  // Expected-value gate: only trade when the historical win rate beats the ask by a fee-aware margin.
  // Optional so test/config literals may omit them; config.ts always sets them and botRunner defaults them.
  requirePositiveEv?: boolean;
  evSafetyMargin?: number;
  evMinExpectedRoi?: number;
  evMinHistoryTrades?: number;
  dailySpendLimitUsd: number;
  // Risk circuit breaker (0 = disabled): halt trading for the rest of the UTC day when today's
  // realized loss or consecutive-loss streak crosses these. Optional so config/test literals may omit.
  maxDailyLossUsd?: number;
  maxConsecutiveLosses?: number;
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
  bestAsk?: number;
  bestBid?: number;
  availableUsdUnderCap: number;
  estimatedSharesForAmount: number;
  estimatedAveragePrice?: number;
  rawAskLevels: Array<{ price: number; size: number }>;
}

export interface AnalyticsTickPoint {
  timestampMs: number;
  secondsToEnd: number;
  price: number;
  distanceUsd: number;
}

export interface AnalyticsQuotePoint {
  timestampMs: number;
  secondsToEnd: number;
  upBestAsk?: number;
  upBestBid?: number;
  downBestAsk?: number;
  downBestBid?: number;
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

export interface AiRecommendationsResponse {
  generatedAtMs: number;
  recommendations: AiRecommendation[];
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
}

export interface SimResolution {
  resolvedAtMs: number;
  finalPrice: number;
  finalTickTimestampMs: number;
  winningOutcome: Outcome;
  won: boolean;
}

export interface BotState {
  version: 1;
  openings: Record<string, WindowOpening>;
  tradedMarkets: Record<string, TradeAttempt>;
  dailySpendUsd: Record<string, number>;
  pnlResetAtMs?: Partial<Record<Mode, number>>;
}

export type TradeEvent =
  | { type: "trade_attempt"; trade: TradeAttempt }
  | { type: "trade_reconciliation"; trade: TradeAttempt }
  | { type: "trade_resolution"; trade: TradeAttempt; resolution: SimResolution }
  | { type: "sim_resolution"; trade: TradeAttempt; resolution: SimResolution }
  | { type: "pnl_reset"; mode: Mode; resetAtMs: number };

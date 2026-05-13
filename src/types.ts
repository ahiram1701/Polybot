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
  minDistanceUsdByMarket: MarketDistanceSettings;
  minDistanceUsdByMarketOutcome?: MarketOutcomeNumberSettings;
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
  dailySpendLimitUsd: number;
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
  averageAsk?: number;
  evRoi?: number;
  maxDrawdown: number;
}

export type StrategyConfidence = "low" | "medium" | "high";

export type StrategyRiskFlag =
  | "no_trades"
  | "few_trades"
  | "low_quote_coverage"
  | "negative_ev"
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
  sampleCount: number;
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
}

export type TradeEvent =
  | { type: "trade_attempt"; trade: TradeAttempt }
  | { type: "trade_reconciliation"; trade: TradeAttempt }
  | { type: "trade_resolution"; trade: TradeAttempt; resolution: SimResolution }
  | { type: "sim_resolution"; trade: TradeAttempt; resolution: SimResolution };

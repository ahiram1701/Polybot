import type { LogEntry } from "../logger.js";
import type { PnlSummary, PnlSummaryByMode } from "../pnl.js";
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
  autoAdjustLiveByMarketOutcome: MarketOutcomeBooleanSettings;
  autoAdjustAfterLossByMarketOutcome: MarketOutcomeBooleanSettings;
  maxAskPrice: number;
  maxAskPriceByMarketOutcome: MarketOutcomeNumberSettings;
  dailySpendLimitUsd: number;
  tickStaleMs: number;
  pollIntervalMs: number;
  openingCaptureGraceMs: number;
  aiAutoApplyLive: boolean;
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

export interface UiStatus {
  running: boolean;
  mode?: Mode;
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
  logs: LogEntry[];
  snapshotError?: string;
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
}

export interface TelegramNotificationPatch {
  enabled?: boolean;
  botToken?: string;
  chatId?: string;
  publicUrl?: string;
}

export interface TelegramNotificationTestResponse {
  ok: true;
  sentAtMs: number;
}

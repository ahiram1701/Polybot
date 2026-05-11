import type { LogEntry } from "../logger.js";
import type { PnlSummary } from "../pnl.js";
import type {
  MarketDistanceSettings,
  MarketEntryWindowSettings,
  MarketInfo,
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
  minDistanceUsdByMarket: MarketDistanceSettings;
  entryWindowSeconds: number;
  entryWindowSecondsByMarket: MarketEntryWindowSettings;
  simTradeAmountUsd: number;
  liveTradeAmountUsd: number;
  autoMinLive: boolean;
  maxAskPrice: number;
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

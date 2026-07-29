import type { LogEntry } from "../logger.js";
import { calculateTradePnl, type PnlResetAtMsByMode, type PnlSummary } from "../pnl.js";
import type { RiskHaltStatus } from "../riskCircuitBreaker.js";
import type {
  MarketSymbol,
  Mode,
  Outcome,
  StrategyAnalysisResponse,
  StrategyCandidate,
  TradeAttempt,
} from "../types.js";
import type { UiStatus } from "../ui/shared.js";

const DEFAULT_STRATEGY_LIMIT = 12;

const DEFAULT_LOG_SAMPLE = 60;

export interface CompactMarket {
  marketSymbol: MarketSymbol;
  reason: string;
  inEntryWindow: boolean;
  secondsToEnd?: number;
  outcome?: Outcome;
  distanceUsd?: number;
  tickValue?: number;
}

export interface CompactPnl {
  realizedUsd: number;
  roiPct?: number;
  resolvedCount: number;
  wonCount: number;
  lostCount: number;
  pendingCount: number;
}

export interface RecentActivity {
  sampleSize: number;
  fromAt?: string;
  toAt?: string;
  skipReasonCounts: Record<string, number>;
  otherMessageCounts: Record<string, number>;
}

export interface CompactStatus {
  running: boolean;
  mode?: Mode;
  startedAtMs?: number;
  uptimeSeconds?: number;
  lastError?: string;
  snapshotError?: string;
  liveReady: boolean;
  dailySpendUsd: number;
  dailySpendLimitUsd?: number;
  markets: CompactMarket[];
  // Post-reset PnL: only trades since each mode's last P&L reset (see `pnlResetAtMs`).
  pnlByMode: { sim: CompactPnl; live: CompactPnl };
  // Lifetime PnL across all trades, ignoring the P&L reset.
  pnlHistoricalByMode: { sim: CompactPnl; live: CompactPnl };
  // When each mode's P&L was last reset (epoch ms); omitted = never reset.
  pnlResetAtMs: PnlResetAtMsByMode;
  riskHalt?: RiskHaltStatus;
  recentActivity: RecentActivity;
}

/**
 * Project the full UiStatus (which can be ~150 KB, dominated by raw logs and market ticks/quotes)
 * into a small, decision-relevant snapshot for AI agents. Drops raw logs/ticks/quotes and folds the
 * recent skip reasons into a structured "why isn't it trading" summary.
 */
export function summarizeStatus(
  status: UiStatus,
  options: { logSampleSize?: number; nowMs?: number } = {},
): CompactStatus {
  const nowMs = options.nowMs ?? Date.now();
  const sampleSize = options.logSampleSize ?? DEFAULT_LOG_SAMPLE;

  return {
    running: status.running,
    mode: status.mode,
    startedAtMs: status.startedAtMs,
    uptimeSeconds:
      status.startedAtMs !== undefined ? Math.max(0, Math.round((nowMs - status.startedAtMs) / 1000)) : undefined,
    lastError: status.lastError,
    snapshotError: status.snapshotError,
    liveReady: status.liveReadiness?.ready ?? false,
    dailySpendUsd: round(status.dailySpendUsd) ?? 0,
    dailySpendLimitUsd: status.config?.dailySpendLimitUsd,
    markets: (status.markets ?? []).map((market) => ({
      marketSymbol: market.marketSymbol,
      reason: market.signal.reason,
      inEntryWindow: market.signal.inEntryWindow,
      secondsToEnd: round(market.signal.secondsToEnd),
      outcome: market.signal.outcome,
      distanceUsd: round(market.signal.distanceUsd),
      tickValue: market.tick?.value,
    })),
    pnlByMode: {
      sim: compactPnl(status.pnlByMode.sim),
      live: compactPnl(status.pnlByMode.live),
    },
    pnlHistoricalByMode: {
      sim: compactPnl(status.pnlHistoricalByMode.sim),
      live: compactPnl(status.pnlHistoricalByMode.live),
    },
    pnlResetAtMs: status.pnlResetAtMs ?? {},
    riskHalt: status.riskHalt,
    recentActivity: summarizeLogs(status.logs ?? [], sampleSize),
  };
}

/** Group the most recent log entries by skip reason (structured "why not trading"). */
export function summarizeLogs(logs: LogEntry[], sampleSize = DEFAULT_LOG_SAMPLE): RecentActivity {
  // UiStatus logs come newest-first, so the head is the most recent slice.
  const sample = logs.slice(0, Math.max(0, sampleSize));
  const skipReasonCounts: Record<string, number> = {};
  const otherMessageCounts: Record<string, number> = {};

  for (const entry of sample) {
    const reason = extractReason(entry);
    if (entry.message === "Skipped trade." && reason) {
      skipReasonCounts[reason] = (skipReasonCounts[reason] ?? 0) + 1;
    } else {
      otherMessageCounts[entry.message] = (otherMessageCounts[entry.message] ?? 0) + 1;
    }
  }

  return {
    sampleSize: sample.length,
    toAt: sample[0]?.at,
    fromAt: sample[sample.length - 1]?.at,
    skipReasonCounts,
    otherMessageCounts,
  };
}

function extractReason(entry: LogEntry): string | undefined {
  if (entry.meta && typeof entry.meta === "object") {
    const reason = (entry.meta as { reason?: unknown }).reason;
    if (typeof reason === "string") {
      return reason;
    }
  }
  return undefined;
}

function compactPnl(pnl: PnlSummary): CompactPnl {
  return {
    realizedUsd: round(pnl.realizedUsd) ?? 0,
    roiPct: pnl.roiPct,
    resolvedCount: pnl.resolvedCount,
    wonCount: pnl.wonCount,
    lostCount: pnl.lostCount,
    pendingCount: pnl.pendingCount,
  };
}

function round(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) ? Math.round(value * 100) / 100 : undefined;
}

export interface CompactTrade {
  id: string;
  market?: MarketSymbol;
  mode: Mode;
  /** "arb" = complete-set arbitrage: redeems $1/set regardless of the winner, so it is never a loss. */
  kind?: TradeAttempt["kind"];
  outcome: Outcome;
  amountUsd: number;
  bestAsk?: number;
  distanceUsd?: number;
  entryWindowSeconds?: number;
  createdAtMs: number;
  resolved?: { won: boolean; winningOutcome: Outcome };
  netUsd?: number;
  // Slim view of the EV that gated the entry (full snapshot omitted).
  ev?: { edge?: number; expectedRoi?: number; adjustedWinProbability?: number; tradeCount: number };
}

/** Project a full TradeAttempt (with its ~20-field EV snapshot and long token/condition ids) into a
 * small agent-friendly record. */
export function summarizeTrade(trade: TradeAttempt): CompactTrade {
  const pnl = calculateTradePnl(trade);
  const ev = trade.expectedValue;
  return {
    id: trade.id,
    market: trade.asset,
    mode: trade.mode,
    kind: trade.kind,
    outcome: trade.outcome,
    amountUsd: trade.amountUsd,
    bestAsk: trade.bestAsk,
    distanceUsd: round(trade.distanceUsd),
    entryWindowSeconds: trade.entryWindowSeconds,
    createdAtMs: trade.createdAtMs,
    resolved: trade.resolved
      ? { won: trade.resolved.won, winningOutcome: trade.resolved.winningOutcome }
      : undefined,
    netUsd: round(pnl.netUsd),
    ev: ev
      ? {
          edge: round(ev.edge),
          expectedRoi: round(ev.expectedRoi),
          adjustedWinProbability: round(ev.adjustedWinProbability),
          tradeCount: ev.tradeCount,
        }
      : undefined,
  };
}

export interface CompactStrategy {
  market: MarketSymbol;
  outcome: Outcome;
  entryWindowSeconds: number;
  minDistanceUsd: number;
  maxAskPrice: number;
  isCurrent: boolean;
  confidence: string;
  qualityScore: number;
  evRoi?: number;
  winRate?: number;
  tradeCount: number;
  quoteCoverage?: number;
  edge?: number;
  passesRecommendedEntry?: boolean;
  riskFlags: string[];
}

function summarizeStrategy(candidate: StrategyCandidate): CompactStrategy {
  const m = candidate.metrics;
  return {
    market: candidate.market,
    outcome: candidate.outcome,
    entryWindowSeconds: candidate.entryWindowSeconds,
    minDistanceUsd: candidate.minDistanceUsd,
    maxAskPrice: candidate.maxAskPrice,
    isCurrent: candidate.isCurrent,
    confidence: candidate.confidence,
    qualityScore: round(candidate.qualityScore) ?? 0,
    evRoi: round(m.evRoi),
    winRate: round(m.winRate),
    tradeCount: m.tradeCount,
    quoteCoverage: round(m.quoteCoverage),
    edge: round(m.edge),
    passesRecommendedEntry: m.passesRecommendedEntry,
    riskFlags: candidate.riskFlags,
  };
}

/** Compact the ~200 KB strategy analysis into the summary plus the top-N ranked strategies and the
 * current per-market strategies, projected to decision-relevant fields. */
export function summarizeStrategyAnalysis(
  response: StrategyAnalysisResponse,
  limit = DEFAULT_STRATEGY_LIMIT,
): {
  generatedAtMs: number;
  summary: StrategyAnalysisResponse["summary"];
  topStrategies: CompactStrategy[];
  currentStrategies: CompactStrategy[];
} {
  const top = Math.max(1, limit);
  return {
    generatedAtMs: response.generatedAtMs,
    summary: response.summary,
    topStrategies: response.strategies.slice(0, top).map(summarizeStrategy),
    currentStrategies: response.currentStrategies.map(summarizeStrategy),
  };
}

import type { LogEntry } from "../logger.js";
import type { PnlResetAtMsByMode, PnlSummary } from "../pnl.js";
import type { RiskHaltStatus } from "../riskCircuitBreaker.js";
import type { MarketSymbol, Mode, Outcome } from "../types.js";
import type { UiStatus } from "../ui/shared.js";

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

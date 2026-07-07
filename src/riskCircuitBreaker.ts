import { calculateTradePnl } from "./pnl.js";
import { dailySpendKey } from "./time.js";
import type { Mode, TradeAttempt } from "./types.js";

export interface RiskLimits {
  maxDailyLossUsd?: number;
  maxConsecutiveLosses?: number;
}

export type RiskHaltReason = "daily_loss_limit" | "consecutive_losses";

export interface RiskHaltStatus {
  tripped: boolean;
  reason?: RiskHaltReason;
  dailyLossUsd: number;
  consecutiveLosses: number;
}

/**
 * Risk circuit breaker: halts trading (not the bot/analytics) when today's realized losses cross a
 * threshold. Both metrics are scoped to the current UTC day so they auto-reset at midnight, and are
 * derived from the trade log (no separate persisted flag — robust across restarts, like dailySpend).
 */
export function evaluateRiskCircuitBreaker(
  trades: TradeAttempt[],
  mode: Mode,
  limits: RiskLimits,
  nowMs = Date.now(),
  haltResetAtMs = 0,
): RiskHaltStatus {
  const todayKey = dailySpendKey(nowMs);
  const resolvedToday = trades
    .filter(
      (trade) =>
        trade.mode === mode &&
        trade.resolved !== undefined &&
        dailySpendKey(trade.resolved.resolvedAtMs) === todayKey &&
        // Ignore losses from before a manual breaker reset so it re-arms with a clean streak.
        trade.resolved.resolvedAtMs > haltResetAtMs,
    )
    .sort((left, right) => (left.resolved?.resolvedAtMs ?? 0) - (right.resolved?.resolvedAtMs ?? 0));

  let netUsd = 0;
  for (const trade of resolvedToday) {
    netUsd += calculateTradePnl(trade).netUsd ?? 0;
  }
  const dailyLossUsd = Math.max(0, -netUsd);

  let consecutiveLosses = 0;
  for (let index = resolvedToday.length - 1; index >= 0; index -= 1) {
    if (resolvedToday[index].resolved?.won) {
      break;
    }
    consecutiveLosses += 1;
  }

  const maxDailyLossUsd = limits.maxDailyLossUsd ?? 0;
  const maxConsecutiveLosses = limits.maxConsecutiveLosses ?? 0;

  let reason: RiskHaltReason | undefined;
  if (maxDailyLossUsd > 0 && dailyLossUsd >= maxDailyLossUsd) {
    reason = "daily_loss_limit";
  } else if (maxConsecutiveLosses > 0 && consecutiveLosses >= maxConsecutiveLosses) {
    reason = "consecutive_losses";
  }

  return { tripped: reason !== undefined, reason, dailyLossUsd, consecutiveLosses };
}

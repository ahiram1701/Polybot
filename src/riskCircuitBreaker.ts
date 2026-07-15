import { calculateTradePnl } from "./pnl.js";
import { dailySpendKey } from "./time.js";
import type { Mode, TradeAttempt } from "./types.js";

export interface RiskLimits {
  maxDailyLossUsd?: number;
  maxConsecutiveLosses?: number;
  // Hours the halt lasts after tripping; the breaker then RE-ARMS ITSELF with a clean slate (losses
  // before the re-arm moment stop counting, exactly like a manual reset). 0 = legacy behavior: halted
  // for the rest of the day.
  cooldownHours?: number;
  // Timezone defining the metrics day (undefined = legacy UTC cut).
  timeZone?: string;
}

export type RiskHaltReason = "daily_loss_limit" | "consecutive_losses";

export interface RiskHaltStatus {
  tripped: boolean;
  reason?: RiskHaltReason;
  dailyLossUsd: number;
  consecutiveLosses: number;
  // When a cooldown-based halt will auto-re-arm (epoch ms). Absent when not tripped or in legacy mode.
  resumeAtMs?: number;
}

/**
 * Risk circuit breaker: halts trading (not the bot/analytics) when realized losses cross a threshold.
 * With a cooldown configured, the halt lasts `cooldownHours` from the moment of the trip and then
 * re-arms automatically with a clean baseline (a fixed rest-of-day halt punished a 00:30 trip with a
 * ~23h pause but a 23:50 trip with 10 minutes — arbitrary). Metrics are scoped to the current calendar
 * day in the configured timezone (legacy UTC when unset) and are derived from the trade log (no
 * separate persisted flag — robust across restarts).
 */
export function evaluateRiskCircuitBreaker(
  trades: TradeAttempt[],
  mode: Mode,
  limits: RiskLimits,
  nowMs = Date.now(),
  haltResetAtMs = 0,
): RiskHaltStatus {
  const todayKey = dailySpendKey(nowMs, limits.timeZone);
  const resolvedToday = trades
    .filter(
      (trade) =>
        trade.mode === mode &&
        trade.resolved !== undefined &&
        dailySpendKey(trade.resolved.resolvedAtMs, limits.timeZone) === todayKey,
    )
    .sort((left, right) => (left.resolved?.resolvedAtMs ?? 0) - (right.resolved?.resolvedAtMs ?? 0));

  const cooldownMs = Math.max(0, limits.cooldownHours ?? 0) * 3_600_000;

  // Baseline: losses before a manual reset never count. With a cooldown, every trip whose cooldown has
  // already elapsed also advances the baseline (auto re-arm), possibly several times in one day.
  let baseline = haltResetAtMs;
  for (;;) {
    const evaluation = evaluateFromBaseline(resolvedToday, limits, baseline);
    if (!evaluation.reason || cooldownMs === 0) {
      return {
        tripped: evaluation.reason !== undefined,
        reason: evaluation.reason,
        dailyLossUsd: evaluation.dailyLossUsd,
        consecutiveLosses: evaluation.consecutiveLosses,
      };
    }
    const resumeAtMs = evaluation.trippedAtMs + cooldownMs;
    if (nowMs < resumeAtMs) {
      return {
        tripped: true,
        reason: evaluation.reason,
        dailyLossUsd: evaluation.dailyLossUsd,
        consecutiveLosses: evaluation.consecutiveLosses,
        resumeAtMs,
      };
    }
    baseline = resumeAtMs;
  }
}

function evaluateFromBaseline(
  resolvedToday: TradeAttempt[],
  limits: RiskLimits,
  baselineMs: number,
): { reason?: RiskHaltReason; trippedAtMs: number; dailyLossUsd: number; consecutiveLosses: number } {
  const maxDailyLossUsd = limits.maxDailyLossUsd ?? 0;
  const maxConsecutiveLosses = limits.maxConsecutiveLosses ?? 0;
  const counted = resolvedToday.filter((trade) => (trade.resolved?.resolvedAtMs ?? 0) > baselineMs);

  // Walk chronologically so we know the exact moment each limit was crossed (the cooldown anchors there).
  let netUsd = 0;
  let consecutiveLosses = 0;
  let reason: RiskHaltReason | undefined;
  let trippedAtMs = 0;
  for (const trade of counted) {
    netUsd += calculateTradePnl(trade).netUsd ?? 0;
    consecutiveLosses = trade.resolved?.won ? 0 : consecutiveLosses + 1;
    if (reason === undefined) {
      if (maxDailyLossUsd > 0 && Math.max(0, -netUsd) >= maxDailyLossUsd) {
        reason = "daily_loss_limit";
        trippedAtMs = trade.resolved?.resolvedAtMs ?? 0;
      } else if (maxConsecutiveLosses > 0 && consecutiveLosses >= maxConsecutiveLosses) {
        reason = "consecutive_losses";
        trippedAtMs = trade.resolved?.resolvedAtMs ?? 0;
      }
    }
  }

  return { reason, trippedAtMs, dailyLossUsd: Math.max(0, -netUsd), consecutiveLosses };
}

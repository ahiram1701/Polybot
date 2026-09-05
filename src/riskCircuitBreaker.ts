import { calculateTradePnl, isWinningTrade, tradeClosedAtMs } from "./pnl.js";
import { dailySpendKey, localDayRange } from "./time.js";
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
  // Rango del dia en epoch ms, calculado UNA vez. Antes se formateaba la fecha de CADA trade para
  // compararla con la de hoy: con zona horaria eso cuesta ~0,32 ms por llamada y, con 1.323 trades,
  // salian 164,7 ms por iteracion del bucle — el 16% de cada segundo, creciendo con el historial.
  // Comparar numeros es exactamente equivalente y practicamente gratis.
  const hoy = localDayRange(nowMs, limits.timeZone);
  // `tradeClosedAtMs` y no `resolved.resolvedAtMs`: una posicion vendida antes de tiempo no tiene
  // `resolved`, asi que filtrar por ese campo dejaba fuera del cortacircuitos precisamente las
  // perdidas que se acaban de realizar. Ninguna de ellas contaba ni en la perdida diaria ni en la
  // racha, que es lo contrario de lo que este freno existe para hacer.
  const resolvedToday = trades
    .filter((trade) => {
      if (trade.mode !== mode) {
        return false;
      }
      const cerradoMs = tradeClosedAtMs(trade);
      return cerradoMs !== undefined && cerradoMs >= hoy.startMs && cerradoMs < hoy.endMs;
    })
    .sort((left, right) => (tradeClosedAtMs(left) ?? 0) - (tradeClosedAtMs(right) ?? 0));

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
  const counted = resolvedToday.filter((trade) => (tradeClosedAtMs(trade) ?? 0) > baselineMs);

  // Walk chronologically so we know the exact moment each limit was crossed (the cooldown anchors there).
  let netUsd = 0;
  let consecutiveLosses = 0;
  let reason: RiskHaltReason | undefined;
  let trippedAtMs = 0;
  for (const trade of counted) {
    netUsd += calculateTradePnl(trade).netUsd ?? 0;
    // A profitable arbitrage must not extend a losing streak just because its nominal side lost.
    consecutiveLosses = isWinningTrade(trade) ? 0 : consecutiveLosses + 1;
    if (reason === undefined) {
      if (maxDailyLossUsd > 0 && Math.max(0, -netUsd) >= maxDailyLossUsd) {
        reason = "daily_loss_limit";
        trippedAtMs = tradeClosedAtMs(trade) ?? 0;
      } else if (maxConsecutiveLosses > 0 && consecutiveLosses >= maxConsecutiveLosses) {
        reason = "consecutive_losses";
        trippedAtMs = tradeClosedAtMs(trade) ?? 0;
      }
    }
  }

  return { reason, trippedAtMs, dailyLossUsd: Math.max(0, -netUsd), consecutiveLosses };
}

/**
 * El cortacircuitos del DIRECCIONAL, tal y como lo aplica el bucle.
 *
 * Existe porque la UI y el runner lo calculaban por separado y decian cosas distintas: el runner
 * excluia los trades de arbitraje y usaba el modo del direccional (`modeFor("dir")`), mientras
 * `buildSnapshot` pasaba TODOS los trades y el modo GLOBAL. Con arbitraje en live y direccional en sim
 * —que es justo el reparto que recomienda el manual— el chip de riesgo podia anunciar un halt que el
 * bucle no estaba aplicando, o callar uno que si.
 *
 * Las dos exclusiones no son un detalle de implementacion, son la politica:
 *
 * - **Fuera el arbitraje.** Un par completo redime $1/set gane quien gane; pararlo por una racha ajena
 *   seria dejar de recoger dinero sin riesgo por un motivo que no le toca.
 * - **Su modo, no el global.** Si no, una racha de perdidas en PAPEL podria frenar dinero real; y al
 *   reves es peor todavia: unas ganancias simuladas tapando perdidas reales.
 *
 * Quien lo dibuje y quien lo aplique tienen que llamar aqui. Duplicar la condicion es como se produjo
 * la divergencia.
 */
export function evaluateDirectionalRiskHalt(args: {
  trades: TradeAttempt[];
  directionalMode: Mode;
  limits: RiskLimits;
  nowMs?: number;
  /** Marcadores de re-armado por modo (`state.getRiskHaltResetAtMs()`). */
  haltResetAtMsByMode?: Partial<Record<Mode, number>>;
}): RiskHaltStatus {
  return evaluateRiskCircuitBreaker(
    args.trades.filter((trade) => trade.kind !== "arb"),
    args.directionalMode,
    args.limits,
    args.nowMs ?? Date.now(),
    args.haltResetAtMsByMode?.[args.directionalMode] ?? 0,
  );
}

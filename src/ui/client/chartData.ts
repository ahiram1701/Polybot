import {
  calculateTradePnl,
  esOperacionCerrada,
  filterTradesForPnlReset,
  isCompleteArbPair,
  isWinningTrade,
  type PnlResetAtMsByMode,
} from "../../pnl.js";
import { dayKeyInTimeZone, hourInTimeZone } from "../../timezone.js";
import type { Mode, Outcome, TradeAttempt } from "../../types.js";

/**
 * Pure derivations of chart series from the trade ledger. Everything the Dashboard/Analysis charts
 * draw is computed here (no backend, no persisted snapshots) so the logic is unit-testable and the SVG
 * components stay dumb. All series operate on RESOLVED trades of one mode, post-reset, ordered by
 * resolution time.
 */

export interface EquityPoint {
  index: number;
  resolvedAtMs: number;
  cumulativeUsd: number;
  drawdownUsd: number;
}

export interface LabeledValue {
  label: string;
  value: number;
  /** Optional secondary value (e.g. break-even to compare a win rate against). */
  reference?: number;
  count?: number;
}

/** Resolved trades of `mode`, post-reset, sorted by resolution time. Optionally exclude arb pairs. */
export function resolvedTradesForCharts(
  trades: TradeAttempt[],
  mode: Mode,
  resetAtMsByMode: PnlResetAtMsByMode = {},
  options: { excludeArb?: boolean } = {},
): TradeAttempt[] {
  return filterTradesForPnlReset(trades, resetAtMsByMode)
    .filter(
      (trade) =>
        trade.mode === mode &&
        trade.resolved !== undefined &&
        (!options.excludeArb || trade.kind !== "arb"),
    )
    .sort((left, right) => (left.resolved?.resolvedAtMs ?? 0) - (right.resolved?.resolvedAtMs ?? 0));
}

/** Running net P&L trade by trade, with the running max-drawdown envelope. */
export function buildEquitySeries(trades: TradeAttempt[]): EquityPoint[] {
  const points: EquityPoint[] = [];
  let cumulative = 0;
  let peak = 0;
  trades.forEach((trade, index) => {
    cumulative += calculateTradePnl(trade).netUsd ?? 0;
    peak = Math.max(peak, cumulative);
    points.push({
      index,
      resolvedAtMs: trade.resolved?.resolvedAtMs ?? 0,
      cumulativeUsd: round2(cumulative),
      drawdownUsd: round2(cumulative - peak),
    });
  });
  return points;
}

/** Rolling win rate (fraction 0..1) over the last `window` resolutions; cumulative until it fills. */
export function rollingWinRate(trades: TradeAttempt[], window = 20): number[] {
  const wins: number[] = trades.map((trade) => (isWinningTrade(trade) ? 1 : 0));
  return wins.map((_value, index) => {
    const from = Math.max(0, index - window + 1);
    const slice = wins.slice(from, index + 1);
    return slice.reduce((sum, value) => sum + value, 0) / slice.length;
  });
}

/** Cumulative ROI (net / stake) after each trade. */
export function cumulativeRoi(trades: TradeAttempt[]): number[] {
  let net = 0;
  let stake = 0;
  return trades.map((trade) => {
    const pnl = calculateTradePnl(trade);
    net += pnl.netUsd ?? 0;
    stake += pnl.stakeUsd;
    return stake > 0 ? net / stake : 0;
  });
}

const CALIBRATION_EDGES = [0.5, 0.6, 0.7, 0.8, 0.9, 1.0000001];

/**
 * Predicted-vs-realized calibration: for each predicted-win-probability bucket, the REAL win rate and
 * the bucket's average predicted probability (the "ideal" it should match). Gaps reveal overconfidence.
 */
export function calibrationBuckets(trades: TradeAttempt[]): LabeledValue[] {
  const withPrediction = trades.flatMap((trade) => {
    const predicted = trade.expectedValue?.adjustedWinProbability;
    return typeof predicted === "number" ? [{ predicted, won: trade.resolved?.won === true }] : [];
  });
  const buckets: LabeledValue[] = [];
  for (let index = 0; index < CALIBRATION_EDGES.length - 1; index += 1) {
    const lo = CALIBRATION_EDGES[index];
    const hi = CALIBRATION_EDGES[index + 1];
    const inBucket = withPrediction.filter((item) => item.predicted >= lo && item.predicted < hi);
    if (inBucket.length === 0) {
      continue;
    }
    const realWin = inBucket.filter((item) => item.won).length / inBucket.length;
    const avgPredicted = inBucket.reduce((sum, item) => sum + item.predicted, 0) / inBucket.length;
    buckets.push({
      label: `${lo.toFixed(1)}–${Math.min(hi, 1).toFixed(1)}`,
      value: realWin,
      reference: avgPredicted,
      count: inBucket.length,
    });
  }
  return buckets;
}

/** Histogram of net$ per trade in fixed buckets, revealing the payoff asymmetry. */
export function netDistribution(trades: TradeAttempt[]): LabeledValue[] {
  const edges = [-Infinity, -5, -2.5, 0, 2.5, 5, Infinity];
  const labels = ["≤−5", "−5..−2.5", "−2.5..0", "0..2.5", "2.5..5", "≥5"];
  const counts = new Array(labels.length).fill(0);
  for (const trade of trades) {
    const net = calculateTradePnl(trade).netUsd ?? 0;
    for (let index = 0; index < labels.length; index += 1) {
      if (net > edges[index] && net <= edges[index + 1]) {
        counts[index] += 1;
        break;
      }
    }
  }
  return labels.map((label, index) => ({ label, value: counts[index] }));
}

/** Net$ and win rate grouped by market and by side, for the comparison bars. */
export function perMarketSide(trades: TradeAttempt[]): { markets: LabeledValue[]; sides: LabeledValue[] } {
  const group = (keyFn: (trade: TradeAttempt) => string, keys: string[]): LabeledValue[] =>
    keys.flatMap((key) => {
      const inGroup = trades.filter((trade) => keyFn(trade) === key);
      if (inGroup.length === 0) {
        return [];
      }
      const net = inGroup.reduce((sum, trade) => sum + (calculateTradePnl(trade).netUsd ?? 0), 0);
      const wins = inGroup.filter((trade) => isWinningTrade(trade)).length;
      return [{ label: key, value: round2(net), reference: wins / inGroup.length, count: inGroup.length }];
    });

  return {
    markets: group((trade) => trade.asset ?? "—", ["BTC", "ETH", "DOGE"]),
    sides: group((trade) => trade.outcome, ["UP", "DOWN"] as Outcome[]),
  };
}

/**
 * Trade counts per hour of entry in the configured timezone ("auto"/undefined = system; only hours with
 * activity); `reference` = wins in that hour.
 */
export function hourOfDayHistogram(trades: TradeAttempt[], timeZone?: string): LabeledValue[] {
  const byHour = new Map<number, { count: number; wins: number }>();
  for (const trade of trades) {
    const hour = hourInTimeZone(trade.createdAtMs, timeZone);
    const entry = byHour.get(hour) ?? { count: 0, wins: 0 };
    entry.count += 1;
    entry.wins += isWinningTrade(trade) ? 1 : 0;
    byHour.set(hour, entry);
  }
  return [...byHour.entries()]
    .sort(([left], [right]) => left - right)
    .map(([hour, entry]) => ({
      label: `${String(hour).padStart(2, "0")}h`,
      value: entry.count,
      reference: entry.wins,
      count: entry.count,
    }));
}

/**
 * Trades per calendar day in the configured timezone from first to last trade, including gap days at 0.
 */
export function tradesPerDaySeries(trades: TradeAttempt[], timeZone?: string): number[] {
  if (trades.length === 0) {
    return [];
  }
  const counts = new Map<string, number>();
  let firstMs = Infinity;
  let lastMs = -Infinity;
  for (const trade of trades) {
    const key = dayKeyInTimeZone(trade.createdAtMs, timeZone);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    firstMs = Math.min(firstMs, trade.createdAtMs);
    lastMs = Math.max(lastMs, trade.createdAtMs);
  }
  // Walk the epoch in 6h steps collecting distinct day keys in order — TZ/DST-proof gap filling.
  const orderedKeys: string[] = [];
  const lastKey = dayKeyInTimeZone(lastMs, timeZone);
  for (let ms = firstMs; ; ms += 6 * 3_600_000) {
    const key = ms >= lastMs ? lastKey : dayKeyInTimeZone(ms, timeZone);
    if (orderedKeys[orderedKeys.length - 1] !== key) {
      orderedKeys.push(key);
    }
    if (key === lastKey) {
      break;
    }
  }
  return orderedKeys.map((key) => counts.get(key) ?? 0);
}

export interface ProjectionPeriod {
  label: string;
  netUsd: number;
  trades: number;
  stakeUsd: number;
}

export interface ProjectionEstimates {
  spanDays: number;
  tradesPerDay: number;
  netPerDayUsd: number;
  stakePerDayUsd: number;
  /** Realized ROI (net/stake) — period-invariant, so shown once rather than per period. */
  roiPct: number;
  periods: ProjectionPeriod[];
}

const MIN_PROJECTION_TRADES = 5;
const MIN_PROJECTION_SPAN_MS = 6 * 60 * 60 * 1000;

/**
 * Linear extrapolation of the post-reset pace to week/month/year. Returns undefined when the base is
 * too thin to be meaningful (<5 resolved trades or <6h of span).
 */
export function projectionEstimates(trades: TradeAttempt[]): ProjectionEstimates | undefined {
  if (trades.length < MIN_PROJECTION_TRADES) {
    return undefined;
  }
  const resolvedTimes = trades.map((trade) => trade.resolved?.resolvedAtMs ?? 0);
  const spanMs = Math.max(...resolvedTimes) - Math.min(...resolvedTimes);
  if (spanMs < MIN_PROJECTION_SPAN_MS) {
    return undefined;
  }
  // Floor the divisor at 6h so a tight burst of trades doesn't explode into an absurd yearly figure.
  const spanDays = Math.max(spanMs / 86_400_000, 0.25);
  let netTotal = 0;
  let stakeTotal = 0;
  for (const trade of trades) {
    const pnl = calculateTradePnl(trade);
    netTotal += pnl.netUsd ?? 0;
    stakeTotal += pnl.stakeUsd;
  }
  const netPerDayUsd = netTotal / spanDays;
  const tradesPerDay = trades.length / spanDays;
  const stakePerDayUsd = stakeTotal / spanDays;
  const period = (label: string, days: number): ProjectionPeriod => ({
    label,
    netUsd: round2(netPerDayUsd * days),
    trades: Math.round(tradesPerDay * days),
    stakeUsd: round2(stakePerDayUsd * days),
  });
  return {
    spanDays: round2(spanDays),
    tradesPerDay: round2(tradesPerDay),
    netPerDayUsd: round2(netPerDayUsd),
    stakePerDayUsd: round2(stakePerDayUsd),
    roiPct: stakeTotal > 0 ? round2((netTotal / stakeTotal) * 100) : 0,
    periods: [period("Semana", 7), period("Mes", 30.44), period("Año", 365.25)],
  };
}

export interface ValidationProgress {
  resolvedCount: number;
  target: number;
  netUsd: number;
  /** ±band: 1.96·σ·√n over per-trade nets — the cumulative range pure luck covers at ~95%. */
  varianceBandUsd: number;
  withinBand: boolean;
}

/** Agreed go/no-go sample size before judging a run (anti-reactive-tinkering context). */
export const VALIDATION_TARGET_TRADES = 50;

export interface ValidationProgressByKind {
  arb: ValidationProgress;
  dir: ValidationProgress;
}

/**
 * Avance hacia el go/no-go SEPARADO por estrategia.
 *
 * El criterio acordado —50 operaciones con neto positivo— se venia calculando sobre el total, y ese
 * total mezcla dos estrategias de signo opuesto: medido tras el reset, el arbitraje daba +$15,26 en 8
 * operaciones y el direccional -$13,75 en 22. Sumados quedan en +$1,52, un numero que no describe
 * ninguna de las dos y que puede aprobar el paso a live por el motivo equivocado.
 *
 * Importa cual se mira: en live el direccional esta bloqueado por la puerta de capital, asi que lo que
 * de verdad va a correr es el arbitraje. Es SU avance el que decide.
 *
 * Recibe el LIBRO ENTERO y filtra por dentro, en vez de una lista ya cribada por `resolved`: el
 * direccional cierra tambien vendiendo, y esas ventas son siempre perdidas. Cribarlas fuera dejaba la
 * linea del direccional enseñando las ganancias sin las perdidas que las pagaron. El arbitraje sigue
 * exigiendo `resolved` —un par completo se redime, no se vende— asi que el avance que decide el
 * go/no-go no se mueve ni un trade.
 */
export function validationProgressByKind(
  trades: TradeAttempt[],
  mode: Mode,
  resetAtMsByMode: PnlResetAtMsByMode = {},
  target = VALIDATION_TARGET_TRADES,
): ValidationProgressByKind {
  const post = filterTradesForPnlReset(trades, resetAtMsByMode).filter((trade) => trade.mode === mode);
  // Misma clasificacion que el desglose de P&L: una pata suelta NO es arbitraje, es direccional, que
  // es donde de verdad quedo el riesgo.
  const arb = post.filter((trade) => isCompleteArbPair(trade) && trade.resolved !== undefined);
  const dir = post.filter((trade) => !isCompleteArbPair(trade) && esOperacionCerrada(trade));
  return {
    arb: validationProgress(arb, target),
    dir: validationProgress(dir, target),
  };
}

/**
 * Progress of the post-reset run toward the agreed validation sample, with variance context: while the
 * cumulative net sits inside ±1.96·σ·√n, the result is statistically indistinguishable from luck.
 */
export function validationProgress(trades: TradeAttempt[], target = VALIDATION_TARGET_TRADES): ValidationProgress {
  const nets = trades.map((trade) => calculateTradePnl(trade).netUsd ?? 0);
  const netUsd = nets.reduce((sum, value) => sum + value, 0);
  const mean = nets.length > 0 ? netUsd / nets.length : 0;
  const variance = nets.length > 1 ? nets.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (nets.length - 1) : 0;
  const varianceBandUsd = 1.96 * Math.sqrt(variance) * Math.sqrt(nets.length);
  return {
    resolvedCount: nets.length,
    target,
    netUsd: round2(netUsd),
    varianceBandUsd: round2(varianceBandUsd),
    withinBand: Math.abs(netUsd) <= varianceBandUsd,
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

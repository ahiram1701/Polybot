import { calculateTradePnl, filterTradesForPnlReset, type PnlResetAtMsByMode } from "../../pnl.js";
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
  const wins: number[] = trades.map((trade) => (trade.resolved?.won ? 1 : 0));
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
      const wins = inGroup.filter((trade) => trade.resolved?.won).length;
      return [{ label: key, value: round2(net), reference: wins / inGroup.length, count: inGroup.length }];
    });

  return {
    markets: group((trade) => trade.asset ?? "—", ["BTC", "ETH", "DOGE"]),
    sides: group((trade) => trade.outcome, ["UP", "DOWN"] as Outcome[]),
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

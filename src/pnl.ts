import type { TradeAttempt } from "./types.js";
import { calculateTradeFeeUsd, defaultTakerFeeRateBps } from "./fees.js";
import { hasResolvablePosition, summarizeLiveOrderFill } from "./tradeResolution.js";

export interface TradePnl {
  status: "pending" | "resolved";
  stakeUsd: number;
  payoutUsd?: number;
  netUsd?: number;
  roiPct?: number;
}

export interface PnlSummary {
  realizedUsd: number;
  realizedStakeUsd: number;
  payoutUsd: number;
  pendingStakeUsd: number;
  totalStakeUsd: number;
  resolvedCount: number;
  pendingCount: number;
  wonCount: number;
  lostCount: number;
  roiPct?: number;
}

export type PnlSummaryByMode = Record<TradeAttempt["mode"], PnlSummary>;
export type PnlResetAtMsByMode = Partial<Record<TradeAttempt["mode"], number>>;

export const EMPTY_PNL_SUMMARY: PnlSummary = {
  realizedUsd: 0,
  realizedStakeUsd: 0,
  payoutUsd: 0,
  pendingStakeUsd: 0,
  totalStakeUsd: 0,
  resolvedCount: 0,
  pendingCount: 0,
  wonCount: 0,
  lostCount: 0,
};

export function emptyPnlSummaryByMode(): PnlSummaryByMode {
  return {
    sim: { ...EMPTY_PNL_SUMMARY },
    live: { ...EMPTY_PNL_SUMMARY },
  };
}

/**
 * A COMPLETE arbitrage pair redeems $1 per set no matter which side wins; only a naked leg (pair
 * incomplete) depends on the winner like a normal position.
 */
export function isCompleteArbPair(trade: TradeAttempt): boolean {
  return trade.kind === "arb" && trade.arbPairComplete === true;
}

/**
 * Did this resolved trade MAKE MONEY? Use this — not `resolved.won` — for anything the user reads as
 * a result (win counts, win rate, "Ganó/Perdió", the circuit breaker's losing streak).
 *
 * `resolved.won` only answers "did the nominal outcome match the winner", which is the wrong question
 * for a complete arb set: it holds BOTH sides, so it always redeems $1/set and always profits, yet it
 * is recorded against one nominal outcome and so reads as a "loss" roughly half the time. The money
 * math already special-cased this (see calculateTradePnl); the counters did not, which is why the
 * dashboard and Telegram showed profitable arbitrages as losses.
 */
export function isWinningTrade(trade: TradeAttempt): boolean {
  if (!trade.resolved) {
    return false;
  }
  return trade.resolved.won === true || isCompleteArbPair(trade);
}

export function calculateTradePnl(trade: TradeAttempt): TradePnl {
  const stakeUsd = getStakeUsd(trade);
  if (!trade.resolved) {
    return {
      status: "pending",
      stakeUsd,
    };
  }

  const paysRegardlessOfWinner = isCompleteArbPair(trade);
  const payoutUsd = trade.resolved.won || paysRegardlessOfWinner ? getPayoutUsd(trade) : 0;
  const netUsd = payoutUsd - stakeUsd;
  return {
    status: "resolved",
    stakeUsd,
    payoutUsd,
    netUsd,
    roiPct: stakeUsd > 0 ? netUsd / stakeUsd : undefined,
  };
}

function getStakeUsd(trade: TradeAttempt): number {
  if (trade.mode === "live" && !hasResolvablePosition(trade)) {
    return 0;
  }
  const filledAmountUsd = getFilledAmountUsd(trade);
  if (isPositiveFinite(filledAmountUsd)) {
    return sanitizeUsd(filledAmountUsd) + getFeeUsd(trade);
  }
  // No explicit fill amount (sim): the real stake is the COST of the shares actually held, which can
  // be less than the requested amount when liquidity under the cap was thin (a partial fill). The
  // payout uses those same shares, so using the requested amountUsd here would score a partially
  // filled WIN as a loss (e.g. 0.93 shares bought for ~$0.69 but staked as $10 -> shows -$9.07).
  const shares = getFilledShares(trade) ?? trade.estimatedShares;
  const cost =
    isPositiveFinite(shares) && isPositiveFinite(trade.bestAsk) ? shares * trade.bestAsk : trade.amountUsd;
  return sanitizeUsd(cost) + getFeeUsd(trade);
}

function getPayoutUsd(trade: TradeAttempt): number {
  return sanitizeUsd(getFilledShares(trade) ?? trade.estimatedShares);
}

function getFilledAmountUsd(trade: TradeAttempt): number | undefined {
  if (trade.mode !== "live") {
    return trade.filledAmountUsd;
  }
  return chooseReliableFillValue(trade.filledAmountUsd, summarizeLiveOrderFill(trade.response).filledAmountUsd);
}

function getFilledShares(trade: TradeAttempt): number | undefined {
  if (trade.mode !== "live") {
    return trade.filledShares;
  }
  return chooseReliableFillValue(trade.filledShares, summarizeLiveOrderFill(trade.response).filledShares);
}

// Exported for the fiscal report: the same fee (recorded or estimated) that calculateTradePnl bakes
// into the stake, so the CSV's fee column reconciles exactly with the dashboard P&L.
export function estimateTradeFeeUsd(trade: TradeAttempt): number {
  return getFeeUsd(trade);
}

function getFeeUsd(trade: TradeAttempt): number {
  if (isPositiveFinite(trade.feeUsd)) {
    return trade.feeUsd;
  }
  // La fee se estima en AMBOS modos. Antes sim devolvia 0, asi que su P&L era libre de comisiones
  // (~3.7% del stake) y toda validacion en sim salia optimista frente al live que pretendia predecir:
  // un sim ligeramente positivo podia ser un live negativo. Un sim honesto exige cobrar lo mismo.
  const filledShares = getFilledShares(trade);
  const filledAmountUsd = getFilledAmountUsd(trade);
  const price = trade.averageFillPrice ?? (
    isPositiveFinite(filledShares) && isPositiveFinite(filledAmountUsd)
      ? filledAmountUsd / filledShares
      : undefined
  );
  if (!isPositiveFinite(filledShares) || !isPositiveFinite(price)) {
    return 0;
  }
  return calculateTradeFeeUsd({
    shares: filledShares,
    price,
    feeRateBps: defaultTakerFeeRateBps(trade.asset),
  });
}

function chooseReliableFillValue(stored: number | undefined, response: number | undefined): number | undefined {
  if (response !== undefined && (!isPositiveFinite(stored) || isLikelyScaledDown(stored, response))) {
    return response;
  }
  return stored ?? response;
}

function isLikelyScaledDown(stored: number | undefined, response: number): boolean {
  return isPositiveFinite(stored) && response >= 0.01 && response / stored >= 1_000;
}

export function calculatePnlSummary(trades: TradeAttempt[]): PnlSummary {
  const summary: PnlSummary = { ...EMPTY_PNL_SUMMARY };

  for (const trade of trades) {
    const pnl = calculateTradePnl(trade);
    summary.totalStakeUsd += pnl.stakeUsd;

    if (pnl.status === "pending") {
      summary.pendingStakeUsd += pnl.stakeUsd;
      summary.pendingCount += 1;
      continue;
    }

    summary.realizedStakeUsd += pnl.stakeUsd;
    summary.payoutUsd += pnl.payoutUsd ?? 0;
    summary.realizedUsd += pnl.netUsd ?? 0;
    summary.resolvedCount += 1;
    if (isWinningTrade(trade)) {
      summary.wonCount += 1;
    } else {
      summary.lostCount += 1;
    }
  }

  summary.roiPct = summary.realizedStakeUsd > 0 ? summary.realizedUsd / summary.realizedStakeUsd : undefined;
  return summary;
}

export function calculatePnlSummaryByMode(trades: TradeAttempt[], resetAtMsByMode: PnlResetAtMsByMode = {}): PnlSummaryByMode {
  const pnlTrades = filterTradesForPnlReset(trades, resetAtMsByMode);
  return {
    sim: calculatePnlSummary(pnlTrades.filter((trade) => trade.mode === "sim")),
    live: calculatePnlSummary(pnlTrades.filter((trade) => trade.mode === "live")),
  };
}

export function calculateResetAwarePnlSummary(trades: TradeAttempt[], resetAtMsByMode: PnlResetAtMsByMode = {}): PnlSummary {
  return calculatePnlSummary(filterTradesForPnlReset(trades, resetAtMsByMode));
}

export function filterTradesForPnlReset(trades: TradeAttempt[], resetAtMsByMode: PnlResetAtMsByMode = {}): TradeAttempt[] {
  return trades.filter((trade) => {
    const resetAtMs = resetAtMsByMode[trade.mode];
    return resetAtMs === undefined || trade.createdAtMs > resetAtMs;
  });
}

function sanitizeUsd(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) ? value : 0;
}

function isPositiveFinite(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value > 0;
}

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

export function calculateTradePnl(trade: TradeAttempt): TradePnl {
  const stakeUsd = getStakeUsd(trade);
  if (!trade.resolved) {
    return {
      status: "pending",
      stakeUsd,
    };
  }

  const payoutUsd = trade.resolved.won ? getPayoutUsd(trade) : 0;
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
  return sanitizeUsd(getFilledAmountUsd(trade) ?? trade.amountUsd) + getFeeUsd(trade);
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

function getFeeUsd(trade: TradeAttempt): number {
  if (isPositiveFinite(trade.feeUsd)) {
    return trade.feeUsd;
  }
  if (trade.mode !== "live") {
    return sanitizeUsd(trade.feeUsd);
  }

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
    if (trade.resolved?.won) {
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

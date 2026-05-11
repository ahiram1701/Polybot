import type { BtcPriceTick, MarketInfo, OrderbookQuote, Outcome, WindowOpening } from "./types.js";
import { secondsToEnd } from "./time.js";

export interface WinningOutcome {
  outcome: Outcome;
  distanceUsd: number;
}

export interface SignalDecision {
  action: "BUY" | "SKIP" | "WAIT";
  reason: string;
  outcome?: Outcome;
  distanceUsd?: number;
}

export function getWinningOutcome(
  openingPrice: number,
  currentPrice: number,
  minDistanceUsd: number,
): WinningOutcome | null {
  const upDistance = currentPrice - openingPrice;
  if (upDistance >= minDistanceUsd) {
    return { outcome: "UP", distanceUsd: upDistance };
  }

  const downDistance = openingPrice - currentPrice;
  if (downDistance >= minDistanceUsd) {
    return { outcome: "DOWN", distanceUsd: downDistance };
  }

  return null;
}

export function shouldCaptureOpeningTick(args: {
  market: MarketInfo;
  tick: BtcPriceTick;
  nowMs: number;
  openingCaptureGraceMs: number;
}): boolean {
  const captureDeadlineMs = args.market.windowStartMs + args.openingCaptureGraceMs;
  return (
    args.tick.timestampMs >= args.market.windowStartMs &&
    args.tick.timestampMs <= captureDeadlineMs
  );
}

export function isWithinEntryWindow(endMs: number, nowMs: number, entryWindowSeconds: number): boolean {
  const remainingSeconds = secondsToEnd(endMs, nowMs);
  return remainingSeconds > 0 && remainingSeconds <= entryWindowSeconds;
}

export function isTickStale(tick: BtcPriceTick, nowMs: number, staleMs: number): boolean {
  return nowMs - tick.timestampMs > staleMs || nowMs - tick.receivedAtMs > staleMs;
}

export function evaluateSignal(args: {
  market: MarketInfo;
  opening?: WindowOpening;
  tick?: BtcPriceTick;
  quote?: OrderbookQuote;
  nowMs: number;
  entryWindowSeconds: number;
  minBtcDistanceUsd: number;
  tickStaleMs: number;
  maxAskPrice: number;
  alreadyTraded: boolean;
  amountUsd: number;
  dailySpendUsd: number;
  dailySpendLimitUsd: number;
}): SignalDecision {
  if (!isWithinEntryWindow(args.market.endMs, args.nowMs, args.entryWindowSeconds)) {
    return { action: "WAIT", reason: "outside_entry_window" };
  }

  if (args.alreadyTraded) {
    return { action: "SKIP", reason: "market_already_traded" };
  }

  if (!args.market.active || args.market.closed || !args.market.acceptingOrders) {
    return { action: "SKIP", reason: "market_not_accepting_orders" };
  }

  if (!args.opening) {
    return { action: "SKIP", reason: "missing_opening_chainlink_tick" };
  }

  if (!args.tick) {
    return { action: "SKIP", reason: "missing_current_chainlink_tick" };
  }

  if (isTickStale(args.tick, args.nowMs, args.tickStaleMs)) {
    return { action: "SKIP", reason: "stale_chainlink_tick" };
  }

  const winner = getWinningOutcome(args.opening.openingPrice, args.tick.value, args.minBtcDistanceUsd);
  if (!winner) {
    return { action: "SKIP", reason: "btc_distance_below_threshold" };
  }

  if (!args.quote?.bestAsk || args.quote.availableUsdUnderCap <= 0) {
    return {
      action: "SKIP",
      reason: "no_ask_liquidity_under_cap",
      outcome: winner.outcome,
      distanceUsd: winner.distanceUsd,
    };
  }

  if (args.quote.bestAsk > args.maxAskPrice) {
    return {
      action: "SKIP",
      reason: "best_ask_above_cap",
      outcome: winner.outcome,
      distanceUsd: winner.distanceUsd,
    };
  }

  if (args.dailySpendUsd + args.amountUsd > args.dailySpendLimitUsd) {
    return {
      action: "SKIP",
      reason: "daily_spend_limit_reached",
      outcome: winner.outcome,
      distanceUsd: winner.distanceUsd,
    };
  }

  return {
    action: "BUY",
    reason: "signal_ready",
    outcome: winner.outcome,
    distanceUsd: winner.distanceUsd,
  };
}

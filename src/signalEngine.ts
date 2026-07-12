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
  minDistanceUsd: number | Partial<Record<Outcome, number>>,
): WinningOutcome | null {
  const upMinDistanceUsd = typeof minDistanceUsd === "number" ? minDistanceUsd : minDistanceUsd.UP;
  const downMinDistanceUsd = typeof minDistanceUsd === "number" ? minDistanceUsd : minDistanceUsd.DOWN;
  const upDistance = currentPrice - openingPrice;
  if (upMinDistanceUsd !== undefined && upDistance >= upMinDistanceUsd) {
    return { outcome: "UP", distanceUsd: upDistance };
  }

  const downDistance = openingPrice - currentPrice;
  if (downMinDistanceUsd !== undefined && downDistance >= downMinDistanceUsd) {
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
  // Symmetric grace around the window start. Chainlink prices are step functions, so the last tick
  // just before the open is the price in effect at the open (needed for sparsely-updated ETH/DOGE).
  const lo = args.market.windowStartMs - args.openingCaptureGraceMs;
  const hi = args.market.windowStartMs + args.openingCaptureGraceMs;
  return args.tick.timestampMs >= lo && args.tick.timestampMs <= hi;
}

export function isWithinEntryWindow(endMs: number, nowMs: number, entryWindowSeconds: number): boolean {
  const remainingSeconds = secondsToEnd(endMs, nowMs);
  return remainingSeconds > 0 && remainingSeconds <= entryWindowSeconds;
}

// Chainlink is a step function: it only publishes on deviation/heartbeat, so for sparse assets
// (ETH/DOGE off-peak) the last published value IS the current oracle price even when it is >10s old —
// and these markets RESOLVE on this same feed. Judging staleness by the oracle timestamp alone caused
// false "stale tick" skips while the connection was perfectly healthy (snapshot-refreshed every 5s).
const ORACLE_UPDATE_STALE_MS = 60_000;

export function isTickStale(
  tick: BtcPriceTick,
  nowMs: number,
  staleMs: number,
  oracleStaleMs = ORACLE_UPDATE_STALE_MS,
): boolean {
  // Delivery freshness (are we still receiving from the feed?) stays strict; the oracle's own update
  // age only matters when it exceeds the heartbeat-scale bound.
  return nowMs - tick.receivedAtMs > staleMs || nowMs - tick.timestampMs > Math.max(oracleStaleMs, staleMs);
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

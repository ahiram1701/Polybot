import type { BtcPriceTick, Outcome, SimResolution, TradeAttempt } from "./types.js";
import { marketSymbolFromSlug } from "./markets.js";

const CLOB_AMOUNT_DECIMALS = 6;
const RESOLVABLE_LIVE_STATUSES = new Set(["matched"]);

export interface LiveFillSummary {
  fillDetected: boolean;
  filledAmountUsd?: number;
  filledShares?: number;
}

export function summarizeLiveOrderFill(response: unknown): LiveFillSummary {
  const orderResponse = unwrapOrderResponse(response);
  const status = getString(orderResponse, "status")?.toLowerCase();
  const makingAmount = parseClobAmount(getProperty(orderResponse, "makingAmount"));
  const takingAmount = parseClobAmount(getProperty(orderResponse, "takingAmount"));
  const tradeIds = getArray(orderResponse, "tradeIDs");
  const transactionHashes = getArray(orderResponse, "transactionsHashes");
  const rejected = getProperty(orderResponse, "success") === false;

  return {
    fillDetected: !rejected && (
      RESOLVABLE_LIVE_STATUSES.has(status ?? "") ||
      makingAmount !== undefined ||
      takingAmount !== undefined ||
      tradeIds.length > 0 ||
      transactionHashes.length > 0
    ),
    filledAmountUsd: makingAmount,
    filledShares: takingAmount,
  };
}

export function extractTradeIds(response: unknown): string[] {
  const orderResponse = unwrapOrderResponse(response);
  return getArray(orderResponse, "tradeIDs")
    .map((tradeId) => String(tradeId))
    .filter((tradeId) => tradeId.length > 0);
}

export function hasResolvablePosition(trade: TradeAttempt): boolean {
  if (trade.mode === "sim") {
    return true;
  }
  if (trade.fillDetected !== undefined) {
    return trade.fillDetected;
  }
  return summarizeLiveOrderFill(trade.response ?? { status: trade.status }).fillDetected;
}

export function resolveTradeFromTick(
  trade: TradeAttempt,
  latestTick: BtcPriceTick,
  nowMs: number,
): SimResolution | undefined {
  const tradeAsset = trade.asset ?? marketSymbolFromSlug(trade.slug);
  if (
    (tradeAsset && latestTick.market !== tradeAsset) ||
    trade.resolved ||
    nowMs < trade.endMs ||
    latestTick.timestampMs < trade.endMs ||
    !hasResolvablePosition(trade)
  ) {
    return undefined;
  }

  const winningOutcome: Outcome = latestTick.value >= trade.openingPrice ? "UP" : "DOWN";
  return {
    resolvedAtMs: nowMs,
    finalPrice: latestTick.value,
    finalTickTimestampMs: latestTick.timestampMs,
    winningOutcome,
    won: winningOutcome === trade.outcome,
  };
}

export function parseClobAmount(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const text = typeof value === "string" ? value.trim() : undefined;
  const numeric = typeof value === "number" ? value : Number(text);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return undefined;
  }
  if (text?.includes(".")) {
    return numeric;
  }
  return Number.isInteger(numeric) && numeric >= 10 ** CLOB_AMOUNT_DECIMALS
    ? numeric / 10 ** CLOB_AMOUNT_DECIMALS
    : numeric;
}

function unwrapOrderResponse(value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }
  const nested = value.response;
  return isRecord(nested) ? nested : value;
}

function getProperty(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

function getString(value: unknown, key: string): string | undefined {
  const property = getProperty(value, key);
  return typeof property === "string" ? property : undefined;
}

function getArray(value: unknown, key: string): unknown[] {
  const property = getProperty(value, key);
  return Array.isArray(property) ? property : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

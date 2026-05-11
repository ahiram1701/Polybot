import type { ClobClient, Trade } from "@polymarket/clob-client-v2";
import type { TradeParams } from "@polymarket/clob-client-v2";

import { LiveClobClientProvider } from "./liveClobClient.js";
import { logger } from "./logger.js";
import { parseClobAmount } from "./tradeResolution.js";
import type { BotConfig, TradeAttempt } from "./types.js";
import { calculateTradeFeeUsd } from "./fees.js";

export interface TradeReconciler {
  reconcile(trade: TradeAttempt, nowMs: number): Promise<TradeAttempt | undefined>;
}

export class NoopTradeReconciler implements TradeReconciler {
  async reconcile(): Promise<TradeAttempt | undefined> {
    return undefined;
  }
}

export class LiveTradeReconciler implements TradeReconciler {
  private readonly clientProvider: LiveClobClientProvider;

  constructor(config: BotConfig) {
    this.clientProvider = new LiveClobClientProvider(config);
  }

  async reconcile(trade: TradeAttempt, nowMs: number): Promise<TradeAttempt | undefined> {
    if (trade.mode !== "live" || !trade.orderId || trade.reconciledAtMs) {
      return undefined;
    }

    const clobTrades = await this.fetchRelevantTrades(await this.clientProvider.getClient(), trade);
    if (clobTrades.length === 0) {
      return undefined;
    }

    const summary = summarizeClobTrades(clobTrades);
    if (summary.filledShares <= 0 || summary.filledAmountUsd <= 0) {
      return undefined;
    }

    const nextTrade: TradeAttempt = {
      ...trade,
      fillDetected: true,
      filledAmountUsd: summary.filledAmountUsd,
      filledShares: summary.filledShares,
      averageFillPrice: summary.averageFillPrice,
      feeUsd: summary.feeUsd,
      fillSource: "clob_trades",
      tradeIds: summary.tradeIds,
      reconciledAtMs: nowMs,
      status: trade.status ?? "matched",
    };

    logger.info("Reconciled live trade from CLOB trades.", {
      slug: trade.slug,
      orderId: trade.orderId,
      tradeCount: clobTrades.length,
      filledAmountUsd: nextTrade.filledAmountUsd,
      filledShares: nextTrade.filledShares,
      averageFillPrice: nextTrade.averageFillPrice,
      feeUsd: nextTrade.feeUsd,
    });
    return nextTrade;
  }

  private async fetchRelevantTrades(client: Pick<ClobClient, "getTrades">, trade: TradeAttempt): Promise<Trade[]> {
    const tradeIds = trade.tradeIds ?? [];
    if (tradeIds.length > 0) {
      const settled = await Promise.allSettled(tradeIds.map((id) => client.getTrades({ id }, true)));
      return settled.flatMap((result) => (result.status === "fulfilled" ? result.value : [])).filter((item) => isMatchingTrade(item, trade));
    }

    const after = Math.max(0, Math.floor((trade.createdAtMs - 60_000) / 1_000)).toString();
    const before = Math.ceil((trade.endMs + 60_000) / 1_000).toString();
    const params: TradeParams = {
      asset_id: trade.tokenId,
      after,
      before,
    };
    if (trade.conditionId) {
      params.market = trade.conditionId;
    }
    const trades = await client.getTrades(params, false);
    return trades.filter((item) => isMatchingTrade(item, trade));
  }
}

export function summarizeClobTrades(trades: Trade[]): {
  filledAmountUsd: number;
  filledShares: number;
  averageFillPrice: number;
  feeUsd: number;
  tradeIds: string[];
} {
  let filledShares = 0;
  let filledAmountUsd = 0;
  let feeUsd = 0;
  const tradeIds: string[] = [];

  for (const trade of trades) {
    const shares = parseClobAmount(trade.size);
    const price = Number(trade.price);
    if (shares === undefined || !Number.isFinite(price) || price <= 0) {
      continue;
    }

    filledShares += shares;
    filledAmountUsd += shares * price;
    feeUsd += calculateTradeFeeUsd({
      shares,
      price,
      feeRateBps: Number(trade.fee_rate_bps),
    });
    if (trade.id) {
      tradeIds.push(trade.id);
    }
  }

  return {
    filledAmountUsd: roundUsd(filledAmountUsd),
    filledShares,
    averageFillPrice: filledShares > 0 ? filledAmountUsd / filledShares : 0,
    feeUsd: roundUsd(feeUsd),
    tradeIds,
  };
}

function isMatchingTrade(trade: Trade, attempt: TradeAttempt): boolean {
  const matchingOrder = trade.taker_order_id?.toLowerCase() === attempt.orderId?.toLowerCase();
  const matchingSavedId = (attempt.tradeIds ?? []).includes(trade.id);
  return (
    (matchingOrder || matchingSavedId) &&
    trade.asset_id === attempt.tokenId &&
    String(trade.side).toUpperCase() === "BUY"
  );
}

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

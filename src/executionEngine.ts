import {
  ClobClient,
  OrderType,
  Side,
  type OrderResponse,
  type TickSize,
} from "@polymarket/clob-client-v2";

import { LiveClobClientProvider } from "./liveClobClient.js";
import type {
  BotConfig,
  BtcPriceTick,
  MarketInfo,
  OrderbookQuote,
  Outcome,
  TradeAttempt,
  WindowOpening,
} from "./types.js";
import type { ExpectedValueSnapshot } from "./expectedValue.js";
import { extractTradeIds, summarizeLiveOrderFill } from "./tradeResolution.js";

// Max amount (in price) a live order may pay above the observed best-ask before it stops filling.
const DEFAULT_LIVE_MAX_SLIPPAGE = 0.02;

export interface ExecutionInput {
  market: MarketInfo;
  outcome: Outcome;
  amountUsd: number;
  maxAskPrice: number;
  quote: OrderbookQuote;
  expectedValue?: ExpectedValueSnapshot;
  opening: WindowOpening;
  tick: BtcPriceTick;
  distanceUsd: number;
  entryWindowSeconds: number;
}

export interface TradeExecutor {
  execute(input: ExecutionInput): Promise<TradeAttempt>;
}

export function resolveTradeAmountUsd(args: {
  mode: "sim" | "live";
  requestedUsd: number;
  orderMinSize: number;
  autoMinLive: boolean;
}): number {
  if (args.mode === "live" && args.autoMinLive) {
    // "Auto minimum live": trade the exchange's minimum order size, ignoring the configured live
    // amount, so live orders stay as small as the market allows (e.g. Polymarket's $5 minimum even
    // when liveTradeAmountUsd is higher). Falls back to the requested size if the minimum is unknown.
    return Number.isFinite(args.orderMinSize) && args.orderMinSize > 0 ? args.orderMinSize : args.requestedUsd;
  }
  return args.requestedUsd;
}

/**
 * Limit price for a live BUY: cap how far above the observed best-ask the FAK order may walk the
 * book. Priced at maxAskPrice (the cap), the order overpays by filling all the way up to the cap
 * when the cheap top-of-book has little size — the sim→live slippage. Capping at bestAsk + a small
 * tolerance means the order fills near the price we evaluated (or fills partially / not at all)
 * instead of overpaying. Falls back to maxAskPrice when the best-ask is unknown.
 */
export function resolveLiveOrderPrice(args: {
  bestAsk: number | undefined;
  maxAskPrice: number;
  maxSlippage: number;
  tickSize?: number;
}): number {
  const base =
    typeof args.bestAsk === "number" && Number.isFinite(args.bestAsk) && args.bestAsk > 0
      ? args.bestAsk
      : args.maxAskPrice;
  const slippage = Number.isFinite(args.maxSlippage) && args.maxSlippage > 0 ? args.maxSlippage : 0;
  let price = Math.min(args.maxAskPrice, base + slippage);
  if (typeof args.tickSize === "number" && Number.isFinite(args.tickSize) && args.tickSize > 0) {
    // Round to the nearest tick, then never let rounding push the price above the cap.
    price = Math.min(args.maxAskPrice, Math.round(price / args.tickSize) * args.tickSize);
  }
  return Number(price.toFixed(6));
}

export class SimulationExecutionEngine implements TradeExecutor {
  constructor(private readonly config: BotConfig) {}

  async execute(input: ExecutionInput): Promise<TradeAttempt> {
    return buildBaseTrade(input, this.config.mode);
  }
}

export class LiveExecutionEngine implements TradeExecutor {
  private readonly clientProvider: LiveClobClientProvider;

  constructor(private readonly config: BotConfig) {
    this.clientProvider = new LiveClobClientProvider(config);
  }

  async execute(input: ExecutionInput): Promise<TradeAttempt> {
    const client = await this.getClient();
    const tokenId = input.market.outcomes[input.outcome].tokenId;
    // Price the order near the best-ask we evaluated, not at the max cap, so it can't walk the book
    // up to the ceiling and overpay (the sim->live slippage).
    const orderPrice = resolveLiveOrderPrice({
      bestAsk: input.quote.bestAsk,
      maxAskPrice: input.maxAskPrice,
      maxSlippage: this.config.liveMaxSlippage ?? DEFAULT_LIVE_MAX_SLIPPAGE,
      tickSize: Number(input.market.tickSize),
    });
    const response = (await client.createAndPostMarketOrder(
      {
        tokenID: tokenId,
        side: Side.BUY,
        amount: input.amountUsd,
        price: orderPrice,
        orderType: OrderType.FAK,
      },
      {
        tickSize: input.market.tickSize as TickSize,
        negRisk: input.market.negRisk,
      },
      OrderType.FAK,
    )) as Partial<OrderResponse> & Record<string, unknown>;

    let finalResponse: unknown = response;
    if (response.status === "live" && response.orderID) {
      const cancelResponse = await client.cancelOrder({ orderID: response.orderID });
      finalResponse = { response, cancelResponse };
    }
    const fill = summarizeLiveOrderFill(response);

    return {
      ...buildBaseTrade(input, this.config.mode),
      orderId: response.orderID,
      status: response.status,
      fillDetected: fill.fillDetected,
      filledAmountUsd: fill.filledAmountUsd,
      filledShares: fill.filledShares,
      averageFillPrice:
        fill.filledAmountUsd !== undefined && fill.filledShares !== undefined
          ? fill.filledAmountUsd / fill.filledShares
          : undefined,
      fillSource: fill.fillDetected ? "order_response" : undefined,
      tradeIds: extractTradeIds(response),
      response: finalResponse,
    };
  }

  private async getClient(): Promise<ClobClient> {
    return this.clientProvider.getClient();
  }
}

function buildBaseTrade(input: ExecutionInput, mode: "sim" | "live"): TradeAttempt {
  const token = input.market.outcomes[input.outcome];
  return {
    id: `${input.market.slug}-${mode}-${input.outcome}-${Date.now()}`,
    asset: input.market.asset,
    slug: input.market.slug,
    mode,
    conditionId: input.market.conditionId,
    outcome: input.outcome,
    tokenId: token.tokenId,
    amountUsd: input.amountUsd,
    maxAskPrice: input.maxAskPrice,
    bestAsk: input.quote.bestAsk,
    expectedValue: input.expectedValue,
    estimatedShares: input.quote.estimatedSharesForAmount,
    openingPrice: input.opening.openingPrice,
    entryPrice: input.tick.value,
    distanceUsd: input.distanceUsd,
    entryWindowSeconds: input.entryWindowSeconds,
    windowStartMs: input.market.windowStartMs,
    endMs: input.market.endMs,
    createdAtMs: Date.now(),
  };
}

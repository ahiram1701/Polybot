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
    return Math.max(args.requestedUsd, args.orderMinSize);
  }
  return args.requestedUsd;
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
    const response = (await client.createAndPostMarketOrder(
      {
        tokenID: tokenId,
        side: Side.BUY,
        amount: input.amountUsd,
        price: input.maxAskPrice,
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

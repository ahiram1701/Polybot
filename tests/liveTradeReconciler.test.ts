import { describe, expect, it } from "vitest";
import type { Trade } from "@polymarket/clob-client-v2";

import { calculateTradeFeeUsd } from "../src/fees.js";
import { summarizeClobTrades } from "../src/liveTradeReconciler.js";

describe("live trade reconciliation math", () => {
  it("summarizes CLOB trades into realized fill, average price, and taker fee", () => {
    const summary = summarizeClobTrades([
      clobTrade({ id: "trade-1", size: "3000000", price: "0.60", fee_rate_bps: "700" }),
      clobTrade({ id: "trade-2", size: "2000000", price: "0.70", fee_rate_bps: "700" }),
    ]);

    expect(summary.filledShares).toBe(5);
    expect(summary.filledAmountUsd).toBe(3.2);
    expect(summary.averageFillPrice).toBeCloseTo(0.64);
    expect(summary.feeUsd).toBeCloseTo(0.0805);
    expect(summary.tradeIds).toEqual(["trade-1", "trade-2"]);
  });

  it("summarizes decimal CLOB trade sizes without scaling them down", () => {
    const summary = summarizeClobTrades([
      clobTrade({ id: "trade-1", size: "3", price: "0.60", fee_rate_bps: "700" }),
      clobTrade({ id: "trade-2", size: "2.5", price: "0.70", fee_rate_bps: "700" }),
    ]);

    expect(summary.filledShares).toBe(5.5);
    expect(summary.filledAmountUsd).toBe(3.55);
    expect(summary.averageFillPrice).toBeCloseTo(3.55 / 5.5);
  });

  it("uses the documented taker fee formula", () => {
    expect(calculateTradeFeeUsd({ shares: 100, price: 0.5, feeRateBps: 700 })).toBe(1.75);
  });
});

function clobTrade(overrides: Partial<Trade>): Trade {
  return {
    id: "trade",
    taker_order_id: "order-1",
    market: "0xcondition",
    asset_id: "token",
    side: "BUY" as Trade["side"],
    size: "1000000",
    fee_rate_bps: "0",
    price: "0.5",
    status: "TRADE_STATUS_CONFIRMED",
    match_time: "1778178300",
    last_update: "1778178301",
    outcome: "UP",
    bucket_index: 0,
    owner: "owner",
    maker_address: "0x1111111111111111111111111111111111111111",
    transaction_hash: "0xhash",
    trader_side: "TAKER",
    maker_orders: [],
    ...overrides,
  } as Trade;
}

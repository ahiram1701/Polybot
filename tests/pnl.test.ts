import { describe, expect, it } from "vitest";

import { calculatePnlSummary, calculateTradePnl } from "../src/pnl.js";
import type { TradeAttempt } from "../src/types.js";

describe("P&L calculations", () => {
  it("uses simulated payout minus stake for won trades", () => {
    expect(calculateTradePnl(trade({ won: true, amountUsd: 1, estimatedShares: 1.25 }))).toMatchObject({
      status: "resolved",
      payoutUsd: 1.25,
      netUsd: 0.25,
      roiPct: 0.25,
    });
  });

  it("counts lost resolved trades as the full stake", () => {
    expect(calculateTradePnl(trade({ won: false, amountUsd: 1, estimatedShares: 1.25 })).netUsd).toBe(-1);
  });

  it("summarizes realized P&L and pending exposure", () => {
    const summary = calculatePnlSummary([
      trade({ won: true, amountUsd: 1, estimatedShares: 1.2 }),
      trade({ won: false, amountUsd: 2, estimatedShares: 4 }),
      trade({ amountUsd: 3, estimatedShares: 6 }),
    ]);

    expect(summary.realizedUsd).toBeCloseTo(-1.8);
    expect(summary.realizedStakeUsd).toBe(3);
    expect(summary.pendingStakeUsd).toBe(3);
    expect(summary.wonCount).toBe(1);
    expect(summary.lostCount).toBe(1);
    expect(summary.pendingCount).toBe(1);
    expect(summary.roiPct).toBeCloseTo(-0.6);
  });

  it("uses actual live fill amounts when available", () => {
    const pnl = calculateTradePnl({
      ...trade({ won: true, amountUsd: 10, estimatedShares: 20 }),
      mode: "live",
      fillDetected: true,
      filledAmountUsd: 5,
      filledShares: 6.25,
      feeUsd: 0.05,
    });

    expect(pnl.stakeUsd).toBe(5.05);
    expect(pnl.payoutUsd).toBe(6.25);
    expect(pnl.netUsd).toBeCloseTo(1.2);
    expect(pnl.roiPct).toBeCloseTo(1.2 / 5.05);
  });

  it("recovers live P&L from decimal CLOB response values if stored fills were scaled down", () => {
    const pnl = calculateTradePnl({
      ...trade({ won: true, amountUsd: 5, estimatedShares: 5.05 }),
      mode: "live",
      fillDetected: true,
      filledAmountUsd: 0.000005,
      filledShares: 0.0000050505,
      response: {
        status: "matched",
        makingAmount: "4.999995",
        takingAmount: "5.0505",
      },
    });

    expect(pnl.stakeUsd).toBeCloseTo(4.999995);
    expect(pnl.payoutUsd).toBeCloseTo(5.0505);
    expect(pnl.netUsd).toBeCloseTo(0.050505);
  });

  it("estimates crypto taker fees when live trades are missing fee details", () => {
    const pnl = calculateTradePnl({
      ...trade({ won: true, amountUsd: 5, estimatedShares: 41.666665 }),
      asset: "BTC",
      mode: "live",
      fillDetected: true,
      filledAmountUsd: 5,
      filledShares: 41.666665,
      averageFillPrice: 0.12,
    });

    expect(pnl.stakeUsd).toBeCloseTo(5.308);
    expect(pnl.payoutUsd).toBeCloseTo(41.666665);
    expect(pnl.netUsd).toBeCloseTo(36.358665);
  });

  it("does not count live orders with no fill as exposure", () => {
    expect(
      calculateTradePnl({
        ...trade({ amountUsd: 10, estimatedShares: 20 }),
        mode: "live",
        fillDetected: false,
      }),
    ).toMatchObject({
      status: "pending",
      stakeUsd: 0,
    });
  });
});

function trade(args: { won?: boolean; amountUsd: number; estimatedShares: number }): TradeAttempt {
  return {
    id: `trade-${args.won ?? "pending"}`,
    slug: `btc-updown-5m-${args.won ?? "pending"}`,
    mode: "sim",
    outcome: "UP",
    tokenId: "token",
    amountUsd: args.amountUsd,
    maxAskPrice: 0.98,
    bestAsk: 0.5,
    estimatedShares: args.estimatedShares,
    openingPrice: 100,
    entryPrice: 125,
    distanceUsd: 25,
    windowStartMs: 1,
    endMs: 2,
    createdAtMs: 3,
    resolved: args.won === undefined
      ? undefined
      : {
          resolvedAtMs: 4,
          finalPrice: args.won ? 130 : 90,
          finalTickTimestampMs: 4,
          winningOutcome: args.won ? "UP" : "DOWN",
          won: args.won,
        },
  };
}

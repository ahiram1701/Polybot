import { describe, expect, it } from "vitest";

import { summarizeAskBands } from "../src/askBands.js";
import type { TradeAttempt } from "../src/types.js";

function trade(args: { id: string; ask: number; won: boolean; mode?: TradeAttempt["mode"]; createdAtMs?: number }): TradeAttempt {
  return {
    id: args.id,
    slug: `eth-updown-5m-${args.id}`,
    mode: args.mode ?? "live",
    outcome: "UP",
    tokenId: "token",
    amountUsd: 5,
    maxAskPrice: 0.85,
    bestAsk: args.ask,
    estimatedShares: 5 / args.ask,
    fillDetected: true,
    filledAmountUsd: 5,
    filledShares: 5 / args.ask,
    feeUsd: 0.1,
    openingPrice: 100,
    entryPrice: 101,
    distanceUsd: 1,
    windowStartMs: 1,
    endMs: 2,
    createdAtMs: args.createdAtMs ?? 100,
    resolved: {
      resolvedAtMs: 200,
      finalPrice: args.won ? 110 : 90,
      finalTickTimestampMs: 200,
      winningOutcome: args.won ? "UP" : "DOWN",
      won: args.won,
    },
  };
}

describe("summarizeAskBands", () => {
  it("groups resolved trades of the mode into ask bands with win/BE/net", () => {
    const trades = [
      trade({ id: "cheap-w", ask: 0.5, won: true }),   // +[5/0.5=10 payout] - 5.1 = +4.9
      trade({ id: "cheap-l", ask: 0.52, won: false }),  // -5.1
      trade({ id: "dear-w", ask: 0.78, won: true }),    // 6.410 - 5.1 = +1.31
      trade({ id: "sim", ask: 0.5, won: true, mode: "sim" }), // excluded (mode)
    ];

    const summary = summarizeAskBands(trades, "live");

    expect(summary.totalTrades).toBe(3);
    const cheap = summary.bands.find((band) => band.lo === 0.45);
    expect(cheap).toMatchObject({ trades: 2, wins: 1 });
    expect(cheap?.winRate).toBeCloseTo(0.5);
    expect(cheap?.breakEvenRate).toBeCloseTo(0.51);
    expect(cheap?.netUsd).toBeCloseTo(4.9 - 5.1, 2);
    const dear = summary.bands.find((band) => band.lo === 0.75);
    expect(dear?.trades).toBe(1);
    expect(dear?.netUsd).toBeCloseTo(5 / 0.78 - 5.1, 2);
  });

  it("respects the P&L reset marker for the mode", () => {
    const trades = [
      trade({ id: "old", ask: 0.5, won: false, createdAtMs: 10 }),
      trade({ id: "new", ask: 0.5, won: true, createdAtMs: 100 }),
    ];
    const summary = summarizeAskBands(trades, "live", { live: 50 });
    expect(summary.totalTrades).toBe(1);
    expect(summary.bands[0]?.wins).toBe(1);
  });
});

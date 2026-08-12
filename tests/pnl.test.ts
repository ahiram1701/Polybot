import { describe, expect, it } from "vitest";

import {
  calculatePnlSummary,
  calculatePnlSummaryByMode,
  calculateTradePnl,
  isCompleteArbPair,
  isWinningTrade,
} from "../src/pnl.js";
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

  it("summarizes simulated and live P&L separately", () => {
    const summary = calculatePnlSummaryByMode([
      trade({ won: true, amountUsd: 1, estimatedShares: 1.25 }),
      {
        ...trade({ won: false, amountUsd: 2, estimatedShares: 4 }),
        mode: "live",
        fillDetected: true,
        filledAmountUsd: 2,
        filledShares: 4,
      },
    ]);

    expect(summary.sim.realizedUsd).toBeCloseTo(0.25);
    expect(summary.sim.wonCount).toBe(1);
    expect(summary.live.realizedUsd).toBeCloseTo(-2);
    expect(summary.live.lostCount).toBe(1);
  });

  it("scores a partially-filled sim win by its real cost, not the requested amount", () => {
    // Only ~$0.69 of liquidity was fillable under the cap: 0.93 shares at ask 0.74. A WIN must not
    // show as a loss because the requested $10 was never actually staked.
    const pnl = calculateTradePnl({
      ...trade({ won: true, amountUsd: 10, estimatedShares: 0.93 }),
      bestAsk: 0.74,
    });
    expect(pnl.stakeUsd).toBeCloseTo(0.93 * 0.74);
    expect(pnl.payoutUsd).toBeCloseTo(0.93);
    expect(pnl.netUsd).toBeCloseTo(0.93 - 0.93 * 0.74);
    expect(pnl.netUsd).toBeGreaterThan(0);
  });

  it("pays a COMPLETE arb pair its full sets no matter which side won", () => {
    const pair: TradeAttempt = {
      ...trade({ won: false, amountUsd: 24.09, estimatedShares: 30 }), // "lost" per winner flag
      mode: "live",
      kind: "arb",
      arbPairComplete: true,
      fillDetected: true,
      filledAmountUsd: 24.09, // both legs (30 sets at pair cost 0.803)
      filledShares: 30,
      feeUsd: 0.35,
    };
    const pnl = calculateTradePnl(pair);
    expect(pnl.payoutUsd).toBeCloseTo(30); // $1 per set regardless of resolved.won
    expect(pnl.stakeUsd).toBeCloseTo(24.44);
    expect(pnl.netUsd).toBeCloseTo(5.56, 2);
  });

  it("counts a profitable COMPLETE arb pair as WON even when its nominal side lost", () => {
    // El bug que veia el usuario: el dinero salia bien (calculateTradePnl ya trataba el set completo)
    // pero el CONTADOR usaba resolved.won, asi que un arbitraje rentable aparecia como perdido en el
    // dashboard, en el win rate y en Telegram. Un set completo cobra $1/set: nunca es una perdida.
    const arbPair: TradeAttempt = {
      ...trade({ won: false, amountUsd: 25, estimatedShares: 26.88 }),
      kind: "arb",
      arbPairComplete: true,
      filledAmountUsd: 25,
      filledShares: 26.88,
    };
    expect(isWinningTrade(arbPair)).toBe(true);
    expect(isCompleteArbPair(arbPair)).toBe(true);

    const summary = calculatePnlSummary([arbPair]);
    expect(summary.wonCount).toBe(1);
    expect(summary.lostCount).toBe(0);
    expect(summary.realizedUsd).toBeGreaterThan(0); // y el dinero sigue cuadrando
  });

  it("still counts a NAKED arb leg that lost as a loss", () => {
    const naked: TradeAttempt = {
      ...trade({ won: false, amountUsd: 12, estimatedShares: 30 }),
      kind: "arb",
      arbPairComplete: false,
      filledAmountUsd: 12,
      filledShares: 30,
    };
    expect(isWinningTrade(naked)).toBe(false);
    expect(calculatePnlSummary([naked]).lostCount).toBe(1);
  });

  it("scores a NAKED arb leg (pair incomplete) like a normal directional trade", () => {
    const nakedLoss: TradeAttempt = {
      ...trade({ won: false, amountUsd: 12, estimatedShares: 30 }),
      mode: "live",
      kind: "arb",
      arbPairComplete: false,
      fillDetected: true,
      filledAmountUsd: 12,
      filledShares: 30,
      feeUsd: 0.2,
    };
    expect(calculateTradePnl(nakedLoss).netUsd).toBeCloseTo(-12.2);
  });

  it("ignores trades before the P&L reset timestamp for that mode", () => {
    const oldSim = trade({ won: true, amountUsd: 1, estimatedShares: 1.25 });
    oldSim.createdAtMs = 3;
    const newSim = trade({ won: false, amountUsd: 2, estimatedShares: 4 });
    newSim.createdAtMs = 5;
    const oldLive = {
      ...trade({ won: false, amountUsd: 3, estimatedShares: 6 }),
      mode: "live" as const,
      fillDetected: true,
      filledAmountUsd: 3,
      filledShares: 6,
      createdAtMs: 3,
    };

    const summary = calculatePnlSummaryByMode([oldSim, newSim, oldLive], { sim: 4 });

    expect(summary.sim.realizedUsd).toBeCloseTo(-2);
    expect(summary.sim.lostCount).toBe(1);
    expect(summary.live.realizedUsd).toBeCloseTo(-3);
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

describe("el coste es lo que se paga, no el mejor ask", () => {
  // Libro: $2 a 0,60 y $8 a 0,70. Importe $10.
  //   participaciones = 2/0,60 + 8/0,70 = 14,7619   (la caminata por el libro, que ya se hacia bien)
  //   precio medio    = 10 / 14,7619   = 0,67742
  // El coste apuntado era 14,7619 x 0,60 = $8,86: se compraba profundidad y se pagaba la superficie.
  const PARTICIPACIONES = 2 / 0.6 + 8 / 0.7;
  const libro = (won: boolean): TradeAttempt => ({
    ...trade({ won, amountUsd: 10, estimatedShares: PARTICIPACIONES }),
    bestAsk: 0.6,
    estimatedAveragePrice: 10 / PARTICIPACIONES,
  });

  it("cobra los $10 que se pagan, no los $8,86 del mejor ask", () => {
    const perdida = calculateTradePnl(libro(false));
    // Perder cuesta el importe entero.
    expect(perdida.netUsd).toBeCloseTo(-10, 2);
  });

  it("el ROI de una ganadora sale del precio medio, no del mejor ask", () => {
    const ganada = calculateTradePnl(libro(true));
    // Pagas $10, recibes 14,7619 -> +$4,76 (ROI 47,6%), no +$5,90 (ROI 66,6%).
    expect(ganada.payoutUsd).toBeCloseTo(PARTICIPACIONES, 3);
    expect(ganada.netUsd).toBeCloseTo(PARTICIPACIONES - 10, 2);
  });
});

describe("la simulacion tambien paga comision", () => {
  it("una direccional simulada a 0,50 paga comision, no cero", () => {
    // El comentario de `getFeeUsd` ya afirmaba que se cobra en AMBOS modos. No era cierto para el
    // direccional: 574 operaciones simuladas no pagaron un centimo, y la comision es MAXIMA en 0,50.
    const t: TradeAttempt = {
      ...trade({ won: true, amountUsd: 10, estimatedShares: 20 }),
      // `asset` hace falta: la tarifa sale de el, y sin el `defaultTakerFeeRateBps` devuelve 0.
      asset: "BTC",
      bestAsk: 0.5,
      estimatedAveragePrice: 0.5,
    };
    const conComision = calculateTradePnl(t);
    // 20 participaciones a 0,50 con 700 bps: 20 x 0,07 x 0,5 x 0,5 = $0,35.
    expect(conComision.netUsd).toBeCloseTo(20 - 10 - 0.35, 4);
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
    // Ask implied by a full fill of the requested amount into the estimated shares.
    bestAsk: args.amountUsd / args.estimatedShares,
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

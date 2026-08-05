import { describe, expect, it } from "vitest";

import { resolveSampleTruth, scoringOutcome } from "../src/analyticsTruth.js";
import type { AnalyticsQuotePoint, AnalyticsSample, Outcome } from "../src/types.js";

/**
 * Estas pruebas fijan la leccion mas cara de este bot: `sample.winningOutcome` lo calcula el propio
 * bot contra SU tick de apertura (capturado con segundos de desfase), asi que se equivoca ~12.5% de
 * las veces Y se equivoca junto con la señal. Puntuar con el produce backtests que se auto-confirman.
 */
describe("analyticsTruth", () => {
  it("lee el ganador del libro al cierre, no del campo winningOutcome", () => {
    const truth = resolveSampleTruth(sample({ closing: { up: 0.99, down: 0.01 }, winningOutcome: "DOWN" }));
    expect(truth?.outcome).toBe("UP");
    expect(truth?.confidence).toBeCloseTo(0.98, 2);
  });

  it("NO cae de vuelta a winningOutcome cuando el libro no es concluyente", () => {
    // Es la propiedad critica: una muestra dudosa se descarta. Si aqui devolviera "UP", el sesgo
    // correlacionado volveria a entrar al modelo y el gate reaprenderia a comprar barato lo que pierde.
    const undecided = sample({ closing: { up: 0.55, down: 0.45 }, winningOutcome: "UP" });
    expect(resolveSampleTruth(undecided)).toBeUndefined();
    expect(scoringOutcome(undecided)).toBeUndefined();
  });

  it("descarta la muestra si no hay quotes cerca del cierre", () => {
    const noClose = sample({ closing: { up: 0.99, down: 0.01 }, winningOutcome: "UP" });
    expect(scoringOutcome({ ...noClose, quotes: [] })).toBeUndefined();
  });

  it("deduce el ganador con un solo lado cotizado (el par es complementario)", () => {
    const onlyDown = sample({ closing: { down: 0.99 }, winningOutcome: "UP" });
    expect(scoringOutcome(onlyDown)).toBe("DOWN");
  });

  it("ignora quotes anteriores al tramo final aunque sean decisivas", () => {
    const early: AnalyticsQuotePoint = {
      timestampMs: 0,
      secondsToEnd: 120,
      upBestAsk: 0.99,
      upBestBid: 0.99,
      downBestAsk: 0.01,
      downBestBid: 0.01,
    };
    const s = sample({ closing: { up: 0.55, down: 0.45 }, winningOutcome: "UP" });
    expect(scoringOutcome({ ...s, quotes: [early, ...s.quotes] })).toBeUndefined();
  });
});

function sample(args: {
  closing: { up?: number; down?: number };
  winningOutcome: Outcome;
}): AnalyticsSample {
  const endMs = 1_000_000;
  return {
    version: 1,
    market: "ETH",
    slug: "eth-updown-5m-truth",
    windowStartMs: endMs - 300_000,
    endMs,
    openingPrice: 100,
    openingTickTimestampMs: endMs - 300_000,
    ticks: [{ timestampMs: endMs - 20_000, secondsToEnd: 20, price: 101, distanceUsd: 1 }],
    quotes: [
      {
        timestampMs: endMs - 2_000,
        secondsToEnd: 2,
        upBestAsk: args.closing.up,
        upBestBid: args.closing.up,
        downBestAsk: args.closing.down,
        downBestBid: args.closing.down,
      },
    ],
    finalPrice: 101,
    finalTickTimestampMs: endMs,
    winningOutcome: args.winningOutcome,
    resolvedAtMs: endMs,
  };
}

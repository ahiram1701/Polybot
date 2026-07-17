import { describe, expect, it } from "vitest";

import type { AskBandRow, AskBandSummary } from "../src/askBands.js";
import { recommendAskCap } from "../src/askCapTuner.js";

function band(lo: number, hi: number, trades: number, winRate: number): AskBandRow {
  return {
    lo,
    hi,
    trades,
    wins: Math.round(trades * winRate),
    winRate,
    // Break-even = ask medio de la banda: usa el punto medio.
    breakEvenRate: (lo + hi) / 2,
    netUsd: 0,
  };
}

function summary(bands: AskBandRow[]): AskBandSummary {
  return { mode: "live", totalTrades: bands.reduce((sum, row) => sum + row.trades, 0), bands };
}

describe("askCapTuner", () => {
  it("returns nothing without enough total trades", () => {
    expect(recommendAskCap(summary([band(0.45, 0.55, 30, 0.8)]), 0.65)).toBeUndefined();
  });

  it("extends the cap while sampled bands beat break-even and stops at the first that does not", () => {
    const bands = summary([
      band(0, 0.45, 25, 0.4), // be 0.225, edge +17pp -> paga
      band(0.45, 0.55, 30, 0.62), // be 0.5, edge +12pp -> paga
      band(0.55, 0.65, 30, 0.65), // be 0.6, edge +5pp -> paga
      band(0.65, 0.7, 25, 0.6), // be 0.675, edge -7pp -> CORTA aqui
      band(0.7, 0.75, 25, 0.9), // rentable pero inalcanzable tras el corte
    ]);
    const reco = recommendAskCap(bands, 0.55);
    expect(reco?.targetCap).toBe(0.65);
    expect(reco?.nextCap).toBe(0.6); // paso maximo 0.05 por aplicacion
  });

  it("ignores thin bands (no evidence) without breaking the chain", () => {
    const bands = summary([
      band(0.45, 0.55, 40, 0.62),
      band(0.55, 0.65, 5, 0.1), // n<20: ni extiende ni corta
      band(0.65, 0.7, 40, 0.75), // be 0.675, edge +7.5pp -> extiende
    ]);
    const reco = recommendAskCap(bands, 0.55);
    expect(reco?.targetCap).toBe(0.7);
  });

  it("lowers the cap when nothing above the floor pays, one step at a time", () => {
    const bands = summary([band(0.45, 0.55, 40, 0.45), band(0.55, 0.65, 40, 0.5)]); // ambas pierden
    const reco = recommendAskCap(bands, 0.65);
    expect(reco?.targetCap).toBe(0.45); // piso
    expect(reco?.nextCap).toBe(0.6); // baja de a 0.05
  });

  it("clamps the target to the ceiling and reports no-op when already there", () => {
    const bands = summary([
      band(0.45, 0.55, 40, 0.7),
      band(0.55, 0.65, 40, 0.75),
      band(0.65, 0.7, 40, 0.78),
      band(0.7, 0.75, 40, 0.82),
      band(0.75, 0.8, 40, 0.85),
      band(0.8, 1, 40, 0.99),
    ]);
    const reco = recommendAskCap(bands, 0.85);
    expect(reco).toBeUndefined(); // target = techo 0.85 = actual -> nada que hacer
  });
});

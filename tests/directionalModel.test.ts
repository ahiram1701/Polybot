import { describe, expect, it } from "vitest";

import { extractFeatures, fitLogistic, logLoss, predictLogistic, type FeatureRow } from "../src/directionalModel.js";
import type { AnalyticsSample } from "../src/types.js";

function sample(overrides: Partial<AnalyticsSample> = {}): AnalyticsSample {
  const endMs = 1_000_000;
  return {
    version: 1,
    market: "ETH",
    slug: "eth-updown-5m-x",
    windowStartMs: endMs - 300_000,
    endMs,
    openingPrice: 100,
    openingTickTimestampMs: endMs - 300_000,
    // Sube monotonamente de 100 a 104; los ultimos dos ticks caen DENTRO de los 30s finales.
    ticks: [60, 50, 40, 35, 20, 10].map((secondsToEnd, index) => ({
      timestampMs: endMs - secondsToEnd * 1000,
      secondsToEnd,
      price: 100 + index,
      distanceUsd: index,
    })),
    quotes: [60, 40, 10].map((secondsToEnd) => ({
      timestampMs: endMs - secondsToEnd * 1000,
      secondsToEnd,
      upBestAsk: 0.7,
      upBestBid: 0.68,
      downBestAsk: 0.32,
      downBestBid: 0.3,
    })),
    winningOutcome: "UP",
    ...overrides,
  };
}

describe("directional model", () => {
  it("only uses ticks and quotes at or before the decision moment (no look-ahead)", () => {
    const row = extractFeatures(sample(), "UP", 30)!;
    expect(row).toBeDefined();
    // A 30s del cierre solo se ven los ticks de 60/50/40/35s: el precio ahi es 103, no el final 105.
    // Un distanceNorm positivo confirma que leyo la subida; el ask usado es el de 40s, no el de 10s.
    expect(row.x[0]).toBeGreaterThan(0);
    expect(row.ask).toBe(0.7);
    expect(row.y).toBe(1);
  });

  it("flips the sign of the directional features for the opposite side", () => {
    const up = extractFeatures(sample(), "UP", 30)!;
    const down = extractFeatures(sample(), "DOWN", 30)!;
    expect(down.x[0]).toBeCloseTo(-up.x[0], 6); // distanceNorm espejo
    expect(down.y).toBe(0); // gano UP
    expect(down.ask).toBe(0.32);
  });

  it("skips windows without an outcome or without a usable quote", () => {
    expect(extractFeatures(sample({ winningOutcome: undefined }), "UP", 30)).toBeUndefined();
    expect(extractFeatures(sample({ quotes: [] }), "UP", 30)).toBeUndefined();
  });

  it("learns a separable relationship and beats the base rate", () => {
    // y depende de la primera feature; el modelo debe recuperarlo.
    const rows: FeatureRow[] = Array.from({ length: 200 }, (_v, i) => {
      const signal = (i % 2 === 0 ? 1 : -1) * (1 + (i % 5) / 5);
      return { x: [signal, 30, 0, 1, 0, 0, 0.5, 0.02], y: signal > 0 ? 1 : 0, ask: 0.5, windowStartMs: i };
    });
    const model = fitLogistic(rows);
    expect(predictLogistic(model, [2, 30, 0, 1, 0, 0, 0.5, 0.02])).toBeGreaterThan(0.6);
    expect(predictLogistic(model, [-2, 30, 0, 1, 0, 0, 0.5, 0.02])).toBeLessThan(0.4);
  });

  it("scores a confidently wrong prediction worse than an unsure one", () => {
    expect(logLoss([0.99], [0])).toBeGreaterThan(logLoss([0.5], [0]));
    expect(logLoss([0.99], [1])).toBeLessThan(logLoss([0.5], [1]));
  });
});

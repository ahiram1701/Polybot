import { describe, expect, it } from "vitest";

import {
  calculateAdjustedWinProbability,
  calculateExpectedValue,
  calculateRealWinProbability,
  DEFAULT_MIN_EXPECTED_ROI,
  DEFAULT_SAFETY_MARGIN,
  getAskGuidance,
} from "../src/expectedValue.js";
import { buildCalibrationMap } from "../src/calibration.js";

describe("expected value formulas", () => {
  it("calculates real and adjusted win probability", () => {
    expect(calculateRealWinProbability(7, 10)).toBeCloseTo(0.7);
    expect(calculateAdjustedWinProbability(7, 10)).toBeCloseTo(8 / 12);
    expect(calculateRealWinProbability(0, 0)).toBeUndefined();
    expect(calculateAdjustedWinProbability(0, 0)).toBeCloseTo(0.5);
  });

  it("shrinks harder toward the prior as priorStrength grows", () => {
    // 7/10 wins with the ask (0.6) as prior. Strength 2 (default) barely moves it; strength 8 pulls the
    // estimate much closer to the market-implied 0.6, i.e. is more skeptical of the thin sample.
    const weak = calculateAdjustedWinProbability(7, 10, 0.6, 2);
    const strong = calculateAdjustedWinProbability(7, 10, 0.6, 8);
    expect(weak).toBeCloseTo((7 + 2 * 0.6) / (10 + 2));
    expect(strong).toBeCloseTo((7 + 8 * 0.6) / (10 + 8));
    expect(strong).toBeLessThan(weak);
    // A non-positive strength falls back to the default (2), matching the 3-arg call.
    expect(calculateAdjustedWinProbability(7, 10, 0.6, 0)).toBeCloseTo(calculateAdjustedWinProbability(7, 10, 0.6));
  });

  it("calculates EV, ROI, edge, payout, loss, and break-even", () => {
    const result = calculateExpectedValue({
      capitalUsd: 10,
      askPrice: 0.8,
      winCount: 8,
      tradeCount: 10,
    });

    // Prior anchored to the market (ask 0.8): adjusted = (8 + 2*0.8) / (10 + 2) = 0.8, so a setup that
    // exactly matches the market price shows zero edge.
    expect(result.realWinProbability).toBeCloseTo(0.8);
    expect(result.adjustedWinProbability).toBeCloseTo(0.8);
    expect(result.edge).toBeCloseTo(0);
    expect(result.expectedRoi).toBeCloseTo(0);
    expect(result.expectedValueUsd).toBeCloseTo(0);
    expect(result.winProfitUsd).toBeCloseTo(10 * (1 / 0.8 - 1));
    expect(result.lossUsd).toBe(-10);
    expect(result.breakEvenProbability).toBe(0.8);
    expect(result.safetyMargin).toBe(DEFAULT_SAFETY_MARGIN);
    expect(result.minExpectedRoi).toBe(DEFAULT_MIN_EXPECTED_ROI);
  });

  it("requires both safety margin and one-percent EV for recommended entry", () => {
    const pass = calculateExpectedValue({ capitalUsd: 5, askPrice: 0.7, winCount: 9, tradeCount: 10 });
    expect(pass.passesBasicEntry).toBe(true);
    expect(pass.passesSafetyMargin).toBe(true);
    expect(pass.passesExpectedValue).toBe(true);
    expect(pass.passesRecommendedEntry).toBe(true);
    expect(pass.decisionReason).toBe("passes");

    const failMargin = calculateExpectedValue({ capitalUsd: 5, askPrice: 0.8, winCount: 8, tradeCount: 10 });
    expect(failMargin.passesSafetyMargin).toBe(false);
    expect(failMargin.passesRecommendedEntry).toBe(false);
    expect(failMargin.decisionReason).toBe("safety_margin");
  });

  it("exposes the RAW probability separately from the calibrated one", () => {
    // Entrenar el mapa con la probabilidad ya calibrada lo hacia perseguir un blanco que el propio
    // mapa movia: solo veia el error residual y se quedaba corto para siempre (quitaba ~9pp de ~26pp).
    // Guardar la cruda es lo que permite entrenar sobre el error COMPLETO.
    const map = buildCalibrationMap(
      Array.from({ length: 60 }, (_v, i) => ({ predicted: 0.7, won: i < 24 })), // predice 70%, gana 40%
    );
    const result = calculateExpectedValue({ capitalUsd: 5, askPrice: 0.5, winCount: 12, tradeCount: 15, calibration: map });
    expect(result.rawWinProbability).toBeCloseTo((12 + 2 * 0.5) / (15 + 2), 5);
    expect(result.adjustedWinProbability).toBeLessThan(result.rawWinProbability); // el mapa corrige a la baja
  });

  it("rejects a trade whose claimed edge over the market is implausible", () => {
    // El bucket edge>0.20 del ledger realizo -17.6pp de discriminacion y -21.8pp de sesgo. Recortar la
    // probabilidad no servia (el trade pasaba igual); hay que RECHAZARLO. Walk-forward: +$28 -> +$135.
    const wild = { capitalUsd: 5, askPrice: 0.4, winCount: 19, tradeCount: 20 };
    const uncapped = calculateExpectedValue(wild);
    expect(uncapped.edge).toBeGreaterThan(0.4); // el historial fino declara una ventaja enorme
    expect(uncapped.passesRecommendedEntry).toBe(true); // sin techo, entraba

    const rejected = calculateExpectedValue({ ...wild, maxClaimedEdge: 0.2 });
    expect(rejected.passesRecommendedEntry).toBe(false);
    expect(rejected.decisionReason).toBe("implausible_edge");
    // La probabilidad NO se toca: el techo decide, no falsea la estimacion.
    expect(rejected.adjustedWinProbability).toBeCloseTo(uncapped.adjustedWinProbability, 5);

    // Un edge modesto y creible pasa intacto: el techo solo corta lo implausible.
    const modest = calculateExpectedValue({ capitalUsd: 5, askPrice: 0.5, winCount: 11, tradeCount: 20, maxClaimedEdge: 0.2 });
    expect(modest.passesRecommendedEntry).toBe(true);
  });

  it("marks 0.98 and 0.99 asks as avoid prices", () => {
    expect(getAskGuidance(0.85)).toBe("preferred");
    expect(getAskGuidance(0.98)).toBe("avoid_098");
    expect(getAskGuidance(0.99)).toBe("avoid_099");

    const result = calculateExpectedValue({ capitalUsd: 1, askPrice: 0.99, winCount: 20, tradeCount: 20 });
    expect(result.askGuidance).toBe("avoid_099");
    expect(result.passesRecommendedEntry).toBe(false);
    expect(result.decisionReason).toBe("avoid_099");
  });
});

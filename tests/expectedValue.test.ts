import { describe, expect, it } from "vitest";

import {
  calculateAdjustedWinProbability,
  calculateExpectedValue,
  calculateRealWinProbability,
  DEFAULT_MIN_EXPECTED_ROI,
  DEFAULT_SAFETY_MARGIN,
  getAskGuidance,
} from "../src/expectedValue.js";

describe("expected value formulas", () => {
  it("calculates real and adjusted win probability", () => {
    expect(calculateRealWinProbability(7, 10)).toBeCloseTo(0.7);
    expect(calculateAdjustedWinProbability(7, 10)).toBeCloseTo(8 / 12);
    expect(calculateRealWinProbability(0, 0)).toBeUndefined();
    expect(calculateAdjustedWinProbability(0, 0)).toBeCloseTo(0.5);
  });

  it("calculates EV, ROI, edge, payout, loss, and break-even", () => {
    const result = calculateExpectedValue({
      capitalUsd: 10,
      askPrice: 0.8,
      winCount: 8,
      tradeCount: 10,
    });

    expect(result.realWinProbability).toBeCloseTo(0.8);
    expect(result.adjustedWinProbability).toBeCloseTo(9 / 12);
    expect(result.edge).toBeCloseTo(9 / 12 - 0.8);
    expect(result.expectedRoi).toBeCloseTo(9 / 12 / 0.8 - 1);
    expect(result.expectedValueUsd).toBeCloseTo(10 * (9 / 12 / 0.8 - 1));
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

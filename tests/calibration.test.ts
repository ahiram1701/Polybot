import { describe, expect, it } from "vitest";

import { applyCalibration, buildCalibrationMap, type CalibrationSample } from "../src/calibration.js";

function samples(predicted: number, count: number, winRate: number): CalibrationSample[] {
  const wins = Math.round(count * winRate);
  return Array.from({ length: count }, (_v, i) => ({ predicted, won: i < wins }));
}

describe("calibration", () => {
  it("is a near no-op with thin data (shrinkage toward identity)", () => {
    const map = buildCalibrationMap(samples(0.85, 4, 0));
    expect(applyCalibration(map, 0.85)).toBeGreaterThan(0.7); // 4 losses barely move it
  });

  it("corrects measured overconfidence with enough data", () => {
    // Model says 85% but reality delivered 50% over 200 trades.
    const map = buildCalibrationMap(samples(0.85, 200, 0.5));
    const corrected = applyCalibration(map, 0.85);
    expect(corrected).toBeLessThan(0.62);
    expect(corrected).toBeGreaterThan(0.45);
  });

  it("enforces monotonicity across noisy bins", () => {
    const map = buildCalibrationMap([
      ...samples(0.55, 100, 0.75), // lucky low bin
      ...samples(0.75, 100, 0.55), // unlucky high bin -> inversion without PAVA
    ]);
    for (let i = 1; i < map.knots.length; i += 1) {
      expect(map.knots[i].calibrated).toBeGreaterThanOrEqual(map.knots[i - 1].calibrated);
    }
    expect(applyCalibration(map, 0.75)).toBeGreaterThanOrEqual(applyCalibration(map, 0.55));
  });

  it("interpolates between knots and extends the edge delta outside", () => {
    const map = buildCalibrationMap([...samples(0.6, 100, 0.5), ...samples(0.8, 100, 0.6)]);
    const mid = applyCalibration(map, 0.7);
    expect(mid).toBeGreaterThan(applyCalibration(map, 0.6));
    expect(mid).toBeLessThan(applyCalibration(map, 0.8));
    // Outside the range, the correction persists instead of vanishing.
    expect(applyCalibration(map, 0.9)).toBeLessThan(0.9);
  });

  it("passes through untouched without a map", () => {
    expect(applyCalibration(undefined, 0.7)).toBe(0.7);
    expect(applyCalibration(buildCalibrationMap([]), 0.7)).toBe(0.7);
  });
});

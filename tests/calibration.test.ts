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

  it("interpola entre knots y desvanece la correccion fuera del rango con evidencia", () => {
    const map = buildCalibrationMap([...samples(0.6, 100, 0.5), ...samples(0.8, 100, 0.6)]);
    const mid = applyCalibration(map, 0.7);
    expect(mid).toBeGreaterThan(applyCalibration(map, 0.6));
    expect(mid).toBeLessThan(applyCalibration(map, 0.8));

    // Justo al salir del rango la correccion sigue casi entera: el mapa es continuo.
    const justOutside = applyCalibration(map, 0.81);
    expect(justOutside).toBeLessThan(0.81);

    // Pero se apaga al alejarse. El mapa se entrena SOLO con trades ejecutados, asi que fuera de esa
    // franja no hay evidencia; aplicar alli el delta del borde entero era extrapolar un sesgo de ~17pp
    // sobre una zona sin datos, y hacia al gate rechazar entradas buenas.
    expect(applyCalibration(map, 0.95)).toBeCloseTo(0.95, 6);
  });

  it("passes through untouched without a map", () => {
    expect(applyCalibration(undefined, 0.7)).toBe(0.7);
    expect(applyCalibration(buildCalibrationMap([]), 0.7)).toBe(0.7);
  });
});

/**
 * El mapa se entrena SOLO con los trades que el gate acepto, asi que su evidencia vive en una franja
 * estrecha y alta de predicciones. Esta guarda evita que esa evidencia parcial se convierta en
 * una correccion global — que es como la calibracion pasaba de corregir a destruir.
 */
describe("calibration: no extrapolar mas alla de la evidencia", () => {
  it("no aplica el delta del borde a predicciones lejanas sin datos", () => {
    // Evidencia solo en 0.60-0.80, con sobreconfianza fuerte.
    const map = buildCalibrationMap([...samples(0.6, 200, 0.45), ...samples(0.8, 200, 0.6)]);
    const dentro = applyCalibration(map, 0.8);
    expect(dentro).toBeLessThan(0.75); // ahi si corrige

    // A 0.99 no hay ni un dato: antes se le restaba el mismo delta (~-17pp) que en el borde.
    expect(applyCalibration(map, 0.99)).toBeCloseTo(0.99, 6);
    // Y por abajo igual.
    expect(applyCalibration(map, 0.2)).toBeCloseTo(0.2, 6);
  });

  it("sigue corrigiendo cuando la evidencia cubre varios niveles", () => {
    const map = buildCalibrationMap([
      ...samples(0.55, 150, 0.45),
      ...samples(0.7, 150, 0.55),
      ...samples(0.85, 150, 0.62),
    ]);
    expect(applyCalibration(map, 0.85)).toBeLessThan(0.8);
    expect(applyCalibration(map, 0.55)).toBeLessThan(0.55);
  });
});

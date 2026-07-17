/**
 * Empirical probability calibration: maps the model's PREDICTED win probability to the win rate it
 * actually REALIZED at that confidence level. Attacks the measured overconfidence (predicted 0.7-0.9
 * setups winning far less out-of-sample).
 *
 * The map is built from (predicted, won) pairs — at runtime from the ledger's own resolved trades
 * (`expectedValue.adjustedWinProbability` vs `resolved.won`), in backtests from walk-forward
 * predictions strictly prior to each point (no look-ahead). Thin bins shrink toward the identity, so
 * with little data the calibration is a no-op instead of noise.
 */

export interface CalibrationSample {
  predicted: number;
  won: boolean;
}

export interface CalibrationKnot {
  /** Mean predicted probability of the bin (x). */
  predicted: number;
  /** Calibrated probability for that prediction level (y). */
  calibrated: number;
  count: number;
}

export interface CalibrationMap {
  knots: CalibrationKnot[];
  sampleCount: number;
}

const BIN_COUNT = 10;
/** Pseudo-count pulling each bin toward the identity: n=25 data points move it halfway. */
const SHRINK_K = 25;
const MIN_BIN_SAMPLES = 3;

export function buildCalibrationMap(samples: CalibrationSample[]): CalibrationMap {
  const valid = samples.filter((sample) => Number.isFinite(sample.predicted) && sample.predicted > 0 && sample.predicted < 1);
  const bins: { sumPredicted: number; wins: number; count: number }[] = Array.from({ length: BIN_COUNT }, () => ({
    sumPredicted: 0,
    wins: 0,
    count: 0,
  }));
  for (const sample of valid) {
    const index = Math.min(BIN_COUNT - 1, Math.floor(sample.predicted * BIN_COUNT));
    bins[index].sumPredicted += sample.predicted;
    bins[index].wins += sample.won ? 1 : 0;
    bins[index].count += 1;
  }

  const knots: CalibrationKnot[] = [];
  for (const bin of bins) {
    if (bin.count < MIN_BIN_SAMPLES) {
      continue;
    }
    const meanPredicted = bin.sumPredicted / bin.count;
    const realized = bin.wins / bin.count;
    // Shrink toward identity: with few samples the knot stays at y≈x.
    const calibrated = (bin.count * realized + SHRINK_K * meanPredicted) / (bin.count + SHRINK_K);
    knots.push({ predicted: meanPredicted, calibrated, count: bin.count });
  }

  // Monotonicity (pool adjacent violators, weighted by count): a higher prediction must never map to a
  // lower calibrated probability — noise between neighbouring bins would otherwise create inversions.
  for (let i = 1; i < knots.length; ) {
    if (knots[i].calibrated >= knots[i - 1].calibrated) {
      i += 1;
      continue;
    }
    const left = knots[i - 1];
    const right = knots[i];
    const pooled = (left.calibrated * left.count + right.calibrated * right.count) / (left.count + right.count);
    const merged: CalibrationKnot = {
      predicted: (left.predicted * left.count + right.predicted * right.count) / (left.count + right.count),
      calibrated: pooled,
      count: left.count + right.count,
    };
    knots.splice(i - 1, 2, merged);
    i = Math.max(1, i - 1);
  }

  return { knots, sampleCount: valid.length };
}

/** Piecewise-linear interpolation over the knots; outside the covered range the edge delta applies. */
export function applyCalibration(map: CalibrationMap | undefined, predicted: number): number {
  if (!map || map.knots.length === 0 || !Number.isFinite(predicted)) {
    return predicted;
  }
  const knots = map.knots;
  const clampProb = (value: number) => Math.min(Math.max(value, 0.02), 0.98);

  if (predicted <= knots[0].predicted) {
    return clampProb(predicted + (knots[0].calibrated - knots[0].predicted));
  }
  const last = knots[knots.length - 1];
  if (predicted >= last.predicted) {
    return clampProb(predicted + (last.calibrated - last.predicted));
  }
  for (let i = 1; i < knots.length; i += 1) {
    if (predicted <= knots[i].predicted) {
      const left = knots[i - 1];
      const right = knots[i];
      const t = (predicted - left.predicted) / (right.predicted - left.predicted);
      return clampProb(left.calibrated + t * (right.calibrated - left.calibrated));
    }
  }
  return clampProb(predicted);
}

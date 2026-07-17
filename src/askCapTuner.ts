import type { AskBandSummary } from "./askBands.js";

/**
 * Ask-cap auto-tuner: derives the per-market ask ceiling from REALIZED live band performance (the same
 * table the user reads when tuning by hand). The cap becomes the upper edge of the last contiguous
 * band, from the cheapest up, whose realized win rate beats its break-even by a margin — i.e. "allow
 * asks only while paying that price has actually been profitable".
 *
 * Locks (all pre-committed):
 *  - a band only counts with >= MIN_BAND_TRADES resolved trades; the market needs >= MIN_TOTAL_TRADES;
 *  - the recommended cap is clamped to [CAP_FLOOR, CAP_CEILING];
 *  - each application moves the current cap at most MAX_STEP toward the recommendation;
 *  - callers must respect COOLDOWN_MS between applications per market (tracked by the caller).
 */

export const ASK_CAP_TUNER_LOCKS = {
  MIN_BAND_TRADES: 20,
  MIN_TOTAL_TRADES: 60,
  EDGE_MARGIN: 0.03,
  CAP_FLOOR: 0.45,
  CAP_CEILING: 0.85,
  MAX_STEP: 0.05,
  COOLDOWN_MS: 24 * 60 * 60 * 1000,
} as const;

export interface AskCapRecommendation {
  /** Cap the bands justify (already clamped to [floor, ceiling]). */
  targetCap: number;
  /** What to apply NOW: current cap moved at most MAX_STEP toward the target. */
  nextCap: number;
  reason: string;
}

export function recommendAskCap(bands: AskBandSummary, currentCap: number): AskCapRecommendation | undefined {
  const locks = ASK_CAP_TUNER_LOCKS;
  if (bands.totalTrades < locks.MIN_TOTAL_TRADES) {
    return undefined;
  }

  // Walk bands from the cheapest up; the cap extends while each SUFFICIENTLY SAMPLED band keeps beating
  // its break-even. Thin bands neither extend nor break the chain (no evidence either way).
  let targetCap: number = locks.CAP_FLOOR;
  const supporting: string[] = [];
  for (const band of bands.bands) {
    if (band.lo >= locks.CAP_CEILING) {
      break;
    }
    if (band.trades < locks.MIN_BAND_TRADES) {
      continue;
    }
    const edge = (band.winRate ?? 0) - (band.breakEvenRate ?? 1);
    if (edge >= locks.EDGE_MARGIN) {
      targetCap = Math.max(targetCap, Math.min(band.hi, locks.CAP_CEILING));
      supporting.push(`${band.lo.toFixed(2)}-${band.hi.toFixed(2)} edge +${(edge * 100).toFixed(0)}pp (n=${band.trades})`);
    } else if (band.lo >= targetCap) {
      // The first sufficiently-sampled band at/above the current frontier that does NOT pay stops the walk.
      break;
    }
  }

  const clampedTarget = Math.min(Math.max(targetCap, locks.CAP_FLOOR), locks.CAP_CEILING);
  if (Math.abs(clampedTarget - currentCap) < 0.005) {
    return undefined;
  }
  const step = Math.min(Math.abs(clampedTarget - currentCap), locks.MAX_STEP);
  const nextCap = Number((currentCap + Math.sign(clampedTarget - currentCap) * step).toFixed(2));
  return {
    targetCap: Number(clampedTarget.toFixed(2)),
    nextCap,
    reason:
      supporting.length > 0
        ? `Bandas rentables: ${supporting.join("; ")}`
        : `Ninguna banda con n>=${locks.MIN_BAND_TRADES} paga su break-even + ${locks.EDGE_MARGIN * 100}pp`,
  };
}

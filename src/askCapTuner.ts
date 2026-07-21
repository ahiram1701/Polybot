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
  // Window tuner: the whole tradeable range, not just the ceiling.
  WINDOW_MIN: 0.2,
  WINDOW_MAX: 0.85,
  // A window narrower than this is refused: strangling itself to zero is exactly how the cap-only
  // tuner lost money in replay (it kept targeting 0.45 and cut the profitable part away).
  MIN_WINDOW_WIDTH: 0.15,
} as const;

export interface AskCapRecommendation {
  /** Cap the bands justify (already clamped to [floor, ceiling]). */
  targetCap: number;
  /** What to apply NOW: current cap moved at most MAX_STEP toward the target. */
  nextCap: number;
  reason: string;
}

export interface AskWindowRecommendation {
  /** Window the bands justify (already clamped). */
  targetFloor: number;
  targetCap: number;
  /** What to apply NOW: each edge moved at most MAX_STEP toward its target. */
  nextFloor: number;
  nextCap: number;
  reason: string;
}

/**
 * Full-window version: moves BOTH edges. The cap-only tuner could not exclude a losing cheap tail —
 * its only lever was tightening the ceiling, so it cut the profitable middle instead (measured
 * -$18 vs a fixed cap). Here the floor rises past leading losing bands and the cap stops at the last
 * contiguous paying band.
 */
export function recommendAskWindow(
  bands: AskBandSummary,
  current: { floor: number; cap: number },
): AskWindowRecommendation | undefined {
  const locks = ASK_CAP_TUNER_LOCKS;
  if (bands.totalTrades < locks.MIN_TOTAL_TRADES) {
    return undefined;
  }

  const pays = (band: AskBandSummary["bands"][number]) =>
    band.trades >= locks.MIN_BAND_TRADES && (band.winRate ?? 0) - (band.breakEvenRate ?? 1) >= locks.EDGE_MARGIN;

  // Walk cheap -> expensive. The first paying band opens the window; the run ends at the first
  // sufficiently-sampled band that does NOT pay. Thin bands neither open, extend nor close it.
  let targetFloor: number | undefined;
  let targetCap: number | undefined;
  const supporting: string[] = [];
  for (const band of bands.bands) {
    if (band.trades < locks.MIN_BAND_TRADES) {
      continue;
    }
    if (pays(band)) {
      if (targetFloor === undefined) {
        targetFloor = band.lo;
      }
      targetCap = band.hi;
      supporting.push(
        `${band.lo.toFixed(2)}-${band.hi.toFixed(2)} +${(((band.winRate ?? 0) - (band.breakEvenRate ?? 1)) * 100).toFixed(0)}pp (n=${band.trades})`,
      );
    } else if (targetFloor !== undefined) {
      break; // la racha rentable terminó
    }
  }

  if (targetFloor === undefined || targetCap === undefined) {
    return undefined; // ninguna banda con muestra suficiente paga: no hay evidencia para mover nada
  }
  const clampedFloor = Math.min(Math.max(targetFloor, locks.WINDOW_MIN), locks.WINDOW_MAX);
  const clampedCap = Math.min(Math.max(targetCap, locks.WINDOW_MIN), locks.WINDOW_MAX);
  if (clampedCap - clampedFloor < locks.MIN_WINDOW_WIDTH) {
    return undefined;
  }
  if (Math.abs(clampedFloor - current.floor) < 0.005 && Math.abs(clampedCap - current.cap) < 0.005) {
    return undefined;
  }
  return {
    targetFloor: round2(clampedFloor),
    targetCap: round2(clampedCap),
    nextFloor: stepToward(current.floor, clampedFloor, locks.MAX_STEP),
    nextCap: stepToward(current.cap, clampedCap, locks.MAX_STEP),
    reason: `Bandas rentables: ${supporting.join("; ")}`,
  };
}

function stepToward(from: number, to: number, maxStep: number): number {
  const delta = to - from;
  const step = Math.min(Math.abs(delta), maxStep) * Math.sign(delta);
  return round2(from + step);
}

function round2(value: number): number {
  return Number(value.toFixed(2));
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

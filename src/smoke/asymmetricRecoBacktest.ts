import { join } from "node:path";

import { readAnalyticsSamples } from "../analyticsRecorder.js";
import { loadConfig } from "../config.js";
import { getMinDistanceUsd, SUPPORTED_MARKETS } from "../markets.js";
import { buildCandidate, buildCandidateGrid, selectBestCandidate } from "../recommendationEngine.js";
import type { AnalyticsSample, MarketSymbol, Outcome, RecommendationCandidate } from "../types.js";

/**
 * Walk-forward comparison: SYMMETRIC selector (current engine: one config per market, both sides mixed)
 * vs ASYMMETRIC selector (independent config per market/side). Chronological blocks per market; at each
 * cut the selector picks its config using ONLY past samples (same grid + same selectBestCandidate
 * objective as the live engine), then "trades" the next block with the frozen pick. Returns use the
 * engine's own returnRoi (1/ask-1 or -1, fee-free) — identical for both selectors, so the comparison is
 * apples-to-apples. Decides whether per-side auto-adjust is wired in: only if aggregate net$ improves
 * without flipping any market negative.
 *
 * Run: npx tsx src/smoke/asymmetricRecoBacktest.ts
 */
const MAX_SAMPLES_PER_MARKET = 1800; // more history than the live engine cap: better test resolution
const BLOCKS = 6; // first block is training-only; cuts happen at blocks 1..5
const STAKE_USD = 1;

interface Bucket {
  trades: number;
  wins: number;
  net: number;
}

const OUTCOMES: Outcome[] = ["UP", "DOWN"];

async function main(): Promise<void> {
  const { config } = loadConfig(["--mode", "sim"]);
  const maxAsk = 0.85;
  const all = await readAnalyticsSamples(join(config.dataDir, "analytics.jsonl"));

  const totals = { sym: emptyBucket(), asym: emptyBucket() };
  console.log(`Muestras totales: ${all.length} | maxAsk=${maxAsk} | bloques=${BLOCKS}\n`);

  for (const market of SUPPORTED_MARKETS) {
    const samples = all
      .filter((sample) => sample.market === market && sample.winningOutcome)
      .sort((left, right) => left.windowStartMs - right.windowStartMs)
      .slice(-MAX_SAMPLES_PER_MARKET);
    if (samples.length < BLOCKS * 20) {
      console.log(`${market}: insuficientes muestras (${samples.length}), se omite.`);
      continue;
    }

    const floor = config.minDistanceFloorUsdByMarket?.[market] ?? 0;
    const currentDistance = Math.max(getMinDistanceUsd(config.minDistanceUsdByMarket, market), floor);
    const currentWindow = config.entryWindowSecondsByMarket?.[market] ?? config.entryWindowSeconds;

    const blockSize = Math.floor(samples.length / BLOCKS);
    const sym = emptyBucket();
    const asym = emptyBucket();

    for (let cut = 1; cut < BLOCKS; cut += 1) {
      const train = samples.slice(0, cut * blockSize);
      const test = samples.slice(cut * blockSize, cut === BLOCKS - 1 ? samples.length : (cut + 1) * blockSize);

      const grid = buildCandidateGrid(market, train, currentDistance, floor);

      // SYMMETRIC: one pick for both sides (the current engine's behavior).
      const symCurrent = buildCandidate(market, train, currentWindow, currentDistance, maxAsk);
      const symCandidates: RecommendationCandidate[] = [];
      for (const cell of grid) {
        const built = buildCandidate(market, train, cell.entryWindowSeconds, cell.minDistanceUsd, maxAsk);
        if (built.metrics.adjustedRoi !== undefined) {
          symCandidates.push(built);
        }
      }
      const symBest = pickPositive(selectBestCandidate(symCandidates, symCurrent) ?? symCurrent);
      if (symBest) {
        accumulate(sym, buildCandidate(market, test, symBest.entryWindowSeconds, symBest.minDistanceUsd, maxAsk));
      }

      // ASYMMETRIC: independent pick per side, evaluated per side on the test block.
      for (const outcome of OUTCOMES) {
        const sideCurrent = buildCandidate(market, train, currentWindow, currentDistance, maxAsk, outcome);
        const sideCandidates: RecommendationCandidate[] = [];
        for (const cell of grid) {
          const built = buildCandidate(market, train, cell.entryWindowSeconds, cell.minDistanceUsd, maxAsk, outcome);
          if (built.metrics.adjustedRoi !== undefined) {
            sideCandidates.push(built);
          }
        }
        const sideBest = pickPositive(selectBestCandidate(sideCandidates, sideCurrent) ?? sideCurrent);
        if (sideBest) {
          accumulate(
            asym,
            buildCandidate(market, test, sideBest.entryWindowSeconds, sideBest.minDistanceUsd, maxAsk, outcome),
          );
        }
      }
    }

    totals.sym = addBuckets(totals.sym, sym);
    totals.asym = addBuckets(totals.asym, asym);
    console.log(
      `${market}: SIMÉTRICO trades=${sym.trades} win=${winRate(sym)} net=${fmt(sym.net)} | ` +
        `ASIMÉTRICO trades=${asym.trades} win=${winRate(asym)} net=${fmt(asym.net)}`,
    );
  }

  console.log(
    `\nTOTAL: SIMÉTRICO trades=${totals.sym.trades} win=${winRate(totals.sym)} net=${fmt(totals.sym.net)} | ` +
      `ASIMÉTRICO trades=${totals.asym.trades} win=${winRate(totals.asym)} net=${fmt(totals.asym.net)}`,
  );
  const delta = totals.asym.net - totals.sym.net;
  console.log(`Delta asimétrico vs simétrico: ${fmt(delta)} -> ${delta > 0 ? "ASIMÉTRICO MEJOR" : "sin mejora (mantener simétrico)"}`);
}

// Mirror the engine's own guard: never trade a pick whose out-of-sample ROI on the training data is not
// positive (canApply requires walkForwardRoi > 0). Skipping means "keep the money in your pocket".
function pickPositive(candidate: RecommendationCandidate | undefined): RecommendationCandidate | undefined {
  if (!candidate) {
    return undefined;
  }
  const wf = candidate.metrics.walkForwardRoi;
  return wf !== undefined && wf > 0 ? candidate : undefined;
}

function accumulate(bucket: Bucket, tested: RecommendationCandidate): void {
  const { tradeCount, winCount, averageRoi } = tested.metrics;
  if (tradeCount > 0 && averageRoi !== undefined) {
    bucket.trades += tradeCount;
    bucket.wins += winCount;
    bucket.net += averageRoi * tradeCount * STAKE_USD;
  }
}

function emptyBucket(): Bucket {
  return { trades: 0, wins: 0, net: 0 };
}

function addBuckets(left: Bucket, right: Bucket): Bucket {
  return { trades: left.trades + right.trades, wins: left.wins + right.wins, net: left.net + right.net };
}

function winRate(bucket: Bucket): string {
  return bucket.trades > 0 ? `${((100 * bucket.wins) / bucket.trades).toFixed(0)}%` : "-";
}

function fmt(net: number): string {
  return `${net >= 0 ? "+" : "-"}$${Math.abs(net).toFixed(2)}`;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

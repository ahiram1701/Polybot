import { join } from "node:path";

import { readAnalyticsSamples } from "../analyticsRecorder.js";
import { loadConfig } from "../config.js";
import { buildRecommendations, type RecommendationSettings } from "../recommendationEngine.js";

/**
 * Prints the recommendation engine's walk-forward metrics per market over the recorded samples, so we
 * can measure whether feature/calibration changes improve prediction (lower calibrationError, higher
 * walk-forward ROI / lowerBound) and coverage (quoteCoverage, tradeCount) WITHOUT look-ahead.
 *
 * Run: npx tsx src/smoke/recoMetrics.ts
 */
async function main(): Promise<void> {
  const { config } = loadConfig(["--mode", "sim"]);
  const samples = await readAnalyticsSamples(join(config.dataDir, "analytics.jsonl"));
  // Seed the candidate grid near the productive region (the engine explores around the current
  // distance), so the walk-forward metrics are computed on configs that actually execute.
  const settings: RecommendationSettings = {
    minDistanceUsdByMarket: { BTC: 21, ETH: 0.25, DOGE: 0.0001 },
    entryWindowSecondsByMarket: { BTC: 50, ETH: 55, DOGE: 55 },
    entryWindowSeconds: 50,
    maxAskPrice: 0.98,
    minDistanceFloorUsdByMarket: config.minDistanceFloorUsdByMarket,
  };
  const response = await buildRecommendations(samples, settings);
  console.log(`Muestras: ${samples.length}`);
  for (const rec of response.recommendations) {
    const best = rec.recommended ?? rec.current;
    const m = best.metrics;
    console.log(
      `${rec.market}: ventana=${best.entryWindowSeconds}s dist=${best.minDistanceUsd} ` +
        `trades=${m.tradeCount} cobertura=${fmt(m.quoteCoverage)} ` +
        `predWin=${fmt(m.predictedWinProbability)} calibErr=${fmt(m.calibrationError)} ` +
        `wfRoi=${fmt(m.walkForwardRoi)} lowerBound=${fmt(m.lowerBoundRoi)} overfit=${fmt(m.overfitRisk)}`,
    );
  }
}

function fmt(value: number | undefined): string {
  return value === undefined ? "--" : value.toFixed(3);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

/**
 * ¿EXISTE EDGE REAL? Barre umbral de distancia (en BPS, comparable entre mercados) x ventana de
 * entrada y puntua contra `resolveSampleTruth` (el libro de ordenes al cierre, validado al 98.6%
 * contra la resolucion oficial), NO contra `sample.winningOutcome`, que se equivoca un 12.5% y
 * ademas se equivoca correlacionado con la señal.
 *
 * Reporta dos escenarios porque la diferencia entre ambos decide si una config es viable:
 *   - JUZGADO: solo las ventanas con veredicto claro del mercado.
 *   - PEOR CASO: ademas cuenta las ventanas sin veredicto (empates) como moneda al aire, que es lo
 *     que realmente pasa al comprar a 0.90 una ventana que acaba 50/50.
 *
 * Run: npx tsx src/smoke/edgeScan.ts [--bps 1,2,4] [--windows 42,60]
 */
import { join } from "node:path";

import { QUOTE_MATCH_WINDOW_MS, readAnalyticsSamples } from "../analyticsRecorder.js";
import { resolveSampleTruth } from "../analyticsTruth.js";
import { loadConfig } from "../config.js";
import { calculateTradeFeeUsd, defaultTakerFeeRateBps } from "../fees.js";
import { SUPPORTED_MARKETS } from "../markets.js";
import type { AnalyticsSample, MarketSymbol, Outcome } from "../types.js";

const STAKE = 1;

export interface Candidate {
  market: MarketSymbol;
  outcome: Outcome;
  ask: number;
  windowStartMs: number;
  /** `undefined` = el mercado nunca fue concluyente (empate). */
  won?: boolean;
}

/** Neto de un stake de $1 comprando a `ask`, con la misma comision que cobra el bot. */
export function netForStake(ask: number, won: boolean, market: MarketSymbol): number {
  const shares = STAKE / ask;
  const fee = calculateTradeFeeUsd({ shares, price: ask, feeRateBps: defaultTakerFeeRateBps(market) });
  return (won ? shares : 0) - STAKE - fee;
}

/** Entrada de momentum: primer tick de la ventana que supera `bps` de distancia relativa. */
export function buildCandidate(
  sample: AnalyticsSample,
  bps: number,
  entryWindowSeconds: number,
): Candidate | undefined {
  const minDistance = (bps / 10_000) * sample.openingPrice;
  const tick = sample.ticks
    .filter((t) => t.secondsToEnd > 0 && t.secondsToEnd <= entryWindowSeconds)
    .sort((left, right) => left.timestampMs - right.timestampMs)
    .find((t) => Math.abs(t.distanceUsd) >= minDistance);
  if (!tick) {
    return undefined;
  }
  const outcome: Outcome = tick.distanceUsd >= 0 ? "UP" : "DOWN";
  const quote = sample.quotes
    .map((q) => ({ q, gap: Math.abs(q.timestampMs - tick.timestampMs) }))
    .filter((item) => item.gap <= QUOTE_MATCH_WINDOW_MS)
    .sort((left, right) => left.gap - right.gap)[0]?.q;
  if (!quote) {
    return undefined;
  }
  const ask = outcome === "UP" ? quote.upBestAsk : quote.downBestAsk;
  if (ask == null || !(ask > 0) || ask >= 1) {
    return undefined;
  }
  const truth = resolveSampleTruth(sample);
  return {
    market: sample.market,
    outcome,
    ask,
    windowStartMs: sample.windowStartMs,
    won: truth ? truth.outcome === outcome : undefined,
  };
}

export interface Score {
  judged: number;
  unjudged: number;
  wins: number;
  askSum: number;
  net: number;
  netWorstCase: number;
  results: number[];
}

export function scoreCandidates(candidates: Candidate[]): Score {
  const s: Score = { judged: 0, unjudged: 0, wins: 0, askSum: 0, net: 0, netWorstCase: 0, results: [] };
  for (const c of candidates) {
    s.askSum += c.ask;
    if (c.won === undefined) {
      s.unjudged += 1;
      // Empate: mitad de las veces gana, mitad pierde. Valor esperado honesto.
      s.netWorstCase += 0.5 * netForStake(c.ask, true, c.market) + 0.5 * netForStake(c.ask, false, c.market);
      continue;
    }
    s.judged += 1;
    if (c.won) {
      s.wins += 1;
    }
    const net = netForStake(c.ask, c.won, c.market);
    s.net += net;
    s.netWorstCase += net;
    s.results.push(net);
  }
  return s;
}

export function tStat(s: Score): number {
  if (s.results.length < 2) {
    return 0;
  }
  const mean = s.net / s.results.length;
  const sd = Math.sqrt(s.results.reduce((sum, r) => sum + (r - mean) ** 2, 0) / (s.results.length - 1));
  return sd > 0 ? mean / (sd / Math.sqrt(s.results.length)) : 0;
}

function parseList(flag: string, fallback: number[]): number[] {
  const index = process.argv.indexOf(flag);
  if (index < 0 || !process.argv[index + 1]) {
    return fallback;
  }
  return process.argv[index + 1].split(",").map(Number).filter(Number.isFinite);
}

async function main(): Promise<void> {
  const bpsList = parseList("--bps", [1, 2, 4, 8, 16]);
  const windows = parseList("--windows", [20, 42, 60, 120]);
  const { config } = loadConfig(["--mode", "sim"]);
  const all = await readAnalyticsSamples(join(config.dataDir, "analytics.jsonl"));

  for (const market of SUPPORTED_MARKETS) {
    const samples = all
      .filter((s) => s.market === market)
      .sort((left, right) => left.windowStartMs - right.windowStartMs);
    console.log(`\n################ ${market}  (muestras=${samples.length}) ################`);
    console.log(" bps  vent |  entr  sinJuez |  win%   ask   | JUZGADO net$   ROI%     t | PEOR CASO net$   ROI%");
    for (const bps of bpsList) {
      for (const entryWindowSeconds of windows) {
        const candidates = samples
          .map((s) => buildCandidate(s, bps, entryWindowSeconds))
          .filter((c): c is Candidate => c !== undefined);
        const s = scoreCandidates(candidates);
        const total = s.judged + s.unjudged;
        if (s.judged < 30) {
          continue;
        }
        const roiJudged = (100 * s.net) / s.judged;
        const roiWorst = (100 * s.netWorstCase) / total;
        const t = tStat(s);
        const verdict = roiWorst > 0 && t >= 2 ? "  <<< VIABLE" : "";
        console.log(
          `${String(bps).padStart(4)} ${String(entryWindowSeconds).padStart(4)}s |` +
            ` ${String(total).padStart(5)} ${String(s.unjudged).padStart(7)} |` +
            ` ${((100 * s.wins) / s.judged).toFixed(1).padStart(5)} ${(s.askSum / total).toFixed(3)} |` +
            ` ${s.net.toFixed(1).padStart(12)} ${roiJudged.toFixed(2).padStart(6)} ${t.toFixed(1).padStart(5)} |` +
            ` ${s.netWorstCase.toFixed(1).padStart(13)} ${roiWorst.toFixed(2).padStart(6)}${verdict}`,
        );
      }
    }
  }
}

await main();

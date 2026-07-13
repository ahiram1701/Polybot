import { calculateTradePnl, filterTradesForPnlReset, type PnlResetAtMsByMode } from "./pnl.js";
import type { Mode, TradeAttempt } from "./types.js";

/**
 * Realized performance by entry-price (ask) band, over RESOLVED trades of one mode. This is the table
 * that decides the ask cap: the edge lives where realized win% beats the band's break-even (its average
 * ask). Built from the trade ledger (official resolutions included on read), NOT from observation
 * samples — observation data cannot see live fill quality, which is exactly what killed high-ask trades.
 */

export interface AskBandRow {
  // Band is [lo, hi).
  lo: number;
  hi: number;
  trades: number;
  wins: number;
  winRate?: number;
  // Average ask of the band's trades = the win rate needed to break even.
  breakEvenRate?: number;
  netUsd: number;
}

export interface AskBandSummary {
  mode: Mode;
  totalTrades: number;
  bands: AskBandRow[];
}

const BAND_EDGES = [0, 0.45, 0.55, 0.65, 0.7, 0.75, 0.8, 1.0000001];

export function summarizeAskBands(
  trades: TradeAttempt[],
  mode: Mode,
  resetAtMsByMode: PnlResetAtMsByMode = {},
): AskBandSummary {
  const resolved = filterTradesForPnlReset(trades, resetAtMsByMode)
    .filter((trade) => trade.mode === mode && trade.resolved !== undefined)
    .flatMap((trade) => (typeof trade.bestAsk === "number" ? [{ trade, ask: trade.bestAsk }] : []));

  const bands: AskBandRow[] = [];
  for (let index = 0; index < BAND_EDGES.length - 1; index += 1) {
    const lo = BAND_EDGES[index];
    const hi = BAND_EDGES[index + 1];
    const inBand = resolved.filter((entry) => entry.ask >= lo && entry.ask < hi);
    if (inBand.length === 0) {
      continue;
    }
    const wins = inBand.filter((entry) => entry.trade.resolved?.won).length;
    const askSum = inBand.reduce((sum, entry) => sum + entry.ask, 0);
    const netUsd = inBand.reduce((sum, entry) => sum + (calculateTradePnl(entry.trade).netUsd ?? 0), 0);
    bands.push({
      lo,
      hi: Math.min(hi, 1),
      trades: inBand.length,
      wins,
      winRate: wins / inBand.length,
      breakEvenRate: askSum / inBand.length,
      netUsd,
    });
  }

  return { mode, totalTrades: resolved.length, bands };
}

import { calculateTradeFeeUsd, defaultTakerFeeRateBps } from "./fees.js";
import type { MarketSymbol, OrderbookQuote, Outcome } from "./types.js";

/**
 * Complete-set arbitrage OBSERVER (no money): a binary pair always redeems for exactly $1, so whenever
 * ask(UP) + ask(DOWN) + taker fees < 1 buying both sides locks a riskless profit. The historical scan
 * (src/smoke/arbScan.ts) found ~6-7 such moments/day but the archived quotes lack depth, so this
 * monitor records live opportunities WITH the real depth of both books to answer "how many dollars
 * actually fit through the door" before any execution phase is considered.
 */

export interface ArbOpportunity {
  at: number;
  market: MarketSymbol;
  slug: string;
  secondsToEnd: number;
  upAsk: number;
  downAsk: number;
  upDepthUsd: number;
  downDepthUsd: number;
  grossPerSet: number;
  feePerSet: number;
  netPerSet: number;
  // Sets bounded by the thinner book (shares available near best ask, approximated by depth/bestAsk —
  // an upper bound, since deeper levels cost more than the best ask).
  maxSetsByDepth: number;
  capturableUsd: number;
}

export function detectCompleteSetArb(args: {
  market: MarketSymbol;
  slug: string;
  endMs: number;
  nowMs: number;
  quotes: Partial<Record<Outcome, OrderbookQuote>>;
}): ArbOpportunity | undefined {
  const up = args.quotes.UP;
  const down = args.quotes.DOWN;
  // Profundidad del libro COMPLETO, no la limitada por el tope de ask: ese tope protege del riesgo
  // direccional, que aqui no existe (el par redime $1 gane quien gane). La condicion economica del
  // arbitraje es netPerSet > 0, y se comprueba abajo.
  if (!up?.bestAsk || !down?.bestAsk || up.availableUsdAllLevels <= 0 || down.availableUsdAllLevels <= 0) {
    return undefined;
  }

  const feeRateBps = defaultTakerFeeRateBps(args.market);
  const feePerSet =
    calculateTradeFeeUsd({ shares: 1, price: up.bestAsk, feeRateBps }) +
    calculateTradeFeeUsd({ shares: 1, price: down.bestAsk, feeRateBps });
  const grossPerSet = 1 - (up.bestAsk + down.bestAsk);
  const netPerSet = grossPerSet - feePerSet;
  if (netPerSet <= 0) {
    return undefined;
  }

  const maxSetsByDepth = Math.min(up.availableUsdAllLevels / up.bestAsk, down.availableUsdAllLevels / down.bestAsk);
  return {
    at: args.nowMs,
    market: args.market,
    slug: args.slug,
    secondsToEnd: Math.round(((args.endMs - args.nowMs) / 1000) * 10) / 10,
    upAsk: up.bestAsk,
    downAsk: down.bestAsk,
    upDepthUsd: up.availableUsdUnderCap,
    downDepthUsd: down.availableUsdUnderCap,
    grossPerSet: round4(grossPerSet),
    feePerSet: round4(feePerSet),
    netPerSet: round4(netPerSet),
    maxSetsByDepth: Math.floor(maxSetsByDepth * 100) / 100,
    capturableUsd: round4(netPerSet * maxSetsByDepth),
  };
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

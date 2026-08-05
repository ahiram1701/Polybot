import { describe, expect, it } from "vitest";

import { passesRealizedGuard, realizedForCandidate, REALIZED_GUARD_MIN_TRADES } from "../src/realizedGuard.js";
import type { MarketSymbol, TradeAttempt } from "../src/types.js";

/** Operacion resuelta con una entrada a `secondsToEnd` del cierre. `won` decide el signo del neto. */
function trade(args: {
  market: MarketSymbol;
  secondsToEnd: number;
  won: boolean;
  distanceUsd?: number;
  index: number;
}): TradeAttempt {
  const endMs = 1_800_000_000_000 + args.index * 300_000;
  return {
    id: `t${args.index}`,
    asset: args.market,
    slug: `${args.market.toLowerCase()}-updown-5m-${args.index}`,
    mode: "sim",
    outcome: "UP",
    amountUsd: 5,
    // Comprado a 0.50: ganar devuelve ~$10 sobre $5 (neto ~+$5), perder se lleva los $5.
    bestAsk: 0.5,
    estimatedShares: 10,
    distanceUsd: args.distanceUsd ?? 30,
    endMs,
    createdAtMs: endMs - args.secondsToEnd * 1000,
    resolved: { won: args.won, finalPrice: args.won ? 110 : 90, finalTickTimestampMs: endMs },
  } as unknown as TradeAttempt;
}

describe("realizedGuard", () => {
  it("vetoes a window whose executed trades actually lost money", () => {
    // El caso real: ETH a 26s. Las entradas tardias perdieron; las tempranas pagaron.
    const trades = [
      // Entradas tardias (caben en 26s): 10 de 40 aciertan -> pierden dinero.
      ...Array.from({ length: 40 }, (_v, i) => trade({ market: "ETH", secondsToEnd: 20, won: i % 4 === 0, index: i })),
      // Entradas tempranas (solo caben en la ventana ancha): 45 de 60 aciertan -> pagan.
      ...Array.from({ length: 60 }, (_v, i) => trade({ market: "ETH", secondsToEnd: 45, won: i % 4 !== 0, index: 100 + i })),
    ];

    const narrow = realizedForCandidate(trades, "ETH", { entryWindowSeconds: 26, minDistanceUsd: 10 });
    expect(narrow.tradeCount).toBe(40); // solo las tardias caben en 26s
    expect(narrow.netUsd).toBeLessThan(0);
    expect(passesRealizedGuard(narrow)).toBe(false); // VETO

    const wide = realizedForCandidate(trades, "ETH", { entryWindowSeconds: 60, minDistanceUsd: 10 });
    expect(wide.tradeCount).toBe(100);
    expect(wide.netUsd).toBeGreaterThan(0);
    expect(passesRealizedGuard(wide)).toBe(true);
  });

  it("abstains instead of approving when the sample is too thin", () => {
    // Perdedora pero con poca muestra: el veto NO opina, deciden las demas guardas.
    const few = Array.from({ length: REALIZED_GUARD_MIN_TRADES - 1 }, (_v, i) =>
      trade({ market: "BTC", secondsToEnd: 15, won: false, index: i }),
    );
    const region = realizedForCandidate(few, "BTC", { entryWindowSeconds: 42, minDistanceUsd: 10 });
    expect(region.netUsd).toBeLessThan(0);
    expect(passesRealizedGuard(region)).toBe(true); // callar no es aprobar
  });

  it("only counts trades that meet the candidate's distance threshold", () => {
    const trades = Array.from({ length: 30 }, (_v, i) =>
      trade({ market: "BTC", secondsToEnd: 30, won: true, distanceUsd: 12, index: i }),
    );
    expect(realizedForCandidate(trades, "BTC", { entryWindowSeconds: 42, minDistanceUsd: 26 }).tradeCount).toBe(0);
    expect(realizedForCandidate(trades, "BTC", { entryWindowSeconds: 42, minDistanceUsd: 10 }).tradeCount).toBe(30);
  });

  it("ignores arbitrage and other markets", () => {
    const trades = [
      trade({ market: "ETH", secondsToEnd: 20, won: true, index: 1 }),
      { ...trade({ market: "BTC", secondsToEnd: 20, won: true, index: 2 }), kind: "arb" } as TradeAttempt,
    ];
    expect(realizedForCandidate(trades, "BTC", { entryWindowSeconds: 42, minDistanceUsd: 10 }).tradeCount).toBe(0);
  });
});

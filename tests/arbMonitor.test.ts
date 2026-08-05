import { describe, expect, it } from "vitest";

import { detectCompleteSetArb, reviewArbOpportunities } from "../src/arbMonitor.js";
import type { OrderbookQuote } from "../src/types.js";

/**
 * `underCap` es la profundidad que ve el camino direccional; `allLevels` la del libro entero, que es
 * la que debe usar el arbitraje. Por defecto coinciden; se separan para probar el caso en que un lado
 * cotiza por ENCIMA del tope de ask (underCap = 0) y el arbitraje debe seguir viendolo.
 */
function quote(bestAsk: number, underCap: number, allLevels = underCap): OrderbookQuote {
  return {
    tokenId: "token",
    bestAsk,
    bestBid: bestAsk - 0.01,
    availableUsdUnderCap: underCap,
    availableUsdAllLevels: allLevels,
    estimatedSharesForAmount: underCap / bestAsk,
    rawAskLevels: [],
  } as unknown as OrderbookQuote;
}

describe("detectCompleteSetArb", () => {
  it("detects a post-fee opportunity and sizes it by the thinner book", () => {
    // UP 0.40 + DOWN 0.50 = 0.90 gross; fees ~ 0.07*(0.4*0.6 + 0.5*0.5) = 0.0343 -> net ~ 0.0657/set.
    const opportunity = detectCompleteSetArb({
      market: "ETH",
      slug: "eth-updown-5m-1",
      endMs: 100_000,
      nowMs: 40_000,
      quotes: { UP: quote(0.4, 40), DOWN: quote(0.5, 10) },
    });

    expect(opportunity).toBeDefined();
    expect(opportunity?.grossPerSet).toBeCloseTo(0.1);
    expect(opportunity?.netPerSet).toBeCloseTo(0.0657, 3);
    // Thinner book: DOWN has $10 at 0.50 -> 20 sets (UP could do 100).
    expect(opportunity?.maxSetsByDepth).toBeCloseTo(20, 1);
    expect(opportunity?.capturableUsd).toBeCloseTo(20 * 0.0657, 2);
    expect(opportunity?.secondsToEnd).toBeCloseTo(60);
  });

  it("still sees the arb when one side quotes ABOVE the directional ask cap", () => {
    // El caso que costaba dinero: DOWN a 0.72 supera el tope de 0.65, asi que su profundidad bajo el
    // tope es CERO y el arbitraje quedaba descartado. Pero 0.20 + 0.72 = 0.92 y el par redime $1: es
    // ganancia garantizada. El tope protege del riesgo direccional, que aqui no existe.
    const opportunity = detectCompleteSetArb({
      market: "ETH",
      slug: "eth-updown-5m-2",
      endMs: 100_000,
      nowMs: 40_000,
      quotes: { UP: quote(0.2, 50, 50), DOWN: quote(0.72, 0, 36) },
    });

    expect(opportunity).toBeDefined();
    expect(opportunity?.netPerSet).toBeGreaterThan(0);
    // Dimensionado por el libro completo de DOWN: $36 a 0.72 -> 50 sets (UP tambien da 250).
    expect(opportunity?.maxSetsByDepth).toBeCloseTo(50, 1);
  });

  it("returns nothing when fees eat the gross edge", () => {
    // 0.49 + 0.49 = 0.98 gross 0.02; fees ~ 0.07*2*0.49*0.51 = 0.035 -> net negative.
    expect(
      detectCompleteSetArb({
        market: "BTC",
        slug: "btc-updown-5m-1",
        endMs: 100_000,
        nowMs: 40_000,
        quotes: { UP: quote(0.49, 50), DOWN: quote(0.49, 50) },
      }),
    ).toBeUndefined();
  });

  it("returns nothing without both books priced and funded", () => {
    expect(
      detectCompleteSetArb({
        market: "BTC",
        slug: "btc-updown-5m-1",
        endMs: 100_000,
        nowMs: 40_000,
        quotes: { UP: quote(0.4, 50), DOWN: quote(0.5, 0) },
      }),
    ).toBeUndefined();
    expect(
      detectCompleteSetArb({
        market: "BTC",
        slug: "btc-updown-5m-1",
        endMs: 100_000,
        nowMs: 40_000,
        quotes: { UP: quote(0.4, 50) },
      }),
    ).toBeUndefined();
  });
});

describe("reviewArbOpportunities", () => {
  const base = {
    at: 1_700_000_000_000,
    market: "ETH" as const,
    slug: "eth-updown-5m-1",
    secondsToEnd: 60,
    upDepthUsd: 500,
    downDepthUsd: 500,
    grossPerSet: 0.1,
    feePerSet: 0.03,
    maxSetsByDepth: 500,
    capturableUsd: 0,
  };

  it("distingue 'neto bajo el umbral' de 'capital insuficiente'", () => {
    const summary = reviewArbOpportunities(
      [
        // Neto suficiente y patas asequibles con $25: la pata barata (0.45) exige 11.1 sets = $19.9.
        { ...base, upAsk: 0.45, downAsk: 0.45, netPerSet: 0.08 },
        // Neto por debajo del umbral configurado.
        { ...base, upAsk: 0.45, downAsk: 0.45, netPerSet: 0.005 },
        // Neto de sobra, pero la pata barata (0.10) exige 50 sets: $47.5, mas que el presupuesto.
        { ...base, upAsk: 0.1, downAsk: 0.85, netPerSet: 0.05 },
      ],
      { minNetPerSet: 0.02, orderMinSize: 5, budgetUsd: 25 },
    );

    expect(summary.detected).toBe(3);
    expect(summary.executable).toBe(1);
    expect(summary.blocked.net_below_threshold).toBe(1);
    expect(summary.blocked.capital_below_min_legs).toBe(1);
  });

  it("calcula el capital por la pata MAS BARATA, que es la que obliga", () => {
    const summary = reviewArbOpportunities([{ ...base, upAsk: 0.2, downAsk: 0.75, netPerSet: 0.05 }], {
      minNetPerSet: 0.02,
      orderMinSize: 5,
      budgetUsd: 1000,
    });
    // 5 / 0.20 = 25 sets; 25 * (0.20 + 0.75) = $23.75.
    expect(summary.recent[0].requiredCapitalUsd).toBeCloseTo(23.75, 2);
  });
});

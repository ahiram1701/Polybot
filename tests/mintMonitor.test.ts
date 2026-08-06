import { describe, expect, it } from "vitest";

import { detectMintArb } from "../src/mintMonitor.js";
import type { OrderbookQuote } from "../src/types.js";

function quote(bids: Array<{ price: number; size: number }>): OrderbookQuote {
  return {
    tokenId: "t",
    bestAsk: bids[0] ? bids[0].price + 0.01 : undefined,
    bestBid: bids[0]?.price,
    availableUsdUnderCap: 0,
    availableUsdAllLevels: 0,
    estimatedSharesForAmount: 0,
    rawAskLevels: [],
    rawBidLevels: bids,
    availableBidUsdAllLevels: bids.reduce((sum, b) => sum + b.price * b.size, 0),
  };
}

const base = { market: "BTC" as const, slug: "btc-updown-5m-1", endMs: 300_000, nowMs: 100_000 };

describe("detectMintArb", () => {
  it("no ve nada cuando los dos bids juntos no llegan a $1", () => {
    const found = detectMintArb({
      ...base,
      quotes: { UP: quote([{ price: 0.5, size: 100 }]), DOWN: quote([{ price: 0.45, size: 100 }]) },
    });
    expect(found).toBeUndefined();
  });

  it("no ve nada cuando pasan de $1 pero la comision se lo come", () => {
    // 0.51+0.50 = 1.01 bruto. Fee 7% x p x (1-p) por pata ~= 0.0175+0.0175 = 0.035 > 0.01.
    const found = detectMintArb({
      ...base,
      quotes: { UP: quote([{ price: 0.51, size: 100 }]), DOWN: quote([{ price: 0.5, size: 100 }]) },
    });
    expect(found).toBeUndefined();
  });

  it("detecta la oportunidad cuando el par se vende por mas de $1 tras comisiones", () => {
    const found = detectMintArb({
      ...base,
      quotes: { UP: quote([{ price: 0.9, size: 100 }]), DOWN: quote([{ price: 0.3, size: 100 }]) },
    })!;
    expect(found.grossPerSet).toBeCloseTo(1.2, 4);
    expect(found.netPerSet).toBeGreaterThan(0);
    expect(found.market).toBe("BTC");
    expect(found.secondsToEnd).toBe(200);
  });

  /**
   * El error que este modulo existe para evitar: cobrar todas las participaciones al mejor bid. Con un
   * libro fino los niveles de abajo pagan mucho menos, y el neto real queda por debajo del que sugiere
   * `netPerSet x sets`.
   */
  it("el neto a profundidad es MENOR que el neto por set multiplicado por el tamaño", () => {
    const found = detectMintArb({
      ...base,
      quotes: {
        UP: quote([
          { price: 0.9, size: 10 },
          { price: 0.6, size: 500 },
        ]),
        DOWN: quote([{ price: 0.3, size: 500 }]),
      },
    })!;
    expect(found.maxSetsByDepth).toBeGreaterThan(0);
    expect(found.netUsdAtDepth).toBeLessThan(found.netPerSet * found.maxSetsByDepth + 1e-9);
  });

  it("elige el tamaño que MAXIMIZA el neto, no el mayor que sigue siendo positivo", () => {
    // 10 sets a bids 0.90/0.30 dejan buen margen; seguir hasta 510 con el UP a 0.60 lo destruye.
    const found = detectMintArb({
      ...base,
      quotes: {
        UP: quote([
          { price: 0.9, size: 10 },
          { price: 0.6, size: 500 },
        ]),
        DOWN: quote([{ price: 0.3, size: 510 }]),
      },
    })!;
    expect(found.maxSetsByDepth).toBe(10);
  });

  it("nunca propone mas sets de los que el libro MAS FINO puede absorber: media pata no es arbitraje", () => {
    const found = detectMintArb({
      ...base,
      quotes: {
        UP: quote([{ price: 0.9, size: 1000 }]),
        DOWN: quote([{ price: 0.3, size: 7 }]),
      },
    })!;
    expect(found.maxSetsByDepth).toBeLessThanOrEqual(7);
  });

  /**
   * Regresion: la primera version leia `rawBidLevels.length` sin proteger. Un quote sin ese campo
   * lanzaba, y como esto corre dentro de la fase de captura en paralelo, la excepcion tumbaba la
   * iteracion ENTERA — dejando al bot ciego tambien para el direccional y el arbitraje de compra.
   */
  it("un quote sin niveles de bid devuelve undefined en vez de lanzar", () => {
    const roto = { tokenId: "t", bestBid: 0.9, bestAsk: 0.91 } as unknown as OrderbookQuote;
    expect(() =>
      detectMintArb({ ...base, quotes: { UP: roto, DOWN: quote([{ price: 0.3, size: 10 }]) } }),
    ).not.toThrow();
    expect(detectMintArb({ ...base, quotes: { UP: roto, DOWN: quote([{ price: 0.3, size: 10 }]) } })).toBeUndefined();
  });

  it("sin libro comprador en un lado no hay oportunidad", () => {
    expect(
      detectMintArb({ ...base, quotes: { UP: quote([{ price: 0.9, size: 10 }]), DOWN: quote([]) } }),
    ).toBeUndefined();
  });
});

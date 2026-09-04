import { describe, expect, it, vi } from "vitest";

import { resolveOpeningTick } from "../src/markets.js";
import type { PriceTick } from "../src/types.js";

/**
 * La apertura de la ventana, y de QUE serie salio.
 *
 * Vive en un helper compartido porque hay dos rutas que la necesitan —el bot, que opera contra ella, y
 * el panel, que la enseña cuando `state.json` todavia no la tiene— y cuando cada una llevaba su propia
 * cascada se separaron: el bot ya prefería el TWAP y el panel seguia leyendo spot. La pantalla mostraba
 * una apertura y el bot habia operado contra otra, sin que nada lo dijera.
 */
function tick(value: number, timestampMs = 1_000): PriceTick {
  return { market: "BTC", symbol: "btc/usd", value, timestampMs, receivedAtMs: timestampMs };
}

describe("resolveOpeningTick", () => {
  it("prefiere el TWAP: es la serie con la que el mercado RESUELVE", () => {
    const feed = {
      getTwapAtOrBefore: vi.fn(() => tick(100)),
      getOpeningTick: vi.fn(() => tick(999)),
    };

    const resuelto = resolveOpeningTick({
      feed,
      market: "BTC",
      windowStartMs: 1_000,
      twapLookbackSeconds: 30,
      graceMs: 15_000,
    });

    expect(resuelto).toEqual({ tick: tick(100), priceSource: "twap" });
    // Ni siquiera se consulta el spot cuando el TWAP esta disponible.
    expect(feed.getOpeningTick).not.toHaveBeenCalled();
  });

  it("cae al spot cuando la serie TWAP aun no ha llegado, y lo MARCA", () => {
    const resuelto = resolveOpeningTick({
      feed: { getTwapAtOrBefore: vi.fn(() => undefined), getOpeningTick: vi.fn(() => tick(101)) },
      market: "BTC",
      windowStartMs: 1_000,
      twapLookbackSeconds: 30,
      graceMs: 15_000,
    });

    // La etiqueta es lo que impide comparar una apertura spot contra un cierre TWAP sin saberlo.
    expect(resuelto).toEqual({ tick: tick(101), priceSource: "spot" });
  });

  it("un mercado que no resuelve por TWAP no lo intenta siquiera", () => {
    const feed = { getTwapAtOrBefore: vi.fn(), getOpeningTick: vi.fn(() => tick(102)) };

    const resuelto = resolveOpeningTick({
      feed,
      market: "BTC",
      windowStartMs: 1_000,
      twapLookbackSeconds: undefined,
      graceMs: 15_000,
    });

    expect(feed.getTwapAtOrBefore).not.toHaveBeenCalled();
    expect(resuelto?.priceSource).toBe("spot");
  });

  it("sin ninguna fuente devuelve undefined en vez de un precio inventado", () => {
    expect(
      resolveOpeningTick({
        feed: { getTwapAtOrBefore: vi.fn(() => undefined), getOpeningTick: vi.fn(() => undefined) },
        market: "BTC",
        windowStartMs: 1_000,
        twapLookbackSeconds: 30,
        graceMs: 15_000,
      }),
    ).toBeUndefined();
  });

  it("agota la cascada del spot antes de rendirse", () => {
    const resuelto = resolveOpeningTick({
      feed: {
        getTwapAtOrBefore: vi.fn(() => undefined),
        getOpeningTick: vi.fn(() => undefined),
        getTickInRange: vi.fn(() => undefined),
      },
      market: "BTC",
      windowStartMs: 1_000,
      twapLookbackSeconds: 30,
      graceMs: 15_000,
      latestTick: tick(103),
    });

    expect(resuelto).toEqual({ tick: tick(103), priceSource: "spot" });
  });
});

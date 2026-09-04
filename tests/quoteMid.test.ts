import { describe, expect, it } from "vitest";

import { summarizeOrderBook } from "../src/orderbookService.js";

/**
 * El punto medio que la UI enseña como "probabilidad" del lado.
 *
 * Existe porque el panel pintaba `bestAsk` bajo esa idea y no cuadraba con polymarket.com: con
 * spreads de 1,5 a 4,5 centavos el ask queda 1-3 centavos por encima del medio, SIEMPRE en la misma
 * direccion.
 *
 * Es el medio de TOPE DE LIBRO, y no el "size-cutoff-adjusted midpoint" de `medioAjustadoPorTamano`.
 * Ese existe para el programa de RECOMPENSAS —tira los niveles por debajo del minimo para que nadie
 * fije un medio falso con polvo— y para repartir es el correcto, pero para enseñar un precio no: en el
 * libro fino de DOGE, medido en produccion, con el ask en 0,83 devolvia 0,505.
 */
function libro(bids: Array<{ price: number; size: number }>, asks: Array<{ price: number; size: number }>) {
  return {
    asset_id: "token",
    bids: bids.map((n) => ({ price: String(n.price), size: String(n.size) })),
    asks: asks.map((n) => ({ price: String(n.price), size: String(n.size) })),
  } as unknown as Parameters<typeof summarizeOrderBook>[0];
}

describe("punto medio de la cotizacion", () => {
  it("es el medio del tope de libro, que es el numero que enseña la web", () => {
    const quote = summarizeOrderBook(
      libro(
        [
          { price: 0.8, size: 40 },
          { price: 0.76, size: 60 },
        ],
        [
          { price: 0.81, size: 40 },
          { price: 0.84, size: 80 },
        ],
      ),
      1,
      0.98,
    );

    expect(quote.mid).toBeCloseTo(0.805, 9);
    // El ask es lo que de verdad se paga y queda por encima: los dos juntos explican la diferencia
    // con la web en vez de dejarla como un misterio.
    expect(quote.bestAsk).toBeCloseTo(0.81, 9);
  });

  it("no descarta los niveles pequeños del tope: ahi esta el precio", () => {
    // El caso real de DOGE: bids cercanos pequeños y un nivel grande MUY abajo. Descartar los primeros
    // daba un medio de 0,505 con el ask en 0,83 — el ancho del libro disfrazado de precio.
    const quote = summarizeOrderBook(
      libro(
        [
          { price: 0.8, size: 3 },
          { price: 0.18, size: 500 },
        ],
        [{ price: 0.83, size: 200 }],
      ),
      1,
      0.98,
    );

    expect(quote.mid).toBeCloseTo(0.815, 9);
  });

  it("sin un lado del libro no hay medio, y no se inventa un cero", () => {
    const quote = summarizeOrderBook(libro([], [{ price: 0.9, size: 100 }]), 1, 0.98);

    expect(quote.mid).toBeUndefined();
  });
});

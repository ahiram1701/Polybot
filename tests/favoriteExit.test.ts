import { describe, expect, it } from "vitest";

import { decideFavoriteExit, resolveStopAsk } from "../src/favoriteExit.js";
import type { OrderbookQuote, Outcome } from "../src/types.js";

const AHORA = 1_000_000;
const FIN = AHORA + 120_000;
const COMPRADA = AHORA - 60_000;

function quote(args: {
  bestAsk?: number;
  bestBid?: number;
  bids?: Array<{ price: number; size: number }>;
}): OrderbookQuote {
  const bids = args.bids ?? (args.bestBid === undefined ? [] : [{ price: args.bestBid, size: 1_000 }]);
  // OrderbookQuote COMPLETO, nunca un `as` parcial: con un parcial, un campo nuevo del tipo no rompe
  // este test y la cobertura envejece en silencio.
  return {
    tokenId: "token",
    quotedAtMs: AHORA,
    bestAsk: args.bestAsk,
    bestBid: args.bestBid ?? bids[0]?.price,
    mid: args.bestAsk !== undefined && bids[0] ? (args.bestAsk + bids[0].price) / 2 : undefined,
    availableUsdUnderCap: 50,
    availableUsdAllLevels: 200,
    estimatedSharesForAmount: args.bestAsk ? 5 / args.bestAsk : 0,
    estimatedAveragePrice: args.bestAsk,
    rawAskLevels: args.bestAsk === undefined ? [] : [{ price: args.bestAsk, size: 100 }],
    rawBidLevels: bids,
    availableBidUsdAllLevels: bids.reduce((sum, b) => sum + b.price * b.size, 0),
  };
}

/** Caso base: se tiene UP, ha caido a 0,70, y hay compradores de sobra a 0,68. */
function escenario(overrides: Partial<Parameters<typeof decideFavoriteExit>[0]> = {}) {
  return decideFavoriteExit({
    posicion: { outcome: "UP" as Outcome, shares: 100, createdAtMs: COMPRADA },
    quotes: {
      UP: quote({ bestAsk: 0.7, bids: [{ price: 0.68, size: 1_000 }] }),
      DOWN: quote({ bestAsk: 0.32, bids: [{ price: 0.3, size: 1_000 }] }),
    },
    nowMs: AHORA,
    endMs: FIN,
    stopAsk: 0.79,
    ...overrides,
  });
}

describe("decideFavoriteExit", () => {
  it("cierra cuando el ask cae por debajo del stop y hay compradores", () => {
    const decision = escenario();

    expect(decision.reason).toBe("stop_bajo_banda");
    expect(decision.plan?.outcome).toBe("UP");
    expect(decision.plan?.sharesVendibles).toBe(100);
    expect(decision.plan?.proceedsUsd).toBeCloseTo(68, 6);
    expect(decision.plan?.precioMedioSalida).toBeCloseTo(0.68, 6);
  });

  it("baja por el libro en vez de cobrarlo todo al mejor bid", () => {
    // El error que evita: 100 participaciones a 0,68 serian $68, pero solo 40 caben en ese nivel. El
    // resto se paga a 0,60 y 0,55, y el precio medio real es bastante peor.
    const decision = escenario({
      quotes: {
        UP: quote({
          bestAsk: 0.7,
          bids: [
            { price: 0.68, size: 40 },
            { price: 0.6, size: 40 },
            { price: 0.55, size: 40 },
          ],
        }),
        DOWN: quote({ bestAsk: 0.32, bids: [{ price: 0.3, size: 1_000 }] }),
      },
    });

    expect(decision.reason).toBe("stop_bajo_banda");
    // 40*0,68 + 40*0,60 + 20*0,55 = 27,2 + 24 + 11 = 62,2
    expect(decision.plan?.proceedsUsd).toBeCloseTo(62.2, 6);
    expect(decision.plan?.precioMedioSalida).toBeCloseTo(0.622, 6);
    // El limite de la orden es el peor nivel que hace falta tocar, no el mejor bid.
    expect(decision.plan?.peorPrecio).toBe(0.55);
  });

  it("no toca la posicion mientras el ask sigue en el tramo", () => {
    const decision = escenario({
      quotes: {
        UP: quote({ bestAsk: 0.81, bids: [{ price: 0.79, size: 1_000 }] }),
        DOWN: quote({ bestAsk: 0.21, bids: [{ price: 0.19, size: 1_000 }] }),
      },
    });

    expect(decision.reason).toBe("en_banda");
    expect(decision.plan).toBeUndefined();
  });

  it("el stop se mide sobre el ASK, no sobre el bid", () => {
    // La regresion mas cara posible: con el bid en 0,78 y el stop en 0,79, medir sobre el bid cerraria
    // una posicion recien comprada a 0,80 en la iteracion siguiente, SIEMPRE. El spread tipico de
    // estos libros (1,5 a 4,5 centimos) garantiza que el bid este por debajo del suelo de la banda.
    const decision = escenario({
      quotes: {
        UP: quote({ bestAsk: 0.8, bids: [{ price: 0.78, size: 1_000 }] }),
        DOWN: quote({ bestAsk: 0.22, bids: [{ price: 0.2, size: 1_000 }] }),
      },
    });

    expect(decision.reason).toBe("en_banda");
  });

  it("justo EN el stop ya cierra: el umbral es el ultimo precio al que se vende", () => {
    // Inclusivo a proposito. Asi el ajuste dice literalmente lo que hace —"vende con el ask en 0,69 o
    // menos" es `stopAsk: 0.69`— en vez de obligar a configurar el primer precio que NO vende, que es
    // como se cuelan los errores de un tick.
    const decision = escenario({
      quotes: {
        UP: quote({ bestAsk: 0.79, bids: [{ price: 0.77, size: 1_000 }] }),
        DOWN: quote({ bestAsk: 0.23, bids: [{ price: 0.21, size: 1_000 }] }),
      },
    });

    expect(decision.reason).toBe("stop_bajo_banda");
  });

  it("un tick por encima del stop no cierra", () => {
    const decision = escenario({
      quotes: {
        UP: quote({ bestAsk: 0.8, bids: [{ price: 0.78, size: 1_000 }] }),
        DOWN: quote({ bestAsk: 0.22, bids: [{ price: 0.2, size: 1_000 }] }),
      },
    });

    expect(decision.reason).toBe("en_banda");
  });

  it("un libro muerto no autoriza la venta aunque el ask haya caido", () => {
    // 0,70 + 0,78 = 1,48. Los dos lados cotizan ancho y suelto: ese 0,70 no dice "ha caido al 70%",
    // dice que no hay mercado. Vender por esa lectura seria pagar el ancho creyendo que se acota.
    const decision = escenario({
      quotes: {
        UP: quote({ bestAsk: 0.7, bids: [{ price: 0.5, size: 1_000 }] }),
        DOWN: quote({ bestAsk: 0.78, bids: [{ price: 0.5, size: 1_000 }] }),
      },
    });

    expect(decision.reason).toBe("dead_book");
  });

  it("sin el ask del contrario SI vende, si el libro propio es estrecho", () => {
    // Es el caso que `dead_book` no puede cubrir y por el que este modulo no exige los dos asks como
    // hace el selector: al final de la ventana el lado ganador se queda sin asks, y exigirlos dejaria
    // la posicion atrapada justo mientras se derrumba.
    const decision = escenario({
      quotes: {
        UP: quote({ bestAsk: 0.7, bids: [{ price: 0.68, size: 1_000 }] }),
        DOWN: quote({ bestAsk: undefined, bids: [{ price: 0.3, size: 1_000 }] }),
      },
    });

    expect(decision.reason).toBe("stop_bajo_banda");
  });

  it("sin el ask del contrario y con el libro propio ancho, no vende", () => {
    const decision = escenario({
      quotes: {
        UP: quote({ bestAsk: 0.7, bids: [{ price: 0.55, size: 1_000 }] }),
        DOWN: quote({ bestAsk: undefined, bids: [] }),
      },
    });

    expect(decision.reason).toBe("libro_ancho");
  });

  it("sin el ask del lado que se tiene no hay nada que medir", () => {
    const decision = escenario({
      quotes: {
        UP: quote({ bestAsk: undefined, bids: [{ price: 0.68, size: 1_000 }] }),
        DOWN: quote({ bestAsk: 0.32, bids: [{ price: 0.3, size: 1_000 }] }),
      },
    });

    expect(decision.reason).toBe("missing_quote");
  });

  it("no vende una posicion recien comprada", () => {
    // La misma oscilacion del libro que produjo la compra no puede producir la venta.
    const decision = escenario({ posicion: { outcome: "UP", shares: 100, createdAtMs: AHORA - 5_000 } });

    expect(decision.reason).toBe("demasiado_pronto");
  });

  it("no vende en los ultimos segundos, cuando el CLOB ya rechaza taker", () => {
    const decision = escenario({ endMs: AHORA + 20_000 });

    expect(decision.reason).toBe("demasiado_tarde");
  });

  it("no regala la posicion cuando el mejor bid esta por los suelos", () => {
    const decision = escenario({
      quotes: {
        UP: quote({ bestAsk: 0.06, bids: [{ price: 0.03, size: 1_000 }] }),
        DOWN: quote({ bestAsk: 0.95, bids: [{ price: 0.93, size: 1_000 }] }),
      },
    });

    expect(decision.reason).toBe("bid_bajo_suelo");
  });

  it("descarta cuando los compradores no absorben casi toda la posicion", () => {
    // Una salida parcial paga el spread entero y deja la perdida encima.
    const decision = escenario({
      quotes: {
        UP: quote({ bestAsk: 0.7, bids: [{ price: 0.68, size: 50 }] }),
        DOWN: quote({ bestAsk: 0.32, bids: [{ price: 0.3, size: 1_000 }] }),
      },
    });

    expect(decision.reason).toBe("liquidez_insuficiente");
    expect(decision.detail.ratio).toBeCloseTo(0.5, 3);
  });

  it("los niveles por debajo del suelo no cuentan como profundidad", () => {
    // 60 participaciones a 0,68 y el resto solo a 0,02. Contar ese polvo daria un ratio de 1 y una
    // venta que en realidad regala el 40% de la posicion — exactamente lo que `bid_bajo_suelo` acaba
    // de rechazar unas lineas antes.
    const decision = escenario({
      quotes: {
        UP: quote({
          bestAsk: 0.7,
          bids: [
            { price: 0.68, size: 60 },
            { price: 0.02, size: 10_000 },
          ],
        }),
        DOWN: quote({ bestAsk: 0.32, bids: [{ price: 0.3, size: 1_000 }] }),
      },
    });

    expect(decision.reason).toBe("liquidez_insuficiente");
    expect(decision.detail.sharesVendibles).toBeCloseTo(60, 3);
  });

  it("vende el lado DOWN cuando es el que se tiene", () => {
    const decision = escenario({
      posicion: { outcome: "DOWN", shares: 100, createdAtMs: COMPRADA },
      quotes: {
        UP: quote({ bestAsk: 0.32, bids: [{ price: 0.3, size: 1_000 }] }),
        DOWN: quote({ bestAsk: 0.7, bids: [{ price: 0.68, size: 1_000 }] }),
      },
    });

    expect(decision.reason).toBe("stop_bajo_banda");
    expect(decision.plan?.outcome).toBe("DOWN");
  });
});

describe("la certeza es el disparador que manda", () => {
  /** Libro sano y muy por encima de la red de seguridad: aqui solo decide la certeza. */
  function conCerteza(certeza: number | undefined, overrides = {}) {
    return escenario({
      quotes: {
        UP: quote({ bestAsk: 0.84, bids: [{ price: 0.82, size: 1_000 }] }),
        DOWN: quote({ bestAsk: 0.18, bids: [{ price: 0.16, size: 1_000 }] }),
      },
      stopAsk: 0.35,
      certeza,
      exitCertainty: 0,
      ...overrides,
    });
  }

  it("vende cuando la ventaja se ha evaporado", () => {
    const decision = conCerteza(-0.4);

    expect(decision.reason).toBe("certeza_perdida");
    expect(decision.plan?.motivo).toBe("certeza_perdida");
    expect(decision.plan?.certeza).toBe(-0.4);
  });

  it("justo EN el umbral ya vende", () => {
    expect(conCerteza(0).reason).toBe("certeza_perdida");
  });

  it("aguanta mientras la ventaja siga viva", () => {
    expect(conCerteza(0.8).reason).toBe("en_banda");
    expect(conCerteza(0.01).reason).toBe("en_banda");
  });

  it("NO vende por un ask hundido si la certeza sigue alta", () => {
    // Es exactamente el falso positivo que costaba el dinero: 264 de 373 ventas por precio iban a
    // lados que acababan ganando. Con el libro en 0,60 y el oraculo diciendo que esta decidido, se
    // aguanta.
    const decision = escenario({
      quotes: {
        UP: quote({ bestAsk: 0.6, bids: [{ price: 0.58, size: 1_000 }] }),
        DOWN: quote({ bestAsk: 0.42, bids: [{ price: 0.4, size: 1_000 }] }),
      },
      stopAsk: 0.35,
      certeza: 1.4,
      exitCertainty: 0,
    });

    expect(decision.reason).toBe("en_banda");
  });

  it("la red de seguridad SI dispara cuando el libro se desploma de verdad", () => {
    const decision = escenario({
      quotes: {
        UP: quote({ bestAsk: 0.3, bids: [{ price: 0.28, size: 1_000 }] }),
        DOWN: quote({ bestAsk: 0.72, bids: [{ price: 0.7, size: 1_000 }] }),
      },
      stopAsk: 0.35,
      certeza: 1.4,
      exitCertainty: 0,
    });

    expect(decision.reason).toBe("stop_bajo_banda");
    expect(decision.plan?.motivo).toBe("stop_bajo_banda");
  });

  it("sin lectura de certeza queda solo la red de seguridad", () => {
    // Una laguna del feed no puede dejar la posicion sin ninguna proteccion, pero tampoco puede
    // inventarse una venta: se cae al unico criterio que si se puede medir.
    expect(conCerteza(undefined).reason).toBe("en_banda");
    expect(
      escenario({
        quotes: {
          UP: quote({ bestAsk: 0.3, bids: [{ price: 0.28, size: 1_000 }] }),
          DOWN: quote({ bestAsk: 0.72, bids: [{ price: 0.7, size: 1_000 }] }),
        },
        stopAsk: 0.35,
        certeza: undefined,
      }).reason,
    ).toBe("stop_bajo_banda");
  });

  it("una certeza negativa no se confunde con 'sin lectura'", () => {
    // `resolveFinito` acepta negativos a proposito: el precio cruzado al lado malo es la señal mas
    // fuerte que hay, y tratarla como ausente seria perder justo el caso que mas urge.
    expect(conCerteza(-2.5).reason).toBe("certeza_perdida");
  });
});

describe("resolveStopAsk", () => {
  it("el umbral ABSOLUTO manda sobre la banda y sobre el margen", () => {
    // Es el caso normal: el stop util esta lejos de la banda, y expresarlo como una resta lo dejaria
    // desplazandose solo en cuanto alguien mueva la banda.
    expect(resolveStopAsk(0.79, 0.02, 0.69)).toBeCloseTo(0.69, 6);
    expect(resolveStopAsk(0.9, 0.5, 0.69)).toBeCloseTo(0.69, 6);
  });

  it("un umbral absoluto fuera de (0,1) se ignora y se cae al derivado", () => {
    expect(resolveStopAsk(0.79, 0.02, 0)).toBeCloseTo(0.77, 6);
    expect(resolveStopAsk(0.79, 0.02, 1)).toBeCloseTo(0.77, 6);
    expect(resolveStopAsk(0.79, 0.02, Number.NaN)).toBeCloseTo(0.77, 6);
  });

  it("sin umbral absoluto, el stop se deriva del suelo de la banda", () => {
    // Un tick por debajo por defecto: con el stop EN el suelo se venderia a un precio al que la
    // estrategia todavia compra.
    expect(resolveStopAsk(0.79, undefined)).toBeCloseTo(0.78, 6);
    expect(resolveStopAsk(0.79, 0.02)).toBeCloseTo(0.77, 6);
  });

  it("un margen absurdo no produce un stop negativo", () => {
    expect(resolveStopAsk(0.79, 5)).toBe(0);
  });
});

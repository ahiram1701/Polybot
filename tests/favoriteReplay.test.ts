import { describe, expect, it } from "vitest";

import { breakEvenWinRate, replayFavoriteSignals, settleFavoriteSignals } from "../src/favoriteReplay.js";
import type { AnalyticsQuotePoint, AnalyticsSample, AnalyticsTickPoint, MarketSymbol, Outcome } from "../src/types.js";

const WINDOW_START_MS = 0;
const END_MS = 300_000;
const OPENING = 100;

/**
 * Configuracion de los tests. La ventana de 120 s es holgada a proposito —deja sitio para colocar
 * varias cotizaciones y comprobar cual se elige—, pero el SUELO es el de verdad:
 * `DEFAULT_MIN_SECONDS_TO_END` = 10 s de `markets.ts`, y no los 45 de `FAVORITE_EXIT_MIN_SECONDS`,
 * que pertenecen al stop de VENTA. Confundirlos recorta del universo el tramo final, que es justo
 * donde la ventana ya esta resuelta.
 */
const PRODUCCION = {
  entryWindowSeconds: 120,
  minSecondsToEnd: 10,
  minAsk: 0.79,
  maxAsk: 0.9,
  maxAskSum: 1.15,
  maxAskSpread: 0.02,
  minCertainty: 1,
};

/**
 * Serie con tendencia limpia y ruido minusculo: mucha distancia sobre poca sigma, o sea z alto.
 * Termina en 120,01 partiendo de 100, con saltos de 0,5 cada 5 s.
 */
function ticksDecididos(): AnalyticsTickPoint[] {
  return serie((i) => OPENING + i * 0.5 + (i % 2 === 0 ? 0.01 : -0.01));
}

/** Serie que oscila fuerte y no va a ningun sitio: sigma grande sobre poca distancia, o sea z bajo. */
function ticksIndecisos(): AnalyticsTickPoint[] {
  return serie((i) => OPENING + (i % 2 === 0 ? 5 : -5));
}

function serie(precio: (i: number) => number, hasta = 40): AnalyticsTickPoint[] {
  const puntos: AnalyticsTickPoint[] = [];
  for (let i = 0; i <= hasta; i += 1) {
    const timestampMs = i * 5_000;
    const price = precio(i);
    puntos.push({
      timestampMs,
      secondsToEnd: (END_MS - timestampMs) / 1000,
      price,
      distanceUsd: price - OPENING,
    });
  }
  return puntos;
}

function quote(args: {
  secondsToEnd: number;
  upAsk?: number;
  downAsk?: number;
  upBid?: number;
  downBid?: number;
}): AnalyticsQuotePoint {
  const timestampMs = END_MS - args.secondsToEnd * 1000;
  return {
    timestampMs,
    secondsToEnd: args.secondsToEnd,
    upBestAsk: args.upAsk,
    downBestAsk: args.downAsk,
    // Por defecto un spread de un centimo, dentro del tope: asi los tests que no hablan del spread no
    // se caen por el sin decirlo.
    upBestBid: args.upBid ?? (args.upAsk === undefined ? undefined : args.upAsk - 0.01),
    downBestBid: args.downBid ?? (args.downAsk === undefined ? undefined : args.downAsk - 0.01),
  };
}

/**
 * La cotizacion del cierre que le da veredicto a la muestra.
 *
 * `scoringOutcome` exige un libro concluyente en los ultimos 30 s. Va a 5 s del cierre, o sea fuera de
 * cualquier ventana de entrada que estos tests usen: es el juez, no una oportunidad de entrar.
 */
function cierre(ganador: Outcome): AnalyticsQuotePoint {
  const alto = { ask: 0.999, bid: 0.995 };
  const bajo = { ask: 0.005, bid: 0.001 };
  const up = ganador === "UP" ? alto : bajo;
  const down = ganador === "UP" ? bajo : alto;
  return quote({ secondsToEnd: 5, upAsk: up.ask, upBid: up.bid, downAsk: down.ask, downBid: down.bid });
}

function muestra(args: {
  ganador: Outcome;
  quotes: AnalyticsQuotePoint[];
  ticks?: AnalyticsTickPoint[];
  market?: MarketSymbol;
  windowStartMs?: number;
}): AnalyticsSample {
  const windowStartMs = args.windowStartMs ?? WINDOW_START_MS;
  return {
    version: 1,
    market: args.market ?? "BTC",
    slug: `btc-updown-5m-${windowStartMs}`,
    windowStartMs,
    endMs: END_MS,
    openingPrice: OPENING,
    openingTickTimestampMs: windowStartMs,
    ticks: args.ticks ?? ticksDecididos(),
    quotes: [...args.quotes, cierre(args.ganador)],
  };
}

/**
 * Muestra de calentamiento: la PRIMERA de cada mercado solo alimenta el historial y no emite señal,
 * igual que en `replaySignals` y `simulateGate`. Sin esto todos los tests medirian cero.
 */
function calentamiento(): AnalyticsSample {
  return muestra({
    ganador: "UP",
    windowStartMs: -600_000,
    quotes: [quote({ secondsToEnd: 100, upAsk: 0.85, downAsk: 0.14 })],
  });
}

function replay(samples: AnalyticsSample[], params: Partial<typeof PRODUCCION> = {}) {
  return replayFavoriteSignals(samples, { ...PRODUCCION, ...params });
}

describe("replayFavoriteSignals", () => {
  it("entra en el favorito cuando la banda, el spread y la certeza dan permiso", () => {
    const { signals } = replay([
      calentamiento(),
      muestra({ ganador: "UP", quotes: [quote({ secondsToEnd: 100, upAsk: 0.85, downAsk: 0.14 })] }),
    ]);

    expect(signals).toHaveLength(1);
    expect(signals[0].outcome).toBe("UP");
    expect(signals[0].ask).toBe(0.85);
    expect(signals[0].won).toBe(true);
    expect(signals[0].secondsToEnd).toBe(100);
    expect(signals[0].z).toBeGreaterThan(1);
  });

  it("marca como fallo la entrada al lado que el libro acabo desmintiendo", () => {
    const { signals } = replay([
      calentamiento(),
      muestra({ ganador: "DOWN", quotes: [quote({ secondsToEnd: 100, upAsk: 0.85, downAsk: 0.14 })] }),
    ]);

    expect(signals[0].outcome).toBe("UP");
    expect(signals[0].won).toBe(false);
  });

  // La invariante que hace que el numero signifique algo. Un replay que mira el futuro siempre gana.
  it("no mira ni un tick posterior al instante de la decision", () => {
    // Hasta la entrada el precio no se ha movido de la apertura: z pequeño, la ventana NO esta
    // decidida. Justo despues pega un salto de 50 y se queda ahi. Un replay con look-ahead leeria ese
    // salto, veria una distancia enorme y entraria; el honesto se queda fuera.
    const conFuturo = serie((i) => (i <= 40 ? OPENING + (i % 2 === 0 ? 0.05 : -0.05) : OPENING + 50 + (i % 2 === 0 ? 0.05 : -0.05)), 50);

    const { signals, skips } = replay([
      calentamiento(),
      muestra({
        ganador: "UP",
        ticks: conFuturo,
        quotes: [quote({ secondsToEnd: 100, upAsk: 0.85, downAsk: 0.14 })],
      }),
    ]);

    expect(signals).toHaveLength(0);
    expect(skips.favorite_ventana_no_decidida).toBe(1);
  });

  // La otra invariante: el bot entra en cuanto puede, no elige la mejor cotizacion de la ventana.
  it("se queda con la PRIMERA cotizacion que califica, no con la mejor", () => {
    const { signals } = replay([
      calentamiento(),
      muestra({
        ganador: "UP",
        quotes: [
          quote({ secondsToEnd: 110, upAsk: 0.8, downAsk: 0.19 }),
          quote({ secondsToEnd: 60, upAsk: 0.88, downAsk: 0.11 }),
        ],
      }),
    ]);

    expect(signals).toHaveLength(1);
    expect(signals[0].ask).toBe(0.8);
    expect(signals[0].secondsToEnd).toBe(110);
  });

  it("ignora las cotizaciones de fuera de la ventana de entrada", () => {
    const { signals, skips } = replay([
      calentamiento(),
      muestra({
        ganador: "UP",
        // Una demasiado pronto (200 s) y otra pasado el suelo de 10 s: ninguna es operable.
        quotes: [
          quote({ secondsToEnd: 200, upAsk: 0.85, downAsk: 0.14 }),
          quote({ secondsToEnd: 8, upAsk: 0.85, downAsk: 0.14 }),
        ],
      }),
    ]);

    expect(signals).toHaveLength(0);
    expect(skips.sin_quotes_en_ventana).toBe(1);
  });

  it("rechaza el libro muerto: con los asks sumando de mas, el precio no es una probabilidad", () => {
    const { signals, skips } = replay([
      calentamiento(),
      muestra({ ganador: "UP", quotes: [quote({ secondsToEnd: 100, upAsk: 0.85, downAsk: 0.5 })] }),
    ]);

    expect(signals).toHaveLength(0);
    expect(skips.favorite_dead_book).toBe(1);
  });

  it("rechaza al favorito fuera de banda por arriba y por abajo", () => {
    const barato = replay([
      calentamiento(),
      muestra({ ganador: "UP", quotes: [quote({ secondsToEnd: 100, upAsk: 0.7, downAsk: 0.29 })] }),
    ]);
    const caro = replay([
      calentamiento(),
      muestra({ ganador: "UP", quotes: [quote({ secondsToEnd: 100, upAsk: 0.95, downAsk: 0.04 })] }),
    ]);

    expect(barato.skips.favorite_below_band).toBe(1);
    expect(caro.skips.favorite_above_band).toBe(1);
  });

  it("rechaza el libro ancho, que es pagar el spread creyendo que compras un favorito", () => {
    const { signals, skips } = replay([
      calentamiento(),
      muestra({
        ganador: "UP",
        quotes: [quote({ secondsToEnd: 100, upAsk: 0.85, upBid: 0.75, downAsk: 0.14 })],
      }),
    ]);

    expect(signals).toHaveLength(0);
    expect(skips.spread_too_wide).toBe(1);
  });

  // Mismo criterio que `buildTradeCandidate`: cerca del cierre el ganador se queda sin libro con
  // normalidad, y convertir esa laguna en un veto seria inventar politica.
  it("no rechaza por spread cuando sencillamente no hay bid", () => {
    const { signals } = replay([
      calentamiento(),
      muestra({
        ganador: "UP",
        quotes: [quote({ secondsToEnd: 100, upAsk: 0.85, upBid: undefined, downAsk: 0.14 })],
      }),
    ]);

    expect(signals).toHaveLength(1);
  });

  it("descarta la ventana que todavia no esta decidida", () => {
    const { signals, skips } = replay([
      calentamiento(),
      muestra({
        ganador: "UP",
        ticks: ticksIndecisos(),
        quotes: [quote({ secondsToEnd: 100, upAsk: 0.85, downAsk: 0.14 })],
      }),
    ]);

    expect(signals).toHaveLength(0);
    expect(skips.favorite_ventana_no_decidida).toBe(1);
  });

  it("con el filtro de certeza apagado, esa misma ventana si entra", () => {
    const { signals } = replay(
      [
        calentamiento(),
        muestra({
          ganador: "UP",
          ticks: ticksIndecisos(),
          quotes: [quote({ secondsToEnd: 100, upAsk: 0.85, downAsk: 0.14 })],
        }),
      ],
      { minCertainty: Number.NEGATIVE_INFINITY },
    );

    expect(signals).toHaveLength(1);
    expect(signals[0].z).toBeLessThan(1);
  });

  // Una laguna del feed no es politica de riesgo. Es la misma decision que toma `buildTradeSignal`.
  it("una lectura de certeza AUSENTE no bloquea la entrada", () => {
    const { signals } = replay([
      calentamiento(),
      muestra({
        ganador: "UP",
        // Cuatro ticks: menos de los seis saltos que `readWindowCertainty` exige para estimar sigma.
        ticks: serie((i) => OPENING + i * 0.5, 3),
        quotes: [quote({ secondsToEnd: 100, upAsk: 0.85, downAsk: 0.14 })],
      }),
    ]);

    expect(signals).toHaveLength(1);
    expect(signals[0].z).toBeUndefined();
  });

  it("descarta la ventana sin veredicto fiable en vez de inventarle un ganador", () => {
    const sinCierre: AnalyticsSample = {
      ...muestra({ ganador: "UP", quotes: [quote({ secondsToEnd: 100, upAsk: 0.85, downAsk: 0.14 })] }),
      // Se queda solo con la cotizacion de entrada: el libro nunca llego a ser concluyente.
      quotes: [quote({ secondsToEnd: 100, upAsk: 0.85, downAsk: 0.14 })],
    };

    const { signals, skips } = replay([calentamiento(), sinCierre]);

    expect(signals).toHaveLength(0);
    expect(skips.sin_veredicto).toBe(1);
  });

  it("la primera ventana de cada mercado solo alimenta el historial", () => {
    const entrada = (market: MarketSymbol, windowStartMs: number) =>
      muestra({ ganador: "UP", market, windowStartMs, quotes: [quote({ secondsToEnd: 100, upAsk: 0.85, downAsk: 0.14 })] });

    const { signals, windows } = replay([
      entrada("BTC", 0),
      entrada("ETH", 60_000),
      entrada("BTC", 120_000),
    ]);

    expect(windows).toBe(3);
    // BTC estrena historial en la primera y opera en la segunda; ETH se queda en su estreno.
    expect(signals).toHaveLength(1);
    expect(signals[0].market).toBe("BTC");
  });
});

describe("breakEvenWinRate", () => {
  // La cifra contra la que se compara el acierto. Sin ella un 84% parece bueno y es una perdida.
  it("es el ask mas la comision, que muerde mas cerca del 50 que en los extremos", () => {
    expect(breakEvenWinRate(0.85, 700)).toBeCloseTo(0.85 + 0.07 * 0.85 * 0.15, 10);
    expect(breakEvenWinRate(0.85, 0)).toBe(0.85);
  });
});

describe("settleFavoriteSignals", () => {
  it("liquida sin gate de EV: el acierto cobra la participacion entera y el fallo pierde el stake", () => {
    const { signals } = replay([
      calentamiento(),
      muestra({ ganador: "UP", quotes: [quote({ secondsToEnd: 100, upAsk: 0.8, downAsk: 0.19 })] }),
    ]);
    const [ganada] = settleFavoriteSignals(signals, { stakeUsd: 5, feeRateBps: 700 });

    // 5 $ a 0,80 son 6,25 participaciones; la comision es 6,25 x 0,07 x 0,80 x 0,20.
    const fee = 6.25 * 0.07 * 0.8 * 0.2;
    expect(ganada.netUsd).toBeCloseTo(6.25 - 5 - fee, 4);
    expect(ganada.stakeUsd).toBeCloseTo(5 + fee, 4);
  });
});

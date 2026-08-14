import { describe, expect, it, vi } from "vitest";

import { ChainlinkPriceFeed, parseChainlinkTick, parseChainlinkTicks, parseTwapPoint } from "../src/chainlinkPriceFeed.js";
import type { PriceTick } from "../src/types.js";

function feedWith(ticks: PriceTick[]): ChainlinkPriceFeed {
  const feed = new ChainlinkPriceFeed("wss://unused.example");
  const internals = feed as unknown as { rememberTick(tick: PriceTick): void };
  for (const tick of ticks) {
    internals.rememberTick(tick);
  }
  return feed;
}

function tick(timestampMs: number, value: number): PriceTick {
  return { market: "ETH", symbol: "eth/usd", value, timestampMs, receivedAtMs: timestampMs };
}

describe("getOpeningTick", () => {
  const START = 1_784_300_000_000;
  const GRACE = 15_000;

  it("prefers the last tick at-or-before the window start (official criterion)", () => {
    // A post-open spike must NOT become the opening reference when a pre-open tick exists.
    const feed = feedWith([tick(START - 3_000, 1830.2), tick(START + 5_000, 1832.0)]);
    expect(feed.getOpeningTick("ETH", START, GRACE)).toMatchObject({ value: 1830.2 });
  });

  it("accepts a tick exactly at the boundary", () => {
    const feed = feedWith([tick(START - 8_000, 1829.9), tick(START, 1830.5)]);
    expect(feed.getOpeningTick("ETH", START, GRACE)).toMatchObject({ value: 1830.5 });
  });

  it("falls back to the first post-open tick within grace on cold start", () => {
    const feed = feedWith([tick(START + 4_000, 1831.1), tick(START + 9_000, 1833.0)]);
    expect(feed.getOpeningTick("ETH", START, GRACE)).toMatchObject({ value: 1831.1 });
  });

  it("returns undefined when nothing falls inside the grace window", () => {
    const feed = feedWith([tick(START - 60_000, 1820.0)]);
    expect(feed.getOpeningTick("ETH", START, GRACE)).toBeUndefined();
  });
});

describe("Chainlink RTDS parser", () => {
  it("parses the legacy crypto_prices_chainlink tick format", () => {
    expect(
      parseChainlinkTick({
        topic: "crypto_prices_chainlink",
        payload: {
          symbol: "eth/usd",
          value: "2290.5",
          timestamp: "1778197500000",
        },
      }),
    ).toMatchObject({
      market: "ETH",
      symbol: "eth/usd",
      value: 2290.5,
      timestampMs: 1778197500000,
    });
  });

  it("parses the current crypto_prices history payload and keeps the latest point", () => {
    const message = {
      topic: "crypto_prices",
      payload: {
        symbol: "doge/usd",
        data: [
          { timestamp: 1778197499000, value: 0.1077501274199228 },
          { timestamp: 1778197500000, value: 0.1077480926584616 },
        ],
      },
    };

    expect(parseChainlinkTicks(message)).toHaveLength(2);
    expect(parseChainlinkTick(message)).toMatchObject({
      market: "DOGE",
      symbol: "doge/usd",
      value: 0.1077480926584616,
      timestampMs: 1778197500000,
    });
  });

  it("ignores unsupported symbols", () => {
    expect(
      parseChainlinkTick({
        topic: "crypto_prices",
        payload: {
          symbol: "sol/usd",
          data: [{ timestamp: 1778197500000, value: 150 }],
        },
      }),
    ).toBeNull();
  });
});

/**
 * La suscripcion usa comodin (`type: "*"`). Chainlink publica TWAPs de 30 y 60 segundos, y si algun
 * dia aparecen bajo el mismo topic entrarian solas en la serie. Mezclar spot con medias temporales
 * corrompe a la vez el precio de APERTURA y la DISTANCIA — los dos terminos de la señal — y encima
 * de forma coherente consigo misma, que es como un error asi se vuelve invisible.
 */
describe("parseChainlinkTicks: no mezclar TWAP con spot", () => {
  const spot = {
    topic: "crypto_prices_chainlink",
    type: "update",
    payload: { symbol: "btc/usd", value: 64764.99, timestamp: 1785955725000 },
  };

  it("acepta el tick spot normal", () => {
    expect(parseChainlinkTicks(spot)).toHaveLength(1);
  });

  it("rechaza un payload marcado con ventana temporal (TWAP)", () => {
    expect(parseChainlinkTicks({ ...spot, payload: { ...spot.payload, windowSeconds: 30 } })).toEqual([]);
    expect(parseChainlinkTicks({ ...spot, payload: { ...spot.payload, windowSeconds: 60 } })).toEqual([]);
  });

  it("rechaza un payload con feedID (feed personalizado, no la serie spot)", () => {
    expect(parseChainlinkTicks({ ...spot, payload: { ...spot.payload, feedID: "0xabc" } })).toEqual([]);
  });
});

/**
 * El 2026-08-08 un corte de red tiro el websocket y el feed se quedo congelado SIETE HORAS, con el
 * proceso vivo y la salud en verde. La cadena de reconexion tenia un punto unico de fallo: si
 * `connect()` lanzaba dentro del timer, `reconnectTimer` ya estaba limpio y `pingTimer` tambien, asi
 * que no quedaba ningun temporizador que pudiera reintentar. Nunca mas.
 */
describe("el feed no puede quedarse muerto", () => {
  it("una excepcion al conectar NO rompe la cadena de reintentos", async () => {
    vi.useFakeTimers();
    let intentos = 0;
    const feed = new ChainlinkPriceFeed("wss://ejemplo-invalido");
    // `connect` es privado a proposito; se sustituye para simular el `new WebSocket()` que lanza.
    (feed as unknown as { connect: () => void }).connect = () => {
      intentos += 1;
      throw new Error("getaddrinfo ENOTFOUND");
    };
    try {
      feed.start();
      expect(intentos).toBe(1);
      // Sin el try/catch, aqui no volveria a intentarse jamas.
      for (let i = 0; i < 4; i += 1) {
        await vi.advanceTimersByTimeAsync(15_000);
      }
      expect(intentos).toBeGreaterThan(1);
    } finally {
      feed.stop();
      vi.useRealTimers();
    }
  });

  it("informa de cuanto lleva sin ticks, que es la unica medida de si ve el mercado", () => {
    const feed = new ChainlinkPriceFeed("wss://ejemplo");
    // Sin ticks todavia: `undefined`, no cero. Recien arrancado no es lo mismo que ciego.
    expect(feed.msSinceLastTick()).toBeUndefined();
  });
});

/**
 * Desde el 2026-08-07 estos mercados resuelven por la serie TWAP, no por spot, y sus reglas lo dicen
 * sin ambiguedad: "no segun ninguna otra fuente ni mercados spot". Son dos series que miden cosas
 * distintas y mezclarlas corromperia a la vez el precio de apertura y la distancia — los dos terminos
 * de la señal — sin dar la cara.
 */
describe("serie spot y serie TWAP, separadas", () => {
  it("un payload con window_s NO entra en la serie spot", () => {
    // `window_s` es la forma REAL del payload RTDS, verificada en vivo. El guardia solo miraba
    // `windowSeconds` (la del cliente tipado), asi que la de verdad se habria colado.
    expect(
      parseChainlinkTicks({
        topic: "crypto_prices_chainlink",
        payload: { symbol: "btc/usd", value: 64000, timestamp: 1786000000000, window_s: 30 },
      }),
    ).toHaveLength(0);
  });

  it("tampoco entra con windowSeconds ni con feedID", () => {
    for (const marca of [{ windowSeconds: 30 }, { feedID: "0xabc" }]) {
      expect(
        parseChainlinkTicks({
          payload: { symbol: "btc/usd", value: 64000, timestamp: 1786000000000, ...marca },
        }),
      ).toHaveLength(0);
    }
  });

  it("un valor TWAP sin su marca de ventana se rechaza: sin ella no es un TWAP", () => {
    // Aceptarlo seria colar un precio spot en la serie que decide quien gana.
    expect(parseTwapPoint({ symbol: "btc/usd", value: 64000, timestamp: 1786000000000 })).toBeUndefined();
  });

  it("con su marca de ventana si se lee, y dice de que ventana es", () => {
    const punto = parseTwapPoint({ symbol: "btc/usd", value: 64000, timestamp: 1786000000000, window_s: 30 });
    expect(punto?.tick.market).toBe("BTC");
    expect(punto?.tick.value).toBe(64000);
    // La VENTANA viaja con el dato. Sin ella no se sabe si esa serie resuelve el mercado o no.
    expect(punto?.windowSeconds).toBe(30);
  });

  it("sin serie TWAP no inventa un sustituto", () => {
    const feed = new ChainlinkPriceFeed("wss://ejemplo");
    expect(feed.getLatestTwapTick("BTC", 60)).toBeUndefined();
    expect(feed.getTwapAtOrBefore("BTC", Date.now(), 60)).toBeUndefined();
  });

  it("las series de 30 s y 60 s conviven sin pisarse", () => {
    // Polymarket paso los mercados de 5 minutos de 30 a 60 segundos. Guardar "el TWAP" sin distinguir
    // la ventana significaba que el ultimo mensaje en llegar machacaba al otro, y el bot leia una
    // mezcla de dos series distintas creyendo que era una.
    const feed = new ChainlinkPriceFeed("wss://ejemplo") as unknown as {
      handleTwapMessage(m: unknown): boolean;
      getLatestTwapTick(market: string, windowSeconds: number): { value: number } | undefined;
    };
    const mensaje = (topic: string, ventana: number, valor: number) => ({
      topic,
      payload: { symbol: "btc/usd", value: valor, timestamp: 1786000000000, window_s: ventana },
    });
    expect(feed.handleTwapMessage(mensaje("crypto_prices_twap_thirty", 30, 64000))).toBe(true);
    expect(feed.handleTwapMessage(mensaje("crypto_prices_twap_sixty", 60, 65000))).toBe(true);

    expect(feed.getLatestTwapTick("BTC", 30)?.value).toBe(64000);
    expect(feed.getLatestTwapTick("BTC", 60)?.value).toBe(65000);
  });

  it("la ventana sale del PAYLOAD, no del nombre del topic", () => {
    // Asi un topic renombrado, o uno tercero, no rompe la indexacion: manda el dato.
    const feed = new ChainlinkPriceFeed("wss://ejemplo") as unknown as {
      handleTwapMessage(m: unknown): boolean;
      getLatestTwapTick(market: string, windowSeconds: number): { value: number } | undefined;
    };
    feed.handleTwapMessage({
      topic: "crypto_prices_twap_thirty",
      payload: { symbol: "btc/usd", value: 70000, timestamp: 1786000000001, window_s: 60 },
    });
    expect(feed.getLatestTwapTick("BTC", 60)?.value).toBe(70000);
    expect(feed.getLatestTwapTick("BTC", 30)).toBeUndefined();
  });
});

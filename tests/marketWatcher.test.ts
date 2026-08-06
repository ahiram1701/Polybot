import { describe, expect, it } from "vitest";

import { MarketWatcher, parseGammaEvent } from "../src/marketWatcher.js";

describe("Gamma market parser", () => {
  it("maps Up/Down outcomes to CLOB token IDs", () => {
    const market = parseGammaEvent(
      {
        title: "Bitcoin Up or Down",
        markets: [
          {
            slug: "btc-updown-5m-1778127900",
            question: "Bitcoin Up or Down - test",
            conditionId: "0xabc",
            outcomes: JSON.stringify(["Up", "Down"]),
            clobTokenIds: JSON.stringify(["up-token", "down-token"]),
            outcomePrices: JSON.stringify(["0.51", "0.49"]),
            endDate: "2026-05-07T04:30:00Z",
            eventStartTime: "2026-05-07T04:25:00Z",
            acceptingOrders: true,
            active: true,
            closed: false,
            orderPriceMinTickSize: 0.01,
            orderMinSize: 5,
            negRisk: false,
          },
        ],
      },
      "btc-updown-5m-1778127900",
    );

    expect(market.outcomes.UP.tokenId).toBe("up-token");
    expect(market.outcomes.DOWN.tokenId).toBe("down-token");
    expect(market.asset).toBe("BTC");
    expect(market.tickSize).toBe("0.01");
    expect(market.orderMinSize).toBe(5);
  });

  it("detects DOGE markets from the slug prefix", () => {
    const market = parseGammaEvent(
      {
        title: "Dogecoin Up or Down",
        markets: [
          {
            slug: "doge-updown-5m-1778127900",
            question: "Dogecoin Up or Down - test",
            conditionId: "0xdoge",
            outcomes: JSON.stringify(["Up", "Down"]),
            clobTokenIds: JSON.stringify(["doge-up", "doge-down"]),
            outcomePrices: JSON.stringify(["0.51", "0.49"]),
            endDate: "2026-05-07T04:30:00Z",
            eventStartTime: "2026-05-07T04:25:00Z",
            acceptingOrders: true,
            active: true,
            closed: false,
            orderPriceMinTickSize: 0.01,
            orderMinSize: 5,
            negRisk: false,
          },
        ],
      },
      "doge-updown-5m-1778127900",
    );

    expect(market.asset).toBe("DOGE");
    expect(market.outcomes.UP.tokenId).toBe("doge-up");
  });
});

/**
 * Un fetch lento a gamma no puede dejar ciego al bot. Antes `getCurrentMarkets` usaba `Promise.all`
 * (falla-rapido) y la excepcion tumbaba la iteracion COMPLETA de los tres mercados: se perdian
 * apertura, analitica, arbitraje y entrada por culpa de uno solo.
 */
describe("MarketWatcher: resiliencia de red", () => {
  const gammaEvent = (slug: string) => ({
    title: "Bitcoin Up or Down",
    markets: [
      {
        slug,
        question: "Bitcoin Up or Down - test",
        conditionId: "0xabc",
        outcomes: JSON.stringify(["Up", "Down"]),
        clobTokenIds: JSON.stringify(["up-token", "down-token"]),
        outcomePrices: JSON.stringify(["0.51", "0.49"]),
        endDate: "2026-05-07T04:30:00Z",
        eventStartTime: "2026-05-07T04:25:00Z",
        acceptingOrders: true,
        active: true,
        closed: false,
        orderPriceMinTickSize: 0.01,
        orderMinSize: 5,
        negRisk: false,
      },
    ],
  });
  const ok = (slug: string) =>
    ({ status: 200, ok: true, json: async () => gammaEvent(slug) }) as unknown as Response;

  it("sirve la cache CADUCADA cuando la red falla, en vez de quedarse sin mercado", async () => {
    let calls = 0;
    const fetchFn = (async (url: string) => {
      calls += 1;
      if (calls === 1) {
        return ok(String(url).split("/").pop()!);
      }
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    // TTL de 1ms: la segunda llamada ya encuentra la entrada caducada y tiene que ir a la red.
    const watcher = new MarketWatcher("https://gamma.test", fetchFn, 1);

    const first = await watcher.getMarketBySlug("btc-updown-5m-1778127900", 1_000);
    expect(first?.slug).toBe("btc-updown-5m-1778127900");

    // Dentro de una ventana de 5 min el slug y los tokenIds no cambian: un dato de hace segundos
    // vale, y es infinitamente mejor que perder la ventana de entrada.
    const stale = await watcher.getMarketBySlug("btc-updown-5m-1778127900", 60_000);
    expect(stale?.slug).toBe("btc-updown-5m-1778127900");
    expect(calls).toBe(2);
  });

  it("un mercado caido no impide devolver los demas", async () => {
    const fetchFn = (async (url: string) => {
      const slug = String(url).split("/").pop()!;
      if (slug.startsWith("eth")) {
        throw new TypeError("fetch failed");
      }
      return ok(slug);
    }) as unknown as typeof fetch;
    const watcher = new MarketWatcher("https://gamma.test", fetchFn);

    const markets = await watcher.getCurrentMarkets(["BTC", "ETH", "DOGE"], Date.UTC(2026, 4, 7, 4, 27));

    expect(markets.map((market) => market.asset).sort()).toEqual(["BTC", "DOGE"]);
  });

  it("pero un apagon TOTAL si se propaga: quien llama en one-shot debe enterarse", async () => {
    const fetchFn = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const watcher = new MarketWatcher("https://gamma.test", fetchFn);

    await expect(
      watcher.getCurrentMarkets(["BTC", "ETH", "DOGE"], Date.UTC(2026, 4, 7, 4, 27)),
    ).rejects.toThrow("fetch failed");
  });
});

/**
 * Gamma se repreguntaba cada 5s para los tres mercados, con un timeout de 5s — mas largo que el propio
 * intervalo del bucle. Una peticion atascada bloqueaba la iteracion entera. Pero dentro de una ventana
 * de 5 minutos los metadatos son inmutables (slug, tokenIds, endMs); solo cambian en los bordes.
 */
describe("MarketWatcher: cache y timeout segun lo que hay en juego", () => {
  const WINDOW_START_MS = 1778127900_000;
  const SLUG = "btc-updown-5m-1778127900";

  function eventoGamma() {
    return {
      title: "Bitcoin Up or Down",
      markets: [
        {
          slug: SLUG,
          question: "Bitcoin Up or Down - test",
          conditionId: "0xabc",
          outcomes: JSON.stringify(["Up", "Down"]),
          clobTokenIds: JSON.stringify(["up-token", "down-token"]),
          outcomePrices: JSON.stringify(["0.51", "0.49"]),
          endDate: new Date(WINDOW_START_MS + 300_000).toISOString(),
          eventStartTime: new Date(WINDOW_START_MS).toISOString(),
          acceptingOrders: true,
          active: true,
          closed: false,
          orderPriceMinTickSize: 0.01,
          orderMinSize: 5,
          negRisk: false,
        },
      ],
    };
  }

  function watcherEspia() {
    let llamadas = 0;
    const fetchFn = (async () => {
      llamadas += 1;
      return { ok: true, status: 200, json: async () => eventoGamma() } as unknown as Response;
    }) as unknown as typeof fetch;
    return { fetchFn, llamadas: () => llamadas };
  }

  it("en mitad de la ventana no repregunta a gamma: los metadatos no cambian", async () => {
    const espia = watcherEspia();
    const watcher = new MarketWatcher("https://gamma.test", espia.fetchFn);
    // 150s dentro de una ventana de 300s: lejos de los dos bordes.
    const medio = WINDOW_START_MS + 150_000;
    await watcher.getMarketBySlug(SLUG, medio);
    await watcher.getMarketBySlug(SLUG, medio + 10_000);
    await watcher.getMarketBySlug(SLUG, medio + 30_000);
    expect(espia.llamadas()).toBe(1);
  });

  it("cerca del cierre SI repregunta: ahi es donde cambia el estado", async () => {
    const espia = watcherEspia();
    const watcher = new MarketWatcher("https://gamma.test", espia.fetchFn);
    // A 10s del cierre, dentro del margen de borde.
    const cerca = WINDOW_START_MS + 290_000;
    await watcher.getMarketBySlug(SLUG, cerca);
    await watcher.getMarketBySlug(SLUG, cerca + 6_000);
    expect(espia.llamadas()).toBe(2);
  });

  it("recien abierta tambien repregunta: el mercado acaba de aparecer", async () => {
    const espia = watcherEspia();
    const watcher = new MarketWatcher("https://gamma.test", espia.fetchFn);
    await watcher.getMarketBySlug(SLUG, WINDOW_START_MS + 5_000);
    await watcher.getMarketBySlug(SLUG, WINDOW_START_MS + 11_000);
    expect(espia.llamadas()).toBe(2);
  });

  it("un fallo al refrescar sirve el dato rancio en vez de perder la ventana", async () => {
    let fallar = false;
    const fetchFn = (async () => {
      if (fallar) {
        throw new Error("The operation was aborted due to timeout");
      }
      return { ok: true, status: 200, json: async () => eventoGamma() } as unknown as Response;
    }) as unknown as typeof fetch;
    const watcher = new MarketWatcher("https://gamma.test", fetchFn);
    const cerca = WINDOW_START_MS + 290_000;
    const primero = await watcher.getMarketBySlug(SLUG, cerca);
    expect(primero?.slug).toBe(SLUG);
    fallar = true;
    const rancio = await watcher.getMarketBySlug(SLUG, cerca + 6_000);
    expect(rancio?.slug).toBe(SLUG);
  });

  it("sin nada cacheado el fallo SI sube: no hay dato viejo que servir", async () => {
    const fetchFn = (async () => {
      throw new Error("The operation was aborted due to timeout");
    }) as unknown as typeof fetch;
    const watcher = new MarketWatcher("https://gamma.test", fetchFn);
    await expect(watcher.getMarketBySlug(SLUG, WINDOW_START_MS + 150_000)).rejects.toThrow("timeout");
  });
});

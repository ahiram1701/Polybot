import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PerpsMarketData } from "../src/perpsClient.js";
import { PerpsLoop } from "../src/perpsLoop.js";
import { PerpsRecorder } from "../src/perpsRecorder.js";
import { FIVE_MINUTES_MS } from "../src/time.js";
import type { PerpsInstrumentInfo, PerpsQuote } from "../src/perpsTypes.js";

const temporales: string[] = [];

function dirTemporal(): string {
  const dir = mkdtempSync(join(tmpdir(), "polybot-perpsloop-"));
  temporales.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(temporales.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function instrumento(instrumentId: number, symbol: string): PerpsInstrumentInfo {
  return {
    instrumentId,
    symbol,
    category: "crypto",
    baseAsset: symbol.split("-")[0],
    quoteAsset: "USD",
    fundingIntervalHours: 1,
    priceDecimals: 1,
    quantityDecimals: 5,
    minNotionalUsd: 10,
    maxMarketNotionalUsd: 1_000_000,
    maxLimitNotionalUsd: 1_000_000,
    maxLeverage: 20,
    isolatedOnly: false,
    liquidationFee: 0.01,
    riskTiers: [],
  };
}

function quote(instrumentId: number, symbol: string): PerpsQuote {
  return {
    instrumentId,
    symbol,
    quotedAtMs: 0,
    bestBid: 99,
    bestAsk: 101,
    mid: 100,
    markPrice: 100,
    indexPrice: 100,
    fundingRate: 0.0001,
    rawAskLevels: [{ price: 101, size: 10 }],
    rawBidLevels: [{ price: 99, size: 10 }],
    availableAskNotionalUsd: 1_010,
    availableBidNotionalUsd: 990,
  };
}

const CATALOGO = [instrumento(6, "BTC-USD"), instrumento(7, "ETH-USD")];
const BASE = 1_757_000_000_000 - (1_757_000_000_000 % FIVE_MINUTES_MS);

function marketData(overrides: Partial<PerpsMarketData> = {}): PerpsMarketData {
  return {
    instruments: vi.fn(async () => CATALOGO),
    quote: vi.fn(async (instrument: PerpsInstrumentInfo) => quote(instrument.instrumentId, instrument.symbol)),
    ticker: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as PerpsMarketData;
}

describe("PerpsLoop", () => {
  it("observa los instrumentos configurados", async () => {
    const recorder = new PerpsRecorder(dirTemporal());
    const loop = new PerpsLoop({
      marketData: marketData(),
      recorder,
      instruments: ["BTC-USD", "ETH-USD"],
      now: () => BASE,
    });
    const resumen = await loop.pasada(BASE + 1_000);
    expect(resumen.observados).toBe(2);
    expect(resumen.instrumentos).toEqual(["BTC-USD", "ETH-USD"]);
    expect(recorder.activeSamples()).toHaveLength(2);
  });

  it("un fallo en UN instrumento no tumba la pasada", async () => {
    const data = marketData({
      quote: vi.fn(async (instrument: PerpsInstrumentInfo) => {
        if (instrument.symbol === "BTC-USD") {
          throw new Error("libro caido");
        }
        return quote(instrument.instrumentId, instrument.symbol);
      }),
    } as unknown as Partial<PerpsMarketData>);
    const loop = new PerpsLoop({
      marketData: data,
      recorder: new PerpsRecorder(dirTemporal()),
      instruments: ["BTC-USD", "ETH-USD"],
      now: () => BASE,
    });
    // Es literalmente la misma leccion que el maker aprendio con su `Promise.all`.
    const resumen = await loop.pasada(BASE + 1_000);
    expect(resumen.observados).toBe(1);
    expect(resumen.instrumentos).toHaveLength(2);
  });

  it("reporta los simbolos que el catalogo no trae", async () => {
    const loop = new PerpsLoop({
      marketData: marketData(),
      recorder: new PerpsRecorder(dirTemporal()),
      instruments: ["BTC-USD", "NVDA-USD"],
      now: () => BASE,
    });
    const resumen = await loop.pasada(BASE + 1_000);
    expect(resumen.faltantes).toEqual(["NVDA-USD"]);
    expect(resumen.observados).toBe(1);
  });

  it("sin catalogo legible NO observa nada y lo dice", async () => {
    const loop = new PerpsLoop({
      marketData: marketData({ instruments: vi.fn(async () => undefined) } as unknown as Partial<PerpsMarketData>),
      recorder: new PerpsRecorder(dirTemporal()),
      now: () => BASE,
    });
    const resumen = await loop.pasada(BASE + 1_000);
    // `sinCatalogo` distingue "no pude leer" de "no hay instrumentos", que es la misma distincion que
    // el cliente conserva y la que evita tratar un fallo de red como una politica.
    expect(resumen.sinCatalogo).toBe(true);
    expect(resumen.observados).toBe(0);
  });

  it("conserva el ultimo catalogo bueno cuando la relectura falla", async () => {
    let devolver: PerpsInstrumentInfo[] | undefined = CATALOGO;
    let ahora = BASE;
    const loop = new PerpsLoop({
      marketData: marketData({
        instruments: vi.fn(async () => devolver),
      } as unknown as Partial<PerpsMarketData>),
      recorder: new PerpsRecorder(dirTemporal()),
      instruments: ["BTC-USD"],
      now: () => ahora,
    });
    expect((await loop.pasada(ahora)).observados).toBe(1);

    devolver = undefined;
    ahora = BASE + 20 * 60_000;
    expect((await loop.pasada(ahora)).observados).toBe(1);
  });

  it("pasa el TWAP de Chainlink del activo equivalente", async () => {
    const recorder = new PerpsRecorder(dirTemporal());
    const oracleTwap = vi.fn(() => 100_000);
    const loop = new PerpsLoop({
      marketData: marketData(),
      recorder,
      instruments: ["BTC-USD"],
      oracleTwap,
      now: () => BASE,
    });
    await loop.pasada(BASE + 1_000);
    expect(oracleTwap).toHaveBeenCalledWith("BTC", BASE + 1_000);
    expect(recorder.activeSamples()[0].ticks[0].chainlinkTwapPrice).toBe(100_000);
  });

  it("detener guarda los cubos en curso", async () => {
    const recorder = new PerpsRecorder(dirTemporal());
    const loop = new PerpsLoop({
      marketData: marketData(),
      recorder,
      instruments: ["BTC-USD", "ETH-USD"],
      now: () => BASE,
    });
    await loop.pasada(BASE + 1_000);
    expect(await loop.detener(BASE + 2_000)).toBe(2);
    expect(recorder.activeSamples()).toHaveLength(0);
  });

  it("prefiere el ticker del feed al del REST", async () => {
    const data = marketData();
    const feed = {
      start: vi.fn(),
      stop: vi.fn(),
      ticker: vi.fn(() => ({ instrumentId: 6, markPrice: 123, receivedAtMs: 0 })),
      bbo: vi.fn(),
    };
    const loop = new PerpsLoop({
      marketData: data,
      recorder: new PerpsRecorder(dirTemporal()),
      feed: feed as never,
      instruments: ["BTC-USD"],
      now: () => BASE,
    });
    await loop.pasada(BASE + 1_000);
    expect(feed.start).toHaveBeenCalledWith([6]);
    // El tercer argumento de `quote` es el ticker ya conocido: con el, no se pide por REST.
    expect((data.quote as unknown as ReturnType<typeof vi.fn>).mock.calls[0][2]).toMatchObject({ markPrice: 123 });
  });
});

import { describe, expect, it, vi } from "vitest";

import { PerpsMarketData, summarizePerpsBook, toInstrumentInfo, type PerpsReader } from "../src/perpsClient.js";
import { oracleMarketForPerp, resolveMaxLeverage, selectPerpsInstruments } from "../src/perpsMarkets.js";
import type { PerpsInstrumentInfo } from "../src/perpsTypes.js";

const CRUDO = {
  id: 6,
  type: "PERPETUAL",
  category: "crypto",
  symbol: "BTC-USD",
  baseAsset: "BTC",
  quoteAsset: "USD",
  fundingInterval: "1h",
  quantityDecimals: 5,
  priceDecimals: 1,
  priceBounds: "0.1",
  liquidationFee: "0.01",
  maxOrderCount: 20,
  minNotional: "10",
  maxMarketNotional: "1000000",
  maxLimitNotional: "1000000",
  maxLeverage: 20,
  isolatedOnly: false,
  riskTiers: [{ lowerBound: "0", maxLeverage: 20 }],
} as unknown as Parameters<typeof toInstrumentInfo>[0];

function reader(overrides: Partial<PerpsReader> = {}): PerpsReader {
  return {
    fetchPerpsInstruments: vi.fn(async () => [CRUDO]),
    fetchPerpsTickers: vi.fn(async () => []),
    fetchPerpsBook: vi.fn(async () => ({
      instrumentId: 6,
      bids: [],
      asks: [],
      timestamp: 0,
      sequence: 1,
    })) as unknown as PerpsReader["fetchPerpsBook"],
    ...overrides,
  } as PerpsReader;
}

describe("normalizacion de instrumentos", () => {
  it("pasa las cadenas decimales a numeros", () => {
    const info = toInstrumentInfo(CRUDO);
    expect(info).toMatchObject({
      instrumentId: 6,
      symbol: "BTC-USD",
      minNotionalUsd: 10,
      maxLeverage: 20,
      fundingIntervalHours: 1,
      liquidationFee: 0.01,
    });
  });
});

describe("summarizePerpsBook", () => {
  const instrumento = toInstrumentInfo(CRUDO);

  it("ordena los niveles y calcula profundidad en NOCIONAL", () => {
    const quote = summarizePerpsBook(
      instrumento,
      {
        instrumentId: 6,
        asks: [
          { price: "102", quantity: "1" },
          { price: "101", quantity: "2" },
        ],
        bids: [
          { price: "98", quantity: "1" },
          { price: "99", quantity: "2" },
        ],
        timestamp: 0,
        sequence: 1,
      } as never,
      { markPrice: 100.5, fundingRate: 0.0001 },
      1_234,
    );
    expect(quote.bestAsk).toBe(101);
    expect(quote.bestBid).toBe(99);
    expect(quote.mid).toBe(100);
    expect(quote.markPrice).toBe(100.5);
    expect(quote.availableAskNotionalUsd).toBeCloseTo(101 * 2 + 102 * 1, 6);
    expect(quote.quotedAtMs).toBe(1_234);
  });

  it("descarta niveles con precio o tamano no positivos", () => {
    const quote = summarizePerpsBook(
      instrumento,
      {
        instrumentId: 6,
        asks: [
          { price: "0", quantity: "5" },
          { price: "101", quantity: "0" },
          { price: "102", quantity: "1" },
        ],
        bids: [],
        timestamp: 0,
        sequence: 1,
      } as never,
      undefined,
      0,
    );
    expect(quote.rawAskLevels).toEqual([{ price: 102, size: 1 }]);
  });
});

describe("PerpsMarketData: cache del catalogo", () => {
  it("cachea el acierto y no repite la peticion", async () => {
    const r = reader();
    let ahora = 0;
    const data = new PerpsMarketData(r, { now: () => ahora });
    await data.instruments();
    ahora = 1_000;
    await data.instruments();
    expect(r.fetchPerpsInstruments).toHaveBeenCalledTimes(1);
  });

  it("ante un fallo sirve el catalogo RANCIO", async () => {
    let falla = false;
    const r = reader({
      fetchPerpsInstruments: vi.fn(async () => {
        if (falla) {
          throw new Error("502");
        }
        return [CRUDO];
      }),
    });
    let ahora = 0;
    const data = new PerpsMarketData(r, { now: () => ahora, instrumentsTtlMs: 100 });
    expect(await data.instruments()).toHaveLength(1);

    falla = true;
    ahora = 1_000;
    // Un fallo de red no debe dejar al bot sin catalogo si tiene uno reciente.
    expect(await data.instruments()).toHaveLength(1);
  });

  it("tras un fallo NO se reintenta en cada pasada", async () => {
    const fetchPerpsInstruments = vi.fn(async () => {
      throw new Error("502");
    });
    let ahora = 0;
    const data = new PerpsMarketData(reader({ fetchPerpsInstruments }), {
      now: () => ahora,
      instrumentsFailureTtlMs: 30_000,
    });
    await data.instruments();
    ahora = 1_000;
    await data.instruments();
    ahora = 2_000;
    await data.instruments();
    // Cachear solo el exito hace que el TTL no frene nada tras el primer fallo, el servicio acabe
    // limitandote y el fallo se vuelva permanente.
    expect(fetchPerpsInstruments).toHaveBeenCalledTimes(1);
  });

  it("una lectura VIEJA deja de servirse: caduca", async () => {
    let falla = false;
    const r = reader({
      fetchPerpsInstruments: vi.fn(async () => {
        if (falla) {
          throw new Error("502");
        }
        return [CRUDO];
      }),
    });
    let ahora = 0;
    const data = new PerpsMarketData(r, {
      now: () => ahora,
      instrumentsTtlMs: 100,
      instrumentsFailureTtlMs: 0,
      instrumentsMaxAgeMs: 10_000,
    });
    await data.instruments();

    falla = true;
    ahora = 5_000;
    expect(await data.instruments()).toHaveLength(1);
    // Pasada la edad maxima ya no es una lectura: es un recuerdo. Devolver `undefined` deja que quien
    // llama distinga "no pude leer" de "no hay nada", que es la distincion que decide sobre dinero.
    ahora = 50_000;
    expect(await data.instruments()).toBeUndefined();
  });

  it("no lanza dos peticiones a la vez para el mismo catalogo", async () => {
    const r = reader();
    const data = new PerpsMarketData(r, { now: () => 0 });
    await Promise.all([data.instruments(), data.instruments(), data.instruments()]);
    expect(r.fetchPerpsInstruments).toHaveBeenCalledTimes(1);
  });

  it("con ticker del feed NO pide el ticker por REST", async () => {
    const r = reader();
    const data = new PerpsMarketData(r, { now: () => 0 });
    await data.quote(toInstrumentInfo(CRUDO), 100, { markPrice: 99 });
    expect(r.fetchPerpsTickers).not.toHaveBeenCalled();
    expect(r.fetchPerpsBook).toHaveBeenCalled();
  });
});

describe("seleccion de instrumentos", () => {
  const catalogo: PerpsInstrumentInfo[] = [toInstrumentInfo(CRUDO)];

  it("reporta los simbolos que el catalogo no trae en vez de ignorarlos", () => {
    const { instruments, missing } = selectPerpsInstruments(catalogo, ["BTC-USD", "NO-EXISTE"]);
    expect(instruments).toHaveLength(1);
    // Un simbolo mal escrito y un exchange que deja de listarlo se ven igual si se descarta en
    // silencio, y son dos problemas muy distintos.
    expect(missing).toEqual(["NO-EXISTE"]);
  });

  it("el tope del OPERADOR manda sobre el del venue", () => {
    expect(resolveMaxLeverage({ instrument: catalogo[0], notionalUsd: 100 })).toBe(20);
    expect(resolveMaxLeverage({ instrument: catalogo[0], notionalUsd: 100, operatorMaxLeverage: 2 })).toBe(2);
  });

  it("el tramo de riesgo tambien recorta", () => {
    const conTramos: PerpsInstrumentInfo = {
      ...catalogo[0],
      riskTiers: [
        { lowerBoundUsd: 0, maxLeverage: 20 },
        { lowerBoundUsd: 50_000, maxLeverage: 5 },
      ],
    };
    expect(resolveMaxLeverage({ instrument: conTramos, notionalUsd: 100 })).toBe(20);
    expect(resolveMaxLeverage({ instrument: conTramos, notionalUsd: 60_000 })).toBe(5);
  });

  it("el oraculo se DECLARA, no se deduce del prefijo del simbolo", () => {
    expect(oracleMarketForPerp("BTC-USD")).toBe("BTC");
    expect(oracleMarketForPerp("ETH-USD")).toBe("ETH");
    // Partir por el guion emparejaria cualquier simbolo nuevo con un oraculo que no le corresponde.
    expect(oracleMarketForPerp("BTC-USD-QUARTERLY")).toBeUndefined();
    expect(oracleMarketForPerp("NVDA-USD")).toBeUndefined();
  });
});

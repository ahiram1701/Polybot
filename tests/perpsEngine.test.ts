import { describe, expect, it } from "vitest";

import {
  accrueFunding,
  isLiquidated,
  liquidationPrice,
  MAINTENANCE_MARGIN_FRACTION,
  perpsFillPrice,
  PerpsLiquidityError,
  SimulationPerpsEngine,
} from "../src/perpsEngine.js";
import {
  calculateFundingCostUsd,
  calculatePerpsFeeUsd,
  PERPS_BASE_TAKER_RATE,
  perpsFeeRate,
} from "../src/perpsFees.js";
import type { PerpsInstrumentInfo, PerpsPositionAttempt, PerpsQuote } from "../src/perpsTypes.js";

const INSTRUMENTO: PerpsInstrumentInfo = {
  instrumentId: 6,
  symbol: "BTC-USD",
  category: "crypto",
  baseAsset: "BTC",
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
  riskTiers: [{ lowerBoundUsd: 0, maxLeverage: 20 }],
};

function quote(overrides: Partial<PerpsQuote> = {}): PerpsQuote {
  return {
    instrumentId: 6,
    symbol: "BTC-USD",
    quotedAtMs: 1_000,
    bestBid: 99,
    bestAsk: 101,
    mid: 100,
    markPrice: 100,
    indexPrice: 100,
    fundingRate: 0,
    rawAskLevels: [
      { price: 101, size: 10 },
      { price: 102, size: 10 },
    ],
    rawBidLevels: [
      { price: 99, size: 10 },
      { price: 98, size: 10 },
    ],
    availableAskNotionalUsd: 101 * 10 + 102 * 10,
    availableBidNotionalUsd: 99 * 10 + 98 * 10,
    ...overrides,
  };
}

describe("comisiones de perps", () => {
  it("son LINEALES sobre el nocional, no la formula p x (1-p) del binario", () => {
    // La del binario es maxima en 0,50 porque `p` es una probabilidad. Con un precio de 77.000 esa
    // formula da una comision negativa de nueve cifras, que es justo el fallo que este modulo aparte
    // existe para hacer imposible.
    const fee = calculatePerpsFeeUsd({ price: 77_000, quantity: 0.01, feeRate: PERPS_BASE_TAKER_RATE });
    expect(fee).toBeCloseTo(770 * 0.0004, 9);
    expect(fee).toBeGreaterThan(0);
  });

  it("el tramo base es el de volumen cero, no uno optimista", () => {
    expect(perpsFeeRate({ volume30dUsd: 0 })).toBe(0.0004);
    expect(perpsFeeRate({})).toBe(0.0004);
  });

  it("el rebate de maker del tramo alto es NEGATIVO y se conserva con signo", () => {
    const rate = perpsFeeRate({ volume30dUsd: 2_000_000_000, maker: true });
    expect(rate).toBeLessThan(0);
    // Un `Math.abs` defensivo aqui convertiria un ingreso en un gasto.
    expect(calculatePerpsFeeUsd({ price: 100, quantity: 10, feeRate: rate })).toBeLessThan(0);
  });

  it("el funding lo paga el LARGO con tasa positiva y lo cobra el CORTO", () => {
    expect(calculateFundingCostUsd({ side: "LONG", notionalUsd: 1_000, fundingRate: 0.0001 })).toBeCloseTo(0.1, 9);
    expect(calculateFundingCostUsd({ side: "SHORT", notionalUsd: 1_000, fundingRate: 0.0001 })).toBeCloseTo(-0.1, 9);
  });

  it("el funding se calcula sobre el NOCIONAL, no sobre el margen", () => {
    // Con 10x, un 0,01% de funding se come el 0,1% del colateral. Es lo que hace que el funding sea
    // despreciable de lejos y decisivo apalancado.
    const nocional = 1_000;
    const funding = calculateFundingCostUsd({ side: "LONG", notionalUsd: nocional, fundingRate: 0.0001 });
    expect(funding / (nocional / 10)).toBeCloseTo(0.001, 9);
  });
});

describe("precio de liquidacion", () => {
  it("el margen de mantenimiento es la MITAD del inicial", () => {
    expect(MAINTENANCE_MARGIN_FRACTION).toBe(0.5);
  });

  it("un largo a 2x se liquida por debajo de la entrada y un corto por encima", () => {
    const largo = liquidationPrice({ side: "LONG", entryPrice: 100, leverage: 2 });
    const corto = liquidationPrice({ side: "SHORT", entryPrice: 100, leverage: 2 });
    expect(largo).toBeLessThan(100);
    expect(corto).toBeGreaterThan(100);
    // L=2 -> mmr = 0,25: P = 100 x (1 - 0,5) / (1 - 0,25) = 66,67
    expect(largo).toBeCloseTo(66.6667, 3);
    // P = 100 x (1 + 0,5) / (1 + 0,25) = 120
    expect(corto).toBeCloseTo(120, 6);
  });

  it("a mas apalancamiento, la liquidacion mas cerca de la entrada", () => {
    const a2 = liquidationPrice({ side: "LONG", entryPrice: 100, leverage: 2 }) as number;
    const a20 = liquidationPrice({ side: "LONG", entryPrice: 100, leverage: 20 }) as number;
    expect(a20).toBeGreaterThan(a2);
    // A 20x basta con perder ~2,5% del nocional.
    expect(100 - a20).toBeLessThan(3);
  });

  it("dispara contra la MARCA y no contra el mejor bid", () => {
    const posicion = {
      side: "LONG",
      liquidationPrice: 66.67,
    } as PerpsPositionAttempt;
    expect(isLiquidated(posicion, 66)).toBe(true);
    expect(isLiquidated(posicion, 70)).toBe(false);
    // Sin marca no se decide nada: un dato ausente no es una liquidacion.
    expect(isLiquidated(posicion, undefined)).toBe(false);
  });
});

describe("SimulationPerpsEngine", () => {
  const engine = new SimulationPerpsEngine(() => 5_000);

  it("entra al precio MEDIO de bajar por el libro, no al mejor", () => {
    // 1.000$ contra niveles de 101x10 (=1.010$) entran enteros en el primero.
    expect(perpsFillPrice(quote(), "LONG", 1_000)).toBeCloseTo(101, 6);
    // 1.500$ ya tocan el segundo nivel, asi que el medio sube por encima de 101.
    const medio = perpsFillPrice(quote(), "LONG", 1_500) as number;
    expect(medio).toBeGreaterThan(101);
    expect(medio).toBeLessThan(102);
  });

  it("un libro que no da para el tamano devuelve undefined, no un precio a medias", () => {
    // Relleno PARCIAL es undefined a proposito: un precio medio sobre media posicion no responde a
    // "cuanto costaria este tamano", y leerlo como si si es como se cuelan los backtests optimistas.
    expect(perpsFillPrice(quote(), "LONG", 100_000)).toBeUndefined();
  });

  it("lanza con contexto cuando el libro no da", async () => {
    await expect(
      engine.open({
        instrument: INSTRUMENTO,
        side: "LONG",
        notionalUsd: 100_000,
        leverage: 2,
        quote: quote(),
      }),
    ).rejects.toBeInstanceOf(PerpsLiquidityError);
  });

  it("etiqueta la posicion como sim SIEMPRE, y calcula margen y liquidacion", async () => {
    const posicion = await engine.open({
      instrument: INSTRUMENTO,
      side: "LONG",
      notionalUsd: 1_000,
      leverage: 2,
      quote: quote(),
    });
    expect(posicion.mode).toBe("sim");
    expect(posicion.entryPrice).toBeCloseTo(101, 6);
    expect(posicion.quantity).toBeCloseTo(1_000 / 101, 9);
    expect(posicion.marginUsd).toBeCloseTo(500, 6);
    expect(posicion.liquidationPrice).toBeLessThan(101);
    expect(posicion.feeUsd).toBeCloseTo(1_000 * PERPS_BASE_TAKER_RATE, 6);
  });

  it("cierra contra el lado CONTRARIO del libro", async () => {
    const posicion = await engine.open({
      instrument: INSTRUMENTO,
      side: "LONG",
      notionalUsd: 500,
      leverage: 2,
      quote: quote(),
    });
    const exit = await engine.close({ position: posicion, quote: quote(), reason: "manual" });
    // Compro a 101 y cierra contra los bids (99): un largo abierto y cerrado en el acto PIERDE el
    // ancho del libro. Un simulador que cerrara al ask diria que deshacer es gratis.
    expect(exit.exitPrice).toBeLessThan(posicion.entryPrice);
    expect(exit.grossPnlUsd).toBeLessThan(0);
    expect(exit.netPnlUsd).toBeLessThan(exit.grossPnlUsd);
  });

  it("una LIQUIDACION se lleva el margen entero, no una perdida parecida", async () => {
    const posicion = await engine.open({
      instrument: INSTRUMENTO,
      side: "LONG",
      notionalUsd: 1_000,
      leverage: 10,
      quote: quote(),
    });
    const exit = await engine.close({ position: posicion, quote: quote(), reason: "liquidada" });
    expect(exit.reason).toBe("liquidada");
    expect(exit.grossPnlUsd).toBeCloseTo(-posicion.marginUsd, 6);
    // Y encima paga comision. El neto es PEOR que perder el margen.
    expect(exit.netPnlUsd).toBeLessThan(-posicion.marginUsd);
  });

  it("el funding devengado sale del cierre, no se olvida", async () => {
    const posicion = await engine.open({
      instrument: INSTRUMENTO,
      side: "LONG",
      notionalUsd: 1_000,
      leverage: 2,
      quote: quote(),
    });
    const funding = accrueFunding({ position: posicion, fundingRate: 0.001, markPrice: 100 });
    expect(funding).toBeGreaterThan(0);
    const exit = await engine.close({
      position: posicion,
      quote: quote(),
      reason: "manual",
      fundingPaidUsd: funding,
    });
    expect(exit.fundingPaidUsd).toBe(funding);
    expect(exit.netPnlUsd).toBeCloseTo(exit.grossPnlUsd - exit.feeUsd - funding, 6);
  });

  it("un CORTO gana cuando el precio baja", async () => {
    const posicion = await engine.open({
      instrument: INSTRUMENTO,
      side: "SHORT",
      notionalUsd: 500,
      leverage: 2,
      quote: quote(),
    });
    // Libro entero 10 puntos mas abajo: el corto cierra comprando mas barato.
    const masAbajo = quote({
      bestBid: 89,
      bestAsk: 91,
      mid: 90,
      markPrice: 90,
      rawAskLevels: [{ price: 91, size: 100 }],
      rawBidLevels: [{ price: 89, size: 100 }],
    });
    const exit = await engine.close({ position: posicion, quote: masAbajo, reason: "manual" });
    expect(exit.grossPnlUsd).toBeGreaterThan(0);
  });
});

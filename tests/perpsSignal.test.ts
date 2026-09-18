import { describe, expect, it } from "vitest";

import { carryOutcome, fundingDelCubo, fundingReceiverSide, summarizePerpsBucket } from "../src/perpsSignal.js";
import { FIVE_MINUTES_MS } from "../src/time.js";
import type { PerpsSample } from "../src/perpsTypes.js";

const INICIO = 1_757_000_000_000 - (1_757_000_000_000 % FIVE_MINUTES_MS);

function cubo(tasas: number[], overrides: Partial<PerpsSample> = {}): PerpsSample {
  return {
    version: 1,
    instrumentId: 6,
    symbol: "BTC-USD",
    bucketStartMs: INICIO,
    bucketEndMs: INICIO + FIVE_MINUTES_MS,
    openMarkPrice: 100,
    closeMarkPrice: 100,
    fundingIntervalHours: 1,
    ticks: tasas.map((fundingRate, i) => ({ timestampMs: INICIO + i * 1_000, markPrice: 100, fundingRate })),
    quotes: [],
    ...overrides,
  };
}

/**
 * Guardas del fallo del 2026-09-18.
 *
 * El funding se resumia sumando cada CAMBIO de la tasa publicada, y salio inflado de dos maneras que
 * se prueban aqui por separado, porque se pueden volver a colar por separado:
 *
 *   1. La tasa es HORARIA: con una sola tasa en el cubo se cobraba la hora entera por cinco minutos.
 *      12x de mas. Era la mediana de los 2.282 cubos medidos.
 *   2. La tasa es una PREVISION que se actualiza sin parar: cada actualizacion contaba como otro
 *      cobro. Hasta ~400x en el p90.
 *
 * El error iba en la direccion peligrosa —el carry COBRA funding— y hizo parecer rentable (+3,61 $,
 * P(+) 99%) una casilla que era un artefacto.
 */
describe("fundingDelCubo: la tasa es HORARIA", () => {
  it("una tasa constante devenga la DOCEAVA parte en un cubo de cinco minutos, no la hora entera", () => {
    const { rate, accrued } = fundingDelCubo(cubo([0.0012, 0.0012, 0.0012]));
    expect(rate).toBeCloseTo(0.0012, 12);
    // El fallo 1: aqui salia 0.0012, doce veces lo que se paga de verdad en cinco minutos.
    expect(accrued).toBeCloseTo(0.0012 / 12, 12);
    expect(accrued).not.toBeCloseTo(0.0012, 6);
  });

  it("respeta el intervalo de funding del instrumento", () => {
    // Con funding cada 8 h, cinco minutos devengan 1/96 de la tasa, no 1/12.
    const { accrued } = fundingDelCubo(cubo([0.0096], { fundingIntervalHours: 8 }));
    expect(accrued).toBeCloseTo(0.0096 / 96, 12);
  });

  it("sin intervalo grabado asume 1 h, que es el de BTC-USD y ETH-USD", () => {
    const { accrued } = fundingDelCubo(cubo([0.0012], { fundingIntervalHours: undefined }));
    expect(accrued).toBeCloseTo(0.0012 / 12, 12);
  });
});

describe("fundingDelCubo: la tasa es una PREVISION, no un cobro por valor", () => {
  it("muchas actualizaciones se PROMEDIAN, no se suman", () => {
    // Cinco revisiones de la tasa prevista dentro del mismo cubo. Sumarlas daba 5x la tasa; lo que
    // liquida el exchange es la tasa vigente, una vez por intervalo.
    const tasas = [0.0010, 0.0011, 0.0012, 0.0013, 0.0014];
    const { rate, accrued } = fundingDelCubo(cubo(tasas));
    const media = tasas.reduce((a, b) => a + b, 0) / tasas.length;
    expect(rate).toBeCloseTo(media, 12);
    expect(accrued).toBeCloseTo(media / 12, 12);
    // El fallo 2, con el 1 encima: la suma de cambios daba ~0.006, sesenta veces lo real.
    const sumaDeCambios = tasas.reduce((a, b) => a + b, 0);
    expect(sumaDeCambios / accrued).toBeGreaterThan(50);
  });

  it("repetir la MISMA tasa muchas veces no la multiplica", () => {
    const pocas = fundingDelCubo(cubo([0.0012, 0.0012]));
    const muchas = fundingDelCubo(cubo(Array.from({ length: 300 }, () => 0.0012)));
    expect(muchas.accrued).toBeCloseTo(pocas.accrued, 12);
  });

  it("un cubo sin tasas no devenga nada, en vez de inventar un cero con lado", () => {
    expect(fundingDelCubo(cubo([]))).toEqual({ rate: 0, accrued: 0 });
    expect(fundingReceiverSide(0)).toBeUndefined();
  });
});

describe("summarizePerpsBucket calcula de los ticks e IGNORA el resumen viejo", () => {
  it("un fundingRateSum inflado grabado en la fila no entra en la cuenta", () => {
    // Las 2.282 filas capturadas antes del arreglo llevan el campo inflado. Si alguien volviera a
    // leerlo, todo el historico se re-puntuaria mal sin dar la cara.
    const metricas = summarizePerpsBucket(cubo([0.0012], { fundingRateSum: 0.5 }));
    expect(metricas?.fundingRate).toBeCloseTo(0.0012, 12);
    expect(metricas?.fundingAccrued).toBeCloseTo(0.0012 / 12, 12);
  });
});

describe("carryOutcome cobra lo DEVENGADO", () => {
  it("un cubo de cinco minutos no cobra una hora de funding", () => {
    const metricas = summarizePerpsBucket(cubo([0.0012]));
    if (!metricas) throw new Error("cubo no puntuable");
    const resultado = carryOutcome({ metrics: metricas, side: "SHORT", notionalUsd: 100, entryPrice: 100 });
    // El corto COBRA con tasa positiva: coste negativo. 100 $ x 0,0012 / 12 = 0,01 $.
    expect(resultado.fundingUsd).toBeCloseTo(-0.01, 9);
    // Con el fallo cobraba 0,12 $: la ganancia de funding de toda una hora en cinco minutos.
    expect(resultado.fundingUsd).not.toBeCloseTo(-0.12, 6);
  });
});

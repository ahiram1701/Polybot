import { describe, expect, it } from "vitest";

import { partirEnTramos, replayCarry, summarizeReplay } from "../src/perpsReplay.js";
import { FIVE_MINUTES_MS } from "../src/time.js";
import type { PerpsSample } from "../src/perpsTypes.js";

const BASE = 1_757_000_000_000 - (1_757_000_000_000 % FIVE_MINUTES_MS);

/**
 * Un cubo con apertura, cierre y una tasa de funding.
 *
 * Se le ponen SIETE ticks de marca porque `summarizePerpsBucket` exige al menos seis saltos para
 * estimar la volatilidad; con menos, la muestra sigue siendo puntuable pero sin `volPerSecond`.
 */
function cubo(args: {
  indice: number;
  open: number;
  close: number;
  funding: number;
  instrumentId?: number;
  symbol?: string;
}): PerpsSample {
  const bucketStartMs = BASE + args.indice * FIVE_MINUTES_MS;
  const ticks = Array.from({ length: 8 }, (_, i) => ({
    timestampMs: bucketStartMs + i * 30_000,
    markPrice: args.open + ((args.close - args.open) * i) / 7,
    indexPrice: args.open,
    fundingRate: args.funding,
  }));
  return {
    version: 1,
    instrumentId: args.instrumentId ?? 6,
    symbol: args.symbol ?? "BTC-USD",
    bucketStartMs,
    bucketEndMs: bucketStartMs + FIVE_MINUTES_MS,
    openMarkPrice: args.open,
    closeMarkPrice: args.close,
    fundingIntervalHours: 1,
    ticks,
    quotes: [],
  };
}

describe("replayCarry: el invariante de no mirar el futuro", () => {
  it("el lado sale del cubo ANTERIOR, no del que se opera", () => {
    // Cubo 0: funding POSITIVO -> paga el largo -> quien cobra es el CORTO.
    // Cubo 1: funding negativo, que sugeriria lo contrario. Si el replay mirase el cubo que opera,
    // elegiria LONG. Tiene que elegir SHORT.
    const samples = [
      cubo({ indice: 0, open: 100, close: 100, funding: 0.001 }),
      cubo({ indice: 1, open: 100, close: 100, funding: -0.001 }),
    ];
    const trades = replayCarry(samples, { notionalUsd: 100, minFundingRate: 0 });
    expect(trades).toHaveLength(1);
    expect(trades[0].side).toBe("SHORT");
    expect(trades[0].bucketStartMs).toBe(BASE + FIVE_MINUTES_MS);
  });

  it("el resultado se mide en el cubo que se opera, no en el que decidio", () => {
    const samples = [
      // Decide SHORT (funding positivo).
      cubo({ indice: 0, open: 100, close: 100, funding: 0.001 }),
      // Y el precio SUBE durante el cubo operado: un corto pierde.
      cubo({ indice: 1, open: 100, close: 110, funding: 0 }),
    ];
    const [trade] = replayCarry(samples, { notionalUsd: 100, minFundingRate: 0 });
    expect(trade.side).toBe("SHORT");
    expect(trade.priceUsd).toBeLessThan(0);
  });

  it("un cubo sin cierre no se puntua", () => {
    const sinCierre = { ...cubo({ indice: 1, open: 100, close: 100, funding: 0 }), closeMarkPrice: undefined };
    const samples = [cubo({ indice: 0, open: 100, close: 100, funding: 0.001 }), sinCierre];
    // Un cubo que el feed no vio entero NO es un periodo plano: no entra en la muestra.
    expect(replayCarry(samples, { notionalUsd: 100, minFundingRate: 0 })).toHaveLength(0);
  });
});

describe("replayCarry: huecos y solapes", () => {
  it("los cubos NO consecutivos se saltan", () => {
    const samples = [
      cubo({ indice: 0, open: 100, close: 100, funding: 0.001 }),
      // Hueco: falta el cubo 1. Una decision tomada con el funding de hace media hora no es la que el
      // bot habria tomado.
      cubo({ indice: 6, open: 100, close: 100, funding: 0.001 }),
    ];
    expect(replayCarry(samples, { notionalUsd: 100, minFundingRate: 0 })).toHaveLength(0);
  });

  it("las posiciones NO se solapan cuando se mantienen varios cubos", () => {
    const samples = Array.from({ length: 7 }, (_, i) =>
      cubo({ indice: i, open: 100, close: 100, funding: 0.001 }),
    );
    const trades = replayCarry(samples, { notionalUsd: 100, minFundingRate: 0, holdBuckets: 3 });
    // 7 cubos, el primero solo decide: caben dos posiciones de 3 cubos sin pisarse.
    expect(trades).toHaveLength(2);
    expect(trades[0].bucketStartMs).toBe(BASE + FIVE_MINUTES_MS);
    expect(trades[1].bucketStartMs).toBe(BASE + 4 * FIVE_MINUTES_MS);
    expect(trades[0].heldBuckets).toBe(3);
  });

  it("mantener mas cubos acumula MAS funding con las mismas comisiones", () => {
    const samples = Array.from({ length: 13 }, (_, i) =>
      cubo({ indice: i, open: 100, close: 100, funding: 0.001 }),
    );
    const corto = replayCarry(samples, { notionalUsd: 100, minFundingRate: 0, holdBuckets: 1 })[0];
    const largo = replayCarry(samples, { notionalUsd: 100, minFundingRate: 0, holdBuckets: 12 })[0];
    // Las comisiones son las mismas (una ida y una vuelta), el funding se multiplica por doce.
    expect(largo.feeUsd).toBeCloseTo(corto.feeUsd, 9);
    expect(Math.abs(largo.fundingUsd)).toBeGreaterThan(Math.abs(corto.fundingUsd) * 10);
  });

  it("el umbral de funding descarta los cubos flojos", () => {
    const samples = [
      cubo({ indice: 0, open: 100, close: 100, funding: 0.00001 }),
      cubo({ indice: 1, open: 100, close: 100, funding: 0.00001 }),
    ];
    expect(replayCarry(samples, { notionalUsd: 100, minFundingRate: 0 })).toHaveLength(1);
    expect(replayCarry(samples, { notionalUsd: 100, minFundingRate: 0.001 })).toHaveLength(0);
  });

  it("no cruza instrumentos: el funding de BTC no decide el lado de ETH", () => {
    const samples = [
      cubo({ indice: 0, open: 100, close: 100, funding: 0.001, instrumentId: 6, symbol: "BTC-USD" }),
      cubo({ indice: 1, open: 100, close: 100, funding: 0, instrumentId: 7, symbol: "ETH-USD" }),
    ];
    // ETH no tiene cubo anterior propio, asi que no se opera.
    expect(replayCarry(samples, { notionalUsd: 100, minFundingRate: 0 })).toHaveLength(0);
  });
});

describe("summarizeReplay", () => {
  it("el BLOQUE del bootstrap es el cubo, no la operacion", () => {
    // Dos instrumentos en el MISMO cubo no son dos sorteos independientes: BTC y ETH se mueven juntos.
    const samples = [
      cubo({ indice: 0, open: 100, close: 100, funding: 0.001, instrumentId: 6, symbol: "BTC-USD" }),
      cubo({ indice: 1, open: 100, close: 100, funding: 0.001, instrumentId: 6, symbol: "BTC-USD" }),
      cubo({ indice: 0, open: 50, close: 50, funding: 0.001, instrumentId: 7, symbol: "ETH-USD" }),
      cubo({ indice: 1, open: 50, close: 50, funding: 0.001, instrumentId: 7, symbol: "ETH-USD" }),
    ];
    const trades = replayCarry(samples, { notionalUsd: 100, minFundingRate: 0 });
    expect(trades).toHaveLength(2);
    const resumen = summarizeReplay(trades, samples.length);
    // Dos operaciones, UN bloque: comparten el cubo.
    expect(resumen.bootstrap.bloques).toBe(1);
  });

  it("el peor tramo es el minimo de los tramos, no la media", () => {
    const samples = Array.from({ length: 13 }, (_, i) =>
      cubo({ indice: i, open: 100, close: i === 6 ? 80 : 100, funding: 0.001 }),
    );
    const trades = replayCarry(samples, { notionalUsd: 100, minFundingRate: 0 });
    const resumen = summarizeReplay(trades, samples.length);
    expect(resumen.peorTramo).toBeLessThanOrEqual(Math.min(...resumen.tramos));
    expect(resumen.peorTramo).toBe(Math.min(...resumen.tramos));
  });

  it("parte en tramos cronologicos de tamano parecido", () => {
    const tramos = partirEnTramos([1, 2, 3, 4, 5, 6, 7], 3);
    expect(tramos.map((tramo) => tramo.length)).toEqual([2, 2, 3]);
    expect(tramos.flat()).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("sin operaciones no inventa un resumen positivo", () => {
    const resumen = summarizeReplay([], 0);
    expect(resumen.netUsd).toBe(0);
    expect(resumen.peorTramo).toBe(0);
    expect(resumen.bootstrap.bloques).toBe(0);
  });
});

import { mkdtempSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  invalidatePerpsReadCache,
  parsePerpsLine,
  PerpsRecorder,
  readPerpsSamples,
  trimPerpsFileToMostRecent,
} from "../src/perpsRecorder.js";
import { FIVE_MINUTES_MS } from "../src/time.js";
import type { PerpsInstrumentInfo, PerpsQuote } from "../src/perpsTypes.js";

const temporales: string[] = [];

function dirTemporal(): string {
  const dir = mkdtempSync(join(tmpdir(), "polybot-perps-"));
  temporales.push(dir);
  return dir;
}

afterEach(async () => {
  invalidatePerpsReadCache();
  await Promise.all(temporales.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

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
  riskTiers: [],
};

function quote(markPrice: number, fundingRate = 0.0001): PerpsQuote {
  return {
    instrumentId: 6,
    symbol: "BTC-USD",
    quotedAtMs: 0,
    bestBid: markPrice - 1,
    bestAsk: markPrice + 1,
    mid: markPrice,
    markPrice,
    indexPrice: markPrice,
    fundingRate,
    rawAskLevels: [{ price: markPrice + 1, size: 100 }],
    rawBidLevels: [{ price: markPrice - 1, size: 100 }],
    availableAskNotionalUsd: (markPrice + 1) * 100,
    availableBidNotionalUsd: (markPrice - 1) * 100,
  };
}

/** Un instante dentro del cubo que empieza en `bucket`. */
const BUCKET_0 = 1_757_000_000_000 - (1_757_000_000_000 % FIVE_MINUTES_MS);

describe("PerpsRecorder", () => {
  it("acumula en el cubo en curso sin escribir nada", async () => {
    const dir = dirTemporal();
    const recorder = new PerpsRecorder(dir);
    await recorder.observe({ instrument: INSTRUMENTO, quote: quote(100), nowMs: BUCKET_0 + 1_000 });
    await recorder.observe({ instrument: INSTRUMENTO, quote: quote(101), nowMs: BUCKET_0 + 2_000 });

    expect(recorder.activeSamples()).toHaveLength(1);
    expect(recorder.activeSamples()[0].ticks).toHaveLength(2);
    await expect(readFile(recorder.perpsAnalyticsPath, "utf8")).rejects.toThrow();
  });

  it("cierra el cubo anterior ANTES de abrir el nuevo", async () => {
    const dir = dirTemporal();
    const recorder = new PerpsRecorder(dir);
    await recorder.observe({ instrument: INSTRUMENTO, quote: quote(100), nowMs: BUCKET_0 + 1_000 });
    await recorder.observe({ instrument: INSTRUMENTO, quote: quote(110), nowMs: BUCKET_0 + 290_000 });
    // Primer instante del cubo siguiente.
    const cerrada = await recorder.observe({
      instrument: INSTRUMENTO,
      quote: quote(200),
      nowMs: BUCKET_0 + FIVE_MINUTES_MS + 1_000,
    });

    expect(cerrada).toBeDefined();
    expect(cerrada?.bucketStartMs).toBe(BUCKET_0);
    expect(cerrada?.openMarkPrice).toBe(100);
    // La verdad del cubo es el ULTIMO tick del cubo, no el primero del siguiente. Si el orden fuera al
    // reves, el 200 del cubo nuevo se colaria como cierre del viejo.
    expect(cerrada?.closeMarkPrice).toBe(110);
  });

  it("NO guarda un resumen de funding: se calcula de los ticks, que son la verdad", async () => {
    const dir = dirTemporal();
    const recorder = new PerpsRecorder(dir);
    for (const t of [1_000, 2_000, 3_000]) {
      await recorder.observe({ instrument: INSTRUMENTO, quote: quote(100, 0.0002), nowMs: BUCKET_0 + t });
    }
    const cerrada = await recorder.observe({
      instrument: INSTRUMENTO,
      quote: quote(100, 0.0002),
      nowMs: BUCKET_0 + FIVE_MINUTES_MS + 1_000,
    });
    // Aqui vivia `fundingRateSum`, que sumaba cada cambio de la tasa y salio inflado 12-400x. Guardar
    // un derivado junto a los datos crudos es lo que permitio el fallo: el derivado mentia y los ticks,
    // que decian la verdad, no los leia nadie.
    expect(cerrada?.fundingRateSum).toBeUndefined();
    // Los ticks, en cambio, conservan cada tasa leida: de ahi sale la cuenta buena.
    expect(cerrada?.ticks.map((tick) => tick.fundingRate)).toEqual([0.0002, 0.0002, 0.0002]);
  });

  it("guarda el intervalo de funding, que hace falta para pasar de tasa a devengado", async () => {
    const dir = dirTemporal();
    const recorder = new PerpsRecorder(dir);
    await recorder.observe({ instrument: INSTRUMENTO, quote: quote(100), nowMs: BUCKET_0 + 1_000 });
    expect(recorder.activeSamples()[0].fundingIntervalHours).toBe(1);
  });

  it("flush guarda los cubos abiertos", async () => {
    const dir = dirTemporal();
    const recorder = new PerpsRecorder(dir);
    await recorder.observe({ instrument: INSTRUMENTO, quote: quote(100), nowMs: BUCKET_0 + 1_000 });
    // Sin esto, cada reinicio tiraria el cubo en curso de cada instrumento.
    expect(await recorder.flush(BUCKET_0 + 10_000)).toBe(1);
    expect(recorder.activeSamples()).toHaveLength(0);

    const guardadas = await readPerpsSamples(recorder.perpsAnalyticsPath);
    expect(guardadas).toHaveLength(1);
    expect(guardadas[0].closedAtMs).toBe(BUCKET_0 + 10_000);
  });

  it("lee incrementalmente y devuelve los cubos ordenados", async () => {
    const dir = dirTemporal();
    const recorder = new PerpsRecorder(dir);
    for (let i = 0; i < 3; i += 1) {
      await recorder.observe({
        instrument: INSTRUMENTO,
        quote: quote(100 + i),
        nowMs: BUCKET_0 + i * FIVE_MINUTES_MS + 1_000,
      });
    }
    await recorder.flush(BUCKET_0 + 3 * FIVE_MINUTES_MS);

    const primera = await readPerpsSamples(recorder.perpsAnalyticsPath);
    expect(primera).toHaveLength(3);
    // Segunda lectura sin cambios: sale de la cache y devuelve lo mismo.
    expect(await readPerpsSamples(recorder.perpsAnalyticsPath)).toHaveLength(3);
    expect(primera.map((sample) => sample.bucketStartMs)).toEqual([
      BUCKET_0,
      BUCKET_0 + FIVE_MINUTES_MS,
      BUCKET_0 + 2 * FIVE_MINUTES_MS,
    ]);
  });

  it("una linea corrupta se salta sin tirar la lectura", () => {
    expect(parsePerpsLine("{ esto no es json")).toBeUndefined();
    expect(parsePerpsLine("")).toBeUndefined();
    expect(parsePerpsLine(JSON.stringify({ sample: { version: 2 } }))).toBeUndefined();
  });

  it("la poda deja los cubos MAS RECIENTES", async () => {
    const dir = dirTemporal();
    const recorder = new PerpsRecorder(dir, 2, 0);
    for (let i = 0; i < 5; i += 1) {
      await recorder.observe({
        instrument: INSTRUMENTO,
        quote: quote(100 + i),
        nowMs: BUCKET_0 + i * FIVE_MINUTES_MS + 1_000,
      });
    }
    await recorder.flush(BUCKET_0 + 5 * FIVE_MINUTES_MS);

    const quedan = await trimPerpsFileToMostRecent(recorder.perpsAnalyticsPath, 2);
    expect(quedan).toBe(2);
    const leidas = await readPerpsSamples(recorder.perpsAnalyticsPath);
    expect(leidas.map((sample) => sample.bucketStartMs)).toEqual([
      BUCKET_0 + 3 * FIVE_MINUTES_MS,
      BUCKET_0 + 4 * FIVE_MINUTES_MS,
    ]);
  });

  it("escribe en su PROPIO fichero, nunca en el del binario", () => {
    const dir = dirTemporal();
    const recorder = new PerpsRecorder(dir);
    expect(recorder.perpsAnalyticsPath.endsWith("perps-analytics.jsonl")).toBe(true);
    expect(recorder.perpsAnalyticsPath).not.toContain("/analytics.jsonl");
  });
});

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { indexarMuestras, muestrasEnOrden } from "../src/analyticsStream.js";
import type { AnalyticsSample } from "../src/types.js";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "analytics-stream-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function muestra(args: { slug: string; windowStartMs: number; ticks?: number; quotes?: number }): AnalyticsSample {
  const ticks = Array.from({ length: args.ticks ?? 2 }, (_, i) => ({
    timestampMs: args.windowStartMs + i * 1000,
    secondsToEnd: 300 - i,
    price: 100 + i,
    distanceUsd: 0.5,
  }));
  const quotes = Array.from({ length: args.quotes ?? 2 }, (_, i) => ({
    timestampMs: args.windowStartMs + i * 1000,
    secondsToEnd: 300 - i,
    upBestAsk: 0.8,
    upBestBid: 0.2,
    downBestAsk: 0.8,
    downBestBid: 0.2,
  }));
  return {
    version: 1,
    market: "BTC",
    slug: args.slug,
    windowStartMs: args.windowStartMs,
    endMs: args.windowStartMs + 310_000,
    openingPrice: 100,
    openingTickTimestampMs: args.windowStartMs,
    ticks,
    quotes,
    finalPrice: 101,
    finalTickTimestampMs: args.windowStartMs + 310_000,
    winningOutcome: "UP",
    resolvedAtMs: args.windowStartMs + 310_000,
  } as unknown as AnalyticsSample;
}

/** Como escribe el bot: una linea por muestra, envuelta con `at` y `type`. */
async function escribir(path: string, muestras: readonly AnalyticsSample[]): Promise<void> {
  const lineas = muestras.map((sample) => JSON.stringify({ at: new Date().toISOString(), type: "analytics", sample }));
  await writeFile(path, `${lineas.join("\n")}\n`, "utf8");
}

const T0 = Date.UTC(2026, 8, 17, 10, 0, 0);

describe("lectura de la analitica en flujo", () => {
  it("entrega las ventanas en orden cronologico aunque el fichero no lo este", async () => {
    const path = join(dir, "a.jsonl");
    await escribir(path, [
      muestra({ slug: "c", windowStartMs: T0 + 600_000 }),
      muestra({ slug: "a", windowStartMs: T0 }),
      muestra({ slug: "b", windowStartMs: T0 + 300_000 }),
    ]);

    const leidas: string[] = [];
    for await (const sample of muestrasEnOrden([path])) leidas.push(sample.slug);

    expect(leidas).toEqual(["a", "b", "c"]);
  });

  it("entre dos ficheros gana la copia con mas detalle, no la ultima", async () => {
    // El caso real: una reescritura degradada en el fichero vivo tapaba la copia completa del archivo.
    const archivo = join(dir, "archivo.jsonl");
    const vivo = join(dir, "vivo.jsonl");
    await escribir(archivo, [muestra({ slug: "w1", windowStartMs: T0, ticks: 40, quotes: 80 })]);
    await escribir(vivo, [muestra({ slug: "w1", windowStartMs: T0, ticks: 2, quotes: 2 })]);

    const indice = await indexarMuestras([archivo, vivo]);

    expect(indice).toHaveLength(1);
    expect(indice[0].path).toBe(archivo);
    expect(indice[0].detalle).toBe(120);
  });

  it("a igualdad de detalle gana el ultimo fichero de la lista", async () => {
    const archivo = join(dir, "archivo.jsonl");
    const vivo = join(dir, "vivo.jsonl");
    await escribir(archivo, [muestra({ slug: "w1", windowStartMs: T0 })]);
    await escribir(vivo, [muestra({ slug: "w1", windowStartMs: T0 })]);

    const indice = await indexarMuestras([archivo, vivo]);

    expect(indice).toHaveLength(1);
    expect(indice[0].path).toBe(vivo);
  });

  it("dentro de un mismo fichero manda la ultima linea del slug, como el lector del bot", async () => {
    const path = join(dir, "a.jsonl");
    await escribir(path, [
      muestra({ slug: "w1", windowStartMs: T0, ticks: 30, quotes: 30 }),
      muestra({ slug: "w1", windowStartMs: T0, ticks: 3, quotes: 3 }),
    ]);

    const indice = await indexarMuestras([path]);

    expect(indice).toHaveLength(1);
    expect(indice[0].detalle).toBe(6);
  });

  it("el filtro se aplica sobre el indice, sin llegar a parsear lo descartado", async () => {
    const path = join(dir, "a.jsonl");
    await escribir(path, [
      muestra({ slug: "vieja", windowStartMs: T0 }),
      muestra({ slug: "nueva", windowStartMs: T0 + 600_000 }),
    ]);

    const leidas: string[] = [];
    for await (const sample of muestrasEnOrden([path], (u) => u.windowStartMs > T0)) leidas.push(sample.slug);

    expect(leidas).toEqual(["nueva"]);
  });

  it("un fichero que no existe no rompe la lectura", async () => {
    const path = join(dir, "a.jsonl");
    await escribir(path, [muestra({ slug: "w1", windowStartMs: T0 })]);

    const leidas: string[] = [];
    for await (const sample of muestrasEnOrden([join(dir, "no-esta.jsonl"), path])) leidas.push(sample.slug);

    expect(leidas).toEqual(["w1"]);
  });

  it("las ventanas sin resolver no se entregan: no se puede puntuar lo que no ha cerrado", async () => {
    const path = join(dir, "a.jsonl");
    const abierta = { ...muestra({ slug: "abierta", windowStartMs: T0 }) } as Record<string, unknown>;
    delete abierta.winningOutcome;
    delete abierta.resolvedAtMs;
    await escribir(path, [abierta as unknown as AnalyticsSample, muestra({ slug: "cerrada", windowStartMs: T0 + 600_000 })]);

    const leidas: string[] = [];
    for await (const sample of muestrasEnOrden([path])) leidas.push(sample.slug);

    expect(leidas).toEqual(["cerrada"]);
  });
});

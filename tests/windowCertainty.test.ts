import { describe, expect, it } from "vitest";

import { readWindowCertainty } from "../src/windowCertainty.js";

const AHORA = 1_000_000;

/**
 * Serie con un paseo determinista: sube `deriva` por tick y alterna +-`ruido` para que la sigma no sea
 * cero. Se construye hacia atras desde `AHORA`, un tick cada 5 s, como el feed real.
 */
function serie(args: { apertura: number; deriva: number; ruido: number; n?: number }) {
  const n = args.n ?? 12;
  const ticks: Array<{ timestampMs: number; value: number }> = [];
  for (let i = 0; i < n; i += 1) {
    const paso = n - 1 - i;
    ticks.push({
      timestampMs: AHORA - paso * 5_000,
      value: args.apertura + args.deriva * i + (i % 2 === 0 ? args.ruido : -args.ruido),
    });
  }
  return ticks;
}

describe("readWindowCertainty", () => {
  it("mide la distancia en unidades de lo que aun puede moverse", () => {
    const c = readWindowCertainty({
      ticks: serie({ apertura: 100, deriva: 1, ruido: 0.2 }),
      openingPrice: 100,
      outcome: "UP",
      nowMs: AHORA,
      endMs: AHORA + 60_000,
    });

    expect(c).toBeDefined();
    expect(c!.z).toBeGreaterThan(0);
    expect(c!.distanceUsd).toBeGreaterThan(0);
    expect(c!.sigmaPorSegundo).toBeGreaterThan(0);
    expect(c!.segundosAlCierre).toBe(60);
  });

  it("la MISMA distancia vale mas cuanto menos tiempo queda", () => {
    // Es la razon de ser del modulo: un umbral en dolares no distingue estos dos casos, y son
    // completamente distintos. Con cuatro minutos por delante el precio tiene tiempo de darse la
    // vuelta; con quince segundos, no.
    const ticks = serie({ apertura: 100, deriva: 1, ruido: 0.2 });
    const comun = { ticks, openingPrice: 100, outcome: "UP" as const, nowMs: AHORA };

    const lejos = readWindowCertainty({ ...comun, endMs: AHORA + 240_000 })!;
    const cerca = readWindowCertainty({ ...comun, endMs: AHORA + 15_000 })!;

    expect(cerca.z).toBeGreaterThan(lejos.z);
    expect(cerca.distanceUsd).toBeCloseTo(lejos.distanceUsd, 9);
  });

  it("dos mercados con escalas de precio abismales dan la MISMA certeza", () => {
    // BTC a ~79.000 y DOGE a ~0,2. En dolares no hay umbral que sirva para los dos; normalizado, si.
    const btc = readWindowCertainty({
      ticks: serie({ apertura: 79_000, deriva: 40, ruido: 8 }),
      openingPrice: 79_000,
      outcome: "UP",
      nowMs: AHORA,
      endMs: AHORA + 60_000,
    })!;
    const doge = readWindowCertainty({
      ticks: serie({ apertura: 0.2, deriva: 40 / 395_000, ruido: 8 / 395_000 }),
      openingPrice: 0.2,
      outcome: "UP",
      nowMs: AHORA,
      endMs: AHORA + 60_000,
    })!;

    expect(doge.z).toBeCloseTo(btc.z, 6);
    // Y las distancias crudas no se parecen en nada, que es justo el problema que resuelve.
    expect(btc.distanceUsd / doge.distanceUsd).toBeGreaterThan(100_000);
  });

  it("el signo va a favor del lado que se pregunta", () => {
    const ticks = serie({ apertura: 100, deriva: 1, ruido: 0.2 });
    const comun = { ticks, openingPrice: 100, nowMs: AHORA, endMs: AHORA + 60_000 };

    const up = readWindowCertainty({ ...comun, outcome: "UP" })!;
    const down = readWindowCertainty({ ...comun, outcome: "DOWN" })!;

    expect(up.z).toBeCloseTo(-down.z, 9);
  });

  it("un precio ya cruzado al lado malo da certeza NEGATIVA", () => {
    // Es el caso que mas dinero cuesta: el libro sigue marcando un favorito pero el oraculo ya se paso
    // al otro lado. Medido, ahi el acierto cae al 53,4% contra un 62,0% de equilibrio.
    const c = readWindowCertainty({
      ticks: serie({ apertura: 100, deriva: -1, ruido: 0.2 }),
      openingPrice: 100,
      outcome: "UP",
      nowMs: AHORA,
      endMs: AHORA + 60_000,
    })!;

    expect(c.z).toBeLessThan(0);
  });

  it("sin muestras suficientes NO opina", () => {
    const c = readWindowCertainty({
      ticks: serie({ apertura: 100, deriva: 1, ruido: 0.2, n: 4 }),
      openingPrice: 100,
      outcome: "UP",
      nowMs: AHORA,
      endMs: AHORA + 60_000,
    });

    expect(c).toBeUndefined();
  });

  it("un feed congelado NO se lee como certeza infinita", () => {
    // Sigma cero daria z infinito, convirtiendo una averia en la señal mas fuerte posible.
    const ticks = Array.from({ length: 12 }, (_, i) => ({
      timestampMs: AHORA - (11 - i) * 5_000,
      value: 100,
    }));

    expect(
      readWindowCertainty({ ticks, openingPrice: 90, outcome: "UP", nowMs: AHORA, endMs: AHORA + 60_000 }),
    ).toBeUndefined();
  });

  it("una ventana ya cerrada no tiene certeza que medir", () => {
    expect(
      readWindowCertainty({
        ticks: serie({ apertura: 100, deriva: 1, ruido: 0.2 }),
        openingPrice: 100,
        outcome: "UP",
        nowMs: AHORA,
        endMs: AHORA,
      }),
    ).toBeUndefined();
  });

  it("los ticks del futuro y los demasiado viejos no entran en la cuenta", () => {
    const ticks = [
      ...serie({ apertura: 100, deriva: 1, ruido: 0.2 }),
      { timestampMs: AHORA - 10 * 60_000, value: 5 },   // mas viejo que la historia
      { timestampMs: AHORA + 30_000, value: 5_000 },    // del futuro
    ];
    const c = readWindowCertainty({
      ticks,
      openingPrice: 100,
      outcome: "UP",
      nowMs: AHORA,
      endMs: AHORA + 60_000,
    })!;

    // Si alguno hubiera entrado, la sigma se dispararia y la distancia saldria de un precio absurdo.
    expect(c.distanceUsd).toBeLessThan(20);
    expect(c.sigmaPorSegundo).toBeLessThan(5);
  });
});

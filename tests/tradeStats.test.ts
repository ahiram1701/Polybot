import { describe, expect, it } from "vitest";

import { bootstrapCI, bootstrapCIPorBloques, trimmedNet, winLossProfile } from "../src/tradeStats.js";

describe("tradeStats", () => {
  it("trims BOTH tails, not just the winners", () => {
    // El caso que motiva el modulo: perdidas topadas en -5, ganancias de cola larga.
    const nets = [14, 11, 9, 9, 8, ...Array.from({ length: 20 }, () => 1), -5, -5, -5, -5, -5];
    const total = nets.reduce((a, b) => a + b, 0);

    const oneSided = total - [14, 11, 9, 9, 8].reduce((a, b) => a + b, 0); // la prueba VIEJA
    const fair = trimmedNet(nets, 5);

    expect(oneSided).toBeLessThan(fair.netUsd); // recortar solo arriba castiga de mas
    expect(fair.netUsd).toBe(total - 51 + 25);
    expect(fair.count).toBe(nets.length - 10);
    expect(fair.trimmedPerTail).toBe(5);
  });

  it("returns the untouched total when there is not enough to trim", () => {
    const nets = [3, -1, 2];
    expect(trimmedNet(nets, 5)).toMatchObject({ netUsd: 4, count: 3, trimmedPerTail: 0 });
  });

  it("gives a reproducible bootstrap interval", () => {
    const nets = Array.from({ length: 120 }, (_v, i) => (i % 2 === 0 ? 5 : -5));
    const a = bootstrapCI(nets, { iterations: 500, seed: 7 });
    const b = bootstrapCI(nets, { iterations: 500, seed: 7 });
    expect(a).toEqual(b); // misma semilla, mismo numero: las decisiones son reproducibles
    expect(a.lowerUsd).toBeLessThan(a.upperUsd);
    expect(a.meanUsd).toBeCloseTo(0); // alternado exacto -> neto cero
    expect(a.positiveShare).toBeGreaterThan(0.2);
    expect(a.positiveShare).toBeLessThan(0.8);
  });

  it("reports a clearly winning run as almost always positive", () => {
    const nets = Array.from({ length: 100 }, () => 3);
    const ci = bootstrapCI(nets, { iterations: 500, seed: 1 });
    expect(ci.positiveShare).toBe(1);
    expect(ci.lowerUsd).toBeGreaterThan(0);
  });

  it("describes the win/loss shape", () => {
    const p = winLossProfile([14, 5, 5, -5, -5, -5]);
    expect(p.wins).toBe(3);
    expect(p.losses).toBe(3);
    expect(p.averageWinUsd).toBeCloseTo(8);
    expect(p.averageLossUsd).toBeCloseTo(-5);
    expect(p.payoffRatio).toBeCloseTo(1.6);
    expect(p.bestUsd).toBe(14);
    expect(p.worstUsd).toBe(-5); // la cola baja esta topada; la alta no
  });
});

describe("bootstrapCIPorBloques", () => {
  // Si esto se rompe, el bootstrap por bloques deja de ser "el mismo con otra unidad" y pasa a ser otro
  // estimador distinto, con otra forma de equivocarse.
  it("con un bloque por operacion da exactamente lo mismo que bootstrapCI", () => {
    const nets = Array.from({ length: 80 }, (_v, i) => (i % 3 === 0 ? -5 : 0.9));
    const plano = bootstrapCI(nets, { iterations: 400, seed: 3 });
    const porBloques = bootstrapCIPorBloques(nets, nets.map((_v, i) => i), { iterations: 400, seed: 3 });

    expect(porBloques.lowerUsd).toBe(plano.lowerUsd);
    expect(porBloques.upperUsd).toBe(plano.upperUsd);
    expect(porBloques.positiveShare).toBe(plano.positiveShare);
    expect(porBloques.meanUsd).toBe(plano.meanUsd);
    expect(porBloques.bloques).toBe(80);
  });

  // El caso que motiva la funcion: tres mercados de la misma ventana que ganan o pierden JUNTOS. Son 60
  // sorteos, no 180, y el intervalo tiene que decirlo (en teoria sale raiz de 3 veces mas ancho).
  it("ensancha el intervalo cuando las operaciones de una misma ventana van juntas", () => {
    const nets: number[] = [];
    const ventanas: number[] = [];
    for (let v = 0; v < 60; v += 1) {
      const resultado = v % 2 === 0 ? 4 : -3;
      for (let mercado = 0; mercado < 3; mercado += 1) {
        nets.push(resultado);
        ventanas.push(v * 300_000);
      }
    }
    const sueltas = bootstrapCI(nets, { iterations: 2000, seed: 5 });
    const porVentana = bootstrapCIPorBloques(nets, ventanas, { iterations: 2000, seed: 5 });

    expect(porVentana.bloques).toBe(60);
    expect(porVentana.upperUsd - porVentana.lowerUsd).toBeGreaterThan(1.4 * (sueltas.upperUsd - sueltas.lowerUsd));
    expect(porVentana.p5Usd).toBeLessThan(porVentana.meanUsd);
  });

  it("es reproducible con la misma semilla", () => {
    const nets = [1, -5, 0.8, 0.8, -5, 1.2];
    const bloques = ["a", "a", "b", "c", "c", "d"];

    expect(bootstrapCIPorBloques(nets, bloques, { seed: 9 })).toEqual(bootstrapCIPorBloques(nets, bloques, { seed: 9 }));
  });

  it("rechaza listas de distinta longitud y devuelve ceros sin datos", () => {
    expect(() => bootstrapCIPorBloques([1, 2], [1])).toThrow();
    expect(bootstrapCIPorBloques([], [])).toEqual({ meanUsd: 0, lowerUsd: 0, upperUsd: 0, positiveShare: 0, p5Usd: 0, bloques: 0 });
  });
});

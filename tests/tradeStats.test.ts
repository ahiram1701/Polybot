import { describe, expect, it } from "vitest";

import { bootstrapCI, trimmedNet, winLossProfile } from "../src/tradeStats.js";

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

import { describe, expect, it, vi } from "vitest";

import { MakerLoop } from "../src/makerLoop.js";
import { SimulationMakerEngine } from "../src/makerEngine.js";
import type { MarketInfo } from "../src/types.js";

const AHORA = Date.UTC(2026, 7, 19, 12, 0, 0);

function market(asset: string, segundosAlCierre = 200): MarketInfo {
  return {
    asset,
    slug: `${asset.toLowerCase()}-updown-5m-1`,
    conditionId: `0x${asset}`,
    endMs: AHORA + segundosAlCierre * 1000,
    tickSize: "0.01",
    negRisk: false,
    outcomes: { UP: { tokenId: `${asset}-up` }, DOWN: { tokenId: `${asset}-down` } },
  } as unknown as MarketInfo;
}

function libro(mid: number, competencia: number) {
  return {
    getQuote: vi.fn(async () => ({
      tokenId: "t",
      bestAsk: mid + 0.005,
      bestBid: mid - 0.005,
      availableUsdUnderCap: 100,
      availableUsdAllLevels: 100,
      availableBidUsdAllLevels: 100,
      estimatedSharesForAmount: 10,
      rawAskLevels: [{ price: mid + 0.005, size: competencia / 2 }],
      rawBidLevels: [{ price: mid - 0.005, size: competencia / 2 }],
    })),
  } as never;
}

const recompensas = (ratePerDay: number) => ({
  paraMercado: vi.fn(async () => (ratePerDay > 0 ? { minSize: 50, maxSpreadCents: 1.5, ratePerDay } : undefined)),
});

describe("bucle maker", () => {
  it("coloca una orden en el mercado que paga", async () => {
    const engine = new SimulationMakerEngine();
    const loop = new MakerLoop(
      { orderbook: libro(0.5, 40), rewards: recompensas(10000) as never, engine },
      { capitalUsd: 41, retirarSegundosAntesDelCierre: 30 },
    );
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const r = await loop.runOnce([market("BTC")], AHORA);
    expect(r.colocadas).toBe(1);
    // 50 participaciones a 0,49 = $24,50 inmovilizados.
    expect(r.comprometidoUsd).toBeCloseTo(24.5, 2);
    expect(await engine.ordenesVivas(market("BTC"))).toHaveLength(1);
  });

  it("NO compromete el mismo dolar en dos mercados", async () => {
    // Es la guarda que evita que el exchange rechace la segunda orden — o peor, que la acepte.
    const engine = new SimulationMakerEngine();
    const loop = new MakerLoop(
      { orderbook: libro(0.5, 0), rewards: recompensas(10000) as never, engine },
      { capitalUsd: 41, retirarSegundosAntesDelCierre: 30 },
    );
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const r = await loop.runOnce([market("BTC"), market("ETH"), market("DOGE")], AHORA);
    expect(r.colocadas).toBe(1);
    expect(r.comprometidoUsd).toBeLessThanOrEqual(41);
  });

  it("cerca del cierre retira todo: una orden llena ahi resuelve en segundos", async () => {
    const engine = new SimulationMakerEngine();
    const m = market("BTC", 10);
    await engine.colocar(m, { outcome: "UP", side: "BUY", price: 0.49, size: 50 });
    const loop = new MakerLoop(
      { orderbook: libro(0.5, 0), rewards: recompensas(10000) as never, engine },
      { capitalUsd: 41, retirarSegundosAntesDelCierre: 30 },
    );
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const r = await loop.runOnce([m], AHORA);
    expect(r.colocadas).toBe(0);
    expect(r.canceladas).toBe(1);
    expect(r.mercados[0].motivo).toBe("cerca_del_cierre");
  });

  it("en un mercado sin programa retira y no coloca", async () => {
    const engine = new SimulationMakerEngine();
    const m = market("BTC");
    await engine.colocar(m, { outcome: "UP", side: "BUY", price: 0.49, size: 50 });
    const loop = new MakerLoop(
      { orderbook: libro(0.5, 0), rewards: recompensas(0) as never, engine },
      { capitalUsd: 41, retirarSegundosAntesDelCierre: 30 },
    );
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const r = await loop.runOnce([m], AHORA);
    expect(r.colocadas).toBe(0);
    expect(r.canceladas).toBe(1);
    expect(r.mercados[0].motivo).toBe("sin_programa_de_recompensas");
  });

  it("con el libro quieto no recoloca en la segunda pasada", async () => {
    // Recolocar pierde el turno en la cola, que es justo lo que da valor a estar en reposo.
    const engine = new SimulationMakerEngine();
    const loop = new MakerLoop(
      { orderbook: libro(0.5, 0), rewards: recompensas(10000) as never, engine },
      { capitalUsd: 41, retirarSegundosAntesDelCierre: 30 },
    );
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await loop.runOnce([market("BTC")], AHORA);
    const segunda = await loop.runOnce([market("BTC")], AHORA + 1000);
    expect(segunda.colocadas).toBe(0);
    expect(segunda.canceladas).toBe(0);
  });

  it("si no cabe el minimo, no coloca y lo dice", async () => {
    const engine = new SimulationMakerEngine();
    const loop = new MakerLoop(
      { orderbook: libro(0.9, 0), rewards: recompensas(10000) as never, engine },
      { capitalUsd: 20, retirarSegundosAntesDelCierre: 30 },
    );
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const r = await loop.runOnce([market("BTC")], AHORA);
    expect(r.colocadas).toBe(0);
  });
});

describe("no martillear al exchange", () => {
  it("no recoloca dos veces seguidas en el mismo mercado", async () => {
    // La banda que puntua (1,5c) es mas estrecha que lo que se mueve el precio, asi que sin freno la
    // orden se sale una y otra vez: ~1.400 recolocaciones/hora medidas en simulacion.
    const engine = new SimulationMakerEngine();
    const loop = new MakerLoop(
      { orderbook: libro(0.5, 0), rewards: recompensas(10000) as never, engine },
      { capitalUsd: 41, retirarSegundosAntesDelCierre: 30, minMsEntreRecolocaciones: 15_000 },
    );
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const primera = await loop.runOnce([market("BTC")], AHORA);
    expect(primera.colocadas).toBe(1);

    // Dos segundos despues el precio se ha movido fuera de banda: sin freno recolocaria.
    const loop2 = loop as unknown as { deps: { orderbook: unknown } };
    loop2.deps.orderbook = libro(0.6, 0);
    const segunda = await loop.runOnce([market("BTC")], AHORA + 2000);
    expect(segunda.colocadas).toBe(0);
    expect(segunda.canceladas).toBe(0);

    // Pasado el intervalo, si.
    const tercera = await loop.runOnce([market("BTC")], AHORA + 16_000);
    expect(tercera.colocadas).toBe(1);
  });
});

describe("lo que pasa cuando algo va mal", () => {
  it("al parar, retira TODAS las ordenes vivas", async () => {
    // Sin esto, parar el bot dejaba ordenes reales en el libro sin nadie mirandolas — y el watchdog
    // reinicia el proceso a diario.
    const engine = new SimulationMakerEngine();
    const m1 = market("BTC");
    const m2 = market("ETH");
    await engine.colocar(m1, { outcome: "UP", side: "BUY", price: 0.49, size: 50 });
    await engine.colocar(m2, { outcome: "UP", side: "BUY", price: 0.49, size: 50 });
    const loop = new MakerLoop(
      { orderbook: libro(0.5, 0), rewards: recompensas(10000) as never, engine },
      { capitalUsd: 41, retirarSegundosAntesDelCierre: 30 },
    );
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(await loop.retirarTodo([m1, m2])).toBe(2);
    expect(await engine.ordenesVivas(m1)).toHaveLength(0);
    expect(await engine.ordenesVivas(m2)).toHaveLength(0);
  });

  it("si un mercado falla al retirar, sigue con los demas", async () => {
    // Dejar ordenes vivas en UNO es malo; en TODOS es peor.
    const engine = new SimulationMakerEngine();
    const m1 = market("BTC");
    const m2 = market("ETH");
    await engine.colocar(m2, { outcome: "UP", side: "BUY", price: 0.49, size: 50 });
    const roto = {
      ordenesVivas: vi.fn(async (mk: MarketInfo) => {
        if (mk.asset === "BTC") throw new Error("red caida");
        return engine.ordenesVivas(mk);
      }),
      colocar: engine.colocar.bind(engine),
      cancelar: engine.cancelar.bind(engine),
    };
    const loop = new MakerLoop(
      { orderbook: libro(0.5, 0), rewards: recompensas(10000) as never, engine: roto as never },
      { capitalUsd: 41, retirarSegundosAntesDelCierre: 30 },
    );
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(await loop.retirarTodo([m1, m2])).toBe(1);
    expect(await engine.ordenesVivas(m2)).toHaveLength(0);
  });

  it("detecta que una orden se ha LLENADO", async () => {
    // Un llenado era invisible: el maker solo miraba si la orden seguia puntuando. Te enterarias
    // mirando tu cuenta de Polymarket.
    const m = market("BTC");
    let tamano = 50;
    const engine = {
      ordenesVivas: vi.fn(async () => [{ id: "o1", outcome: "UP" as const, side: "BUY" as const, price: 0.49, size: tamano }]),
      colocar: vi.fn(async () => "nueva"),
      cancelar: vi.fn(async () => 0),
    };
    const loop = new MakerLoop(
      { orderbook: libro(0.5, 0), rewards: recompensas(10000) as never, engine: engine as never },
      { capitalUsd: 41, retirarSegundosAntesDelCierre: 30 },
    );
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    await loop.runOnce([m], AHORA);
    tamano = 30; // se llenaron 20 participaciones
    const segunda = await loop.runOnce([m], AHORA + 20_000);
    expect(segunda.llenadas).toBe(20);
  });
});

describe("mensajes que no mienten", () => {
  it("si NO se financia ninguno, dice que falta capital y cuanto", async () => {
    // Antes los tres decian "capital_dedicado_a_otro_mercado" aunque no se hubiera financiado ninguno,
    // lo que manda a mirar donde no es.
    const engine = new SimulationMakerEngine();
    const loop = new MakerLoop(
      { orderbook: libro(0.5, 0), rewards: recompensas(10000) as never, engine },
      { capitalUsd: 12, retirarSegundosAntesDelCierre: 30 },
    );
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    // 50 participaciones a ~0,495 son ~$24,75: no caben en $12.
    const r = await loop.runOnce([market("BTC")], AHORA);
    expect(r.colocadas).toBe(0);
    expect(r.mercados[0].motivo).toMatch(/^capital_insuficiente_necesita_/);
  });
});

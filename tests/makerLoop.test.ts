import { describe, expect, it, vi } from "vitest";

import { MakerLoop } from "../src/makerLoop.js";
import { SimulationMakerEngine } from "../src/makerEngine.js";
import type { MarketInfo } from "../src/types.js";

const AHORA = Date.UTC(2026, 7, 19, 12, 0, 0);

/** Un par de dos lados cuesta ~$49, asi que este es el capital que permite financiar UN mercado. */
const CAPITAL = 60;

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

/**
 * Libro por TOKEN, no uno solo para los dos.
 *
 * El libro de DOWN vive alrededor de `1 - mid`, porque comprar DOWN a `p` es vender UP a `1 - p`. Un
 * mock que devolviera el mismo libro para los dos tokens no probaria nada de la fusion — y la fusion
 * es justo lo que faltaba.
 */
function libro(mid: number, competencia: number, opciones: { asksDeUp?: boolean } = {}) {
  const { asksDeUp = true } = opciones;
  return {
    getQuote: vi.fn(async (tokenId: string) => {
      const m = String(tokenId).endsWith("-down") ? 1 - mid : mid;
      return {
        tokenId,
        bestAsk: m + 0.005,
        bestBid: m - 0.005,
        availableUsdUnderCap: 100,
        availableUsdAllLevels: 100,
        availableBidUsdAllLevels: 100,
        estimatedSharesForAmount: 10,
        // `asksDeUp: false` reproduce lo que se ve de verdad en los mercados de 5 min: el libro del
        // token UP trae 99 compras y CERO ventas, porque las ventas de UP estan en el libro de DOWN.
        rawAskLevels: asksDeUp || String(tokenId).endsWith("-down") ? [{ price: m + 0.005, size: competencia / 2 }] : [],
        rawBidLevels: [{ price: m - 0.005, size: competencia / 2 }],
      };
    }),
  } as never;
}

const recompensas = (ratePerDay: number) => ({
  paraMercado: vi.fn(async () => (ratePerDay > 0 ? { minSize: 50, maxSpreadCents: 1.5, ratePerDay } : undefined)),
});

const callar = () => vi.spyOn(console, "log").mockImplementation(() => undefined);

describe("bucle maker", () => {
  it("coloca los DOS lados en el mercado que paga", async () => {
    const engine = new SimulationMakerEngine();
    const loop = new MakerLoop(
      { orderbook: libro(0.5, 40), rewards: recompensas(10000) as never, engine },
      { capitalUsd: CAPITAL, retirarSegundosAntesDelCierre: 30 },
    );
    callar();
    const r = await loop.runOnce([market("BTC")], AHORA);
    expect(r.colocadas).toBe(2);
    // 50 participaciones a 0,49 en cada lado = $49. El par redime $50 gane quien gane.
    expect(r.comprometidoUsd).toBeCloseTo(49, 2);
    const vivas = await engine.ordenesVivas(market("BTC"));
    expect(vivas.map((o) => o.outcome).sort()).toEqual(["DOWN", "UP"]);
  });

  it("NO compromete el mismo dolar en dos mercados", async () => {
    // Es la guarda que evita que el exchange rechace la segunda orden — o peor, que la acepte.
    const engine = new SimulationMakerEngine();
    const loop = new MakerLoop(
      { orderbook: libro(0.5, 0), rewards: recompensas(10000) as never, engine },
      { capitalUsd: CAPITAL, retirarSegundosAntesDelCierre: 30 },
    );
    callar();
    const r = await loop.runOnce([market("BTC"), market("ETH"), market("DOGE")], AHORA);
    expect(r.colocadas).toBe(2); // un solo mercado, sus dos lados
    expect(r.comprometidoUsd).toBeLessThanOrEqual(CAPITAL);
  });

  it("cerca del cierre retira todo: una orden llena ahi resuelve en segundos", async () => {
    const engine = new SimulationMakerEngine();
    const m = market("BTC", 10);
    await engine.colocar(m, { outcome: "UP", side: "BUY", price: 0.49, size: 50 });
    const loop = new MakerLoop(
      { orderbook: libro(0.5, 0), rewards: recompensas(10000) as never, engine },
      { capitalUsd: CAPITAL, retirarSegundosAntesDelCierre: 30 },
    );
    callar();
    const r = await loop.runOnce([m], AHORA);
    expect(r.colocadas).toBe(0);
    expect(r.canceladas).toBe(1);
    expect(r.mercados[0]!.motivo).toBe("cerca_del_cierre");
  });

  it("en un mercado sin programa retira y no coloca", async () => {
    const engine = new SimulationMakerEngine();
    const m = market("BTC");
    await engine.colocar(m, { outcome: "UP", side: "BUY", price: 0.49, size: 50 });
    const loop = new MakerLoop(
      { orderbook: libro(0.5, 0), rewards: recompensas(0) as never, engine },
      { capitalUsd: CAPITAL, retirarSegundosAntesDelCierre: 30 },
    );
    callar();
    const r = await loop.runOnce([m], AHORA);
    expect(r.colocadas).toBe(0);
    expect(r.canceladas).toBe(1);
    expect(r.mercados[0]!.motivo).toBe("sin_programa_de_recompensas");
  });

  it("con el libro quieto no recoloca en la segunda pasada", async () => {
    const engine = new SimulationMakerEngine();
    const loop = new MakerLoop(
      { orderbook: libro(0.5, 0), rewards: recompensas(10000) as never, engine },
      { capitalUsd: CAPITAL, retirarSegundosAntesDelCierre: 30 },
    );
    callar();
    await loop.runOnce([market("BTC")], AHORA);
    const segunda = await loop.runOnce([market("BTC")], AHORA + 1000);
    expect(segunda.colocadas).toBe(0);
    expect(segunda.canceladas).toBe(0);
  });

  it("si no cabe el par entero, no coloca NADA", async () => {
    // Media cotizacion —un solo lado— es exactamente el error que costo $41,41.
    const engine = new SimulationMakerEngine();
    const loop = new MakerLoop(
      { orderbook: libro(0.9, 0), rewards: recompensas(10000) as never, engine },
      { capitalUsd: 20, retirarSegundosAntesDelCierre: 30 },
    );
    callar();
    const r = await loop.runOnce([market("BTC")], AHORA);
    expect(r.colocadas).toBe(0);
  });
});

describe("el libro fusionado de los dos tokens", () => {
  it("saca punto medio aunque el libro de UP no tenga NINGUNA venta", async () => {
    // Es el caso real: `book?token_id=<up>` devolvia 99 compras y 0 ventas, porque las ventas de UP
    // son compras de DOWN. Leyendo un solo libro no habia punto medio y el maker se saltaba la pasada:
    // 1.187 veces en un dia.
    const engine = new SimulationMakerEngine();
    const loop = new MakerLoop(
      { orderbook: libro(0.5, 40, { asksDeUp: false }), rewards: recompensas(10000) as never, engine },
      { capitalUsd: CAPITAL, retirarSegundosAntesDelCierre: 30 },
    );
    callar();
    const r = await loop.runOnce([market("BTC")], AHORA);
    expect(r.mercados[0]!.motivo).not.toBe("sin_punto_medio");
    expect(r.colocadas).toBe(2);
  });

  it("si un libro no llega, se salta ESE mercado y no revienta la pasada", async () => {
    // Leer los dos libros duplico la exposicion a timeouts. Una excepcion aqui abortaria la pasada
    // entera, incluidos los mercados que si respondian.
    const engine = new SimulationMakerEngine();
    const orderbook = {
      getQuote: vi.fn(async (tokenId: string) => {
        if (tokenId === "BTC-down") {
          throw new Error("Timeout tras 2000ms");
        }
        const m = String(tokenId).endsWith("-down") ? 0.5 : 0.5;
        return {
          tokenId,
          bestAsk: m + 0.005,
          bestBid: m - 0.005,
          availableUsdUnderCap: 100,
          availableUsdAllLevels: 100,
          availableBidUsdAllLevels: 100,
          estimatedSharesForAmount: 10,
          rawAskLevels: [{ price: m + 0.005, size: 0 }],
          rawBidLevels: [{ price: m - 0.005, size: 0 }],
        };
      }),
    } as never;
    const loop = new MakerLoop(
      { orderbook, rewards: recompensas(10000) as never, engine },
      { capitalUsd: CAPITAL, retirarSegundosAntesDelCierre: 30 },
    );
    callar();
    const r = await loop.runOnce([market("BTC"), market("ETH")], AHORA);
    expect(r.mercados.find((m) => m.slug.startsWith("btc"))?.motivo).toBe("sin_punto_medio");
    expect(r.colocadas).toBe(2); // ETH sigue cotizando con sus dos lados
  });

  it("si falla LEER un mercado, los demas siguen cotizando", async () => {
    // Una excepcion de `ordenesVivas` —timeout, 429— abortaba la pasada entera por `Promise.all`,
    // incluidos los mercados que si respondian y la retirada de los que estaban cerca del cierre.
    const engine = new SimulationMakerEngine();
    const roto = {
      ordenesVivas: vi.fn(async (m: MarketInfo) => {
        if (m.asset === "BTC") throw new Error("Timeout tras 2000ms");
        return engine.ordenesVivas(m);
      }),
      colocar: engine.colocar.bind(engine),
      cancelar: engine.cancelar.bind(engine),
    };
    const loop = new MakerLoop(
      { orderbook: libro(0.5, 0), rewards: recompensas(10000) as never, engine: roto as never },
      { capitalUsd: CAPITAL, retirarSegundosAntesDelCierre: 30 },
    );
    callar();
    const r = await loop.runOnce([market("BTC"), market("ETH")], AHORA);
    expect(r.colocadas).toBe(2); // ETH cotiza con sus dos lados
    expect(r.mercados.some((m) => m.slug.startsWith("btc"))).toBe(false);
  });

  it("informa de lo VIVO aparte de lo colocado en esta pasada", async () => {
    // Una orden en reposo baja el saldo del exchange sin ser una perdida. Quien decida parar mirando
    // solo el saldo pararia en operacion normal, que es peor que no tener guarda.
    const engine = new SimulationMakerEngine();
    const loop = new MakerLoop(
      { orderbook: libro(0.5, 0), rewards: recompensas(10000) as never, engine },
      { capitalUsd: CAPITAL, retirarSegundosAntesDelCierre: 30 },
    );
    callar();
    const primera = await loop.runOnce([market("BTC")], AHORA);
    expect(primera.comprometidoUsd).toBeCloseTo(49, 2);
    // En la pasada siguiente NO se coloca nada, pero sigue habiendo $49 inmovilizados.
    const segunda = await loop.runOnce([market("BTC")], AHORA + 1000);
    expect(segunda.comprometidoUsd).toBe(0);
    expect(segunda.vivoUsd).toBeCloseTo(49, 2);
  });

  it("un par COMPLETO cuenta como patrimonio; una participacion suelta, como cero", async () => {
    // Es lo que evita que un suelo de saldo salte en operacion normal. Al llenarse un par el efectivo
    // baja, pero el par redime $1 gane quien gane: el dinero no se ha perdido, ha cambiado de forma.
    // Y al reves: el lado suelto es justo lo que puede irse a cero, asi que se valora a cero.
    const m = market("BTC");
    let ordenes = [
      { id: "o1", outcome: "UP" as const, side: "BUY" as const, price: 0.49, size: 50 },
      { id: "o2", outcome: "DOWN" as const, side: "BUY" as const, price: 0.49, size: 50 },
    ];
    const engine = {
      ordenesVivas: vi.fn(async () => [...ordenes]),
      colocar: vi.fn(async () => "nueva"),
      cancelar: vi.fn(async (ids: string[]) => ids),
    };
    const loop = new MakerLoop(
      { orderbook: libro(0.5, 0), rewards: recompensas(10000) as never, engine: engine as never },
      { capitalUsd: CAPITAL, retirarSegundosAntesDelCierre: 30 },
    );
    callar();
    await loop.runOnce([m], AHORA);

    // Se llena SOLO el lado UP: 50 sueltas, ningun par -> patrimonio en posiciones = 0.
    ordenes = [{ id: "o2", outcome: "DOWN", side: "BUY", price: 0.49, size: 50 }];
    const suelto = await loop.runOnce([m], AHORA + 20_000);
    expect(loop.estadoDe(m.slug)?.inventario).toEqual({ UP: 50, DOWN: 0 });
    expect(suelto.paresUsd).toBe(0);

    // Ahora se llena el DOWN: 50 pares completos -> $50 garantizados.
    ordenes = [];
    const emparejado = await loop.runOnce([m], AHORA + 40_000);
    expect(loop.estadoDe(m.slug)?.inventario).toEqual({ UP: 50, DOWN: 50 });
    expect(emparejado.paresUsd).toBe(50);
  });

  it("no se cuenta a si mismo como competencia", async () => {
    // Si las ordenes propias contaran como rivales, la cuota estimada caeria sola en cada pasada.
    const engine = new SimulationMakerEngine();
    const m = market("BTC");
    await engine.colocar(m, { outcome: "UP", side: "BUY", price: 0.495, size: 50 });
    const loop = new MakerLoop(
      { orderbook: libro(0.5, 0), rewards: recompensas(10000) as never, engine },
      { capitalUsd: CAPITAL, retirarSegundosAntesDelCierre: 30 },
    );
    callar();
    const r = await loop.runOnce([m], AHORA);
    // Sin competencia ajena, la cuota es total: el esperado es el bote entero del dia.
    expect(r.mercados[0]!.esperadoUsdDia).toBeCloseTo(10000, 4);
  });
});

describe("dos lados o ninguno, tambien cuando el exchange rechaza", () => {
  it("si el exchange rechaza UN lado, retira el otro en vez de quedarse direccional", async () => {
    // Un rechazo —tamano bajo el minimo, un 429, una carrera del libro— dejaba la primera orden VIVA
    // con dinero real: el estado de un solo lado que costo $41,41. Y no se arregla solo: si el rechazo
    // es permanente, la pasada siguiente falla igual.
    const vivas: Array<{ id: string; outcome: "UP" | "DOWN"; side: "BUY"; price: number; size: number }> = [];
    const canceladas: string[] = [];
    const engine = {
      ordenesVivas: vi.fn(async () => [...vivas]),
      // La de UP entra; la de DOWN la rechaza el exchange.
      colocar: vi.fn(async (_m: MarketInfo, o: { outcome: "UP" | "DOWN"; price: number; size: number }) => {
        if (o.outcome === "DOWN") {
          return undefined;
        }
        vivas.push({ id: "u1", outcome: "UP", side: "BUY", price: o.price, size: o.size });
        return "u1";
      }),
      cancelar: vi.fn(async (ids: string[]) => {
        canceladas.push(...ids);
        for (const id of ids) {
          const i = vivas.findIndex((v) => v.id === id);
          if (i >= 0) vivas.splice(i, 1);
        }
        return ids;
      }),
    };
    const loop = new MakerLoop(
      { orderbook: libro(0.5, 0), rewards: recompensas(10000) as never, engine: engine as never },
      { capitalUsd: CAPITAL, retirarSegundosAntesDelCierre: 30 },
    );
    callar();
    const r = await loop.runOnce([market("BTC")], AHORA);
    expect(canceladas).toEqual(["u1"]);
    expect(vivas).toHaveLength(0);
    // Y el resumen no puede presumir de una orden que ya se retiro.
    expect(r.colocadas).toBe(0);
    expect(r.comprometidoUsd).toBeCloseTo(0, 6);
  });

  it("un lado intencionado por inventario NO se retira", async () => {
    // Con inventario desequilibrado se cotiza un lado a proposito para COMPLETAR el par. Eso es lo
    // correcto y no debe confundirse con quedarse direccional por un rechazo.
    const engine = new SimulationMakerEngine();
    const m = market("BTC");
    const loop = new MakerLoop(
      { orderbook: libro(0.5, 0), rewards: recompensas(10000) as never, engine },
      { capitalUsd: CAPITAL, retirarSegundosAntesDelCierre: 30, minMsEntreRecolocaciones: 0 },
    );
    callar();
    await loop.runOnce([m], AHORA);
    const vivas = await engine.ordenesVivas(m);
    expect(vivas.map((o) => o.outcome).sort()).toEqual(["DOWN", "UP"]);
  });
});

describe("el tope tiene que acotar el GASTO, no solo lo comprometido", () => {
  /** Motor que llena TODO lo que se coloca: el peor caso, y el que de verdad ocurrio. */
  function motorQueLlena() {
    const vivas: Array<{ id: string; outcome: "UP" | "DOWN"; side: "BUY"; price: number; size: number }> = [];
    let n = 0;
    return {
      gastado: 0,
      ordenesVivas: vi.fn(async () => [...vivas]),
      colocar: vi.fn(async (_m: MarketInfo, o: { outcome: "UP" | "DOWN"; price: number; size: number }) => {
        const id = `o${++n}`;
        vivas.push({ id, outcome: o.outcome, side: "BUY", price: o.price, size: o.size });
        return id;
      }),
      cancelar: vi.fn(async (ids: string[]) => ids),
      /** Todas las ordenes vivas se llenan de golpe y desaparecen del libro. */
      llenarTodo(this: { gastado: number }) {
        for (const o of vivas) {
          this.gastado += o.price * o.size;
        }
        vivas.length = 0;
      },
    };
  }

  it("tras llenarse, NO vuelve a colocar por encima del tope", async () => {
    // La regresion exacta del 2026-08-19: una orden llena deja de estar viva, el presupuesto se
    // liberaba y la pasada siguiente colocaba otra. Una ventana de 5 minutos gasto $85 con el tope
    // en $12 — siete veces el limite.
    const engine = motorQueLlena();
    const loop = new MakerLoop(
      { orderbook: libro(0.5, 0), rewards: recompensas(10000) as never, engine: engine as never },
      { capitalUsd: CAPITAL, retirarSegundosAntesDelCierre: 30, minMsEntreRecolocaciones: 0 },
    );
    callar();

    await loop.runOnce([market("BTC")], AHORA);
    expect(engine.colocar).toHaveBeenCalledTimes(2);
    engine.llenarTodo();

    // Cinco pasadas mas. Sin la correccion, cada una colocaria otro par de $49.
    for (let i = 1; i <= 5; i += 1) {
      await loop.runOnce([market("BTC")], AHORA + i * 20_000);
      engine.llenarTodo();
    }
    expect(engine.gastado).toBeLessThanOrEqual(CAPITAL);
    expect(engine.colocar).toHaveBeenCalledTimes(2);

    const estado = loop.estadoDe(market("BTC").slug);
    expect(estado?.gastadoUsd).toBeCloseTo(49, 2);
  });

  it("cuando la ventana se cierra, el gasto deja de contar", async () => {
    // Las posiciones resolvieron y el dinero volvio: seguir descontandolo dejaria el maker mudo.
    const engine = motorQueLlena();
    const loop = new MakerLoop(
      { orderbook: libro(0.5, 0), rewards: recompensas(10000) as never, engine: engine as never },
      { capitalUsd: CAPITAL, retirarSegundosAntesDelCierre: 30, minMsEntreRecolocaciones: 0 },
    );
    callar();
    await loop.runOnce([market("BTC")], AHORA);
    engine.llenarTodo();
    await loop.runOnce([market("BTC")], AHORA + 20_000);
    expect(loop.estadoDe(market("BTC").slug)?.gastadoUsd).toBeCloseTo(49, 2);

    // Otra ventana: el mercado viejo ya no esta en la lista.
    await loop.runOnce([market("ETH")], AHORA + 40_000);
    expect(loop.estadoDe(market("BTC").slug)).toBeUndefined();
  });
});

describe("mercados que rotan: nada se queda vivo sin vigilancia", () => {
  it("retira las ordenes de un mercado que se cae de la lista", async () => {
    // El escaner rehace su seleccion cada 5 minutos y los mercados de un dia expiran. Un mercado que
    // sale de la lista deja de recorrerse: lo que quede vivo ahi seria una orden que nadie vuelve a
    // mirar y que puede llenarse y resolver sola.
    const engine = new SimulationMakerEngine();
    const loop = new MakerLoop(
      { orderbook: libro(0.5, 0), rewards: recompensas(10000) as never, engine },
      { capitalUsd: CAPITAL, retirarSegundosAntesDelCierre: 30 },
    );
    callar();
    const viejo = market("BTC");
    await loop.runOnce([viejo], AHORA);
    expect(await engine.ordenesVivas(viejo)).toHaveLength(2);

    // Pasada siguiente: el escaner ya no lo devuelve.
    const r = await loop.runOnce([market("ETH")], AHORA + 20_000);
    expect(r.canceladas).toBeGreaterThanOrEqual(2);
    expect(await engine.ordenesVivas(viejo)).toHaveLength(0);
  });

  it("al parar retira tambien lo cotizado que ya no esta en la lista", async () => {
    // El llamante pasa los mercados de AHORA. Si uno roto entre la ultima cotizacion y la parada, sus
    // ordenes seguirian vivas y el llamante no tiene forma de saberlo.
    const engine = new SimulationMakerEngine();
    const loop = new MakerLoop(
      { orderbook: libro(0.5, 0), rewards: recompensas(10000) as never, engine },
      { capitalUsd: CAPITAL, retirarSegundosAntesDelCierre: 30 },
    );
    callar();
    const viejo = market("BTC");
    await loop.runOnce([viejo], AHORA);
    // Se para pasando una lista que NO incluye el mercado cotizado.
    expect(await loop.retirarTodo([market("ETH")])).toBeGreaterThanOrEqual(2);
    expect(await engine.ordenesVivas(viejo)).toHaveLength(0);
  });

  it("si no se pueden retirar, el mercado se conserva para reintentarlo", async () => {
    // Olvidarlo seria perder de vista ordenes vivas de verdad.
    let fallarBtc = false;
    const vivas = [{ id: "o1", outcome: "UP" as const, side: "BUY" as const, price: 0.49, size: 50 }];
    const engine = {
      ordenesVivas: vi.fn(async (m: MarketInfo) => {
        if (fallarBtc && m.asset === "BTC") throw new Error("red caida");
        return [...vivas];
      }),
      colocar: vi.fn(async () => "nueva"),
      cancelar: vi.fn(async (ids: string[]) => ids),
    };
    const loop = new MakerLoop(
      { orderbook: libro(0.5, 0), rewards: recompensas(10000) as never, engine: engine as never },
      { capitalUsd: CAPITAL, retirarSegundosAntesDelCierre: 30 },
    );
    callar();
    await loop.runOnce([market("BTC")], AHORA);
    fallarBtc = true;
    await loop.runOnce([market("ETH")], AHORA + 20_000);
    fallarBtc = false;
    // El mercado sigue vigilado: en la pasada siguiente se vuelve a intentar.
    const r = await loop.runOnce([market("ETH")], AHORA + 40_000);
    expect(r.canceladas).toBeGreaterThan(0);
  });
});

describe("no martillear al exchange", () => {
  it("no recoloca dos veces seguidas en el mismo mercado", async () => {
    const engine = new SimulationMakerEngine();
    const loop = new MakerLoop(
      { orderbook: libro(0.5, 0), rewards: recompensas(10000) as never, engine },
      { capitalUsd: CAPITAL, retirarSegundosAntesDelCierre: 30, minMsEntreRecolocaciones: 15_000 },
    );
    callar();
    const primera = await loop.runOnce([market("BTC")], AHORA);
    expect(primera.colocadas).toBe(2);

    // Dos segundos despues el precio se ha movido fuera de banda: sin freno recolocaria.
    const loop2 = loop as unknown as { deps: { orderbook: unknown } };
    loop2.deps.orderbook = libro(0.6, 0);
    const segunda = await loop.runOnce([market("BTC")], AHORA + 2000);
    expect(segunda.colocadas).toBe(0);
    expect(segunda.canceladas).toBe(0);

    // Pasado el intervalo, si.
    const tercera = await loop.runOnce([market("BTC")], AHORA + 16_000);
    expect(tercera.colocadas).toBe(2);
  });
});

describe("lo que pasa cuando algo va mal", () => {
  it("al parar, retira TODAS las ordenes vivas", async () => {
    const engine = new SimulationMakerEngine();
    const m1 = market("BTC");
    const m2 = market("ETH");
    await engine.colocar(m1, { outcome: "UP", side: "BUY", price: 0.49, size: 50 });
    await engine.colocar(m2, { outcome: "UP", side: "BUY", price: 0.49, size: 50 });
    const loop = new MakerLoop(
      { orderbook: libro(0.5, 0), rewards: recompensas(10000) as never, engine },
      { capitalUsd: CAPITAL, retirarSegundosAntesDelCierre: 30 },
    );
    callar();
    expect(await loop.retirarTodo([m1, m2])).toBe(2);
    expect(await engine.ordenesVivas(m1)).toHaveLength(0);
    expect(await engine.ordenesVivas(m2)).toHaveLength(0);
  });

  it("si un mercado falla al retirar, sigue con los demas", async () => {
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
      { capitalUsd: CAPITAL, retirarSegundosAntesDelCierre: 30 },
    );
    callar();
    expect(await loop.retirarTodo([m1, m2])).toBe(1);
    expect(await engine.ordenesVivas(m2)).toHaveLength(0);
  });

  it("detecta un llenado PARCIAL", async () => {
    const m = market("BTC");
    let tamano = 50;
    const engine = {
      ordenesVivas: vi.fn(async () => [
        { id: "o1", outcome: "UP" as const, side: "BUY" as const, price: 0.49, size: tamano },
        { id: "o2", outcome: "DOWN" as const, side: "BUY" as const, price: 0.49, size: 50 },
      ]),
      colocar: vi.fn(async () => "nueva"),
      cancelar: vi.fn(async (ids: string[]) => ids),
    };
    const loop = new MakerLoop(
      { orderbook: libro(0.5, 0), rewards: recompensas(10000) as never, engine: engine as never },
      { capitalUsd: CAPITAL, retirarSegundosAntesDelCierre: 30 },
    );
    callar();
    await loop.runOnce([m], AHORA);
    tamano = 30; // se llenaron 20 participaciones
    const segunda = await loop.runOnce([m], AHORA + 20_000);
    expect(segunda.llenadas).toBe(20);
    expect(loop.estadoDe(m.slug)?.inventario.UP).toBe(20);
  });

  it("detecta un llenado TOTAL, que antes era invisible", async () => {
    // Una orden llena del todo DESAPARECE del libro. El codigo viejo solo miraba las que seguian
    // vivas con menos tamano, asi que el llenado completo —el que mas dinero mueve— no se contaba.
    const m = market("BTC");
    // Se parte con el par ya puesto, para que la pasada no coloque nada y el unico cambio observable
    // sea la desaparicion de las dos.
    let ordenes = [
      { id: "o1", outcome: "UP" as const, side: "BUY" as const, price: 0.49, size: 50 },
      { id: "o2", outcome: "DOWN" as const, side: "BUY" as const, price: 0.49, size: 50 },
    ];
    const engine = {
      ordenesVivas: vi.fn(async () => [...ordenes]),
      colocar: vi.fn(async () => "nueva"),
      cancelar: vi.fn(async (ids: string[]) => ids),
    };
    const loop = new MakerLoop(
      { orderbook: libro(0.5, 0), rewards: recompensas(10000) as never, engine: engine as never },
      { capitalUsd: CAPITAL, retirarSegundosAntesDelCierre: 30 },
    );
    callar();
    await loop.runOnce([m], AHORA);
    expect(engine.colocar).not.toHaveBeenCalled();
    ordenes = [];
    const segunda = await loop.runOnce([m], AHORA + 20_000);
    expect(segunda.llenadas).toBe(100);
    expect(loop.estadoDe(m.slug)?.gastadoUsd).toBeCloseTo(49, 2);
    expect(loop.estadoDe(m.slug)?.inventario).toEqual({ UP: 50, DOWN: 50 });
  });

  it("una CANCELACION nuestra no se confunde con un llenado", async () => {
    // Sin llevar la cuenta de lo que cancelamos, toda orden que desaparece pareceria llenada y el
    // tope de gasto se agotaria solo, dejando al maker mudo sin motivo.
    const m = market("BTC", 10); // cerca del cierre: el bucle cancela
    let ordenes = [{ id: "o1", outcome: "UP" as const, side: "BUY" as const, price: 0.49, size: 50 }];
    const engine = {
      ordenesVivas: vi.fn(async () => [...ordenes]),
      colocar: vi.fn(async () => "nueva"),
      cancelar: vi.fn(async (ids: string[]) => {
        ordenes = ordenes.filter((o) => !ids.includes(o.id));
        return ids;
      }),
    };
    const loop = new MakerLoop(
      { orderbook: libro(0.5, 0), rewards: recompensas(10000) as never, engine: engine as never },
      { capitalUsd: CAPITAL, retirarSegundosAntesDelCierre: 30 },
    );
    callar();
    await loop.runOnce([m], AHORA); // cancela o1
    const segunda = await loop.runOnce([m], AHORA + 20_000);
    expect(segunda.llenadas).toBeUndefined();
    expect(loop.estadoDe(m.slug)?.gastadoUsd ?? 0).toBe(0);
  });
});

describe("mensajes que no mienten", () => {
  it("si NO se financia ninguno, dice que falta capital y cuanto", async () => {
    const engine = new SimulationMakerEngine();
    const loop = new MakerLoop(
      { orderbook: libro(0.5, 0), rewards: recompensas(10000) as never, engine },
      { capitalUsd: 12, retirarSegundosAntesDelCierre: 30 },
    );
    callar();
    // El par cuesta ~$49: con $12 no se llega. Es el tope con el que se opero en live el 2026-08-19,
    // y explica por que solo podia colocar medio lado en la cola barata.
    const r = await loop.runOnce([market("BTC")], AHORA);
    expect(r.colocadas).toBe(0);
    expect(r.mercados[0]!.motivo).toMatch(/^capital_insuficiente_necesita_/);
  });
});

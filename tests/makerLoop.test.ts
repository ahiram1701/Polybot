import { describe, expect, it, vi } from "vitest";

import { MakerLoop } from "../src/makerLoop.js";
import { SimulationMakerEngine } from "../src/makerEngine.js";
import { logger } from "../src/logger.js";
import type { LogEntry } from "../src/logger.js";
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

  it("sembrar posiciones devuelve los pares que el reinicio borro", async () => {
    // El fallo real del 2026-08-28: la PC se reinicio con 6,45 pares abiertos, el maker volvio creyendo
    // que no tenia nada y se detuvo por un suelo de patrimonio que en realidad no habia cruzado.
    const loop = new MakerLoop(
      { orderbook: libro(0.5, 40), rewards: recompensas(10000) as never, engine: new SimulationMakerEngine() },
      { capitalUsd: CAPITAL, retirarSegundosAntesDelCierre: 30 },
    );
    callar();
    expect(loop.paresUsd()).toBe(0);

    const sembradas = loop.sembrarPosiciones(
      [
        {
          slug: "gta-vi",
          finMs: AHORA + 3_600_000,
          gastadoUsd: 8.1085,
          inventario: { UP: 20, DOWN: 6.45 },
        },
      ],
      AHORA,
    );

    expect(sembradas).toBe(1);
    // min(20, 6.45) pares, a $1 el par.
    expect(loop.paresUsd()).toBeCloseTo(6.45, 4);
  });

  it("no siembra posiciones de mercados ya acabados", async () => {
    // Su dinero vuelve solo al redimirse; contarlo ademas dejaria al maker mudo de mas.
    const loop = new MakerLoop(
      { orderbook: libro(0.5, 40), rewards: recompensas(10000) as never, engine: new SimulationMakerEngine() },
      { capitalUsd: CAPITAL, retirarSegundosAntesDelCierre: 30 },
    );
    callar();

    const sembradas = loop.sembrarPosiciones(
      [{ slug: "vieja", finMs: AHORA - 1000, gastadoUsd: 5, inventario: { UP: 10, DOWN: 10 } }],
      AHORA,
    );

    expect(sembradas).toBe(0);
    expect(loop.paresUsd()).toBe(0);
  });

  it("lo que el bucle ya sabe manda sobre lo sembrado", async () => {
    // El estado de ESTA sesion es mas fresco que cualquier lectura externa: pisarlo seria retroceder.
    const loop = new MakerLoop(
      { orderbook: libro(0.5, 40), rewards: recompensas(10000) as never, engine: new SimulationMakerEngine() },
      { capitalUsd: CAPITAL, retirarSegundosAntesDelCierre: 30 },
    );
    callar();
    await loop.runOnce([market("BTC")], AHORA);

    const sembradas = loop.sembrarPosiciones(
      [{ slug: market("BTC").slug, finMs: AHORA + 3_600_000, gastadoUsd: 99, inventario: { UP: 99, DOWN: 99 } }],
      AHORA,
    );

    expect(sembradas).toBe(0);
    expect(loop.paresUsd()).toBe(0); // el mercado vivo no tiene llenados, no los 99 inventados
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

  it("si el exchange LANZA al rechazar un lado, tambien retira el otro", async () => {
    // El gemelo del test de arriba, y el que faltaba. Aquel cubria el rechazo que devuelve `undefined`,
    // que es lo que dice el contrato; pero el motor LIVE no devuelve, LANZA, porque el rechazo llega
    // como un 400 del CLOB. Y la excepcion se salia de `runOnce` entera, saltandose la atomicidad.
    //
    // Real, 2026-08-29 00:00:08: "not enough balance", $6,80 de un solo lado vivos en el libro y sin
    // registrar —el resumen se pierde con la excepcion—. Los limpio 25 segundos despues una guarda que
    // miraba otra cosa.
    const vivas: Array<{ id: string; outcome: "UP" | "DOWN"; side: "BUY"; price: number; size: number }> = [];
    const canceladas: string[] = [];
    const engine = {
      ordenesVivas: vi.fn(async () => [...vivas]),
      colocar: vi.fn(async (_m: MarketInfo, o: { outcome: "UP" | "DOWN"; price: number; size: number }) => {
        if (o.outcome === "DOWN") {
          throw new Error(
            "not enough balance / allowance: the balance is not enough -> balance: 17046831, sum of active orders: 6800000",
          );
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

    // Lo primero: la pasada NO puede lanzar, o el resumen se pierde y nadie se entera de nada.
    const r = await loop.runOnce([market("BTC")], AHORA);

    expect(canceladas).toEqual(["u1"]);
    expect(vivas).toHaveLength(0); // sin patas huerfanas en el libro
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

  it("cuando el mercado ACABA, el gasto deja de contar", async () => {
    // Las posiciones resolvieron y el dinero volvio: seguir descontandolo dejaria el maker mudo.
    const engine = motorQueLlena();
    const loop = new MakerLoop(
      { orderbook: libro(0.5, 0), rewards: recompensas(10000) as never, engine: engine as never },
      { capitalUsd: CAPITAL, retirarSegundosAntesDelCierre: 30, minMsEntreRecolocaciones: 0 },
    );
    callar();
    const btc = market("BTC", 200);
    await loop.runOnce([btc], AHORA);
    engine.llenarTodo();
    await loop.runOnce([btc], AHORA + 20_000);
    expect(loop.estadoDe(btc.slug)?.gastadoUsd).toBeCloseTo(49, 2);

    // Otra ventana, y la de BTC ya PASO (cerraba a los 200 s): su posicion resolvio y su dinero volvio.
    await loop.runOnce([market("ETH")], AHORA + 300_000);
    expect(loop.estadoDe(btc.slug)).toBeUndefined();
    expect(loop.paresUsd()).toBe(0);
  });

  it("pero si el mercado sigue ABIERTO, el gasto sigue contando aunque rote", async () => {
    // El estado se borraba al rotar con el argumento de que "esas posiciones ya resolvieron". Cierto
    // para una ventana de cripto de 5 min; FALSO para los mercados de un dia o de meses que el maker
    // opera ahora. Si te llenan un lado en uno de temperatura y luego se cae del top-25 —7 veces en
    // 24 h—, su gasto dejaba de contar contra el tope con la posicion todavia abierta.
    const engine = motorQueLlena();
    const loop = new MakerLoop(
      { orderbook: libro(0.5, 0), rewards: recompensas(10000) as never, engine: engine as never },
      { capitalUsd: CAPITAL, retirarSegundosAntesDelCierre: 30, minMsEntreRecolocaciones: 0 },
    );
    callar();
    const btc = market("BTC", 7200); // dos horas por delante: no resuelve por rotar
    await loop.runOnce([btc], AHORA);
    engine.llenarTodo();
    await loop.runOnce([btc], AHORA + 20_000);
    expect(loop.estadoDe(btc.slug)?.gastadoUsd).toBeCloseTo(49, 2);

    // BTC se cae de la lista, pero su mercado sigue abierto: esos $49 siguen fuera de la cuenta.
    const r = await loop.runOnce([market("ETH", 7200)], AHORA + 40_000);
    expect(r.gastadoUsd).toBeCloseTo(49, 2);
    // Y con $60 de tope y $49 gastados no queda para financiar otro par de $49.
    expect(r.colocadas).toBe(0);
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

/**
 * El dinero atado en ordenes vivas tiene que cuadrar SIEMPRE, y con una sola cuenta.
 *
 * Habia dos medias cuentas —lo comprometido al empezar y lo usado al planificar— y las tres formas de
 * que se descuadraran costaban dinero en direcciones opuestas: una dejaba al maker mudo con el capital
 * libre, otra le dejaba pasarse del tope, y la tercera reportaba menos patrimonio del que hay, que es
 * lo que lee el suelo para decidir si parar.
 */
describe("la contabilidad del capital no puede mentir", () => {
  /** Libro con competencia DISTINTA por activo: asi uno gana el ranking y el otro lo pierde. */
  function libroPorActivo(competenciaPorActivo: Record<string, number>) {
    return {
      getQuote: vi.fn(async (tokenId: string) => {
        const asset = String(tokenId).split("-")[0]!;
        const competencia = competenciaPorActivo[asset] ?? 0;
        const m = 0.5;
        return {
          tokenId,
          bestAsk: m + 0.005,
          bestBid: m - 0.005,
          availableUsdUnderCap: 100,
          availableUsdAllLevels: 100,
          availableBidUsdAllLevels: 100,
          estimatedSharesForAmount: 10,
          rawAskLevels: [{ price: m + 0.005, size: competencia / 2 }],
          rawBidLevels: [{ price: m - 0.005, size: competencia / 2 }],
        };
      }),
    } as never;
  }

  /** Libro que revienta por timeout en ciertos activos, que es lo que pasa ~1.000 veces por hora. */
  function libroQueFallaEn(assetsQueFallan: string[]) {
    return {
      getQuote: vi.fn(async (tokenId: string) => {
        const asset = String(tokenId).split("-")[0]!;
        if (assetsQueFallan.includes(asset)) {
          throw new Error("Timeout tras 2000ms: orderbook getQuote");
        }
        const m = 0.5;
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
  }

  it("el dinero de un mercado descartado vuelve al bote en la MISMA pasada", async () => {
    // Un mercado financiado que pierde el ranking se queda sin ordenes en el acto, asi que su capital
    // esta libre. Apartarlo hasta la pasada siguiente dejaba sin cotizar al que acababa de GANAR el
    // ranking: $60 de tope, $0 en uso, y aun asi "capital_insuficiente_necesita_49.00".
    const engine = new SimulationMakerEngine();
    const btc = market("BTC");
    await engine.colocar(btc, { outcome: "UP", side: "BUY", price: 0.49, size: 50 });
    await engine.colocar(btc, { outcome: "DOWN", side: "BUY", price: 0.49, size: 50 });

    const loop = new MakerLoop(
      { orderbook: libroPorActivo({ BTC: 100_000, ETH: 0 }), rewards: recompensas(10000) as never, engine },
      { capitalUsd: CAPITAL, retirarSegundosAntesDelCierre: 30 },
    );
    callar();
    await loop.runOnce([btc, market("ETH")], AHORA);
    expect(await engine.ordenesVivas(btc)).toHaveLength(0);
    expect(await engine.ordenesVivas(market("ETH"))).toHaveLength(2);
  });

  it("un mercado cuyo libro no llega SIGUE contando: ni se pasa del tope ni desaparece del patrimonio", async () => {
    // Sin punto medio no se cotiza, pero tampoco se retira nada: sus ordenes siguen vivas y su dinero
    // sigue fuera. Antes se borraban de la cuenta y pasaban las dos cosas a la vez — $98 atados con el
    // tope en $60, y un `vivoUsd` de $0 que le habria dicho al suelo de patrimonio que no queda nada.
    const engine = new SimulationMakerEngine();
    const btc = market("BTC");
    await engine.colocar(btc, { outcome: "UP", side: "BUY", price: 0.49, size: 50 });
    await engine.colocar(btc, { outcome: "DOWN", side: "BUY", price: 0.49, size: 50 });

    const loop = new MakerLoop(
      { orderbook: libroQueFallaEn(["BTC"]), rewards: recompensas(10000) as never, engine },
      { capitalUsd: CAPITAL, retirarSegundosAntesDelCierre: 30 },
    );
    callar();
    const r = await loop.runOnce([btc, market("ETH")], AHORA);
    expect(r.mercados.find((m) => m.slug.startsWith("btc"))?.motivo).toBe("sin_punto_medio");

    const vivas = [...(await engine.ordenesVivas(btc)), ...(await engine.ordenesVivas(market("ETH")))];
    const atadoDeVerdad = vivas.reduce((s, o) => s + o.price * o.size, 0);
    expect(atadoDeVerdad).toBeLessThanOrEqual(CAPITAL);
    expect(r.vivoUsd).toBeCloseTo(atadoDeVerdad, 2);
  });

  it("al retirar por un rechazo, solo se deshace lo COLOCADO en esta pasada", async () => {
    // El retroceso restaba tambien el valor de lo conservado, que nunca llego a sumarse: `comprometidoUsd`
    // cuenta colocaciones, no ordenes vivas. Con una sola orden conservada de $24,50 el resumen salia a
    // -$24,50, y ese numero es el que mira el informe del maker para decir si esta trabajando.
    const sim = new SimulationMakerEngine();
    const btc = market("BTC");
    await sim.colocar(btc, { outcome: "UP", side: "BUY", price: 0.49, size: 50 });
    const engine = {
      ordenesVivas: (m: MarketInfo) => sim.ordenesVivas(m),
      colocar: async () => undefined, // el exchange rechaza toda colocacion nueva
      cancelar: (ids: string[]) => sim.cancelar(ids),
    };
    const loop = new MakerLoop(
      { orderbook: libroPorActivo({ BTC: 0 }), rewards: recompensas(10000) as never, engine: engine as never },
      { capitalUsd: CAPITAL, retirarSegundosAntesDelCierre: 30 },
    );
    callar();
    const r = await loop.runOnce([btc], AHORA);
    expect(r.comprometidoUsd).toBe(0);
    expect(r.colocadas).toBe(0);
    // Y lo que importa de verdad: no queda ningun lado suelto.
    expect(await sim.ordenesVivas(btc)).toHaveLength(0);
  });
});

/**
 * Elegir mercado es TODO el negocio del maker, y hasta el 2026-08-21 se elegia casi a ciegas.
 *
 * Medido ese dia sobre el registro real: entre los 13.109 mercados que caben en $20 hay 54 empatados
 * por bote, la correlacion entre el orden del escaner y el rendimiento real es 0,007, y el rendimiento
 * va de 10,2 a 0,004 dolares al dia por dolar. Con esa forma, dos cosas deciden cuanto se gana: mirar
 * a MUCHOS (el mejor de 20 rinde 2,2x el mejor de 3) y no mudarse por ruido (10,7 mudanzas/hora, el
 * 86% a un mercado que no era mejor).
 */
describe("elegir donde cotizar", () => {
  /** Libro con competencia por activo y CONTADOR de lecturas, que es el recurso escaso. */
  function libroContado(competenciaPorActivo: Record<string, number>) {
    const getQuote = vi.fn(async (tokenId: string) => {
      const asset = String(tokenId).split("-")[0]!;
      const competencia = competenciaPorActivo[asset] ?? 0;
      const m = 0.5;
      return {
        tokenId,
        bestAsk: m + 0.005,
        bestBid: m - 0.005,
        availableUsdUnderCap: 100,
        availableUsdAllLevels: 100,
        availableBidUsdAllLevels: 100,
        estimatedSharesForAmount: 10,
        rawAskLevels: [{ price: m + 0.005, size: competencia / 2 }],
        rawBidLevels: [{ price: m - 0.005, size: competencia / 2 }],
      };
    });
    return { orderbook: { getQuote } as never, getQuote };
  }

  /** Bote por activo, mutable: es la forma exacta de mover el ranking sin tocar el libro. */
  function recompensasPorActivo(botes: Record<string, number>) {
    return {
      paraMercado: vi.fn(async (_id: string, slug?: string) => ({
        minSize: 50,
        maxSpreadCents: 1.5,
        ratePerDay: botes[String(slug).split("-")[0]!.toUpperCase()] ?? 0,
      })),
    };
  }

  it("no lee el libro de TODOS: sondea por turnos y ordena con la ultima ficha", async () => {
    // 25 candidatos x 3 peticiones cada 15 s contra un pool de 24 conexiones es como se llego a 1.049
    // timeouts en una hora con el endpoint respondiendo en 280 ms. Mirar a muchos solo es posible si
    // mirar es barato.
    const engine = new SimulationMakerEngine();
    const { orderbook, getQuote } = libroContado({});
    const loop = new MakerLoop(
      { orderbook, rewards: recompensas(10000) as never, engine },
      { capitalUsd: CAPITAL, retirarSegundosAntesDelCierre: 30, sondeosPorPasada: 2 },
    );
    callar();
    const muchos = ["BTC", "ETH", "DOGE", "SOL", "XRP", "ADA"].map((a) => market(a));
    await loop.runOnce(muchos, AHORA);
    // 2 sondeos x 2 libros. Sin el cupo serian 12 lecturas para decidir, casi siempre, no hacer nada.
    expect(getQuote).toHaveBeenCalledTimes(4);
  });

  it("un mercado con ficha compite aunque no toque sondearlo, y se RELEE antes de cotizar", async () => {
    // La ficha vale para ordenar y no para colocar: la banda que puntua son 1,5 centavos, asi que con
    // un medio rancio las dos ordenes pueden nacer fuera, sin cobrar y con el dinero inmovilizado.
    const engine = new SimulationMakerEngine();
    // ETH no tiene competencia (rinde mas); BTC y DOGE si.
    const { orderbook, getQuote } = libroContado({ BTC: 100_000, DOGE: 100_000 });
    const loop = new MakerLoop(
      { orderbook, rewards: recompensas(10000) as never, engine },
      { capitalUsd: CAPITAL, retirarSegundosAntesDelCierre: 30, sondeosPorPasada: 1 },
    );
    callar();
    const tres = [market("BTC"), market("ETH"), market("DOGE")];
    await loop.runOnce(tres, AHORA); // sondea BTC
    await loop.runOnce(tres, AHORA + 20_000); // sondea ETH: ya tiene ficha
    getQuote.mockClear();
    // Aqui toca DOGE por turno; ETH entra al ranking con su ficha, gana, y se relee para cotizar.
    await loop.runOnce(tres, AHORA + 40_000);
    const vivas = await engine.ordenesVivas(market("ETH"));
    expect(vivas.map((o) => o.outcome).sort()).toEqual(["DOWN", "UP"]);
    const leidos = (a: string) => getQuote.mock.calls.filter((c) => String(c[0]).startsWith(a)).length;
    expect(leidos("ETH")).toBe(2); // releido, no cotizado a ciegas
    // Y BTC no: no se cotiza ahi y ya tenia ficha. Leerlos todos es lo que hacia inasumible mirar a 25.
    expect(leidos("BTC")).toBe(0);
  });

  it("no se muda por un empate, pero si por una mejora de verdad", async () => {
    // 10,7 mudanzas por hora, el 86% abandonando un mercado que seguia disponible. No era informacion
    // nueva: era un empate resuelto a cara o cruz entre 54 mercados casi identicos.
    const engine = new SimulationMakerEngine();
    const botes: Record<string, number> = { BTC: 100, ETH: 50 };
    const { orderbook } = libroContado({});
    const loop = new MakerLoop(
      { orderbook, rewards: recompensasPorActivo(botes) as never, engine },
      { capitalUsd: CAPITAL, retirarSegundosAntesDelCierre: 30, margenRelevo: 0.25 },
    );
    callar();
    const dos = [market("BTC"), market("ETH")];

    await loop.runOnce(dos, AHORA);
    expect(await engine.ordenesVivas(market("BTC"))).toHaveLength(2);

    // ETH pasa a rendir un 10% mas: por encima, pero dentro del ruido. No se toca nada.
    botes.ETH = 110;
    await loop.runOnce(dos, AHORA + 60_000);
    expect(await engine.ordenesVivas(market("BTC"))).toHaveLength(2);
    expect(await engine.ordenesVivas(market("ETH"))).toHaveLength(0);

    // Un 40% mas ya no es ruido: el capital se muda.
    botes.ETH = 140;
    await loop.runOnce(dos, AHORA + 120_000);
    expect(await engine.ordenesVivas(market("BTC"))).toHaveLength(0);
    expect(await engine.ordenesVivas(market("ETH"))).toHaveLength(2);
  });

  it("la cifra que se reporta es la honesta, sin la ventaja del titular", async () => {
    // La ventaja existe para no mudarse por ruido, no para creerse mas rico. `esperadoUsdDia` es lo que
    // se mira para saber si el modelo acierta: falsearlo ahi seria mentirse en el sitio mas caro.
    const engine = new SimulationMakerEngine();
    const { orderbook } = libroContado({});
    const loop = new MakerLoop(
      { orderbook, rewards: recompensasPorActivo({ BTC: 100 }) as never, engine },
      { capitalUsd: CAPITAL, retirarSegundosAntesDelCierre: 30, margenRelevo: 0.25 },
    );
    callar();
    await loop.runOnce([market("BTC")], AHORA);
    const segunda = await loop.runOnce([market("BTC")], AHORA + 60_000);
    const btc = segunda.mercados.find((m) => m.slug.startsWith("btc"));
    expect(btc?.esperadoUsdDia).toBeCloseTo(100, 6); // el bote entero, sin competencia y sin inflar
  });
});

describe("con 25 candidatos, los mensajes tienen que seguir siendo legibles", () => {
  it("si no se financia ninguno, UNA linea con la entrada mas barata", async () => {
    // Una linea por candidato eran 25 identicas por pasada, y el ruido tapa lo que importa. El dato
    // accionable es cuanto capital hace falta para poder cotizar en algun sitio: el minimo, no el primero.
    const engine = new SimulationMakerEngine();
    const rewards = {
      paraMercado: vi.fn(async (_id: string, slug?: string) => ({
        // DOGE es el mas barato de los tres, y es el que hay que nombrar.
        minSize: String(slug).startsWith("doge") ? 80 : 200,
        maxSpreadCents: 1.5,
        ratePerDay: 10000,
      })),
    };
    const loop = new MakerLoop(
      { orderbook: libro(0.5, 0), rewards: rewards as never, engine },
      { capitalUsd: 60, retirarSegundosAntesDelCierre: 30 },
    );
    callar();
    const r = await loop.runOnce([market("BTC"), market("ETH"), market("DOGE")], AHORA);
    const avisos = r.mercados.filter((m) => m.motivo?.startsWith("capital_insuficiente"));
    expect(avisos).toHaveLength(1);
    expect(avisos[0]!.motivo).toBe("capital_insuficiente_necesita_80.00");
    expect(avisos[0]!.slug).toContain("(+2 mas)");
  });
});

describe("el reparto no puede depender del ORDEN de la lista", () => {
  it("el ganador cobra su presupuesto aunque el titular al que releva vaya DETRAS", async () => {
    // Cazado con `npm run ensayo:maker`, no razonando: en una sola pasada el titular quedo cancelado
    // y el ganador recibio `capital_insuficiente_necesita_19.80`, dejando al maker sin cotizar en
    // ningun sitio con el tope entero libre. En un solo recorrido el presupuesto del ganador dependia
    // de si el mercado al que releva aparecia antes o despues que el. Ahora primero se suelta todo lo
    // descartado y solo despues se reparte.
    const engine = new SimulationMakerEngine();
    const btc = market("BTC");
    await engine.colocar(btc, { outcome: "UP", side: "BUY", price: 0.49, size: 50 });
    await engine.colocar(btc, { outcome: "DOWN", side: "BUY", price: 0.49, size: 50 });

    const orderbook = {
      getQuote: vi.fn(async (tokenId: string) => {
        const asset = String(tokenId).split("-")[0]!;
        const competencia = asset === "BTC" ? 100_000 : 0; // BTC pierde el ranking
        const m = 0.5;
        return {
          tokenId,
          bestAsk: m + 0.005,
          bestBid: m - 0.005,
          availableUsdUnderCap: 100,
          availableUsdAllLevels: 100,
          availableBidUsdAllLevels: 100,
          estimatedSharesForAmount: 10,
          rawAskLevels: [{ price: m + 0.005, size: competencia / 2 }],
          rawBidLevels: [{ price: m - 0.005, size: competencia / 2 }],
        };
      }),
    } as never;
    const loop = new MakerLoop(
      { orderbook, rewards: recompensas(10000) as never, engine },
      { capitalUsd: CAPITAL, retirarSegundosAntesDelCierre: 30 },
    );
    callar();
    // ETH —el que va a GANAR— primero en la lista, y el titular BTC detras.
    const r = await loop.runOnce([market("ETH"), btc], AHORA);
    expect(await engine.ordenesVivas(btc)).toHaveLength(0);
    expect(await engine.ordenesVivas(market("ETH"))).toHaveLength(2);
    expect(r.mercados.some((m) => m.motivo?.startsWith("capital_insuficiente"))).toBe(false);
  });
});

/**
 * Un maker sano parado en su mejor mercado y uno que no encuentra donde entrar escribian lo MISMO:
 * nada. El log solo hablaba cuando algo cambiaba, y quedarse quieto es justo el objetivo del modelo
 * desde que no se muda por ruido. Medido el 2026-08-21: ocho minutos sin una linea, y hubo que
 * preguntarle a la API para saber que estaba sano.
 */
describe("el latido: el silencio tiene que significar algo", () => {
  /** Escucha el logger de verdad, que es lo que se lee en produccion. */
  function escuchar() {
    const entradas: LogEntry[] = [];
    const cortar = logger.subscribe((e) => entradas.push(e));
    return { entradas, cortar, delMaker: () => entradas.filter((e) => e.message.startsWith("Maker:")) };
  }

  it("sin movimiento late cada intervalo, no en cada pasada", async () => {
    const engine = new SimulationMakerEngine();
    const loop = new MakerLoop(
      { orderbook: libro(0.5, 0), rewards: recompensas(10000) as never, engine },
      { capitalUsd: CAPITAL, retirarSegundosAntesDelCierre: 30, intervaloLatidoMs: 60_000 },
    );
    callar();
    const m = market("BTC", 3600);
    await loop.runOnce([m], AHORA); // coloca: deja constancia por si misma

    const { entradas, cortar, delMaker } = escuchar();
    await loop.runOnce([m], AHORA + 30_000); // dentro del intervalo: callado
    expect(delMaker()).toHaveLength(0);

    await loop.runOnce([m], AHORA + 70_000); // pasado el intervalo: late
    const latidos = delMaker();
    expect(latidos).toHaveLength(1);
    expect(latidos[0]!.message).toBe("Maker: latido.");
    cortar();
    void entradas;
  });

  it("el latido dice DONDE se esta cotizando", async () => {
    const engine = new SimulationMakerEngine();
    const loop = new MakerLoop(
      { orderbook: libro(0.5, 0), rewards: recompensas(10000) as never, engine },
      { capitalUsd: CAPITAL, retirarSegundosAntesDelCierre: 30, intervaloLatidoMs: 1000 },
    );
    callar();
    const m = market("BTC", 3600);
    await loop.runOnce([m], AHORA);

    const { cortar, delMaker } = escuchar();
    await loop.runOnce([m], AHORA + 20_000);
    const meta = delMaker()[0]!.meta as Record<string, unknown>;
    expect(meta.cotizandoEn).toBe(1);
    expect(meta.mercados).toEqual([m.slug]);
    expect(meta.vivoUsd).toBeCloseTo(49, 2);
    // Cotizando no hace falta explicar nada: el "por que no" solo aparece cuando no se cotiza.
    expect(meta.porQueNo).toBeUndefined();
    cortar();
  });

  it("un movimiento reprograma el latido en vez de sumarse a el", async () => {
    // Dos lineas seguidas diciendo lo mismo no aportan nada, y el latido existe para quitar ruido.
    const engine = new SimulationMakerEngine();
    const loop = new MakerLoop(
      { orderbook: libro(0.5, 0), rewards: recompensas(10000) as never, engine },
      { capitalUsd: CAPITAL, retirarSegundosAntesDelCierre: 30, intervaloLatidoMs: 1000 },
    );
    callar();
    const { cortar, delMaker } = escuchar();
    await loop.runOnce([market("BTC", 3600)], AHORA); // coloca
    expect(delMaker().map((e) => e.message)).toEqual(["Maker: ordenes actualizadas."]);
    cortar();
  });

  it("mucho rato sin cotizar en NINGUN sitio sube a aviso, y dice por que", async () => {
    // Es el estado que no se distinguia de uno sano. Unos minutos es corriente —un mercado que cierra,
    // una rotacion del escaner—; un cuarto de hora sin una sola orden viva no lo es.
    const engine = new SimulationMakerEngine();
    const loop = new MakerLoop(
      { orderbook: libro(0.5, 0), rewards: recompensas(0) as never, engine },
      { capitalUsd: CAPITAL, retirarSegundosAntesDelCierre: 30 },
    );
    callar();
    const m = market("BTC", 7200);
    const { cortar, delMaker } = escuchar();

    await loop.runOnce([m], AHORA);
    expect(delMaker().at(-1)!.message).toBe("Maker: latido."); // recien mudo: aun es normal

    await loop.runOnce([m], AHORA + 16 * 60_000);
    const aviso = delMaker().at(-1)!;
    expect(aviso.level).toBe("warn");
    expect(aviso.message).toBe("Maker: sin cotizar en ningun sitio.");
    const meta = aviso.meta as Record<string, unknown>;
    expect(meta.mudoMinutos).toBe(16);
    expect(meta.porQueNo).toEqual({ sin_programa_de_recompensas: 1 });
    cortar();
  });

  it("el reloj del mudo cuenta desde que se quedo mudo, no desde el ultimo latido", async () => {
    // Si se reiniciara con cada latido, el aviso del cuarto de hora no saltaria NUNCA: el latido es
    // cada cinco minutos.
    const engine = new SimulationMakerEngine();
    const loop = new MakerLoop(
      { orderbook: libro(0.5, 0), rewards: recompensas(0) as never, engine },
      { capitalUsd: CAPITAL, retirarSegundosAntesDelCierre: 30, intervaloLatidoMs: 60_000 },
    );
    callar();
    const m = market("BTC", 7200);
    const { cortar, delMaker } = escuchar();
    for (let minuto = 0; minuto <= 16; minuto += 1) {
      await loop.runOnce([m], AHORA + minuto * 60_000);
    }
    const ultimo = delMaker().at(-1)!;
    expect(ultimo.level).toBe("warn");
    expect((ultimo.meta as Record<string, unknown>).mudoMinutos).toBe(16);
    cortar();
  });
});

describe("el latido recien arrancado no puede parecer un fallo", () => {
  it("sin candidatos todavia, no escribe un porQueNo vacio", async () => {
    // El escaner tarda en traer el registro, asi que las primeras pasadas no tienen ni un mercado que
    // mirar. Salia `"porQueNo":{}` — un hueco que parece un error y no explica nada. Con
    // `candidatos: 0` delante, la explicacion ya esta dada.
    const engine = new SimulationMakerEngine();
    const loop = new MakerLoop(
      { orderbook: libro(0.5, 0), rewards: recompensas(10000) as never, engine },
      { capitalUsd: CAPITAL, retirarSegundosAntesDelCierre: 30 },
    );
    callar();
    const entradas: LogEntry[] = [];
    const cortar = logger.subscribe((e) => entradas.push(e));
    await loop.runOnce([], AHORA); // el escaner aun no ha traido nada
    const latido = entradas.find((e) => e.message === "Maker: latido.")!;
    const meta = latido.meta as Record<string, unknown>;
    expect(meta.candidatos).toBe(0);
    expect(meta.cotizandoEn).toBe(0);
    expect("porQueNo" in meta).toBe(false);
    cortar();
  });
});

/**
 * El titular se mide fresco en CADA pasada —tiene dinero puesto—, y los demas compiten con una ficha
 * de hasta dos minutos. Esa asimetria empujaba a mudarse: a quien se le tomo la ficha en un buen
 * momento seguia compitiendo con ese numero aunque desde entonces se le hubiera llenado de
 * competencia. Medido sobre 3,5 h de produccion: 6 mudanzas/hora, 16 de 21 decididas por el ranking.
 */
describe("una ficha rancia no puede desbancar a quien ya cotiza", () => {
  /** Competencia mutable por activo: es la palanca exacta para mover el ranking sin tocar el resto. */
  function libroMutable(comp: Record<string, number>) {
    return {
      getQuote: vi.fn(async (tokenId: string) => {
        const a = String(tokenId).split("-")[0]!;
        const m = 0.5;
        return {
          tokenId,
          bestAsk: m + 0.005,
          bestBid: m - 0.005,
          availableUsdUnderCap: 100,
          availableUsdAllLevels: 100,
          availableBidUsdAllLevels: 100,
          estimatedSharesForAmount: 10,
          rawAskLevels: [{ price: m + 0.005, size: (comp[a] ?? 0) / 2 }],
          rawBidLevels: [{ price: m - 0.005, size: (comp[a] ?? 0) / 2 }],
        };
      }),
    } as never;
  }

  it("no se muda a un mercado que HOY es peor, aunque su ficha vieja dijera que era mejor", async () => {
    const engine = new SimulationMakerEngine();
    const comp: Record<string, number> = { BTC: 0, ETH: 0, DOGE: 1e6 };
    const loop = new MakerLoop(
      { orderbook: libroMutable(comp), rewards: recompensas(100) as never, engine },
      {
        capitalUsd: CAPITAL,
        retirarSegundosAntesDelCierre: 30,
        sondeosPorPasada: 1,
        margenRelevo: 0.25,
        // Lo que se prueba aqui es el RELEVO, no el suelo de pago. La competencia de este banco es
        // deliberadamente extrema (1e4 contra 50 participaciones nuestras), asi que el esperado cae
        // por debajo del suelo y sin esto no se cotizaria en ningun sitio, tapando el efecto a medir.
        minEsperadoUsdDia: 0,
      },
    );
    callar();
    const ms = [market("BTC", 7200), market("ETH", 7200), market("DOGE", 7200)];

    await loop.runOnce(ms, AHORA); // sondea BTC -> lo financia; ya es el titular
    await loop.runOnce(ms, AHORA + 20_000); // sondea ETH -> ficha de ETH SIN competencia
    expect(await engine.ordenesVivas(market("BTC"))).toHaveLength(2);

    // La realidad cambia: ETH se llena de competencia y BTC empeora un poco, pero BTC sigue siendo
    // mejor DE VERDAD. En la pasada 3 le toca sondear a DOGE, asi que ETH entra con su ficha vieja.
    comp.ETH = 5e5;
    comp.BTC = 1e4;
    await loop.runOnce(ms, AHORA + 40_000);

    expect(await engine.ordenesVivas(market("BTC"))).toHaveLength(2);
    expect(await engine.ordenesVivas(market("ETH"))).toHaveLength(0);
  });

  it("pero una mejora REAL sigue llevandose el capital", async () => {
    // La regla es "decidir con datos frescos", no "no mudarse nunca". Si al releer el aspirante sigue
    // siendo mejor, se muda igual: lo que se elimina es la mudanza decidida a ciegas.
    const engine = new SimulationMakerEngine();
    const comp: Record<string, number> = { BTC: 0, ETH: 0, DOGE: 1e6 };
    const loop = new MakerLoop(
      { orderbook: libroMutable(comp), rewards: recompensas(100) as never, engine },
      { capitalUsd: CAPITAL, retirarSegundosAntesDelCierre: 30, sondeosPorPasada: 1, margenRelevo: 0.25 },
    );
    callar();
    const ms = [market("BTC", 7200), market("ETH", 7200), market("DOGE", 7200)];
    await loop.runOnce(ms, AHORA);
    await loop.runOnce(ms, AHORA + 20_000);

    // Ahora es BTC el que se llena de competencia y ETH sigue limpio: la mudanza esta justificada.
    comp.BTC = 1e6;
    await loop.runOnce(ms, AHORA + 40_000);

    expect(await engine.ordenesVivas(market("BTC"))).toHaveLength(0);
    expect(await engine.ordenesVivas(market("ETH"))).toHaveLength(2);
  });

  it("al relevar, el log dice cuanto valia el que PIERDE el capital", async () => {
    // Con solo el ganador anotado no habia forma de juzgar una mudanza desde el log: el valor del
    // saliente que quedaba en el historial era el de su ultima pasada con movimiento, a veces de hace
    // media hora. Hubo que reproducir el fallo en un banco de pruebas para entenderlo.
    const engine = new SimulationMakerEngine();
    const comp: Record<string, number> = { BTC: 0, ETH: 0 };
    const loop = new MakerLoop(
      { orderbook: libroMutable(comp), rewards: recompensas(100) as never, engine },
      { capitalUsd: CAPITAL, retirarSegundosAntesDelCierre: 30, margenRelevo: 0.25 },
    );
    callar();
    const ms = [market("BTC", 7200), market("ETH", 7200)];
    await loop.runOnce(ms, AHORA);
    comp.BTC = 1e6; // BTC se hunde: ETH se lleva el capital
    const r = await loop.runOnce(ms, AHORA + 20_000);

    const saliente = r.mercados.find((m) => m.slug.startsWith("btc"));
    expect(saliente?.motivo).toBe("relevado");
    expect(typeof saliente?.esperadoUsdDia).toBe("number");
    const entrante = r.mercados.find((m) => m.slug.startsWith("eth"));
    // Las dos cifras en la misma linea: la mudanza se puede juzgar sin salir del log.
    expect(entrante!.esperadoUsdDia!).toBeGreaterThan(saliente!.esperadoUsdDia!);
  });
});

/**
 * Lo que quedo vivo de un proceso anterior no lo encuentra nadie.
 *
 * El rastro de que ordenes teniamos y donde vive en memoria. El bucle pregunta SIEMPRE por un mercado
 * concreto, asi que lo que quedo en uno que ya no esta entre los candidatos es invisible — y una orden
 * que nadie mira puede llenarse y resolver sola. El unico camino de retirada que existia corre al
 * PARAR limpiamente, y el watchdog no para: mata con `Stop-Process -Force`.
 */
describe("la herencia de un proceso muerto", () => {
  it("al arrancar en LIVE, retira lo que quedo vivo aunque su mercado ya no se siga", async () => {
    const sim = new SimulationMakerEngine();
    // Un mercado que YA NO esta en la lista de candidatos: nadie preguntaria por el.
    const olvidado = market("DOGE", 7200);
    await sim.colocar(olvidado, { outcome: "UP", side: "BUY", price: 0.49, size: 50 });
    await sim.colocar(olvidado, { outcome: "DOWN", side: "BUY", price: 0.49, size: 50 });

    const loop = new MakerLoop(
      { orderbook: libro(0.5, 0), rewards: recompensas(10000) as never, engine: sim },
      { capitalUsd: CAPITAL, retirarSegundosAntesDelCierre: 30, limpiarHerenciaAlArrancar: true },
    );
    callar();
    await loop.runOnce([market("BTC", 7200)], AHORA);
    expect(await sim.ordenesVivas(olvidado)).toHaveLength(0);
  });

  it("solo se intenta UNA vez, no en cada pasada", async () => {
    // Si el exchange responde mal, reintentarlo cada quince segundos seria machacarlo sin arreglar nada.
    const sim = new SimulationMakerEngine();
    const listar = vi.fn(async () => [] as string[]);
    const engine = {
      ordenesVivas: (m: MarketInfo) => sim.ordenesVivas(m),
      colocar: (m: MarketInfo, o: never) => sim.colocar(m, o),
      cancelar: (ids: string[]) => sim.cancelar(ids),
      ordenesDeLaCuenta: listar,
    };
    const loop = new MakerLoop(
      { orderbook: libro(0.5, 0), rewards: recompensas(10000) as never, engine: engine as never },
      { capitalUsd: CAPITAL, retirarSegundosAntesDelCierre: 30, limpiarHerenciaAlArrancar: true },
    );
    callar();
    await loop.runOnce([market("BTC", 7200)], AHORA);
    await loop.runOnce([market("BTC", 7200)], AHORA + 20_000);
    await loop.runOnce([market("BTC", 7200)], AHORA + 40_000);
    expect(listar).toHaveBeenCalledTimes(1);
  });

  it("en SIM no toca nada: no hay herencia que limpiar", async () => {
    // El libro de simulacion muere con el proceso. Activarlo aqui solo borraria lo que un test siembra.
    const sim = new SimulationMakerEngine();
    const btc = market("BTC", 7200);
    await sim.colocar(btc, { outcome: "UP", side: "BUY", price: 0.49, size: 50 });
    const loop = new MakerLoop(
      { orderbook: libro(0.5, 0), rewards: recompensas(10000) as never, engine: sim },
      { capitalUsd: CAPITAL, retirarSegundosAntesDelCierre: 30 },
    );
    callar();
    await loop.runOnce([btc], AHORA);
    expect((await sim.ordenesVivas(btc)).length).toBeGreaterThan(0);
  });

  it("si listar la cuenta falla, el arranque sigue adelante", async () => {
    // Nunca puede tumbar el arranque: sin limpieza el bot queda como antes de que existiera.
    const sim = new SimulationMakerEngine();
    const engine = {
      ordenesVivas: (m: MarketInfo) => sim.ordenesVivas(m),
      colocar: (m: MarketInfo, o: never) => sim.colocar(m, o),
      cancelar: (ids: string[]) => sim.cancelar(ids),
      ordenesDeLaCuenta: async () => {
        throw new Error("503 del exchange");
      },
    };
    const loop = new MakerLoop(
      { orderbook: libro(0.5, 0), rewards: recompensas(10000) as never, engine: engine as never },
      { capitalUsd: CAPITAL, retirarSegundosAntesDelCierre: 30, limpiarHerenciaAlArrancar: true },
    );
    callar();
    const r = await loop.runOnce([market("BTC", 7200)], AHORA);
    expect(r.colocadas).toBe(2); // cotiza igual
  });
});

/**
 * La formula oficial mide la distancia contra el "size-cutoff-adjusted midpoint": el medio que queda
 * tras tirar los niveles por debajo del minimo del programa. El bucle usaba el medio CRUDO, con el
 * polvo incluido, y colocaba a un tick de el. Medido sobre los 29 mejores mercados que caben en $22 el
 * 2026-08-25: 1 puntuaba CERO y otros 4 perdian entre el 26% y el 51% de la puntuacion.
 */
describe("se coloca contra el medio que REPARTE, no contra el del libro entero", () => {
  /** Libro con polvo pegado por dentro y los niveles que califican mas afuera. */
  function libroConPolvo(args: {
    /** Precio del polvo en el lado bid de UP (tamano por debajo del minimo). */
    polvoBid: number;
    polvoAsk: number;
    buenoBid: number;
    buenoAsk: number;
  }) {
    return {
      getQuote: vi.fn(async (tokenId: string) => {
        const esDown = String(tokenId).endsWith("-down");
        // El libro de DOWN es el espejo del de UP: comprar DOWN a `p` es vender UP a `1 - p`.
        const bids = esDown
          ? [{ price: 1 - args.polvoAsk, size: 2 }, { price: 1 - args.buenoAsk, size: 200 }]
          : [{ price: args.polvoBid, size: 2 }, { price: args.buenoBid, size: 200 }];
        const asks = esDown
          ? [{ price: 1 - args.polvoBid, size: 2 }, { price: 1 - args.buenoBid, size: 200 }]
          : [{ price: args.polvoAsk, size: 2 }, { price: args.buenoAsk, size: 200 }];
        return {
          tokenId,
          bestAsk: asks[0]!.price,
          bestBid: bids[0]!.price,
          availableUsdUnderCap: 100,
          availableUsdAllLevels: 100,
          availableBidUsdAllLevels: 100,
          estimatedSharesForAmount: 10,
          rawAskLevels: asks,
          rawBidLevels: bids,
        };
      }),
    } as never;
  }

  it("el polvo NO mueve donde se colocan las ordenes", async () => {
    const engine = new SimulationMakerEngine();
    // Polvo en 0,55/0,57 (medio crudo 0,56) contra niveles que califican en 0,30/0,50 (ajustado 0,40).
    const loop = new MakerLoop(
      {
        orderbook: libroConPolvo({ polvoBid: 0.55, polvoAsk: 0.57, buenoBid: 0.3, buenoAsk: 0.5 }),
        rewards: { paraMercado: vi.fn(async () => ({ minSize: 50, maxSpreadCents: 20, ratePerDay: 10000 })) } as never,
        engine,
      },
      { capitalUsd: CAPITAL * 4, retirarSegundosAntesDelCierre: 30 },
    );
    callar();
    await loop.runOnce([market("BTC", 7200)], AHORA);
    const vivas = await engine.ordenesVivas(market("BTC"));
    expect(vivas).toHaveLength(2);
    // Ajustado = (0,30 + 0,50) / 2 = 0,40. A un tick: UP a 0,39 y DOWN a 0,59 (o sea ask de UP a 0,41).
    // Con el medio crudo (0,56) habrian salido en 0,55 y 0,43: 15 centavos fuera de sitio.
    expect(vivas.find((o) => o.outcome === "UP")!.price).toBeCloseTo(0.39, 6);
    expect(vivas.find((o) => o.outcome === "DOWN")!.price).toBeCloseTo(0.59, 6);
  });

  it("si los dos medios discrepan MAS que la banda entera, no se cotiza: no hay precio que puntue", async () => {
    const engine = new SimulationMakerEngine();
    // Crudo 0,56 y ajustado 0,40: 16 centavos de separacion con una banda de 4,5. Elegir uno seria
    // apostar a cual usa el exchange, inmovilizando el capital entero a cambio de esa moneda al aire.
    const loop = new MakerLoop(
      {
        orderbook: libroConPolvo({ polvoBid: 0.55, polvoAsk: 0.57, buenoBid: 0.3, buenoAsk: 0.5 }),
        rewards: { paraMercado: vi.fn(async () => ({ minSize: 50, maxSpreadCents: 4.5, ratePerDay: 10000 })) } as never,
        engine,
      },
      { capitalUsd: CAPITAL * 4, retirarSegundosAntesDelCierre: 30 },
    );
    callar();
    const r = await loop.runOnce([market("BTC", 7200)], AHORA);
    expect(r.colocadas).toBe(0);
    expect(r.mercados.find((m) => m.slug.startsWith("btc"))?.motivo).toBe("medio_ambiguo");
    expect(await engine.ordenesVivas(market("BTC"))).toHaveLength(0);
  });

  it("un libro que es TODO polvo cae al medio crudo: no hay nada que ajustar", async () => {
    const engine = new SimulationMakerEngine();
    const loop = new MakerLoop(
      {
        orderbook: libro(0.5, 4), // niveles de 2 participaciones, por debajo del minimo de 50
        rewards: recompensas(10000) as never,
        engine,
      },
      { capitalUsd: CAPITAL, retirarSegundosAntesDelCierre: 30 },
    );
    callar();
    const r = await loop.runOnce([market("BTC")], AHORA);
    // Sigue cotizando: quedarse quieto porque nadie llega al minimo seria renunciar justo a los
    // mercados vacios, que son los que mas pagan.
    expect(r.colocadas).toBe(2);
  });
});

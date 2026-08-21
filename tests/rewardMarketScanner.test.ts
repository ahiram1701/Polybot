import { describe, expect, it, vi } from "vitest";

import { RewardMarketScanner } from "../src/rewardMarketScanner.js";

/** Una fila del registro de recompensas, como la publica el exchange. */
function fila(id: string, minSize: number, maxSpread: number, ratePerDay: number) {
  return {
    condition_id: id,
    rewards_min_size: minSize,
    rewards_max_spread: maxSpread,
    rewards_config: [{ rate_per_day: ratePerDay }],
  };
}

/** Un mercado resuelto, como lo devuelve `/markets/{conditionId}`. */
function mercado(id: string, extra: Record<string, unknown> = {}) {
  return {
    market_slug: `slug-${id}`,
    closed: false,
    active: true,
    accepting_orders: true,
    end_date_iso: "2026-12-31T00:00:00Z",
    minimum_tick_size: "0.01",
    neg_risk: false,
    tokens: [{ token_id: `${id}-a`, outcome: "Yes" }, { token_id: `${id}-b`, outcome: "No" }],
    ...extra,
  };
}

/** Servidor falso: una pagina de registro y los mercados que se le pidan. */
function servidor(filas: unknown[], mercados: Record<string, unknown> = {}) {
  const fetchImpl = vi.fn(async (url: string) => {
    if (url.includes("/rewards/markets/current")) {
      return { json: async () => ({ data: filas, next_cursor: "LTE=" }) };
    }
    const id = url.split("/markets/")[1] ?? "";
    return { json: async () => mercados[id] ?? mercado(id) };
  });
  return { fetchImpl: fetchImpl as never, llamadas: fetchImpl };
}

const callar = () => vi.spyOn(console, "log").mockImplementation(() => undefined);

describe("buscar mercados de recompensa que quepan en el capital", () => {
  it("descarta los que no caben: el par cuesta ~minSize dolares", async () => {
    // La entrada cuesta `minSize` porque precio(UP)+precio(DOWN) = $1. No hay banda de precio barata,
    // y por eso $12 no calificaba en NINGUN sitio.
    callar();
    const { fetchImpl } = servidor([fila("caro", 50, 1.5, 10000), fila("barato", 20, 4.5, 200)]);
    const scanner = new RewardMarketScanner("https://clob", fetchImpl);
    await scanner.precargar();
    const r = await scanner.mejores(25);
    expect(r.map((c) => c.mercado.conditionId)).toEqual(["barato"]);
    expect(r[0]!.costeEntradaUsd).toBe(20);
  });

  it("ordena por bote diario POR DOLAR de entrada, no por bote", async () => {
    callar();
    const { fetchImpl } = servidor([
      fila("bote-grande", 50, 1.5, 500), // $10/dia por dolar
      fila("mejor", 20, 4.5, 400), // $20/dia por dolar
    ]);
    const scanner = new RewardMarketScanner("https://clob", fetchImpl);
    await scanner.precargar();
    const r = await scanner.mejores(1000);
    expect(r.map((c) => c.mercado.conditionId)).toEqual(["mejor", "bote-grande"]);
  });

  it("descarta los que parecen gratis y no pagan nada", async () => {
    // Hay 74 mercados reales con `min_size: 0` y `max_spread: 0`. Con banda cero NINGUNA orden puntua,
    // asi que entrarian los primeros por "coste 0" y no darian un centimo.
    callar();
    const { fetchImpl } = servidor([fila("trampa", 0, 0, 3), fila("bueno", 20, 4.5, 100)]);
    const scanner = new RewardMarketScanner("https://clob", fetchImpl);
    await scanner.precargar();
    const r = await scanner.mejores(1000);
    expect(r.map((c) => c.mercado.conditionId)).toEqual(["bueno"]);
  });

  it("descarta lo cerrado y lo que no tiene los DOS lados", async () => {
    // Toda la estrategia vive de que los dos tokens sumen $1. Sin par no hay par que redimir.
    callar();
    const { fetchImpl } = servidor(
      [fila("cerrado", 20, 4.5, 100), fila("suelto", 20, 4.5, 100), fila("ok", 20, 4.5, 50)],
      {
        cerrado: mercado("cerrado", { closed: true }),
        suelto: mercado("suelto", { tokens: [{ token_id: "solo-uno", outcome: "Yes" }] }),
      },
    );
    const scanner = new RewardMarketScanner("https://clob", fetchImpl);
    await scanner.precargar();
    const r = await scanner.mejores(1000);
    expect(r.map((c) => c.mercado.conditionId)).toEqual(["ok"]);
  });

  it("si NO cabe ninguno devuelve vacio en vez de inventarse algo", async () => {
    callar();
    const { fetchImpl } = servidor([fila("caro", 50, 1.5, 10000)]);
    const scanner = new RewardMarketScanner("https://clob", fetchImpl);
    await scanner.precargar();
    expect(await scanner.mejores(4.13)).toEqual([]);
  });

  it("no relee el registro entero en cada llamada", async () => {
    // Son ~30 peticiones para 15.000 mercados, y el bucle pasa cada 3 segundos.
    callar();
    const { fetchImpl, llamadas } = servidor([fila("a", 20, 4.5, 100)]);
    const scanner = new RewardMarketScanner("https://clob", fetchImpl);
    await scanner.precargar();
    await scanner.mejores(1000);
    const tras = llamadas.mock.calls.length;
    await scanner.mejores(1000);
    expect(llamadas.mock.calls.length).toBe(tras);
  });

  it("un mercado sin fecha de fin no se toma por 'a punto de cerrar'", async () => {
    // `secondsToEnd` sobre un NaN haria que el maker se retirase siempre por `cerca_del_cierre`.
    callar();
    const { fetchImpl } = servidor([fila("sinfecha", 20, 4.5, 100)], {
      sinfecha: mercado("sinfecha", { end_date_iso: undefined }),
    });
    const scanner = new RewardMarketScanner("https://clob", fetchImpl);
    await scanner.precargar();
    const r = await scanner.mejores(1000);
    expect(r[0]!.mercado.endMs).toBeGreaterThan(Date.now() + 24 * 3_600_000);
  });

  it("una fecha de fin PASADA no se toma por 'cierra ya' si sigue aceptando ordenes", async () => {
    // `end_date_iso` es la medianoche de la fecha nominal, no la hora de cierre. Medido: el mercado del
    // tiempo de Los Angeles la daba 9 horas en el pasado y seguia aceptando ordenes; uno de Alaska, 57
    // horas. Creersela marcaba `cerca_del_cierre` justo a los que MAS pagan.
    callar();
    const { fetchImpl } = servidor([fila("pasado", 20, 4.5, 217)], {
      pasado: mercado("pasado", { end_date_iso: "2020-01-01T00:00:00Z", accepting_orders: true }),
    });
    const scanner = new RewardMarketScanner("https://clob", fetchImpl);
    await scanner.precargar();
    const r = await scanner.mejores(1000);
    expect(r).toHaveLength(1);
    expect(r[0]!.mercado.endMs).toBeGreaterThan(Date.now() + 24 * 3_600_000);
  });

  it("una fecha de fin FUTURA se respeta tal cual", async () => {
    callar();
    const finIso = new Date(Date.now() + 3 * 3_600_000).toISOString();
    const { fetchImpl } = servidor([fila("futuro", 20, 4.5, 100)], {
      futuro: mercado("futuro", { end_date_iso: finIso }),
    });
    const scanner = new RewardMarketScanner("https://clob", fetchImpl);
    await scanner.precargar();
    const r = await scanner.mejores(1000);
    expect(r[0]!.mercado.endMs).toBe(Date.parse(finIso));
  });

  it("con capital para UN mercado sigue proponiendo muchos: este orden no sabe elegir", async () => {
    // Antes se resolvian los que caben mas dos —con $20, TRES de 13.109— razonando que si solo se
    // financia uno, evaluar 25 es trabajo tirado. Es al reves. Medido el 2026-08-21 sobre los 60
    // primeros del registro real: la correlacion de Spearman entre ESTE puesto y el rendimiento real
    // es 0,007, y hay 54 mercados empatados por bote. Cortar en 3 es sortear. Quien sabe elegir es la
    // competencia, que mide `MakerLoop`, y solo puede elegir entre los que le lleguen.
    callar();
    const filas = Array.from({ length: 25 }, (_, i) => fila(`m${i}`, 20, 4.5, 200 - i));
    const { fetchImpl } = servidor(filas);
    const scanner = new RewardMarketScanner("https://clob", fetchImpl);
    await scanner.precargar();
    expect(await scanner.mejores(20)).toHaveLength(25);
  });

  it("el tope lo pone el limite pedido, no el capital", async () => {
    callar();
    const filas = Array.from({ length: 25 }, (_, i) => fila(`m${i}`, 20, 4.5, 200 - i));
    const { fetchImpl } = servidor(filas);
    const scanner = new RewardMarketScanner("https://clob", fetchImpl);
    await scanner.precargar();
    expect(await scanner.mejores(20, 8)).toHaveLength(8);
  });

  it("los que NO caben en el capital se quedan fuera", async () => {
    // Un mercado cuya entrada minima no cabe no es un candidato: no se puede cotizar en el.
    callar();
    const filas = [fila("caro", 500, 4.5, 5000), fila("barato", 20, 4.5, 100)];
    const { fetchImpl } = servidor(filas);
    const scanner = new RewardMarketScanner("https://clob", fetchImpl);
    await scanner.precargar();
    const r = await scanner.mejores(20);
    expect(r.map((c) => c.mercado.conditionId)).toEqual(["barato"]);
  });

  it("la PRIMERA llamada no espera al registro: devuelve vacio y carga por detras", async () => {
    // Esperar las ~30 peticiones del registro dentro del bucle costo una iteracion de 84 SEGUNDOS en el
    // arranque. Mejor no cotizar una pasada que dejar el bot entero parado.
    callar();
    const { fetchImpl } = servidor([fila("a", 20, 4.5, 100)]);
    const scanner = new RewardMarketScanner("https://clob", fetchImpl);
    expect(await scanner.mejores(1000)).toEqual([]);
    // Tres segundos despues (la pasada siguiente) ya hay datos.
    await scanner.precargar();
    expect(await scanner.mejores(1000)).toHaveLength(1);
  });

  it("no lanza treinta peticiones por cada pasada mientras carga", async () => {
    callar();
    const { fetchImpl, llamadas } = servidor([fila("a", 20, 4.5, 100)]);
    const scanner = new RewardMarketScanner("https://clob", fetchImpl);
    await Promise.all([scanner.mejores(1000), scanner.mejores(1000), scanner.mejores(1000)]);
    // Una sola recarga en vuelo, no tres.
    expect(llamadas.mock.calls.filter((c) => String(c[0]).includes("/rewards/markets/current"))).toHaveLength(1);
  });

  it("nunca devuelve dos mercados con el MISMO slug", async () => {
    // Todo el estado del maker —gasto, inventario, rastro de ordenes— se indexa por slug: dos mercados
    // distintos con el mismo slug mezclarian su contabilidad y su inventario decidiria las ordenes del
    // otro. Se conserva el mejor clasificado.
    callar();
    const { fetchImpl } = servidor([fila("a", 20, 4.5, 200), fila("b", 20, 4.5, 100)], {
      a: mercado("a", { market_slug: "mismo-slug" }),
      b: mercado("b", { market_slug: "mismo-slug" }),
    });
    const scanner = new RewardMarketScanner("https://clob", fetchImpl);
    await scanner.precargar();
    const r = await scanner.mejores(1000);
    expect(r).toHaveLength(1);
    expect(r[0]!.mercado.conditionId).toBe("a"); // el que mas paga
  });

  it("los dos tokens salen del mercado, sin suponer cual es cual", async () => {
    // En un mercado de Si/No no hay UP ni DOWN: son simplemente los dos complementarios.
    callar();
    const { fetchImpl } = servidor([fila("x", 20, 4.5, 100)]);
    const scanner = new RewardMarketScanner("https://clob", fetchImpl);
    await scanner.precargar();
    const r = await scanner.mejores(1000);
    expect(r[0]!.mercado.outcomes.UP.tokenId).toBe("x-a");
    expect(r[0]!.mercado.outcomes.DOWN.tokenId).toBe("x-b");
  });
});

describe("resolver en paralelo no puede cambiar lo que se elige", () => {
  it("conserva el orden de la criba aunque las respuestas lleguen desordenadas", async () => {
    // Se resuelve por tandas para no comerse 6 segundos del bucle. El paralelismo es una optimizacion
    // de latencia y NO debe reordenar el ranking: quien llega antes no gana nada.
    const filas = Array.from({ length: 10 }, (_, i) => fila(`m${i}`, 20, 4.5, 200 - i));
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("/rewards/markets/current")) {
        return { json: async () => ({ data: filas, next_cursor: "LTE=" }) };
      }
      const id = url.split("/markets/")[1] ?? "";
      // Los primeros de la criba responden los ULTIMOS: si el orden dependiera de la llegada, se veria.
      const retraso = id === "m0" ? 30 : id === "m1" ? 20 : 1;
      await new Promise((r) => setTimeout(r, retraso));
      return { json: async () => mercado(id) };
    });
    const scanner = new RewardMarketScanner("https://clob", fetchImpl as never);
    await scanner.precargar();
    const r = await scanner.mejores(20, 5);
    expect(r.map((c) => c.mercado.conditionId)).toEqual(["m0", "m1", "m2", "m3", "m4"]);
  });

  it("si alguno no resuelve, se rellena con los siguientes hasta el limite", async () => {
    // El bucle en serie se saltaba los que fallaban y seguia bajando. La version por tandas pide
    // algunos de mas para conservar ese comportamiento: el objetivo son N BUENOS, no N intentos.
    const filas = Array.from({ length: 10 }, (_, i) => fila(`m${i}`, 20, 4.5, 200 - i));
    const { fetchImpl } = servidor(filas, {
      m1: mercado("m1", { accepting_orders: false }),
      m2: mercado("m2", { closed: true }),
    });
    const scanner = new RewardMarketScanner("https://clob", fetchImpl);
    await scanner.precargar();
    const r = await scanner.mejores(20, 4);
    expect(r.map((c) => c.mercado.conditionId)).toEqual(["m0", "m3", "m4", "m5"]);
  });
});

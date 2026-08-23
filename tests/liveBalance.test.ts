import { describe, expect, it, vi } from "vitest";

import {
  makerDebeRetirarse,
  OnChainBankrollSource,
  POLYMARKET_COLLATERAL_ADDRESS,
  resolveEffectiveBankrollUsd,
} from "../src/liveBalance.js";

const client = (impl: () => Promise<unknown>) => ({ readContract: vi.fn(impl) }) as never;

describe("resolveEffectiveBankrollUsd", () => {
  it("prefiere el saldo leido on-chain sobre el declarado a mano", () => {
    expect(resolveEffectiveBankrollUsd({ usd: 137.5, atMs: 1 }, 10, 1)).toEqual({ usd: 137.5, source: "onchain" });
  });

  it("un CERO leido es autoritativo: no se tapa con el valor declarado", () => {
    // Es la mitad del sentido de esta guardia. Si la wallet esta vacia hay que bloquear, y dejar que
    // un numero declarado obsoleto diga lo contrario seria justo el fallo que se viene a corregir.
    expect(resolveEffectiveBankrollUsd({ usd: 0, atMs: 1 }, 500, 1)).toEqual({ usd: 0, source: "onchain" });
  });

  it("si no se pudo leer, cae al declarado", () => {
    expect(resolveEffectiveBankrollUsd(undefined, 20, 1)).toEqual({ usd: 20, source: "declared" });
  });

  it("sin lectura ni valor declarado el resultado es 'unknown', no cero", () => {
    // Quien llama debe poder distinguir "no hay fondos" de "no lo se", para no bloquear por un RPC
    // caido: eso seria un fallo de red disfrazado de politica de riesgo.
    expect(resolveEffectiveBankrollUsd(undefined, 0, 1).source).toBe("unknown");
    expect(resolveEffectiveBankrollUsd(undefined, undefined, 1).source).toBe("unknown");
  });
});

describe("OnChainBankrollSource", () => {
  const funder = "0x1111111111111111111111111111111111111111" as const;

  it("convierte los 6 decimales de USDC a dolares", async () => {
    const source = new OnChainBankrollSource(funder, "http://rpc.test", 60_000, client(async () => 12_345_678n));
    expect((await source.read(1_000))?.usd).toBeCloseTo(12.345678, 6);
  });

  it("cachea: el bucle corre cada segundo y esto es una llamada de red", async () => {
    const read = vi.fn(async () => 5_000_000n);
    const source = new OnChainBankrollSource(funder, "http://rpc.test", 60_000, { readContract: read } as never);
    await source.read(1_000);
    await source.read(2_000);
    await source.read(30_000);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("relee cuando el TTL expira", async () => {
    const read = vi.fn(async () => 5_000_000n);
    const source = new OnChainBankrollSource(funder, "http://rpc.test", 10_000, { readContract: read } as never);
    await source.read(1_000);
    await source.read(20_000);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("un fallo de RPC NO se convierte en un saldo de cero", async () => {
    const source = new OnChainBankrollSource(
      funder,
      "http://rpc.test",
      60_000,
      client(async () => {
        throw new Error("HTTP 401");
      }),
    );
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await source.read(1_000)).toBeUndefined();
  });

  it("ante un fallo conserva la ultima lectura buena en vez de olvidarla", async () => {
    let ok = true;
    const source = new OnChainBankrollSource(funder, "http://rpc.test", 1, client(async () => {
      if (!ok) {
        throw new Error("RPC caido");
      }
      return 7_000_000n;
    }));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect((await source.read(1_000))?.usd).toBe(7);
    ok = false;
    // Una lectura buena de hace un momento es mejor que quedarse sin dato.
    expect((await source.read(50_000))?.usd).toBe(7);
  });
});

describe("colateral de Polymarket", () => {
  it("apunta a pUSD (CLOB V2), no al USDC.e antiguo", () => {
    // Leer USDC.e devuelve 0 para una cuenta CON fondos — un cero creible que hace concluir que la
    // wallet esta vacia. Se comprobo contra la cadena: el saldo real vivia en pUSD.
    expect(POLYMARKET_COLLATERAL_ADDRESS).toBe("0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB");
    expect(POLYMARKET_COLLATERAL_ADDRESS).not.toBe("0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174");
  });
});

describe("OnChainBankrollSource: no martillear el RPC tras un fallo", () => {
  const funder = "0x1111111111111111111111111111111111111111" as const;

  it("aplica retroceso: un fallo no provoca un reintento por segundo", async () => {
    // El bucle del bot corre cada segundo. Sin retroceso, el fallo no se cacheaba (solo el exito) y
    // cada iteracion disparaba otra peticion — el RPC acababa limitandonos y el fallo se volvia
    // permanente. Observado en produccion con un RPC que respondia 6/6 en pruebas aisladas.
    const read = vi.fn(async () => {
      throw new Error("rate limited");
    });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const source = new OnChainBankrollSource(funder, "http://rpc.test", 60_000, { readContract: read } as never);

    await source.read(1_000);
    expect(read).toHaveBeenCalledTimes(1);

    // Siguientes segundos: dentro del retroceso, ni una peticion mas.
    for (let t = 2_000; t <= 5_000; t += 1_000) {
      await source.read(t);
    }
    expect(read).toHaveBeenCalledTimes(1);

    // Pasado el retroceso si vuelve a intentarlo.
    await source.read(7_000);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("un exito posterior borra el retroceso", async () => {
    let falla = true;
    const read = vi.fn(async () => {
      if (falla) {
        throw new Error("caido");
      }
      return 9_000_000n;
    });
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const source = new OnChainBankrollSource(funder, "http://rpc.test", 60_000, { readContract: read } as never);

    await source.read(1_000);
    falla = false;
    expect((await source.read(7_000))?.usd).toBe(9);
    // Con la racha a cero, la siguiente lectura la gobierna el TTL normal, no el retroceso.
    await source.read(8_000);
    expect(read).toHaveBeenCalledTimes(2);
  });
});

describe("una lectura on-chain caduca", () => {
  it("pasada la edad maxima cae al declarado, y dice cuanto hace que no lee", async () => {
    const { BANKROLL_READING_MAX_AGE_MS, resolveEffectiveBankrollUsd } = await import("../src/liveBalance.js");
    const atMs = 1_000_000;
    // `read()` conserva la ultima lectura buena a proposito y nadie la borra nunca. Sin este tope, un
    // RPC caido horas seguiria dimensionando el arbitraje contra un saldo que ya no existe — y si bajo
    // mientras tanto, eso produce justo la pata suelta que la guardia evita.
    const fresca = resolveEffectiveBankrollUsd({ usd: 137.5, atMs }, 20, atMs + BANKROLL_READING_MAX_AGE_MS);
    expect(fresca).toEqual({ usd: 137.5, source: "onchain" });

    const caducada = resolveEffectiveBankrollUsd({ usd: 137.5, atMs }, 20, atMs + BANKROLL_READING_MAX_AGE_MS + 1);
    expect(caducada.source).toBe("declared");
    expect(caducada.usd).toBe(20);
    // La UI necesita distinguir "nunca hubo lectura" de "el RPC lleva media hora muerto".
    expect(caducada.staleReadingMs).toBeGreaterThan(BANKROLL_READING_MAX_AGE_MS);
  });

  it("caducada y SIN declarado no opera: dimensionar a ciegas es peor que perder la oportunidad", async () => {
    const { BANKROLL_READING_MAX_AGE_MS, resolveEffectiveBankrollUsd } = await import("../src/liveBalance.js");
    const atMs = 1_000_000;
    const sinRespaldo = resolveEffectiveBankrollUsd(
      { usd: 137.5, atMs },
      0,
      atMs + BANKROLL_READING_MAX_AGE_MS + 1,
    );
    expect(sinRespaldo.source).toBe("unknown");
    expect(sinRespaldo.usd).toBe(0);
  });

  it("un cero LEIDO y fresco sigue mandando sobre el declarado", async () => {
    const { resolveEffectiveBankrollUsd } = await import("../src/liveBalance.js");
    // Taparlo con un declarado obsoleto es el fallo original que este modulo vino a corregir.
    expect(resolveEffectiveBankrollUsd({ usd: 0, atMs: 1_000 }, 500, 1_000)).toEqual({ usd: 0, source: "onchain" });
  });
});

/**
 * La unica red global del maker: cuando retirarse.
 *
 * Se prueba aparte y en puro porque es una decision sobre DINERO. Cablear medio bot para comprobar
 * tres condiciones es como no comprobarlas.
 */
describe("cuando el maker tiene que retirarse", () => {
  const base = { ordenesVivasUsd: 0, paresUsd: 0, sueloUsd: 8 };

  it("con saldo leido y patrimonio por encima, sigue", () => {
    const v = makerDebeRetirarse({ ...base, saldo: { usd: 30, source: "onchain" } });
    expect(v.retirar).toBe(false);
    expect(v.patrimonioUsd).toBe(30);
  });

  it("por debajo del suelo, se retira", () => {
    const v = makerDebeRetirarse({ ...base, saldo: { usd: 5, source: "onchain" } });
    expect(v.retirar).toBe(true);
    expect(v.motivo).toBe("patrimonio_bajo");
  });

  it("una orden viva no es una perdida: cuenta como patrimonio", () => {
    // El efectivo baja al poner una orden en reposo, pero el dinero sigue siendo nuestro. Mirar el
    // saldo desnudo hacia saltar el suelo en operacion normal.
    const v = makerDebeRetirarse({ ...base, saldo: { usd: 2, source: "onchain" }, ordenesVivasUsd: 20 });
    expect(v.retirar).toBe(false);
  });

  it("un par completo tambien: redime $1 gane quien gane", () => {
    const v = makerDebeRetirarse({ ...base, saldo: { usd: 2, source: "onchain" }, paresUsd: 20 });
    expect(v.retirar).toBe(false);
  });

  it("SIN saldo leido se retira, por mucho dinero que diga el declarado", () => {
    // Es el fallo que motivo esto. Cuando la lectura on-chain caduca se cae al valor de la
    // configuracion, que es optimista por naturaleza y no baja cuando el dinero se va: el 2026-08-23
    // decia 40 con $4,13 reales. Con la lectura caida, la unica red global habria visto diez veces mas
    // dinero del que hay. No saber cuanto tienes es motivo de sobra para dejar de arriesgarlo.
    const v = makerDebeRetirarse({ ...base, saldo: { usd: 40, source: "declared" } });
    expect(v.retirar).toBe(true);
    expect(v.motivo).toBe("saldo_a_ciegas");
  });

  it("y con saldo desconocido, igual", () => {
    const v = makerDebeRetirarse({ ...base, saldo: { usd: 0, source: "unknown" } });
    expect(v.retirar).toBe(true);
    expect(v.motivo).toBe("saldo_a_ciegas");
  });

  it("sin suelo configurado no se retira nunca: la guarda esta apagada a proposito", () => {
    // Con el suelo en cero el usuario ha dicho que no quiere esta red. Retirarle las ordenes porque no
    // podemos leer un saldo que no le importa seria decidir por el.
    const v = makerDebeRetirarse({ ...base, sueloUsd: 0, saldo: { usd: 0, source: "unknown" } });
    expect(v.retirar).toBe(false);
  });
});

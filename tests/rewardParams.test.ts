import { describe, expect, it, vi } from "vitest";

import { normalizar, RewardParamsReader } from "../src/rewardParams.js";

describe("parametros de recompensa", () => {
  it("acepta las dos formas en que el exchange los publica", () => {
    // El objeto del mercado usa `min_size`/`max_spread`; el endpoint de recompensas, `rewards_*`.
    expect(normalizar({ min_size: 50, max_spread: 1.5 })).toMatchObject({ minSize: 50, maxSpreadCents: 1.5 });
    expect(normalizar({ rewards_min_size: 20, rewards_max_spread: 3, total_daily_rate: 500 })).toMatchObject({
      minSize: 20,
      maxSpreadCents: 3,
      ratePerDay: 500,
    });
  });

  it("un mercado sin programa devuelve undefined, que NO es lo mismo que cero", () => {
    // Poner ordenes donde no pagan es inmovilizar dinero a cambio de nada.
    expect(normalizar(undefined)).toBeUndefined();
    expect(normalizar({ min_size: 0, max_spread: 0 })).toBeUndefined();
  });

  it("cachea para no preguntar en cada iteracion", async () => {
    const fetchMock = vi.fn(async () => ({ json: async () => ({ rewards: { min_size: 50, max_spread: 1.5 } }) })) as never;
    const lector = new RewardParamsReader("https://clob", fetchMock);
    await lector.paraMercado("0xA");
    await lector.paraMercado("0xA");
    expect((fetchMock as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(1);
  });

  it("ante un fallo de red conserva lo ultimo bueno en vez de decir 'aqui no pagan'", async () => {
    let fallar = false;
    const fetchMock = vi.fn(async () => {
      if (fallar) throw new Error("red caida");
      return { json: async () => ({ rewards: { min_size: 50, max_spread: 1.5 } }) };
    }) as never;
    const lector = new RewardParamsReader("https://clob", fetchMock);
    const bueno = await lector.paraMercado("0xB");
    fallar = true;
    (lector as unknown as { cache: Map<string, { leidoEnMs: number }> }).cache.get("0xB")!.leidoEnMs = 0;
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(await lector.paraMercado("0xB")).toEqual(bueno);
  });
});

describe("de donde sale cuanto paga", () => {
  it("suma las dotaciones de rewards_config, que es donde vive de verdad", async () => {
    const { normalizar } = await import("../src/rewardParams.js");
    // El endpoint por mercado no trae `total_daily_rate`: lo anida en un array con una entrada por
    // campana. Leerlo del sitio equivocado daba $0/dia en mercados que reparten $10.000.
    const p = normalizar({
      rewards_min_size: 50,
      rewards_max_spread: 1.5,
      rewards_config: [{ rate_per_day: 10000 }, { rate_per_day: 500 }],
    });
    expect(p?.ratePerDay).toBe(10500);
    expect(p?.maxSpreadCents).toBe(1.5);
  });
});

describe("cada ventana es un mercado nuevo", () => {
  it("la familia sale del slug quitando el epoch", async () => {
    const { familiaDeSlug } = await import("../src/rewardParams.js");
    expect(familiaDeSlug("btc-updown-5m-1787134500")).toBe("btc-updown-5m");
    expect(familiaDeSlug("eth-updown-15m-1787134500")).toBe("eth-updown-15m");
    // Si el formato cambia, mejor usar el slug entero que fallar.
    expect(familiaDeSlug("formato-raro")).toBe("formato-raro");
    expect(familiaDeSlug(undefined)).toBeUndefined();
  });

  it("una ventana que aun no figura NO borra lo que ya sabemos de su familia", async () => {
    // El endpoint devuelve {"data":[],"count":0} para ventanas recien creadas. Tratarlo como "aqui no
    // pagan" hacia que el maker no cotizara nunca: cada 5 minutos hay un mercado nuevo.
    let vacio = false;
    const fetchMock = vi.fn(async () => ({
      json: async () => (vacio ? { data: [] } : { data: [{ rewards_min_size: 50, rewards_max_spread: 1.5, rewards_config: [{ rate_per_day: 10000 }] }] }),
    })) as never;
    const { RewardParamsReader } = await import("../src/rewardParams.js");
    const lector = new RewardParamsReader("https://clob", fetchMock);

    const primera = await lector.paraMercado("0xVENTANA1", "btc-updown-5m-100");
    expect(primera?.ratePerDay).toBe(10000);

    // Ventana siguiente, misma familia, y el endpoint aun no la lista.
    vacio = true;
    (lector as unknown as { cache: Map<string, { leidoEnMs: number }> }).cache.get("btc-updown-5m")!.leidoEnMs = 0;
    const segunda = await lector.paraMercado("0xVENTANA2", "btc-updown-5m-200");
    expect(segunda?.ratePerDay).toBe(10000);
  });
});

describe("un vacio no puede durar lo mismo que un acierto", () => {
  it("reintenta el vacio en 30 s, no en 10 minutos", async () => {
    // Con el mismo TTL para los dos, una sola lectura vacia —y el endpoint tarda en dar de alta cada
    // ventana nueva, asi que pasa de continuo— dejaba al maker mudo diez minutos en un mercado que
    // reparte $10.000/dia. Medido: 24 pasadas seguidas sin cotizar con el endpoint sano.
    const respuestas = [
      { data: [] },
      { data: [{ min_size: 50, max_spread: 1.5, rewards_config: [{ rate_per_day: 10000 }] }] },
    ];
    let n = 0;
    const fetchImpl = vi.fn(async () => ({ json: async () => respuestas[Math.min(n++, 1)] })) as never;
    const reader = new RewardParamsReader("https://clob", fetchImpl);

    expect(await reader.paraMercado("0x1", "btc-updown-5m-1")).toBeUndefined();
    // Inmediatamente despues sale de cache: no se vuelve a preguntar.
    expect(await reader.paraMercado("0x1", "btc-updown-5m-2")).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // Pasados 31 s el vacio caduca y se reintenta.
    vi.setSystemTime(Date.now() + 31_000);
    expect(await reader.paraMercado("0x1", "btc-updown-5m-3")).toEqual({
      minSize: 50,
      maxSpreadCents: 1.5,
      ratePerDay: 10000,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    // Y el ACIERTO si aguanta: a los 5 minutos sigue sirviendo de cache.
    vi.setSystemTime(Date.now() + 5 * 60_000);
    expect(await reader.paraMercado("0x1", "btc-updown-5m-4")).toBeDefined();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});

import { describe, expect, it } from "vitest";

import { LIMITE_POSICIONES, posicionesAbiertas } from "../src/makerPositions.js";

/** Una fila como las que devuelve `data-api.polymarket.com/positions`, recortada a lo que se lee. */
function fila(over: Record<string, unknown> = {}) {
  return {
    slug: "un-mercado",
    outcomeIndex: 0,
    size: 20,
    avgPrice: 0.17,
    redeemable: false,
    endDate: "2026-08-29T23:59:00Z",
    // Sin estos no se puede COLOCAR la orden que cierra el par, solo contarla. Por eso una fila que no
    // los traiga se descarta: contar una posicion sobre la que no se puede actuar es peor que no
    // verla, porque el suelo la sumaria al patrimonio y luego no habria como rebalancearla.
    asset: "token-propio",
    oppositeAsset: "token-contrario",
    conditionId: "0xcondicion",
    negativeRisk: false,
    ...over,
  };
}

describe("posicionesAbiertas", () => {
  it("junta las dos patas del mismo mercado en un inventario", () => {
    // El caso real del 2026-08-28: 20 de Yes a 0,17 y 6,45 de No a 0,73, que son 6,45 pares.
    const salida = posicionesAbiertas([
      fila({ slug: "gta-vi", outcomeIndex: 0, size: 20, avgPrice: 0.17 }),
      fila({ slug: "gta-vi", outcomeIndex: 1, size: 6.45, avgPrice: 0.73 }),
    ]);

    expect(salida).toHaveLength(1);
    expect(salida?.[0].inventario).toEqual({ UP: 20, DOWN: 6.45 });
    // 20 x 0,17 + 6,45 x 0,73 = 3,40 + 4,7085
    expect(salida?.[0].gastadoUsd).toBeCloseTo(8.1085, 4);
  });

  it("dice NO SE cuando la lista viene llena, en vez de arriesgarse a leer media posicion", () => {
    // La trampa que costo descubrir: con el limite por defecto de 100 y 170 posiciones en la cuenta,
    // la respuesta traia la pata de Yes y dejaba fuera la de No. Eso no es "menos informacion", es
    // informacion INVERTIDA: un par completo leido como una apuesta direccional.
    const llena = Array.from({ length: 10 }, (_, i) => fila({ slug: `m${i}` }));

    expect(posicionesAbiertas(llena, 10)).toBeUndefined();
    // Con una menos del limite ya se puede confiar en que estan todas.
    expect(posicionesAbiertas(llena.slice(0, 9), 10)).toHaveLength(9);
  });

  it("una fecha SIN HORA acaba al final de ese dia, no al principio", () => {
    // El fallo real: `positions` devuelve "2026-08-28" pelado y `Date.parse` lo lee como las 00:00Z.
    // Durante las 24 horas en que el mercado esta vivo su "fin" ya es pasado, asi que la siembra
    // descartaba justo las posiciones abiertas — y en silencio, porque descartar no es un error.
    const salida = posicionesAbiertas([fila({ endDate: "2026-08-28" })]);

    expect(salida).toHaveLength(1);
    expect(salida?.[0].finMs).toBe(Date.parse("2026-08-28T23:59:59.999Z"));
    // Lo que importa: a media tarde de ese mismo dia, la posicion sigue viva.
    expect(salida?.[0].finMs).toBeGreaterThan(Date.parse("2026-08-28T20:06:00Z"));
  });

  it("respeta la hora cuando la fecha si la trae", () => {
    const salida = posicionesAbiertas([fila({ endDate: "2026-08-29T13:45:00Z" })]);
    expect(salida?.[0].finMs).toBe(Date.parse("2026-08-29T13:45:00Z"));
  });

  it("ignora lo ya resuelto, que o es efectivo o no vale nada", () => {
    // Contar una posicion redimible ademas del efectivo que produce seria contarla dos veces.
    const salida = posicionesAbiertas([
      fila({ slug: "vieja", redeemable: true }),
      fila({ slug: "viva", redeemable: false }),
    ]);

    expect(salida?.map((p) => p.slug)).toEqual(["viva"]);
  });

  it("descarta filas sin fecha de fin", () => {
    // Sin `finMs` la posicion no se olvidaria nunca y dejaria al maker mudo para siempre.
    expect(posicionesAbiertas([fila({ endDate: undefined })])).toEqual([]);
    expect(posicionesAbiertas([fila({ endDate: "no es una fecha" })])).toEqual([]);
  });

  it("saca los token ids de los DOS lados de una sola fila", () => {
    // `asset` es el lado de la fila y `oppositeAsset` el contrario, asi que con una basta. Sin esto la
    // posicion se puede contar pero no rebalancear, que fue el agujero del 2026-08-29.
    const salida = posicionesAbiertas([
      fila({ outcomeIndex: 1, asset: "el-down", oppositeAsset: "el-up" }),
    ]);

    expect(salida?.[0].tokenIds).toEqual({ UP: "el-up", DOWN: "el-down" });
    expect(salida?.[0].conditionId).toBe("0xcondicion");
  });

  it("descarta una fila sin los datos para poder actuar", () => {
    // Contarla sin poder actuar sobre ella es peor que no verla: el suelo la sumaria al patrimonio y
    // luego no habria forma de cerrar el par.
    expect(posicionesAbiertas([fila({ oppositeAsset: undefined })])).toEqual([]);
    expect(posicionesAbiertas([fila({ conditionId: undefined })])).toEqual([]);
  });

  it("dice NO SE ante una respuesta que no es una lista", () => {
    // `undefined` y lista vacia significan cosas distintas: "no se" frente a "no tienes nada". Quien
    // llama se creeria la segunda.
    expect(posicionesAbiertas(null)).toBeUndefined();
    expect(posicionesAbiertas({ error: "boom" })).toBeUndefined();
    expect(posicionesAbiertas({ data: [] })).toEqual([]);
  });

  it("pide de sobra por defecto", () => {
    // 100 se quedaba corto con 170 posiciones reales en la cuenta.
    expect(LIMITE_POSICIONES).toBeGreaterThan(170);
  });
});

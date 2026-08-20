import { describe, expect, it } from "vitest";

import {
  elegirMercados,
  planificarDosLados,
  precioObjetivo,
  puntuacionRecompensa,
  qMinOficial,
  siguePuntuando,
} from "../src/makerQuoting.js";
import type { CandidatoMercado, OrdenViva } from "../src/makerQuoting.js";

const PARAMS = { minSize: 50, maxSpreadCents: 1.5 };

describe("precio objetivo de una orden en reposo", () => {
  it("se pega al medio SIN cruzar el spread", () => {
    // El reparto es cuadratico con la distancia al medio, asi que un centavo de mas cuesta mucho. Pero
    // cruzar convierte la orden en taker: pagarias 7% justo en lo que vienes a dejar de pagar.
    expect(precioObjetivo(0.5, "BUY", 0.01)).toBe(0.49);
    expect(precioObjetivo(0.5, "SELL", 0.01)).toBe(0.51);
  });

  it("nunca sale de (0,1): un precio de 0 o 1 no es una apuesta, es un error", () => {
    expect(precioObjetivo(0.005, "BUY", 0.01)).toBeGreaterThan(0);
    expect(precioObjetivo(0.995, "SELL", 0.01)).toBeLessThan(1);
  });
});

describe("cuando una orden deja de puntuar", () => {
  const orden: OrdenViva = { id: "1", outcome: "UP", side: "BUY", price: 0.49, size: 50 };

  it("dentro de la banda y con tamano suficiente, puntua", () => {
    expect(siguePuntuando(orden, 0.5, PARAMS)).toBe(true);
  });

  it("si el medio se aleja mas de la banda, deja de puntuar", () => {
    // 0,49 contra un medio de 0,53 son 4 centavos: fuera de los 1,5 que paga.
    expect(siguePuntuando(orden, 0.53, PARAMS)).toBe(false);
  });

  it("por debajo del tamano minimo NO puntua, aunque este pegada al medio", () => {
    // Es la trampa del programa: una orden pequena no cobra menos, cobra CERO.
    expect(siguePuntuando({ ...orden, size: 49 }, 0.5, PARAMS)).toBe(false);
  });
});

describe("puntuacion oficial S(v,s)", () => {
  it("cae con el CUADRADO de la distancia, no linealmente", () => {
    // A media banda queda 1/4, no 1/2. Por eso pegarse al medio no es una preferencia.
    const pegada = puntuacionRecompensa(50, 0, PARAMS);
    const aMedia = puntuacionRecompensa(50, 0.0075, PARAMS);
    expect(pegada).toBeCloseTo(50, 6);
    expect(aMedia).toBeCloseTo(50 * 0.25, 6);
  });

  it("fuera de la banda o por debajo del minimo es CERO, no 'poco'", () => {
    expect(puntuacionRecompensa(50, 0.02, PARAMS)).toBe(0);
    expect(puntuacionRecompensa(49, 0, PARAMS)).toBe(0);
  });
});

describe("Q_min oficial: el castigo por cotizar un solo lado", () => {
  it("dentro de [0,10-0,90] un solo lado cobra un TERCIO", () => {
    expect(qMinOficial(90, 0, 0.5)).toBeCloseTo(30, 6);
  });

  it("FUERA de [0,10-0,90] un solo lado cobra CERO", () => {
    // Es la regla que hizo que el 24% del gasto del 2026-08-19 tuviera recompensa nula por definicion:
    // el bot compraba a 0,01-0,09, todo por debajo del suelo de 0,10.
    expect(qMinOficial(90, 0, 0.05)).toBe(0);
    expect(qMinOficial(90, 0, 0.95)).toBe(0);
  });

  it("con los dos lados equilibrados no hay castigo en ningun rango", () => {
    expect(qMinOficial(90, 90, 0.5)).toBeCloseTo(90, 6);
    expect(qMinOficial(90, 90, 0.05)).toBeCloseTo(90, 6);
  });
});

describe("plan de ordenes: SIEMPRE los dos lados", () => {
  const base = { mid: 0.5, tickSize: 0.01, capitalDisponibleUsd: 60, params: PARAMS };

  it("desde cero coloca los DOS lados, no uno", () => {
    // El fallo que costo $41,41: cotizar solo UP es comprar direccional, porque una compra en reposo
    // solo se llena cuando el precio CAE hasta ella.
    const plan = planificarDosLados({ ...base, vivas: [] });
    expect(plan.colocar.map((o) => o.outcome).sort()).toEqual(["DOWN", "UP"]);
    expect(plan.colocar.every((o) => o.side === "BUY" && o.size === 50)).toBe(true);
  });

  it("el par cuesta poco menos de $1 por participacion: por eso redime con ganancia", () => {
    const plan = planificarDosLados({ ...base, vivas: [] });
    const coste = plan.colocar.reduce((s, o) => s + o.price * o.size, 0);
    // 50 pares a $0,98 = $49, y el par redime exactamente $50 gane quien gane.
    expect(coste).toBeCloseTo(49, 6);
    expect(coste).toBeLessThan(50);
  });

  it("si el capital solo da para UN lado, no coloca NADA", () => {
    // Media cotizacion es exactamente el error que se viene a corregir: mas vale no cotizar.
    const plan = planificarDosLados({ ...base, capitalDisponibleUsd: 30, vivas: [] });
    expect(plan.colocar).toEqual([]);
    expect(plan.motivo).toMatch(/^capital_insuficiente_necesita_49/);
  });

  it("con las dos ordenes puestas y el libro quieto, no toca nada", () => {
    const vivas: OrdenViva[] = [
      { id: "u", outcome: "UP", side: "BUY", price: 0.49, size: 50 },
      { id: "d", outcome: "DOWN", side: "BUY", price: 0.49, size: 50 },
    ];
    const plan = planificarDosLados({ ...base, vivas });
    expect(plan.colocar).toEqual([]);
    expect(plan.cancelar).toEqual([]);
  });

  it("repone SOLO el lado que falta", () => {
    const vivas: OrdenViva[] = [{ id: "u", outcome: "UP", side: "BUY", price: 0.49, size: 50 }];
    const plan = planificarDosLados({ ...base, vivas });
    expect(plan.colocar.map((o) => o.outcome)).toEqual(["DOWN"]);
    expect(plan.cancelar).toEqual([]);
  });

  it("sin punto medio retira todo en vez de dejar ordenes a ciegas", () => {
    const vivas: OrdenViva[] = [{ id: "u", outcome: "UP", side: "BUY", price: 0.49, size: 50 }];
    const plan = planificarDosLados({ ...base, mid: undefined, vivas });
    expect(plan.colocar).toEqual([]);
    expect(plan.cancelar.map((o) => o.id)).toEqual(["u"]);
    expect(plan.motivo).toBe("sin_punto_medio");
  });

  it("el precio de DOWN sale del medio COMPLEMENTARIO, no del de UP", () => {
    // Con el medio de UP en 0,56, el de DOWN es 0,44 y su compra va a 0,43. Usar 0,55 para los dos
    // seria pagar 0,55+0,55 = $1,10 por un par que redime $1: perder 10 centavos por participacion.
    const plan = planificarDosLados({ ...base, mid: 0.56, vivas: [] });
    const porLado = Object.fromEntries(plan.colocar.map((o) => [o.outcome, o.price]));
    expect(porLado.UP).toBeCloseTo(0.55, 6);
    expect(porLado.DOWN).toBeCloseTo(0.43, 6);
    expect(porLado.UP + porLado.DOWN).toBeLessThan(1);
  });
});

describe("guarda de inventario contra la seleccion adversa", () => {
  const base = { mid: 0.5, tickSize: 0.01, capitalDisponibleUsd: 60, params: PARAMS };

  it("siendo largo de UP deja de pedir UP y solo pide DOWN", () => {
    // Completar el par redime $1 seguro; volver a pedir UP seria doblar sobre el lado que cae, que es
    // literalmente lo que hizo el 2026-08-19: 0,140 -> 0,120 -> 0,110 -> 0,090 -> 0,070 en 28 segundos.
    const plan = planificarDosLados({ ...base, vivas: [], inventario: { UP: 50, DOWN: 0 } });
    expect(plan.colocar.map((o) => o.outcome)).toEqual(["DOWN"]);
  });

  it("retira la compra viva del lado del que ya se es largo", () => {
    const vivas: OrdenViva[] = [{ id: "u", outcome: "UP", side: "BUY", price: 0.49, size: 50 }];
    const plan = planificarDosLados({ ...base, vivas, inventario: { UP: 50, DOWN: 0 } });
    expect(plan.cancelar.map((o) => o.id)).toEqual(["u"]);
    expect(plan.colocar.map((o) => o.outcome)).toEqual(["DOWN"]);
  });

  it("con el inventario emparejado vuelve a cotizar los dos lados", () => {
    const plan = planificarDosLados({ ...base, vivas: [], inventario: { UP: 50, DOWN: 50 } });
    expect(plan.colocar.map((o) => o.outcome).sort()).toEqual(["DOWN", "UP"]);
  });
});

describe("no recolocar por un tick de nada", () => {
  const base = { mid: 0.5, tickSize: 0.01, capitalDisponibleUsd: 60, params: PARAMS };

  it("mantiene las ordenes mientras sigan puntuando, aunque el medio se mueva", () => {
    const vivas: OrdenViva[] = [
      { id: "u", outcome: "UP", side: "BUY", price: 0.49, size: 50 },
      { id: "d", outcome: "DOWN", side: "BUY", price: 0.49, size: 50 },
    ];
    const plan = planificarDosLados({ ...base, mid: 0.502, vivas });
    expect(plan.colocar).toEqual([]);
    expect(plan.cancelar).toEqual([]);
  });

  it("el umbral NO puede ser mas estricto que la colocacion ideal", () => {
    // La orden ideal se pone a un tick del medio. Si el criterio para mantenerla fuera mas estricto que
    // eso, se recolocaria a un precio que al instante se considera insuficiente: churn infinito.
    const price = precioObjetivo(0.5, "BUY", 0.01);
    const vivas: OrdenViva[] = [
      { id: "u", outcome: "UP", side: "BUY", price, size: 50 },
      { id: "d", outcome: "DOWN", side: "BUY", price, size: 50 },
    ];
    const plan = planificarDosLados({ ...base, vivas });
    expect(plan.colocar).toEqual([]);
    expect(plan.cancelar).toEqual([]);
  });

  it("respeta el intervalo minimo entre recolocaciones", () => {
    const vivas: OrdenViva[] = [{ id: "u", outcome: "UP", side: "BUY", price: 0.49, size: 50 }];
    const plan = planificarDosLados({
      ...base,
      vivas,
      ultimaRecolocacionMs: 1_000,
      minMsEntreRecolocaciones: 15_000,
      nowMs: 5_000,
    });
    expect(plan.colocar).toEqual([]);
    expect(plan.motivo).toBe("espera_entre_recolocaciones");
  });
});

describe("a que mercados dedicar un capital escaso", () => {
  const base: Omit<CandidatoMercado, "slug" | "poolDiaUsd" | "qRivalBid" | "qRivalAsk"> = {
    params: PARAMS,
    mid: 0.5,
    tickSize: 0.01,
  };

  it("ordena por rendimiento POR DOLAR, no por tamano del bote", () => {
    // BTC reparte 12 veces mas que DOGE, pero con 400 de puntuacion compitiendo en los dos lados. En
    // DOGE no compite nadie. Como el par cuesta lo mismo (~$49) en los dos, gana DOGE: se lleva el
    // bote entero. Con el reparto lineal de antes ganaba BTC — ese sesgo es justo lo que se corrige.
    const elegidos = elegirMercados(
      [
        { ...base, slug: "btc", poolDiaUsd: 34.72, qRivalBid: 400, qRivalAsk: 400 },
        { ...base, slug: "doge", poolDiaUsd: 2.89, qRivalBid: 0, qRivalAsk: 0 },
      ],
      1000,
    );
    expect(elegidos.map((e) => e.slug)).toEqual(["doge", "btc"]);
    expect(elegidos[0]!.esperadoUsdDia).toBeGreaterThan(elegidos[1]!.esperadoUsdDia);
  });

  it("un solo lado rival vale un TERCIO: la formula oficial, no una lineal", () => {
    // Mismo bote y misma puntuacion bruta; el rival de la izquierda cotiza los dos lados y el de la
    // derecha solo uno. Contra el que solo cotiza un lado se captura mas cuota.
    const [dosLados] = elegirMercados(
      [{ ...base, slug: "a", poolDiaUsd: 10, qRivalBid: 90, qRivalAsk: 90 }],
      1000,
    );
    const [unLado] = elegirMercados(
      [{ ...base, slug: "b", poolDiaUsd: 10, qRivalBid: 90, qRivalAsk: 0 }],
      1000,
    );
    expect(unLado!.esperadoUsdDia).toBeGreaterThan(dosLados!.esperadoUsdDia);
  });

  it("no compromete el mismo dolar dos veces", () => {
    const tres = ["a", "b", "c"].map((slug) => ({
      ...base,
      slug,
      poolDiaUsd: 10,
      qRivalBid: 0,
      qRivalAsk: 0,
    }));
    // Cada par cuesta ~$49, asi que con $60 solo cabe uno.
    const elegidos = elegirMercados(tres, 60);
    expect(elegidos).toHaveLength(1);
    expect(elegidos.reduce((s, e) => s + e.costeUsd, 0)).toBeLessThanOrEqual(60);
  });

  it("el par cuesta ~$50 CUALQUIERA que sea el precio: por eso $12 nunca pudo calificar", () => {
    // UP + DOWN ~= $1 por participacion, y el minimo que puntua son 50. No hay banda barata.
    for (const mid of [0.1, 0.3, 0.5, 0.7, 0.9]) {
      const [e] = elegirMercados(
        [{ ...base, mid, slug: "x", poolDiaUsd: 10, qRivalBid: 0, qRivalAsk: 0 }],
        1000,
      );
      expect(e!.costeUsd).toBeGreaterThan(48);
      expect(e!.costeUsd).toBeLessThan(50);
    }
    expect(elegirMercados([{ ...base, slug: "x", poolDiaUsd: 10, qRivalBid: 0, qRivalAsk: 0 }], 12)).toEqual([]);
  });

  it("descarta mercados sin bote: poner ordenes donde no pagan es inmovilizar dinero a cambio de nada", () => {
    expect(
      elegirMercados([{ ...base, slug: "sin-pool", poolDiaUsd: 0, qRivalBid: 0, qRivalAsk: 0 }], 1000),
    ).toEqual([]);
  });
});

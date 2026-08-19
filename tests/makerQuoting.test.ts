import { describe, expect, it } from "vitest";

import { planificarMaker, precioObjetivo, siguePuntuando } from "../src/makerQuoting.js";
import type { OrdenViva } from "../src/makerQuoting.js";

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

describe("plan de ordenes", () => {
  it("con el libro quieto NO recoloca: perder el turno en la cola es perder valor", () => {
    const vivas: OrdenViva[] = [{ id: "1", outcome: "UP", side: "BUY", price: 0.49, size: 50 }];
    const plan = planificarMaker({ outcome: "UP", mid: 0.5, tickSize: 0.01, capitalUsd: 41, params: PARAMS, vivas });
    expect(plan.colocar).toEqual([]);
    expect(plan.cancelar).toEqual([]);
  });

  it("si el medio se mueve fuera de la banda, cancela y recoloca", () => {
    const vivas: OrdenViva[] = [{ id: "1", outcome: "UP", side: "BUY", price: 0.49, size: 50 }];
    const plan = planificarMaker({ outcome: "UP", mid: 0.56, tickSize: 0.01, capitalUsd: 41, params: PARAMS, vivas });
    expect(plan.cancelar.map((o) => o.id)).toEqual(["1"]);
    expect(plan.colocar[0]?.price).toBe(0.55);
    expect(plan.colocar[0]?.size).toBe(50);
  });

  it("sin capital para el minimo no coloca NADA, y lo dice", () => {
    // 50 participaciones a 0,49 son $24,50. Con $10 no se llega, y una orden por debajo del minimo
    // puntuaria cero: seria inmovilizar dinero a cambio de nada.
    const plan = planificarMaker({ outcome: "UP", mid: 0.5, tickSize: 0.01, capitalUsd: 10, params: PARAMS, vivas: [] });
    expect(plan.colocar).toEqual([]);
    expect(plan.motivo).toBe("capital_insuficiente_para_el_minimo");
  });

  it("sin punto medio retira todo en vez de dejar ordenes a ciegas", () => {
    const vivas: OrdenViva[] = [{ id: "1", outcome: "UP", side: "BUY", price: 0.49, size: 50 }];
    const plan = planificarMaker({ outcome: "UP", mid: undefined, tickSize: 0.01, capitalUsd: 41, params: PARAMS, vivas });
    expect(plan.colocar).toEqual([]);
    expect(plan.cancelar.map((o) => o.id)).toEqual(["1"]);
    expect(plan.motivo).toBe("sin_punto_medio");
  });

  it("no toca las ordenes del OTRO lado", () => {
    const vivas: OrdenViva[] = [{ id: "down-1", outcome: "DOWN", side: "BUY", price: 0.49, size: 50 }];
    const plan = planificarMaker({ outcome: "UP", mid: 0.5, tickSize: 0.01, capitalUsd: 41, params: PARAMS, vivas });
    expect(plan.cancelar).toEqual([]);
    expect(plan.colocar).toHaveLength(1);
  });
});

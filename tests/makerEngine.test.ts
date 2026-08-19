import { describe, expect, it, vi } from "vitest";

import { LiveMakerEngine, SimulationMakerEngine } from "../src/makerEngine.js";
import type { MarketInfo } from "../src/types.js";

const market = {
  asset: "BTC",
  slug: "btc-updown-5m-1",
  conditionId: "0xcond",
  tickSize: "0.01",
  negRisk: false,
  outcomes: { UP: { tokenId: "tok-up" }, DOWN: { tokenId: "tok-down" } },
} as unknown as MarketInfo;

describe("motor maker simulado", () => {
  it("lleva su propio libro: coloca, lista y cancela", async () => {
    const motor = new SimulationMakerEngine();
    const id = await motor.colocar(market, { outcome: "UP", side: "BUY", price: 0.49, size: 50 });
    expect(await motor.ordenesVivas(market)).toHaveLength(1);
    await motor.cancelar([id!]);
    expect(await motor.ordenesVivas(market)).toHaveLength(0);
  });
});

describe("motor maker real", () => {
  function conCliente(cliente: Record<string, unknown>) {
    const motor = new LiveMakerEngine({} as never);
    (motor as unknown as { clientProvider: unknown }).clientProvider = { getClient: async () => cliente };
    return motor;
  }

  it("manda la orden como GTC y con postOnly", async () => {
    // postOnly es la guarda que importa: si entre el calculo y el envio el libro se mueve y la orden
    // fuera a cruzar, el exchange la RECHAZA en vez de ejecutarla como taker pagando el 7%. Sin esto,
    // el motor haria justo lo contrario de lo que se pretende.
    const postOrder = vi.fn(async () => ({ orderID: "abc" }));
    const motor = conCliente({ createOrder: vi.fn(async () => ({ firmada: true })), postOrder });
    const id = await motor.colocar(market, { outcome: "UP", side: "BUY", price: 0.49, size: 50 });
    expect(id).toBe("abc");
    expect(postOrder).toHaveBeenCalledWith({ firmada: true }, "GTC", true);
  });

  it("una orden rechazada devuelve undefined en vez de inventar un id", async () => {
    const motor = conCliente({
      createOrder: vi.fn(async () => ({})),
      postOrder: vi.fn(async () => ({ status: "rejected" })),
    });
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(await motor.colocar(market, { outcome: "UP", side: "BUY", price: 0.49, size: 50 })).toBeUndefined();
  });

  it("el tamano vivo descuenta lo ya casado, no el original", async () => {
    // Una orden medio llenada puede haber caido por debajo del minimo y dejado de puntuar. Mirar
    // `original_size` diria que sigue cobrando cuando ya no cobra nada.
    const motor = conCliente({
      getOpenOrders: vi.fn(async () => ({
        data: [{ id: "o1", asset_id: "tok-up", side: "BUY", price: "0.49", original_size: "50", size_matched: "30" }],
      })),
    });
    const vivas = await motor.ordenesVivas(market);
    expect(vivas[0].size).toBe(20);
    expect(vivas[0].outcome).toBe("UP");
  });

  it("ignora ordenes de tokens que no son de este mercado", async () => {
    const motor = conCliente({
      getOpenOrders: vi.fn(async () => ({
        data: [{ id: "ajena", asset_id: "otro-token", side: "BUY", price: "0.5", original_size: "50" }],
      })),
    });
    expect(await motor.ordenesVivas(market)).toEqual([]);
  });

  it("cancelar sin ids no llama al exchange", async () => {
    const cancelOrders = vi.fn(async () => ({}));
    const motor = conCliente({ cancelOrders });
    expect(await motor.cancelar([])).toBe(0);
    expect(cancelOrders).not.toHaveBeenCalled();
  });
});

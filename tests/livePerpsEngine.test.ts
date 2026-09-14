import { OrderSide, PerpsTimeInForce } from "@polymarket/client";
import { describe, expect, it, vi } from "vitest";

import { LivePerpsEngine, PerpsOrderError, type PerpsTradingSession } from "../src/perpsEngine.js";
import type { PerpsInstrumentInfo, PerpsPositionAttempt, PerpsQuote } from "../src/perpsTypes.js";

/**
 * **Aviso que hay que leer antes de fiarse de este fichero.**
 *
 * Aqui la sesion es un doble: estos tests comprueban QUE se manda, no que el exchange lo acepte. El
 * comentario equivalente de `liveExecutionEngine.test.ts` dice que el mock "no valida nada" y que es
 * "el agujero mas peligroso de todo el camino de venta, porque solo se descubre con dinero real".
 * Aqui el agujero es PEOR por dos motivos: la API de perps del SDK esta marcada `@experimental` y
 * puede cambiar en una version de parche, y no hay ni una sola orden real contra la que contrastar.
 *
 * Lo que si se gana frente a aquel: `LivePerpsEngine` recibe la sesion inyectada en vez de construirla,
 * asi que no hace falta `vi.mock` del modulo y los enums (`OrderSide`, `PerpsTimeInForce`) son los
 * DE VERDAD. En el test del binario hubo que escribir a mano `Side: {BUY, SELL}`, con el aviso de que
 * sin `SELL` la orden viaja sin lado y el test pasa verde igual.
 */

const INSTRUMENTO: PerpsInstrumentInfo = {
  instrumentId: 6,
  symbol: "BTC-USD",
  category: "crypto",
  baseAsset: "BTC",
  quoteAsset: "USD",
  fundingIntervalHours: 1,
  priceDecimals: 1,
  quantityDecimals: 5,
  minNotionalUsd: 10,
  maxMarketNotionalUsd: 1_000_000,
  maxLimitNotionalUsd: 1_000_000,
  maxLeverage: 20,
  isolatedOnly: false,
  liquidationFee: 0.01,
  riskTiers: [{ lowerBoundUsd: 0, maxLeverage: 20 }],
};

const QUOTE: PerpsQuote = {
  instrumentId: 6,
  symbol: "BTC-USD",
  quotedAtMs: 1_000,
  bestBid: 99,
  bestAsk: 101,
  mid: 100,
  markPrice: 100,
  rawAskLevels: [{ price: 101, size: 100 }],
  rawBidLevels: [{ price: 99, size: 100 }],
  availableAskNotionalUsd: 10_100,
  availableBidNotionalUsd: 9_900,
};

function sesionFalsa(overrides: Partial<PerpsTradingSession> = {}): {
  session: PerpsTradingSession;
  placeOrder: ReturnType<typeof vi.fn>;
} {
  const placeOrder = vi.fn(async () => ({ order: { oid: 42 } }));
  const session: PerpsTradingSession = {
    placeOrder,
    cancelAllOrders: vi.fn(async () => undefined),
    updateLeverage: vi.fn(async () => undefined),
    armAutoCancel: vi.fn(async () => undefined),
    ...overrides,
  };
  return { session, placeOrder };
}

describe("LivePerpsEngine", () => {
  it("un LARGO se abre comprando y un CORTO vendiendo", async () => {
    const { session, placeOrder } = sesionFalsa();
    const engine = new LivePerpsEngine({ getSession: async () => session }, () => 2_000);

    await engine.open({ instrument: INSTRUMENTO, side: "LONG", notionalUsd: 1_000, leverage: 2, quote: QUOTE });
    expect(placeOrder.mock.calls[0][0]).toMatchObject({ side: OrderSide.BUY, instrumentId: 6 });

    await engine.open({ instrument: INSTRUMENTO, side: "SHORT", notionalUsd: 1_000, leverage: 2, quote: QUOTE });
    expect(placeOrder.mock.calls[1][0]).toMatchObject({ side: OrderSide.SELL });
  });

  it("manda IOC y NUNCA GTC al abrir", async () => {
    const { session, placeOrder } = sesionFalsa();
    const engine = new LivePerpsEngine({ getSession: async () => session });
    await engine.open({ instrument: INSTRUMENTO, side: "LONG", notionalUsd: 1_000, leverage: 2, quote: QUOTE });
    // Una limite en reposo sobre un perpetuo no expira nunca por si sola: un GTC olvidado es una
    // posicion futura que nadie pidio.
    expect(placeOrder.mock.calls[0][0].timeInForce).toBe(PerpsTimeInForce.IOC);
    expect(placeOrder.mock.calls[0][0].reduceOnly).toBe(false);
  });

  it("el CIERRE va con reduceOnly y del lado contrario", async () => {
    const { session, placeOrder } = sesionFalsa();
    const engine = new LivePerpsEngine({ getSession: async () => session });
    const posicion = {
      instrumentId: 6,
      symbol: "BTC-USD",
      side: "LONG",
      quantity: 9.9,
      entryPrice: 101,
      fundingPaidUsd: 0,
    } as PerpsPositionAttempt;

    await engine.close({ position: posicion, quote: QUOTE, reason: "manual" });
    const enviado = placeOrder.mock.calls[0][0];
    expect(enviado.side).toBe(OrderSide.SELL);
    // Sin `reduceOnly`, una orden de cierre que llegue cuando la posicion ya no existe ABRE una nueva
    // del lado contrario. Es la diferencia entre cerrar y operar.
    expect(enviado.reduceOnly).toBe(true);
  });

  it("la cantidad se trunca HACIA ABAJO a los decimales del instrumento", async () => {
    const { session, placeOrder } = sesionFalsa();
    const engine = new LivePerpsEngine({ getSession: async () => session });
    await engine.open({ instrument: INSTRUMENTO, side: "LONG", notionalUsd: 1_000, leverage: 2, quote: QUOTE });
    const cantidad = placeOrder.mock.calls[0][0].quantity as string;
    // 1000 / 101 = 9,900990099... -> 9,90099 con 5 decimales, truncando. Redondear hacia arriba
    // pediria mas de lo que cabe en el nocional.
    expect(cantidad).toBe("9.90099");
    expect(Number(cantidad)).toBeLessThanOrEqual(1_000 / 101);
  });

  it("etiqueta la posicion como live SIEMPRE", async () => {
    const { session } = sesionFalsa();
    const engine = new LivePerpsEngine({ getSession: async () => session });
    const posicion = await engine.open({
      instrument: INSTRUMENTO,
      side: "LONG",
      notionalUsd: 1_000,
      leverage: 2,
      quote: QUOTE,
    });
    expect(posicion.mode).toBe("live");
    expect(posicion.liquidationPrice).toBeDefined();
  });

  it("un rechazo del exchange llega con el contexto de lo enviado", async () => {
    const { session } = sesionFalsa({
      placeOrder: vi.fn(async () => {
        throw new Error("no orders found to match");
      }),
    });
    const engine = new LivePerpsEngine({ getSession: async () => session }, () => 4_000);
    // El mensaje del exchange dice QUE fallo, nunca POR QUE. Sin el precio, la cantidad y la edad de
    // la cotizacion, un rechazo no es diagnosticable — la leccion de la trampa 6.
    await expect(
      engine.open({ instrument: INSTRUMENTO, side: "LONG", notionalUsd: 1_000, leverage: 2, quote: QUOTE }),
    ).rejects.toMatchObject({
      name: "PerpsOrderError",
      details: { symbol: "BTC-USD", side: "LONG", quoteAgeMs: 3_000 },
    });
  });

  it("el error de orden conserva la causa original", async () => {
    const causa = new Error("boom");
    const { session } = sesionFalsa({
      placeOrder: vi.fn(async () => {
        throw causa;
      }),
    });
    const engine = new LivePerpsEngine({ getSession: async () => session });
    await engine
      .open({ instrument: INSTRUMENTO, side: "LONG", notionalUsd: 1_000, leverage: 2, quote: QUOTE })
      .catch((error: unknown) => {
        expect(error).toBeInstanceOf(PerpsOrderError);
        expect((error as PerpsOrderError).cause).toBe(causa);
      });
    expect.assertions(2);
  });

  it("setLeverage pasa por la sesion", async () => {
    const { session } = sesionFalsa();
    const engine = new LivePerpsEngine({ getSession: async () => session });
    await engine.setLeverage({ instrumentId: 6, leverage: 2 });
    expect(session.updateLeverage).toHaveBeenCalledWith({ instrumentId: 6, leverage: 2, crossMargin: false });
  });
});

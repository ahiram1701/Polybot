/**
 * Coloca, consulta y cancela ordenes limite EN REPOSO para cobrar recompensas de liquidez.
 *
 * Es lo unico que Polybot no sabia hacer: `LiveExecutionEngine` solo manda ordenes FAK —dispara y
 * olvida— porque hasta ahora siempre cruzaba el spread. Un maker necesita lo contrario: saber que
 * tiene vivo, dejarlo quieto mientras siga puntuando, y retirarlo cuando deje de hacerlo.
 *
 * Las ordenes se mandan con `postOnly`: si por una carrera acabara cruzando el spread, el exchange la
 * RECHAZA en vez de ejecutarla como taker. Sin eso, un movimiento del libro entre el calculo y el envio
 * convertiria la orden en lo contrario de lo que se pretende — y pagando el 7% de comision.
 */
import { OrderType, Side } from "@polymarket/clob-client-v2";

import { LiveClobClientProvider } from "./liveClobClient.js";
import { logger } from "./logger.js";
import type { OrdenDeseada, OrdenViva } from "./makerQuoting.js";
import type { MercadoMaker } from "./makerMarket.js";
import type { BotConfig, Outcome } from "./types.js";

export interface MakerEngine {
  ordenesVivas(market: MercadoMaker): Promise<OrdenViva[]>;
  colocar(market: MercadoMaker, orden: OrdenDeseada): Promise<string | undefined>;
  cancelar(ids: string[]): Promise<number>;
}

/** Motor de simulacion: lleva un libro de ordenes propio en memoria. No toca la red. */
export class SimulationMakerEngine implements MakerEngine {
  private readonly porMercado = new Map<string, OrdenViva[]>();
  private siguienteId = 1;

  async ordenesVivas(market: MercadoMaker): Promise<OrdenViva[]> {
    return [...(this.porMercado.get(market.slug) ?? [])];
  }

  async colocar(market: MercadoMaker, orden: OrdenDeseada): Promise<string | undefined> {
    const id = `sim-${this.siguienteId++}`;
    const previas = this.porMercado.get(market.slug) ?? [];
    this.porMercado.set(market.slug, [...previas, { ...orden, id }]);
    return id;
  }

  async cancelar(ids: string[]): Promise<number> {
    let quitadas = 0;
    for (const [slug, ordenes] of this.porMercado) {
      const restantes = ordenes.filter((o) => !ids.includes(o.id));
      quitadas += ordenes.length - restantes.length;
      this.porMercado.set(slug, restantes);
    }
    return quitadas;
  }
}

/** Motor real. Cada llamada mueve o inmoviliza dinero de verdad. */
export class LiveMakerEngine implements MakerEngine {
  private readonly clientProvider: LiveClobClientProvider;

  constructor(private readonly config: BotConfig) {
    this.clientProvider = new LiveClobClientProvider(config);
  }

  async ordenesVivas(market: MercadoMaker): Promise<OrdenViva[]> {
    const client = await this.clientProvider.getClient();
    const porToken = new Map<string, Outcome>();
    for (const outcome of ["UP", "DOWN"] as const) {
      porToken.set(market.outcomes[outcome].tokenId, outcome);
    }
    const respuesta = (await client.getOpenOrders({ market: market.conditionId })) as unknown as {
      data?: Array<Record<string, unknown>>;
    };
    const filas = Array.isArray(respuesta) ? respuesta : (respuesta?.data ?? []);
    const vivas: OrdenViva[] = [];
    for (const fila of filas) {
      const outcome = porToken.get(String(fila.asset_id));
      if (!outcome) {
        continue; // orden de otro mercado: no es nuestra incumbencia
      }
      // El tamano que cuenta es el que SIGUE en el libro, no el original: una orden medio llenada
      // puede haber caido por debajo del minimo y dejado de puntuar sin que nadie lo note.
      const original = Number(fila.original_size);
      const casada = Number(fila.size_matched ?? 0);
      vivas.push({
        id: String(fila.id),
        outcome,
        side: String(fila.side).toUpperCase() === "SELL" ? "SELL" : "BUY",
        price: Number(fila.price),
        size: Math.max(0, original - (Number.isFinite(casada) ? casada : 0)),
      });
    }
    return vivas;
  }

  async colocar(market: MercadoMaker, orden: OrdenDeseada): Promise<string | undefined> {
    const client = await this.clientProvider.getClient();
    const firmada = await client.createOrder(
      {
        tokenID: market.outcomes[orden.outcome].tokenId,
        price: orden.price,
        size: orden.size,
        side: orden.side === "BUY" ? Side.BUY : Side.SELL,
      },
      { tickSize: market.tickSize as never, negRisk: market.negRisk },
    );
    // GTC = se queda en el libro. `postOnly` en true: antes ejecutar como taker que colocar, NO.
    const respuesta = (await client.postOrder(firmada, OrderType.GTC, true)) as { orderID?: string; status?: string };
    if (!respuesta?.orderID) {
      logger.warn("Orden maker rechazada por el exchange.", {
        slug: market.slug,
        outcome: orden.outcome,
        price: orden.price,
        size: orden.size,
        status: respuesta?.status,
      });
      return undefined;
    }
    return respuesta.orderID;
  }

  async cancelar(ids: string[]): Promise<number> {
    if (ids.length === 0) {
      return 0;
    }
    const client = await this.clientProvider.getClient();
    await client.cancelOrders(ids);
    return ids.length;
  }
}

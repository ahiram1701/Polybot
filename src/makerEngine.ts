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
  /** Devuelve los ids REALMENTE cancelados, no los pedidos. La diferencia importa: ver abajo. */
  cancelar(ids: string[]): Promise<string[]>;
  /**
   * TODAS las ordenes vivas de la cuenta, sin filtrar por mercado. Solo para limpiar al arrancar.
   *
   * Existe porque el resto del bucle pregunta SIEMPRE por un mercado concreto, y despues de un
   * arranque no sabemos por cuales preguntar: el rastro en memoria —que ordenes teniamos y donde—
   * muere con el proceso. Las que quedaron en un mercado que ya no esta entre los candidatos no las
   * encuentra nadie, y una orden que nadie mira puede llenarse y resolver sola.
   *
   * Opcional: un motor que no sepa responder esto simplemente no se limpia, que es lo que se hacia
   * antes. Nunca debe tumbar el arranque.
   */
  ordenesDeLaCuenta?(): Promise<string[]>;
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

  async cancelar(ids: string[]): Promise<string[]> {
    const quitadas: string[] = [];
    for (const [slug, ordenes] of this.porMercado) {
      const restantes = ordenes.filter((o) => !ids.includes(o.id));
      quitadas.push(...ordenes.filter((o) => ids.includes(o.id)).map((o) => o.id));
      this.porMercado.set(slug, restantes);
    }
    return quitadas;
  }

  async ordenesDeLaCuenta(): Promise<string[]> {
    return [...this.porMercado.values()].flat().map((o) => o.id);
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
    const tokenId = market.outcomes[orden.outcome].tokenId;
    // Un mercado reconstruido desde las POSICIONES no trae `tickSize`: esa API no lo da. Se pregunta
    // aqui, que es donde esta el cliente, y solo en ese caso — el camino normal ya lo trae del escaner
    // y no paga ninguna llamada de mas.
    const tickSize = market.tickSize || (await client.getTickSize(tokenId));
    const firmada = await client.createOrder(
      {
        tokenID: tokenId,
        price: orden.price,
        size: orden.size,
        side: orden.side === "BUY" ? Side.BUY : Side.SELL,
      },
      { tickSize: tickSize as never, negRisk: market.negRisk },
    );
    // GTC = se queda en el libro. `postOnly` en true: antes ejecutar como taker que colocar, NO — salvo
    // en el rebalanceo de emergencia, que pide cruzar a proposito porque ahi el objetivo es quitarse
    // una posicion direccional y una orden que no se llena no la quita.
    const postOnly = orden.permitirCruce !== true;
    const respuesta = (await client.postOrder(firmada, OrderType.GTC, postOnly)) as { orderID?: string; status?: string };
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

  /**
   * Cancela y devuelve las que el exchange dice haber cancelado DE VERDAD.
   *
   * Antes hacia `await client.cancelOrders(ids); return ids.length;` — daba por cancelada cualquier
   * orden sin mirar la respuesta. Y como el bucle borra el rastro de lo que cancela, una orden que el
   * exchange rechazara cancelar quedaba **viva en el libro y ademas invisible**: su llenado no se
   * detectaba, no contaba contra el tope de gasto y nadie volvia a mirarla. Es la peor forma de perder
   * dinero, porque no aparece en ningun sitio.
   *
   * El endpoint responde `{canceled: [...], not_canceled: {id: motivo}}`. Si la respuesta no trae ese
   * detalle se asume lo peor —que NO se cancelaron— y se conserva el rastro: quedarse vigilando una
   * orden que ya no existe solo cuesta una deteccion de llenado fantasma; perder de vista una que
   * sigue viva cuesta dinero.
   */
  async cancelar(ids: string[]): Promise<string[]> {
    if (ids.length === 0) {
      return [];
    }
    const client = await this.clientProvider.getClient();
    const respuesta = (await client.cancelOrders(ids)) as {
      canceled?: unknown;
      not_canceled?: Record<string, unknown>;
    };
    const canceladas = Array.isArray(respuesta?.canceled) ? respuesta.canceled.map(String) : [];
    const fallidas = respuesta?.not_canceled ? Object.keys(respuesta.not_canceled) : [];
    if (fallidas.length > 0) {
      logger.warn("El exchange NO cancelo algunas ordenes maker: siguen vivas.", {
        fallidas,
        motivos: respuesta.not_canceled,
      });
    }
    if (canceladas.length === 0 && fallidas.length === 0) {
      logger.warn("Respuesta de cancelacion sin detalle: se asume que las ordenes SIGUEN VIVAS.", {
        pedidas: ids.length,
      });
    }
    return canceladas;
  }

  /**
   * Todas las ordenes vivas de la cuenta. Es la unica consulta que NO filtra por mercado.
   *
   * Todo lo demas pregunta por un `conditionId` concreto, y tras un arranque no sabemos por cuales
   * preguntar. El unico camino de retirada que existia —`retirarTodo`— corre al PARAR limpiamente, y
   * el watchdog no para: mata con `Stop-Process -Force`. Asi que una orden en un mercado que despues
   * se cae del top-25 del escaner no la vuelve a mirar nadie.
   *
   * Todas las ordenes en reposo de esta cuenta son del maker: el motor direccional manda FAK —dispara
   * y olvida— y esas no se quedan en el libro.
   */
  async ordenesDeLaCuenta(): Promise<string[]> {
    const client = await this.clientProvider.getClient();
    const respuesta = (await client.getOpenOrders({})) as unknown as {
      data?: Array<Record<string, unknown>>;
    };
    const filas = Array.isArray(respuesta) ? respuesta : (respuesta?.data ?? []);
    return filas.map((fila) => String(fila.id)).filter((id) => id && id !== "undefined");
  }
}

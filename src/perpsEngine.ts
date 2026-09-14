import { OrderSide, PerpsTimeInForce } from "@polymarket/client";

import { averageFillPrice } from "./orderbookService.js";
import { calculateFundingCostUsd, calculatePerpsFeeUsd, PERPS_BASE_TAKER_RATE } from "./perpsFees.js";
import type { PerpsExit, PerpsInstrumentInfo, PerpsPositionAttempt, PerpsQuote, PerpsSide } from "./perpsTypes.js";

export interface PerpsOpenInput {
  instrument: PerpsInstrumentInfo;
  side: PerpsSide;
  /** Tamano de la posicion en dolares de NOCIONAL, no de margen. */
  notionalUsd: number;
  leverage: number;
  quote: PerpsQuote;
  clientOrderId?: string;
  feeRate?: number;
}

export interface PerpsCloseInput {
  position: PerpsPositionAttempt;
  quote: PerpsQuote;
  reason: PerpsExit["reason"];
  feeRate?: number;
  /** Funding devengado desde que se abrio. Lo lleva la cuenta quien mantiene la posicion. */
  fundingPaidUsd?: number;
}

export interface PerpsExecutor {
  open(input: PerpsOpenInput): Promise<PerpsPositionAttempt>;
  close(input: PerpsCloseInput): Promise<PerpsExit>;
  /**
   * OPCIONAL, igual que `sell` en `TradeExecutor` y por el mismo motivo: los dobles de test
   * implementan lo minimo, y hacerlo obligatorio los rompe todos a la vez sin ganar nada.
   */
  setLeverage?(input: { instrumentId: number; leverage: number; crossMargin?: boolean }): Promise<void>;
}

/**
 * Lo minimo de `PerpsSession` que el motor live usa.
 *
 * Interfaz estructural y no la clase del SDK: la API de perps esta marcada `@experimental` y puede
 * romper en una version de parche. Con la superficie acotada a cuatro metodos, lo que hay que revisar
 * cuando eso pase cabe en una pantalla — y los tests inyectan un objeto plano.
 */
export interface PerpsTradingSession {
  placeOrder(request: {
    instrumentId: number;
    side: OrderSide;
    quantity: string;
    price?: string;
    timeInForce: PerpsTimeInForce;
    reduceOnly?: boolean;
    clientOrderId?: string;
  }): Promise<unknown>;
  cancelAllOrders(request?: { instrumentId?: number }): Promise<unknown>;
  updateLeverage(request: { instrumentId: number; leverage: number; crossMargin: boolean }): Promise<unknown>;
  /**
   * Interruptor de hombre muerto del exchange: si el bot no vuelve a hablar antes de esa marca, el
   * exchange cancela solo todas las ordenes.
   *
   * No existe equivalente en el camino binario. Aqui importa mas: alli una orden viva acaba
   * resolviendo con la ventana, y un perpetuo no acaba nunca.
   */
  armAutoCancel(request: { timestamp: number }): Promise<unknown>;
}

/** El libro no daba para el tamano pedido. Lleva el contexto pegado, como `LiveOrderError`. */
export class PerpsLiquidityError extends Error {
  constructor(
    message: string,
    readonly details: {
      symbol: string;
      side: PerpsSide;
      notionalUsd: number;
      availableNotionalUsd: number;
      quoteAgeMs?: number;
    },
  ) {
    super(message);
    this.name = "PerpsLiquidityError";
  }
}

/** Error de una orden live con el contexto de lo que se envio. Espejo de `LiveOrderError`. */
export class PerpsOrderError extends Error {
  constructor(
    message: string,
    readonly details: {
      instrumentId: number;
      symbol: string;
      side: PerpsSide;
      quantity: number;
      price?: number;
      quoteAgeMs?: number;
    },
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "PerpsOrderError";
  }
}

/**
 * Fraccion del margen inicial que hay que conservar para no ser liquidado.
 *
 * La documentacion del exchange la fija en la MITAD de la tasa de margen inicial. Con 20x, el margen
 * inicial es el 5% del nocional y el de mantenimiento el 2,5%: o sea que se liquida al perder la
 * mitad del margen puesto, no al perderlo entero. Es una constante del exchange, no una preferencia,
 * asi que vive aqui y no en la configuracion — por la misma razon que `CRYPTO_TAKER_FEE_RATE_BPS`.
 */
export const MAINTENANCE_MARGIN_FRACTION = 0.5;

/**
 * Precio al que la posicion se queda sin margen.
 *
 * Se despeja de igualar el patrimonio al requisito de mantenimiento:
 *   patrimonio = margen + signo x cantidad x (P - entrada)
 *   requisito  = mmr x cantidad x P
 * con `margen / cantidad = entrada / apalancamiento`. De ahi:
 *   LARGO:  P = entrada x (1 - 1/L) / (1 - mmr)
 *   CORTO:  P = entrada x (1 + 1/L) / (1 + mmr)
 *
 * Se escribe como funcion pura y exportada para poder probarla con numeros a mano. Es la pieza que el
 * simulador del binario nunca necesito y de la que depende que la simulacion de perps no mienta.
 */
export function liquidationPrice(args: { side: PerpsSide; entryPrice: number; leverage: number }): number | undefined {
  const { side, entryPrice, leverage } = args;
  if (!(entryPrice > 0) || !(leverage > 0)) {
    return undefined;
  }
  const mmr = MAINTENANCE_MARGIN_FRACTION / leverage;
  if (side === "LONG") {
    const precio = (entryPrice * (1 - 1 / leverage)) / (1 - mmr);
    return precio > 0 ? precio : 0;
  }
  return (entryPrice * (1 + 1 / leverage)) / (1 + mmr);
}

/**
 * Si el precio de marca ya habria liquidado esta posicion.
 *
 * Se mide contra la MARCA y no contra el mejor bid/ask: es el precio con el que el exchange valora la
 * posicion, y por tanto el unico con el que decide liquidarla. Usar el libro daria falsos positivos
 * cada vez que alguien barre un nivel fino.
 */
export function isLiquidated(position: PerpsPositionAttempt, markPrice: number | undefined): boolean {
  if (position.liquidationPrice === undefined || !Number.isFinite(markPrice as number)) {
    return false;
  }
  return position.side === "LONG"
    ? (markPrice as number) <= position.liquidationPrice
    : (markPrice as number) >= position.liquidationPrice;
}

/**
 * Precio medio REAL de mover `notionalUsd` por el lado que toca.
 *
 * Los dos lados usan `averageFillPrice` a proposito: comprar bajando por los asks y vender subiendo
 * por los bids son la misma cuenta —recorrer niveles hasta cubrir un nocional y promediar— y el
 * helper ya esta probado en el binario. Lo unico que cambia es que lista de niveles se le pasa.
 *
 * Devuelve `undefined` con relleno PARCIAL, igual que el original: un precio medio sobre media
 * posicion no responde a "cuanto costaria este tamano", y leerlo como si si es como se cuelan los
 * backtests optimistas.
 */
export function perpsFillPrice(quote: PerpsQuote, side: PerpsSide, notionalUsd: number): number | undefined {
  const niveles = side === "LONG" ? quote.rawAskLevels : quote.rawBidLevels;
  return averageFillPrice(niveles, notionalUsd);
}

export class SimulationPerpsEngine implements PerpsExecutor {
  constructor(private readonly now: () => number = Date.now) {}

  async open(input: PerpsOpenInput): Promise<PerpsPositionAttempt> {
    const disponible = input.side === "LONG" ? input.quote.availableAskNotionalUsd : input.quote.availableBidNotionalUsd;
    const entryPrice = perpsFillPrice(input.quote, input.side, input.notionalUsd);
    if (entryPrice === undefined) {
      throw new PerpsLiquidityError("El libro no da para el tamano pedido.", {
        symbol: input.instrument.symbol,
        side: input.side,
        notionalUsd: input.notionalUsd,
        availableNotionalUsd: disponible,
        quoteAgeMs: this.now() - input.quote.quotedAtMs,
      });
    }
    const quantity = input.notionalUsd / entryPrice;
    const feeRate = input.feeRate ?? PERPS_BASE_TAKER_RATE;
    return {
      id: `perps-${input.instrument.instrumentId}-${this.now()}`,
      instrumentId: input.instrument.instrumentId,
      symbol: input.instrument.symbol,
      // "sim" fijo, no `config.mode`. Mismo criterio que los motores del binario: el modo de una
      // operacion lo define el motor que la ejecuto, y el P&L se agrupa por este campo.
      mode: "sim",
      side: input.side,
      quantity,
      notionalUsd: input.notionalUsd,
      leverage: input.leverage,
      marginUsd: input.notionalUsd / input.leverage,
      entryPrice,
      liquidationPrice: liquidationPrice({ side: input.side, entryPrice, leverage: input.leverage }),
      feeUsd: calculatePerpsFeeUsd({ price: entryPrice, quantity, feeRate }),
      fundingPaidUsd: 0,
      openedAtMs: this.now(),
      status: "sim",
    };
  }

  async close(input: PerpsCloseInput): Promise<PerpsExit> {
    const { position } = input;
    const feeRate = input.feeRate ?? PERPS_BASE_TAKER_RATE;
    const fundingPaidUsd = input.fundingPaidUsd ?? position.fundingPaidUsd;

    // LIQUIDACION: no es "cerrar peor", es otra cosa.
    //
    // El exchange cierra la posicion y se queda el margen. Modelarla como una salida normal al precio
    // de liquidacion daria una perdida parecida por casualidad y ocultaria lo unico que importa: que
    // la perdida esta ACOTADA POR ABAJO al margen entero y llega de golpe. ARQUITECTURA.md ya
    // documenta que "la sim no mostrara esta ruina" para el tramo de conviccion del binario; con 20x
    // disponibles, un simulador de perps sin esto miente igual y mas rapido.
    if (input.reason === "liquidada") {
      const exitPrice = position.liquidationPrice ?? position.entryPrice;
      const feeUsd = calculatePerpsFeeUsd({ price: exitPrice, quantity: position.quantity, feeRate });
      return {
        exitedAtMs: this.now(),
        reason: "liquidada",
        exitPrice,
        closedQuantity: position.quantity,
        grossPnlUsd: round(-position.marginUsd),
        feeUsd,
        fundingPaidUsd,
        netPnlUsd: round(-position.marginUsd - feeUsd - fundingPaidUsd),
        status: "sim",
      };
    }

    // Cerrar es la operacion CONTRARIA: un largo se cierra vendiendo contra los bids.
    const ladoDeCierre: PerpsSide = position.side === "LONG" ? "SHORT" : "LONG";
    const nocionalCierre = position.quantity * (input.quote.markPrice ?? position.entryPrice);
    const exitPrice =
      perpsFillPrice(input.quote, ladoDeCierre, nocionalCierre) ??
      (position.side === "LONG" ? input.quote.bestBid : input.quote.bestAsk) ??
      input.quote.markPrice ??
      position.entryPrice;
    const signo = position.side === "LONG" ? 1 : -1;
    const grossPnlUsd = signo * position.quantity * (exitPrice - position.entryPrice);
    const feeUsd = calculatePerpsFeeUsd({ price: exitPrice, quantity: position.quantity, feeRate });
    return {
      exitedAtMs: this.now(),
      reason: input.reason,
      exitPrice,
      closedQuantity: position.quantity,
      grossPnlUsd: round(grossPnlUsd),
      feeUsd,
      fundingPaidUsd,
      netPnlUsd: round(grossPnlUsd - feeUsd - fundingPaidUsd),
      status: "sim",
    };
  }
}

/**
 * Devenga el funding de una posicion desde la ultima liquidacion.
 *
 * Fuera del motor porque no es una orden: es un cargo que el exchange aplica solo, cada hora, mientras
 * la posicion exista. Quien mantiene la posicion lo va acumulando y se lo pasa al cierre.
 */
export function accrueFunding(args: {
  position: PerpsPositionAttempt;
  fundingRate: number;
  markPrice?: number;
}): number {
  const nocional = args.position.quantity * (args.markPrice ?? args.position.entryPrice);
  return calculateFundingCostUsd({
    side: args.position.side,
    notionalUsd: nocional,
    fundingRate: args.fundingRate,
  });
}

export class LivePerpsEngine implements PerpsExecutor {
  constructor(
    private readonly sessionProvider: { getSession(): Promise<PerpsTradingSession> },
    private readonly now: () => number = Date.now,
  ) {}

  async open(input: PerpsOpenInput): Promise<PerpsPositionAttempt> {
    const session = await this.sessionProvider.getSession();
    const referencia =
      perpsFillPrice(input.quote, input.side, input.notionalUsd) ??
      (input.side === "LONG" ? input.quote.bestAsk : input.quote.bestBid) ??
      input.quote.markPrice;
    if (referencia === undefined || !(referencia > 0)) {
      throw new PerpsLiquidityError("Sin precio de referencia para dimensionar la orden.", {
        symbol: input.instrument.symbol,
        side: input.side,
        notionalUsd: input.notionalUsd,
        availableNotionalUsd:
          input.side === "LONG" ? input.quote.availableAskNotionalUsd : input.quote.availableBidNotionalUsd,
        quoteAgeMs: this.now() - input.quote.quotedAtMs,
      });
    }
    const quantity = roundDown(input.notionalUsd / referencia, input.instrument.quantityDecimals);
    if (!(quantity > 0)) {
      throw new PerpsLiquidityError("El tamano redondeado a los decimales del instrumento es cero.", {
        symbol: input.instrument.symbol,
        side: input.side,
        notionalUsd: input.notionalUsd,
        availableNotionalUsd:
          input.side === "LONG" ? input.quote.availableAskNotionalUsd : input.quote.availableBidNotionalUsd,
      });
    }
    let response: unknown;
    try {
      response = await session.placeOrder({
        instrumentId: input.instrument.instrumentId,
        side: input.side === "LONG" ? OrderSide.BUY : OrderSide.SELL,
        quantity: quantity.toFixed(input.instrument.quantityDecimals),
        // IOC y no GTC: se quiere lo que el libro ofrezca AHORA o nada. Una limite en reposo en un
        // perpetuo no expira nunca por si sola, asi que un GTC olvidado es una posicion futura que
        // nadie pidio.
        timeInForce: PerpsTimeInForce.IOC,
        reduceOnly: false,
        ...(input.clientOrderId ? { clientOrderId: input.clientOrderId } : {}),
      });
    } catch (error) {
      throw new PerpsOrderError(
        error instanceof Error ? error.message : String(error),
        {
          instrumentId: input.instrument.instrumentId,
          symbol: input.instrument.symbol,
          side: input.side,
          quantity,
          price: referencia,
          quoteAgeMs: input.quote.quotedAtMs === undefined ? undefined : this.now() - input.quote.quotedAtMs,
        },
        error,
      );
    }
    const feeRate = input.feeRate ?? PERPS_BASE_TAKER_RATE;
    return {
      id: `perps-${input.instrument.instrumentId}-${this.now()}`,
      instrumentId: input.instrument.instrumentId,
      symbol: input.instrument.symbol,
      // "live" fijo, por lo mismo que el motor de simulacion pone "sim".
      mode: "live",
      side: input.side,
      quantity,
      notionalUsd: quantity * referencia,
      leverage: input.leverage,
      marginUsd: (quantity * referencia) / input.leverage,
      entryPrice: referencia,
      liquidationPrice: liquidationPrice({ side: input.side, entryPrice: referencia, leverage: input.leverage }),
      feeUsd: calculatePerpsFeeUsd({ price: referencia, quantity, feeRate }),
      fundingPaidUsd: 0,
      openedAtMs: this.now(),
      clientOrderId: input.clientOrderId,
      response,
    };
  }

  async close(input: PerpsCloseInput): Promise<PerpsExit> {
    const session = await this.sessionProvider.getSession();
    const { position } = input;
    const referencia =
      (position.side === "LONG" ? input.quote.bestBid : input.quote.bestAsk) ??
      input.quote.markPrice ??
      position.entryPrice;
    let response: unknown;
    try {
      response = await session.placeOrder({
        instrumentId: position.instrumentId,
        side: position.side === "LONG" ? OrderSide.SELL : OrderSide.BUY,
        quantity: String(position.quantity),
        timeInForce: PerpsTimeInForce.IOC,
        // `reduceOnly` no es cosmetico: sin el, una orden de cierre que llegue cuando la posicion ya
        // no existe ABRE una nueva del lado contrario. Es la diferencia entre "cerrar" y "operar".
        reduceOnly: true,
      });
    } catch (error) {
      throw new PerpsOrderError(
        error instanceof Error ? error.message : String(error),
        {
          instrumentId: position.instrumentId,
          symbol: position.symbol,
          side: position.side,
          quantity: position.quantity,
          price: referencia,
        },
        error,
      );
    }
    const feeRate = input.feeRate ?? PERPS_BASE_TAKER_RATE;
    const signo = position.side === "LONG" ? 1 : -1;
    const grossPnlUsd = signo * position.quantity * (referencia - position.entryPrice);
    const feeUsd = calculatePerpsFeeUsd({ price: referencia, quantity: position.quantity, feeRate });
    const fundingPaidUsd = input.fundingPaidUsd ?? position.fundingPaidUsd;
    return {
      exitedAtMs: this.now(),
      reason: input.reason,
      exitPrice: referencia,
      closedQuantity: position.quantity,
      grossPnlUsd: round(grossPnlUsd),
      feeUsd,
      fundingPaidUsd,
      netPnlUsd: round(grossPnlUsd - feeUsd - fundingPaidUsd),
      response,
    };
  }

  async setLeverage(input: { instrumentId: number; leverage: number; crossMargin?: boolean }): Promise<void> {
    const session = await this.sessionProvider.getSession();
    await session.updateLeverage({
      instrumentId: input.instrumentId,
      leverage: input.leverage,
      crossMargin: input.crossMargin ?? false,
    });
  }
}

/** Trunca hacia abajo a `decimals`. Hacia ABAJO: redondear hacia arriba pide mas de lo que cabe. */
function roundDown(value: number, decimals: number): number {
  const factor = 10 ** Math.max(0, Math.min(18, decimals));
  return Math.floor(value * factor) / factor;
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

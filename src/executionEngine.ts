import {
  ClobClient,
  OrderType,
  Side,
  type OrderResponse,
  type TickSize,
} from "@polymarket/clob-client-v2";

import { LiveClobClientProvider } from "./liveClobClient.js";
import type {
  BotConfig,
  BtcPriceTick,
  MarketInfo,
  OrderbookQuote,
  Outcome,
  TradeAttempt,
  TradeExit,
  WindowOpening,
} from "./types.js";
import type { ExpectedValueSnapshot } from "./expectedValue.js";
import { extractTradeIds, summarizeLiveExitFill, summarizeLiveOrderFill } from "./tradeResolution.js";
import { proceedsFromSelling } from "./orderbookService.js";
import { calculateTradeFeeUsd, defaultTakerFeeRateBps } from "./fees.js";

// Max amount (in price) a live order may pay above the observed best-ask before it stops filling.
const DEFAULT_LIVE_MAX_SLIPPAGE = 0.02;

export interface ExecutionInput {
  market: MarketInfo;
  outcome: Outcome;
  amountUsd: number;
  maxAskPrice: number;
  quote: OrderbookQuote;
  expectedValue?: ExpectedValueSnapshot;
  opening: WindowOpening;
  tick: BtcPriceTick;
  distanceUsd: number;
  entryWindowSeconds: number;
  /**
   * De que tramo del favorito sale la entrada. Llega hasta el `TradeAttempt` porque es lo que decide su
   * ranura en el ledger: sin el, las dos entradas de una ventana comparten clave y la segunda borra
   * a la primera.
   */
  entryKind?: "banda" | "conviccion";
  /** Que estrategia eligio el lado. Solo viaja para quedar escrita en el ledger; no decide nada aqui. */
  strategy?: "favorito" | "direccional";
  /**
   * Ronda de rebalanceo de la ventana. Llega hasta el `TradeAttempt` por lo mismo que `entryKind`:
   * forma parte de su clave en el ledger, y sin ella la reentrada pisaria a la posicion vendida.
   */
  reentry?: number;
}

/**
 * Lo que hace falta para CERRAR una posicion. Tipo aparte de `ExecutionInput` a proposito.
 *
 * Meter un `side` dentro de `ExecutionInput` habria dejado condicionalmente falsa la mitad de sus
 * campos —`maxAskPrice`, `opening`, `distanceUsd`, `entryWindowSeconds`, `entryKind` y todo lo que
 * `buildBaseTrade` construye a partir de ellos son conceptos de ENTRADA— sin que nada lo señalara.
 */
export interface ExitExecutionInput {
  market: MarketInfo;
  /** El lado que se vende. */
  outcome: Outcome;
  /** OJO: en un SELL el `amount` del exchange son PARTICIPACIONES, no dolares. */
  shares: number;
  /** El libro del lado que se vende. De aqui salen los bids por los que se baja. */
  quote: OrderbookQuote;
  /** Suelo duro: por debajo de este precio no se vende ni una participacion. */
  minBidPrice: number;
  reason: TradeExit["reason"];
}

export interface TradeExecutor {
  execute(input: ExecutionInput): Promise<TradeAttempt>;
  /**
   * Cerrar una posicion. OPCIONAL: los dobles de test implementan solo `execute`, y hacerlo
   * obligatorio los rompia todos a la vez sin ganar nada. Ausente = este motor no sabe vender, y
   * quien llama debe tratarlo como "no hay salida disponible", no como un error.
   */
  sell?(input: ExitExecutionInput): Promise<TradeExit>;
}

export function resolveTradeAmountUsd(args: {
  mode: "sim" | "live";
  requestedUsd: number;
  orderMinSize: number;
  autoMinLive: boolean;
}): number {
  if (args.autoMinLive) {
    // "Auto minimum": trade the exchange's minimum order size, ignoring the configured amount, so
    // orders stay as small as the market allows (e.g. Polymarket's $5 minimum). Aplica en AMBOS modos:
    // antes solo en live, de modo que live operaba al minimo del exchange y sim al monto configurado
    // — tamanos distintos hacian que el sim no predijera el sizing real.
    return Number.isFinite(args.orderMinSize) && args.orderMinSize > 0 ? args.orderMinSize : args.requestedUsd;
  }
  return args.requestedUsd;
}

/**
 * Limit price for a live BUY: cap how far above the observed best-ask the FAK order may walk the
 * book. Priced at maxAskPrice (the cap), the order overpays by filling all the way up to the cap
 * when the cheap top-of-book has little size — the sim→live slippage. Capping at bestAsk + a small
 * tolerance means the order fills near the price we evaluated (or fills partially / not at all)
 * instead of overpaying. Falls back to maxAskPrice when the best-ask is unknown.
 */
export function resolveLiveOrderPrice(args: {
  bestAsk: number | undefined;
  maxAskPrice: number;
  maxSlippage: number;
  tickSize?: number;
}): number {
  const base =
    typeof args.bestAsk === "number" && Number.isFinite(args.bestAsk) && args.bestAsk > 0
      ? args.bestAsk
      : args.maxAskPrice;
  const slippage = Number.isFinite(args.maxSlippage) && args.maxSlippage > 0 ? args.maxSlippage : 0;
  let price = Math.min(args.maxAskPrice, base + slippage);
  if (typeof args.tickSize === "number" && Number.isFinite(args.tickSize) && args.tickSize > 0) {
    // Round to the nearest tick, then never let rounding push the price above the cap.
    price = Math.min(args.maxAskPrice, Math.round(price / args.tickSize) * args.tickSize);
  }
  return Number(price.toFixed(6));
}

/**
 * Precio limite de una VENTA: cuanto por DEBAJO del mejor bid puede bajar la orden.
 *
 * Espejo de `resolveLiveOrderPrice`, escrito aparte y no como una funcion con signo. Un signo mal
 * puesto aqui no da un error: da una orden de venta al precio del ask, que no se llena nunca — o peor,
 * un limite absurdamente bajo que barre el libro hasta el fondo. Dos funciones cortas y explicitas
 * valen mas que una con un parametro de direccion.
 *
 * El `Math.max` DESPUES del redondeo es el equivalente al `Math.min` de la compra: el redondeo a tick
 * nunca puede empujar el precio por debajo del suelo.
 */
export function resolveLiveExitPrice(args: {
  bestBid: number | undefined;
  minBidPrice: number;
  maxSlippage: number;
  tickSize?: number;
}): number {
  const base =
    typeof args.bestBid === "number" && Number.isFinite(args.bestBid) && args.bestBid > 0
      ? args.bestBid
      : args.minBidPrice;
  const slippage = Number.isFinite(args.maxSlippage) && args.maxSlippage > 0 ? args.maxSlippage : 0;
  let price = Math.max(args.minBidPrice, base - slippage);
  if (typeof args.tickSize === "number" && Number.isFinite(args.tickSize) && args.tickSize > 0) {
    price = Math.max(args.minBidPrice, Math.round(price / args.tickSize) * args.tickSize);
  }
  return Number(price.toFixed(6));
}

export class SimulationExecutionEngine implements TradeExecutor {
  constructor(private readonly config: BotConfig) {}

  async execute(input: ExecutionInput): Promise<TradeAttempt> {
    // "sim" fijo, no `config.mode`. El modo de una operacion lo define el motor que la ejecuto, no el
    // ajuste global: desde que cada estrategia elige el suyo, ambos motores existen a la vez y leer el
    // global aqui etiquetaria de live operaciones de papel. El P&L se agrupa por este campo.
    return buildBaseTrade(input, "sim");
  }

  async sell(input: ExitExecutionInput): Promise<TradeExit> {
    const orderPrice = resolveLiveExitPrice({
      bestBid: input.quote.bestBid,
      minBidPrice: input.minBidPrice,
      maxSlippage: this.config.liveMaxSlippage ?? DEFAULT_LIVE_MAX_SLIPPAGE,
      tickSize: Number(input.market.tickSize),
    });
    // NO se vende todo al mejor bid. Es la misma disciplina que defiende `averageFillPrice`: un sim
    // optimista en la salida haria creer que cerrar es gratis justo donde la realidad es peor —el
    // libro se adelgaza al cierre, que es cuando esto se dispara— y empujaria a encenderlo en live
    // con numeros que no existen.
    const niveles = input.quote.rawBidLevels.filter((nivel) => nivel.price >= orderPrice);
    const { proceedsUsd, sharesSold } = proceedsFromSelling(niveles, input.shares);
    const averageExitPrice = sharesSold > 0 ? proceedsUsd / sharesSold : orderPrice;
    return {
      exitedAtMs: Date.now(),
      reason: input.reason,
      orderPrice,
      soldShares: sharesSold,
      proceedsUsd,
      averageExitPrice,
      // La comision se cobra tambien en sim, por la misma razon que en la entrada: un sim libre de
      // comisiones no predice el live, y aqui la salida paga taker igual que la compra.
      feeUsd:
        sharesSold > 0
          ? calculateTradeFeeUsd({
              shares: sharesSold,
              price: averageExitPrice,
              feeRateBps: defaultTakerFeeRateBps(input.market.asset),
            })
          : 0,
      status: "sim",
    };
  }
}

/**
 * Lo que se mando de verdad al exchange cuando la orden fallo.
 *
 * Se adjunta al error en vez de recalcularse en quien lo registra: una reconstruccion puede derivar del
 * codigo real y entonces el diagnostico miente justo cuando mas falta hace. Aqui el precio es, por
 * construccion, el que viajo.
 */
export interface LiveOrderFailureDetails {
  /** Precio limite enviado. */
  orderPrice: number;
  /** Mejor ask de la cotizacion en la que se baso la decision. */
  quotedBestAsk?: number;
  /** Profundidad que tenia esa cotizacion, para distinguir "libro fino" de "libro que se movio". */
  quotedDepthUsd: number;
  amountUsd: number;
  /** Cuanto habia envejecido la cotizacion al mandar la orden. La sospecha numero uno. */
  quoteAgeMs?: number;
  tokenId: string;
}

/** Error de una orden live con el contexto de lo enviado. */
export class LiveOrderError extends Error {
  constructor(
    message: string,
    readonly details: LiveOrderFailureDetails,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "LiveOrderError";
  }
}

/**
 * Lo que se mando al exchange cuando la VENTA fallo.
 *
 * Clase aparte de `LiveOrderFailureDetails` y no un campo reutilizado: alli el campo se llama
 * `quotedBestAsk`, y meter un bid dentro es exactamente lo que su comentario dice que no se haga. Un
 * diagnostico que miente sobre que precio se miro es peor que no tener diagnostico.
 */
export interface LiveExitFailureDetails {
  orderPrice: number;
  quotedBestBid?: number;
  /** Profundidad COMPRADORA que tenia la cotizacion, para separar "libro fino" de "libro que se movio". */
  quotedBidDepthUsd: number;
  shares: number;
  quoteAgeMs?: number;
  tokenId: string;
}

export class LiveExitError extends Error {
  constructor(
    message: string,
    readonly details: LiveExitFailureDetails,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "LiveExitError";
  }
}

export class LiveExecutionEngine implements TradeExecutor {
  private readonly clientProvider: LiveClobClientProvider;

  constructor(private readonly config: BotConfig) {
    this.clientProvider = new LiveClobClientProvider(config);
  }

  async execute(input: ExecutionInput): Promise<TradeAttempt> {
    const client = await this.getClient();
    const tokenId = input.market.outcomes[input.outcome].tokenId;
    // Price the order near the best-ask we evaluated, not at the max cap, so it can't walk the book
    // up to the ceiling and overpay (the sim->live slippage).
    const orderPrice = resolveLiveOrderPrice({
      bestAsk: input.quote.bestAsk,
      maxAskPrice: input.maxAskPrice,
      maxSlippage: this.config.liveMaxSlippage ?? DEFAULT_LIVE_MAX_SLIPPAGE,
      tickSize: Number(input.market.tickSize),
    });
    let response: Partial<OrderResponse> & Record<string, unknown>;
    try {
      response = (await client.createAndPostMarketOrder(
        {
          tokenID: tokenId,
          side: Side.BUY,
          amount: input.amountUsd,
          price: orderPrice,
          orderType: OrderType.FAK,
        },
        {
          tickSize: input.market.tickSize as TickSize,
          negRisk: input.market.negRisk,
        },
        OrderType.FAK,
      )) as Partial<OrderResponse> & Record<string, unknown>;
    } catch (error) {
      // Se re-lanza con el contexto pegado. El mensaje del exchange solo dice QUE fallo; sin el precio
      // enviado, el ask que vimos y la edad de la cotizacion, no se puede saber POR QUE.
      throw new LiveOrderError(error instanceof Error ? error.message : String(error), {
        orderPrice,
        quotedBestAsk: input.quote.bestAsk,
        quotedDepthUsd: input.quote.availableUsdAllLevels,
        amountUsd: input.amountUsd,
        quoteAgeMs: input.quote.quotedAtMs === undefined ? undefined : Date.now() - input.quote.quotedAtMs,
        tokenId,
      }, error);
    }

    let finalResponse: unknown = response;
    if (response.status === "live" && response.orderID) {
      const cancelResponse = await client.cancelOrder({ orderID: response.orderID });
      finalResponse = { response, cancelResponse };
    }
    const fill = summarizeLiveOrderFill(response);

    return {
      // "live" fijo, por la misma razon que en el motor de simulacion: lo define el motor.
      ...buildBaseTrade(input, "live"),
      orderId: response.orderID,
      status: response.status,
      fillDetected: fill.fillDetected,
      filledAmountUsd: fill.filledAmountUsd,
      filledShares: fill.filledShares,
      averageFillPrice:
        fill.filledAmountUsd !== undefined && fill.filledShares !== undefined
          ? fill.filledAmountUsd / fill.filledShares
          : undefined,
      fillSource: fill.fillDetected ? "order_response" : undefined,
      tradeIds: extractTradeIds(response),
      response: finalResponse,
    };
  }

  async sell(input: ExitExecutionInput): Promise<TradeExit> {
    const client = await this.getClient();
    const tokenId = input.market.outcomes[input.outcome].tokenId;
    const orderPrice = resolveLiveExitPrice({
      bestBid: input.quote.bestBid,
      minBidPrice: input.minBidPrice,
      maxSlippage: this.config.liveMaxSlippage ?? DEFAULT_LIVE_MAX_SLIPPAGE,
      tickSize: Number(input.market.tickSize),
    });
    let response: Partial<OrderResponse> & Record<string, unknown>;
    try {
      response = (await client.createAndPostMarketOrder(
        {
          tokenID: tokenId,
          side: Side.SELL,
          // PARTICIPACIONES, no dolares. Es lo unico que cambia de forma respecto a la compra y lo
          // que ningun tipo puede proteger: los dos campos son `number`.
          amount: input.shares,
          price: orderPrice,
          orderType: OrderType.FAK,
        },
        {
          tickSize: input.market.tickSize as TickSize,
          negRisk: input.market.negRisk,
        },
        OrderType.FAK,
      )) as Partial<OrderResponse> & Record<string, unknown>;
    } catch (error) {
      throw new LiveExitError(error instanceof Error ? error.message : String(error), {
        orderPrice,
        quotedBestBid: input.quote.bestBid,
        quotedBidDepthUsd: input.quote.availableBidUsdAllLevels ?? 0,
        shares: input.shares,
        quoteAgeMs: input.quote.quotedAtMs === undefined ? undefined : Date.now() - input.quote.quotedAtMs,
        tokenId,
      }, error);
    }

    // Igual que en la compra: una FAK que queda viva no es una venta, es una orden en reposo que
    // nadie va a vigilar. Se cancela en el momento.
    let finalResponse: unknown = response;
    if (response.status === "live" && response.orderID) {
      const cancelResponse = await client.cancelOrder({ orderID: response.orderID });
      finalResponse = { response, cancelResponse };
    }
    const fill = summarizeLiveExitFill(response);
    const soldShares = fill.soldShares ?? 0;
    const proceedsUsd = fill.proceedsUsd ?? 0;

    return {
      exitedAtMs: Date.now(),
      reason: input.reason,
      orderPrice,
      soldShares,
      proceedsUsd,
      averageExitPrice: soldShares > 0 ? proceedsUsd / soldShares : orderPrice,
      orderId: response.orderID,
      status: response.status,
      tradeIds: extractTradeIds(response),
      response: finalResponse,
    };
  }

  private async getClient(): Promise<ClobClient> {
    return this.clientProvider.getClient();
  }
}

function buildBaseTrade(input: ExecutionInput, mode: "sim" | "live"): TradeAttempt {
  const token = input.market.outcomes[input.outcome];
  return {
    id: `${input.market.slug}-${mode}-${input.outcome}-${Date.now()}`,
    asset: input.market.asset,
    slug: input.market.slug,
    mode,
    conditionId: input.market.conditionId,
    outcome: input.outcome,
    tokenId: token.tokenId,
    amountUsd: input.amountUsd,
    maxAskPrice: input.maxAskPrice,
    bestAsk: input.quote.bestAsk,
    bestBid: input.quote.bestBid,
    availableUsdUnderCap: input.quote.availableUsdUnderCap,
    expectedValue: input.expectedValue,
    estimatedShares: input.quote.estimatedSharesForAmount,
    // El precio MEDIO de la caminata por el libro. Se calculaba en `summarizeOrderBook` y se tiraba, y
    // por eso el P&L cobraba las participaciones de la caminata al precio del primer nivel.
    estimatedAveragePrice: input.quote.estimatedAveragePrice,
    openingPrice: input.opening.openingPrice,
    entryPrice: input.tick.value,
    distanceUsd: input.distanceUsd,
    entryWindowSeconds: input.entryWindowSeconds,
    entryKind: input.entryKind,
    strategy: input.strategy,
    reentry: input.reentry,
    windowStartMs: input.market.windowStartMs,
    endMs: input.market.endMs,
    // La ventana de la serie que RESUELVE, estampada CON la operacion. Es lo unico que `resolveTrades`
    // mira para pedirle el cierre al TWAP; sin ella cae al spot, y una apertura TWAP contra un cierre
    // spot no es la misma medida. Medido en el ledger: 2.232 resoluciones por spot, 0 por TWAP, y 144
    // de ellas (8,2%) las tuvo que corregir despues el verificador oficial — minutos de P&L, TUI y
    // avisos diciendo lo contrario de lo que Polymarket acabo pagando.
    twapWindowSeconds: input.market.twapLookbackSeconds,
    createdAtMs: Date.now(),
  };
}

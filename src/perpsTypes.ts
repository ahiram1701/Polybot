/**
 * El dominio de Polymarket Perps, DELIBERADAMENTE separado del de los binarios.
 *
 * No reutiliza `Outcome`, `MarketInfo` ni `TradeAttempt`, y no es por pereza: un perpetuo no tiene
 * `tokenId`, ni `conditionId`, ni ventana, ni resolucion. No resuelve nunca — se cierra. Meterlo en
 * los tipos del binario habria dejado condicionalmente falsos `windowStartMs`, `endMs`,
 * `openingPrice`, `winningOutcome` y la redencion a $1, que es de donde cuelga TODO el P&L y toda la
 * analitica del bot.
 *
 * El precedente es del propio proyecto: `makerMarket.ts` existe porque `MarketInfo` "es un tipo de
 * cripto". Aqui la distancia es mayor todavia.
 */

/**
 * Lado de una posicion. NO es `Outcome`.
 *
 * Un UP/DOWN es una apuesta que vale $1 o $0; un LONG/SHORT es exposicion lineal al precio con
 * apalancamiento y liquidacion. Compartir el tipo habria dejado pasar un "UP" donde va un "LONG" sin
 * que el compilador dijera nada.
 */
export type PerpsSide = "LONG" | "SHORT";

/**
 * Nivel de libro. Usa `size` y no `quantity` A PROPOSITO: es la forma que comen `averageFillPrice` y
 * `proceedsFromSelling` de `orderbookService.ts`, que son puras y se reutilizan tal cual. Renombrarlo
 * obligaria a duplicar esos dos helpers, que es justo lo que no se quiere.
 */
export interface PerpsBookLevel {
  price: number;
  size: number;
}

/**
 * Lo que el bot necesita saber de un instrumento. De `GET /v1/info/instruments`.
 *
 * `maxLeverage` es el tope del VENUE (hasta 20x). El tope del operador es otro y vive en la config:
 * confundirlos seria dejar que Polymarket decida cuanto riesgo corre esta cuenta.
 */
export interface PerpsInstrumentInfo {
  instrumentId: number;
  symbol: string;
  category: string;
  baseAsset: string;
  quoteAsset: string;
  /** Cada cuanto se liquida el funding, en horas. Hoy 1h, pero viene del exchange y puede cambiar. */
  fundingIntervalHours: number;
  priceDecimals: number;
  quantityDecimals: number;
  /** Nocional minimo de una orden. El equivalente del `orderMinSize` de $5 del binario. */
  minNotionalUsd: number;
  maxMarketNotionalUsd: number;
  maxLimitNotionalUsd: number;
  /** Tope del VENUE, no del operador. */
  maxLeverage: number;
  isolatedOnly: boolean;
  liquidationFee: number;
  /** Apalancamiento maximo por tramo de nocional: a mas tamano, menos palanca. */
  riskTiers: Array<{ lowerBoundUsd: number; maxLeverage: number }>;
}

/**
 * Una foto del mercado de un instrumento: libro MAS las tres cosas que un binario no tiene.
 *
 * Espeja a proposito la FORMA de `OrderbookQuote` (`bestBid`/`bestAsk`/`mid`/`rawBidLevels`/
 * `rawAskLevels`/`quotedAtMs`) para que los helpers de profundidad valgan sin tocarlos, pero es un
 * tipo aparte: aqui `mid` no es una probabilidad implicita, es un precio en dolares, y confundir las
 * dos cosas rompe todos los umbrales absolutos del binario (ver la trampa 2 de ARQUITECTURA.md, "la
 * comision es maxima en 0,50").
 */
export interface PerpsQuote {
  instrumentId: number;
  symbol: string;
  quotedAtMs: number;
  bestBid?: number;
  bestAsk?: number;
  /** Medio de tope de libro. En dolares del subyacente, NO una probabilidad. */
  mid?: number;
  /**
   * El precio con el que el exchange VALORA la posicion: es el que decide el P&L no realizado y el
   * que dispara la liquidacion. No es el ultimo cruce ni el medio del libro.
   */
  markPrice?: number;
  /** La estimacion del exchange del valor justo del subyacente. El funding tira `mark` hacia aqui. */
  indexPrice?: number;
  /**
   * Tasa de funding del periodo, en tanto por uno. Positiva = los largos pagan a los cortos.
   *
   * Topada por el exchange en 4% POR HORA en cualquier direccion, que es un numero enorme: a tope,
   * mantener una posicion un dia cuesta casi el nocional entero. Es el riesgo que un binario no tiene.
   */
  fundingRate?: number;
  nextFundingMs?: number;
  openInterest?: number;
  rawBidLevels: PerpsBookLevel[];
  rawAskLevels: PerpsBookLevel[];
  /** Dolares de nocional en todo el lado vendedor / comprador. Para dimensionar sin fingir libro. */
  availableAskNotionalUsd: number;
  availableBidNotionalUsd: number;
}

/** Un instante dentro de un cubo. */
export interface PerpsTickPoint {
  timestampMs: number;
  markPrice?: number;
  indexPrice?: number;
  fundingRate?: number;
  /**
   * El TWAP de Chainlink que el bot YA recibe por la RTDS para BTC y ETH.
   *
   * Se graba porque es la unica ventaja de medicion que Polybot tiene aqui: un oraculo independiente
   * ya conectado con el que comprobar si el `mark` del perp adelanta o retrasa. Ausente en los
   * instrumentos sin oraculo propio (acciones, materias primas).
   */
  chainlinkTwapPrice?: number;
}

/** Una lectura de libro dentro de un cubo. */
export interface PerpsQuotePoint {
  timestampMs: number;
  bestBid?: number;
  bestAsk?: number;
  mid?: number;
  /** Precio medio REAL de comprar/vender el tamano de sonda bajando por el libro. */
  askAvgFill?: number;
  bidAvgFill?: number;
  askNotionalUsd?: number;
  bidNotionalUsd?: number;
}

/**
 * La unidad de analitica: UN instrumento durante UN cubo fijo de 5 minutos.
 *
 * Es la decision de diseno que sostiene todo lo demas, y merece explicacion. Un perpetuo no tiene
 * ventanas, pero toda la maquinaria de medicion honesta de este repo es de ventanas:
 * `bootstrapCIPorBloques` remuestrea ventanas ENTERAS porque las operaciones dentro de una no son
 * independientes, y la regla de eleccion parte el historico en 6 tramos de ventanas. Sin una unidad
 * equivalente habria que reescribir esa maquinaria — o, peor, medir perps con bootstrap de
 * operaciones sueltas, que es exactamente el error que inflo el t de 2,36 a 3,28 el dia 8.
 *
 * El cubo se alinea al MISMO reloj que las ventanas del binario (`getWindowStartMs`), asi que las dos
 * series son comparables instante a instante. Eso es lo que permitira, mas adelante, preguntar si la
 * senal del binario dice algo del perp.
 *
 * Y la "verdad" con la que se puntua es `closeMarkPrice`: el precio con el que el exchange valora la
 * posicion al cerrar el cubo. No hay que inventar un juez como `analyticsTruth` porque no hay etiqueta
 * que equivocarse — no se deduce quien gano, se lee cuanto vale.
 */
export interface PerpsSample {
  version: 1;
  instrumentId: number;
  symbol: string;
  bucketStartMs: number;
  bucketEndMs: number;
  openMarkPrice?: number;
  /** La verdad del cubo. Ausente = el cubo no se pudo cerrar (feed caido) y NO debe puntuarse. */
  closeMarkPrice?: number;
  /** Suma de las tasas de funding publicadas durante el cubo, en tanto por uno. */
  fundingRateSum?: number;
  ticks: PerpsTickPoint[];
  quotes: PerpsQuotePoint[];
  closedAtMs?: number;
}

/**
 * Una posicion abierta. El analogo de `TradeAttempt`, y se nota en lo que NO tiene.
 *
 * Sin `resolved`, sin `winningOutcome`, sin `officialResolution`: un perp no resuelve. Lo que si tiene
 * y el binario no: apalancamiento, margen, precio de liquidacion y funding devengado.
 */
export interface PerpsPositionAttempt {
  id: string;
  instrumentId: number;
  symbol: string;
  mode: "sim" | "live";
  side: PerpsSide;
  /** Cantidad del subyacente, NO dolares. El nocional es `quantity * entryPrice`. */
  quantity: number;
  notionalUsd: number;
  leverage: number;
  /** Colateral inmovilizado = nocional / apalancamiento. Es lo maximo que se puede perder de golpe. */
  marginUsd: number;
  entryPrice: number;
  /**
   * Precio al que el exchange cierra la posicion por falta de margen.
   *
   * Se guarda CON la posicion y no se recalcula al leerla: los tramos de riesgo del instrumento
   * cambian, y una posicion vieja auditada contra los tramos de hoy contaria otra historia.
   */
  liquidationPrice?: number;
  feeUsd: number;
  /** Funding pagado (positivo) o cobrado (negativo) mientras la posicion estuvo abierta. */
  fundingPaidUsd: number;
  openedAtMs: number;
  orderId?: string;
  clientOrderId?: string;
  status?: string;
  response?: unknown;
  exit?: PerpsExit;
}

export interface PerpsExit {
  exitedAtMs: number;
  /**
   * Por que se cerro. `liquidada` es la que no existe en el binario y por la que el simulador tiene
   * que modelarla: una posicion liquidada no se "cierra peor", se pierde el margen entero.
   */
  reason: "manual" | "stop" | "take_profit" | "liquidada" | "funding";
  exitPrice: number;
  closedQuantity: number;
  /** P&L realizado del precio, SIN funding ni comisiones. Esos van aparte para poder auditarlos. */
  grossPnlUsd: number;
  feeUsd: number;
  fundingPaidUsd: number;
  /** Lo que de verdad queda: `grossPnlUsd - feeUsd - fundingPaidUsd`. */
  netPnlUsd: number;
  orderId?: string;
  status?: string;
  response?: unknown;
}

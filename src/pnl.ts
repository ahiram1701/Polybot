import type { TradeAttempt } from "./types.js";
import { calculateTradeFeeUsd, defaultTakerFeeRateBps } from "./fees.js";
import { hasResolvablePosition, summarizeLiveOrderFill } from "./tradeResolution.js";

export interface TradePnl {
  status: "pending" | "resolved";
  stakeUsd: number;
  payoutUsd?: number;
  netUsd?: number;
  roiPct?: number;
  /**
   * Capital que SIGUE en riesgo. Igual a `stakeUsd` salvo tras una salida PARCIAL.
   *
   * Campo aparte en vez de recortar `stakeUsd` porque son dos preguntas distintas: el stake es lo que
   * se arriesgo (el denominador del ROI, que no puede encogerse al vender) y esto es lo que queda
   * comprometido ahora mismo. Lo lee `openStakeUsd` en botRunner, que es quien decide cuanto capital
   * libre hay para la siguiente entrada.
   */
  openStakeUsd?: number;
}

export interface PnlSummary {
  realizedUsd: number;
  realizedStakeUsd: number;
  payoutUsd: number;
  pendingStakeUsd: number;
  totalStakeUsd: number;
  resolvedCount: number;
  pendingCount: number;
  wonCount: number;
  lostCount: number;
  roiPct?: number;
}

export type PnlSummaryByMode = Record<TradeAttempt["mode"], PnlSummary>;
export type PnlResetAtMsByMode = Partial<Record<TradeAttempt["mode"], number>>;

export const EMPTY_PNL_SUMMARY: PnlSummary = {
  realizedUsd: 0,
  realizedStakeUsd: 0,
  payoutUsd: 0,
  pendingStakeUsd: 0,
  totalStakeUsd: 0,
  resolvedCount: 0,
  pendingCount: 0,
  wonCount: 0,
  lostCount: 0,
};

export function emptyPnlSummaryByMode(): PnlSummaryByMode {
  return {
    sim: { ...EMPTY_PNL_SUMMARY },
    live: { ...EMPTY_PNL_SUMMARY },
  };
}

/**
 * A COMPLETE arbitrage pair redeems $1 per set no matter which side wins; only a naked leg (pair
 * incomplete) depends on the winner like a normal position.
 */
export function isCompleteArbPair(trade: Pick<TradeAttempt, "kind" | "arbPairComplete">): boolean {
  return trade.kind === "arb" && trade.arbPairComplete === true;
}

/**
 * Did this resolved trade MAKE MONEY? Use this — not `resolved.won` — for anything the user reads as
 * a result (win counts, win rate, "Ganó/Perdió", the circuit breaker's losing streak).
 *
 * `resolved.won` only answers "did the nominal outcome match the winner", which is the wrong question
 * for a complete arb set: it holds BOTH sides, so it always redeems $1/set and always profits, yet it
 * is recorded against one nominal outcome and so reads as a "loss" roughly half the time. The money
 * math already special-cased this (see calculateTradePnl); the counters did not, which is why the
 * dashboard and Telegram showed profitable arbitrages as losses.
 */
export function isWinningTrade(trade: TradeAttempt): boolean {
  if (isCompleteArbPair(trade)) {
    return true;
  }
  // Una salida anticipada no tiene ganador nominal, y no puede tenerlo: se cerro antes de que lo
  // hubiera. La pregunta de arriba —"¿hizo dinero?"— sigue teniendo respuesta, y es el neto. Casi
  // siempre sera negativo, porque acotar una perdida es realizarla; contarla como "ni ganada ni
  // perdida" la sacaria de la racha del cortacircuitos justo cuando mas informa.
  if (trade.exit && !trade.resolved) {
    return (calculateTradePnl(trade).netUsd ?? 0) > 0;
  }
  if (!trade.resolved) {
    return false;
  }
  return trade.resolved.won === true;
}

export function calculateTradePnl(trade: TradeAttempt): TradePnl {
  const stakeUsd = getStakeUsd(trade);
  const sharesTotales = getFilledShares(trade) ?? trade.estimatedShares;
  const sharesVendidas = getSoldShares(trade, sharesTotales);
  const sharesRestantes = Math.max(0, sharesTotales - sharesVendidas);
  // Bruto MENOS la comision de salida. El CLOB la cobra sobre los ingresos, asi que va aqui y no
  // sumada al stake: sumarla al coste de entrada inflaria el denominador del ROI y haria que dos
  // operaciones identicas puntuaran distinto solo por haberse cerrado antes.
  const payoutVenta = trade.exit ? Math.max(0, trade.exit.proceedsUsd - (trade.exit.feeUsd ?? 0)) : 0;
  // Lo que sigue en riesgo, en proporcion a lo que queda sin vender. Solo se separa del stake tras una
  // salida parcial; en cualquier otro caso son el mismo numero.
  const openStakeUsd =
    sharesTotales > 0 ? (stakeUsd * sharesRestantes) / sharesTotales : trade.exit ? 0 : stakeUsd;

  // Una salida TOTAL cierra la operacion aqui mismo, sin esperar al cierre del mercado: el dinero ya
  // esta cobrado y quien pague despues es irrelevante para esta fila. Es lo que permite que la perdida
  // acotada aparezca en el P&L, en el cortacircuitos y en las pantallas el mismo segundo en que ocurre
  // — antes bastaba con no tener `resolved` para quedarse "pendiente" para siempre.
  if (!trade.resolved) {
    if (trade.exit && sharesRestantes <= SHARE_EPSILON) {
      return {
        status: "resolved",
        stakeUsd,
        payoutUsd: payoutVenta,
        netUsd: payoutVenta - stakeUsd,
        roiPct: stakeUsd > 0 ? (payoutVenta - stakeUsd) / stakeUsd : undefined,
        openStakeUsd: 0,
      };
    }
    return {
      status: "pending",
      stakeUsd,
      openStakeUsd,
    };
  }

  const paysRegardlessOfWinner = isCompleteArbPair(trade);
  // Solo redimen las participaciones que SIGUEN en la posicion. Las vendidas ya cobraron su precio de
  // mercado y contarlas otra vez a $1 seria cobrarlas dos veces.
  const payoutResolucion = trade.resolved.won || paysRegardlessOfWinner ? sanitizeUsd(sharesRestantes) : 0;
  const payoutUsd = payoutVenta + payoutResolucion;
  const netUsd = payoutUsd - stakeUsd;
  return {
    status: "resolved",
    stakeUsd,
    payoutUsd,
    netUsd,
    roiPct: stakeUsd > 0 ? netUsd / stakeUsd : undefined,
    openStakeUsd: 0,
  };
}

/** Por debajo de esto un resto de participaciones es ruido de coma flotante, no una posicion viva. */
const SHARE_EPSILON = 1e-6;

/** Nunca mas de lo que se tenia: un llenado reportado de mas no puede inventar payout. */
function getSoldShares(trade: TradeAttempt, sharesTotales: number): number {
  if (!trade.exit || !isPositiveFinite(trade.exit.soldShares)) {
    return 0;
  }
  return Math.min(trade.exit.soldShares, sharesTotales);
}

/**
 * ¿Se vendio ENTERA antes de que el mercado resolviera?
 *
 * Se pregunta por el resultado del P&L y no por `trade.exit !== undefined` porque una salida parcial
 * tambien tiene `exit` y sigue teniendo posicion viva: esa si debe resolver al cierre.
 */
export function esSalidaTotal(trade: TradeAttempt): boolean {
  return trade.exit !== undefined && !trade.resolved && calculateTradePnl(trade).status === "resolved";
}

/**
 * ¿Termino ya esta operacion? Resolvio en el mercado, o se vendio entera antes de resolver.
 *
 * Filtrar por `resolved` a secas deja fuera las salidas por stop, y esas son SIEMPRE perdidas —
 * acotar una perdida es realizarla. Un total que las descarta no es un total conservador: enseña las
 * ganancias sin las perdidas que las pagaron. Medido en el bot el 2026-09-05: el desglose por
 * estrategia decia +$28,22 en 36 operaciones, todas ganadas, mientras el P&L real era +$0,60 — las 9
 * ventas que faltaban sumaban -$27,65.
 */
export function esOperacionCerrada(trade: TradeAttempt): boolean {
  return trade.resolved !== undefined || esSalidaTotal(trade);
}

/**
 * Cuando dejo de estar abierta esta operacion, o `undefined` si sigue viva.
 *
 * Existe porque una salida anticipada NO tiene `resolved`, y todo lo que filtraba por ese campo la
 * daba por pendiente para siempre. En el cortacircuitos eso era grave: las perdidas acotadas —las que
 * mas se parecen a lo que el cortacircuitos existe para atrapar— no contaban ni en la perdida diaria
 * ni en la racha.
 */
export function tradeClosedAtMs(trade: TradeAttempt): number | undefined {
  if (trade.resolved) {
    return trade.resolved.resolvedAtMs;
  }
  return calculateTradePnl(trade).status === "resolved" ? trade.exit?.exitedAtMs : undefined;
}

function getStakeUsd(trade: TradeAttempt): number {
  if (trade.mode === "live" && !hasResolvablePosition(trade)) {
    return 0;
  }
  const filledAmountUsd = getFilledAmountUsd(trade);
  if (isPositiveFinite(filledAmountUsd)) {
    return sanitizeUsd(filledAmountUsd) + getFeeUsd(trade);
  }
  // No explicit fill amount (sim): the real stake is the COST of the shares actually held, which can
  // be less than the requested amount when liquidity under the cap was thin (a partial fill). The
  // payout uses those same shares, so using the requested amountUsd here would score a partially
  // filled WIN as a loss (e.g. 0.93 shares bought for ~$0.69 but staked as $10 -> shows -$9.07).
  const shares = getFilledShares(trade) ?? trade.estimatedShares;
  const price = getEntryPriceUsd(trade);
  const cost = isPositiveFinite(shares) && isPositiveFinite(price) ? shares * price : trade.amountUsd;
  return sanitizeUsd(cost) + getFeeUsd(trade);
}

/**
 * Precio al que se entro de verdad, por orden de fiabilidad.
 *
 * `bestAsk` es el ULTIMO recurso, no el primero: solo vale la superficie del libro cuando el importe
 * cabe entero en el primer nivel. `estimatedShares` se calcula bajando por niveles, asi que cobrarlas
 * al mejor ask apuntaba un coste menor que el dinero realmente gastado — y el error crece cuanto mas
 * fino este el libro, que es exactamente al cierre, que es cuando entra el bot.
 */
function getEntryPriceUsd(trade: TradeAttempt): number | undefined {
  const filledShares = getFilledShares(trade);
  const filledAmountUsd = getFilledAmountUsd(trade);
  if (isPositiveFinite(trade.averageFillPrice)) {
    return trade.averageFillPrice;
  }
  if (isPositiveFinite(filledShares) && isPositiveFinite(filledAmountUsd)) {
    return filledAmountUsd / filledShares;
  }
  if (isPositiveFinite(trade.estimatedAveragePrice)) {
    return trade.estimatedAveragePrice;
  }
  return isPositiveFinite(trade.bestAsk) ? trade.bestAsk : undefined;
}

function getFilledAmountUsd(trade: TradeAttempt): number | undefined {
  if (trade.mode !== "live") {
    return trade.filledAmountUsd;
  }
  return chooseReliableFillValue(trade.filledAmountUsd, summarizeLiveOrderFill(trade.response).filledAmountUsd);
}

function getFilledShares(trade: TradeAttempt): number | undefined {
  if (trade.mode !== "live") {
    return trade.filledShares;
  }
  return chooseReliableFillValue(trade.filledShares, summarizeLiveOrderFill(trade.response).filledShares);
}

// Exported for the fiscal report: the same fee (recorded or estimated) that calculateTradePnl bakes
// into the stake, so the CSV's fee column reconciles exactly with the dashboard P&L.
export function estimateTradeFeeUsd(trade: TradeAttempt): number {
  return getFeeUsd(trade);
}

function getFeeUsd(trade: TradeAttempt): number {
  if (isPositiveFinite(trade.feeUsd)) {
    return trade.feeUsd;
  }
  // La fee se estima en AMBOS modos. Antes sim devolvia 0, asi que su P&L era libre de comisiones
  // (~3.7% del stake) y toda validacion en sim salia optimista frente al live que pretendia predecir:
  // un sim ligeramente positivo podia ser un live negativo. Un sim honesto exige cobrar lo mismo.
  // Se cae a las participaciones ESTIMADAS y al precio de entrada estimado. Antes se exigia un llenado
  // registrado, que en sim direccional nunca existe: por eso 574 operaciones simuladas pagaron cero
  // pese a que este mismo comentario afirmaba lo contrario. Y la comision es MAXIMA en 0,50, asi que
  // no era un descuento plano: perdonaba mas justo la banda central, la que el tuner tiende a proponer.
  const shares = getFilledShares(trade) ?? trade.estimatedShares;
  const price = getEntryPriceUsd(trade);
  if (!isPositiveFinite(shares) || !isPositiveFinite(price)) {
    return 0;
  }
  return calculateTradeFeeUsd({
    shares,
    price,
    feeRateBps: defaultTakerFeeRateBps(trade.asset),
  });
}

function chooseReliableFillValue(stored: number | undefined, response: number | undefined): number | undefined {
  if (response !== undefined && (!isPositiveFinite(stored) || isLikelyScaledDown(stored, response))) {
    return response;
  }
  return stored ?? response;
}

function isLikelyScaledDown(stored: number | undefined, response: number): boolean {
  return isPositiveFinite(stored) && response >= 0.01 && response / stored >= 1_000;
}

export function calculatePnlSummary(trades: TradeAttempt[]): PnlSummary {
  const summary: PnlSummary = { ...EMPTY_PNL_SUMMARY };

  for (const trade of trades) {
    const pnl = calculateTradePnl(trade);
    summary.totalStakeUsd += pnl.stakeUsd;

    if (pnl.status === "pending") {
      summary.pendingStakeUsd += pnl.stakeUsd;
      summary.pendingCount += 1;
      continue;
    }

    summary.realizedStakeUsd += pnl.stakeUsd;
    summary.payoutUsd += pnl.payoutUsd ?? 0;
    summary.realizedUsd += pnl.netUsd ?? 0;
    summary.resolvedCount += 1;
    if (isWinningTrade(trade)) {
      summary.wonCount += 1;
    } else {
      summary.lostCount += 1;
    }
  }

  summary.roiPct = summary.realizedStakeUsd > 0 ? summary.realizedUsd / summary.realizedStakeUsd : undefined;
  return summary;
}

export function calculatePnlSummaryByMode(trades: TradeAttempt[], resetAtMsByMode: PnlResetAtMsByMode = {}): PnlSummaryByMode {
  const pnlTrades = filterTradesForPnlReset(trades, resetAtMsByMode);
  return {
    sim: calculatePnlSummary(pnlTrades.filter((trade) => trade.mode === "sim")),
    live: calculatePnlSummary(pnlTrades.filter((trade) => trade.mode === "live")),
  };
}

export function calculateResetAwarePnlSummary(trades: TradeAttempt[], resetAtMsByMode: PnlResetAtMsByMode = {}): PnlSummary {
  return calculatePnlSummary(filterTradesForPnlReset(trades, resetAtMsByMode));
}

export function filterTradesForPnlReset(trades: TradeAttempt[], resetAtMsByMode: PnlResetAtMsByMode = {}): TradeAttempt[] {
  return trades.filter((trade) => {
    const resetAtMs = resetAtMsByMode[trade.mode];
    return resetAtMs === undefined || trade.createdAtMs > resetAtMs;
  });
}

function sanitizeUsd(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) ? value : 0;
}

function isPositiveFinite(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value > 0;
}

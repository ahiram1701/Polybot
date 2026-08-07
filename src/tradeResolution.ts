import type { AnalyticsTickPoint, BtcPriceTick, Outcome, SimResolution, TradeAttempt } from "./types.js";
import { marketSymbolFromSlug } from "./markets.js";
import { windowTwap } from "./twap.js";

/**
 * Cobertura minima de ticks para fiarse del TWAP. Por debajo se usa la regla vieja y que corrija el
 * verificador oficial: un promedio sobre medio rango no es el promedio del rango.
 */
export const MIN_TWAP_COVERAGE = 0.8;

const CLOB_AMOUNT_DECIMALS = 6;
const RESOLVABLE_LIVE_STATUSES = new Set(["matched"]);

export interface LiveFillSummary {
  fillDetected: boolean;
  filledAmountUsd?: number;
  filledShares?: number;
}

export function summarizeLiveOrderFill(response: unknown): LiveFillSummary {
  const orderResponse = unwrapOrderResponse(response);
  const status = getString(orderResponse, "status")?.toLowerCase();
  const makingAmount = parseClobAmount(getProperty(orderResponse, "makingAmount"));
  const takingAmount = parseClobAmount(getProperty(orderResponse, "takingAmount"));
  const tradeIds = getArray(orderResponse, "tradeIDs");
  const transactionHashes = getArray(orderResponse, "transactionsHashes");
  const rejected = getProperty(orderResponse, "success") === false;

  return {
    fillDetected: !rejected && (
      RESOLVABLE_LIVE_STATUSES.has(status ?? "") ||
      makingAmount !== undefined ||
      takingAmount !== undefined ||
      tradeIds.length > 0 ||
      transactionHashes.length > 0
    ),
    filledAmountUsd: makingAmount,
    filledShares: takingAmount,
  };
}

export function extractTradeIds(response: unknown): string[] {
  const orderResponse = unwrapOrderResponse(response);
  return getArray(orderResponse, "tradeIDs")
    .map((tradeId) => String(tradeId))
    .filter((tradeId) => tradeId.length > 0);
}

export function hasResolvablePosition(trade: TradeAttempt): boolean {
  if (trade.mode === "sim") {
    return true;
  }
  if (trade.fillDetected !== undefined) {
    return trade.fillDetected;
  }
  return summarizeLiveOrderFill(trade.response ?? { status: trade.status }).fillDetected;
}

export function resolveTradeFromTick(
  trade: TradeAttempt,
  latestTick: BtcPriceTick,
  nowMs: number,
  closeTick?: BtcPriceTick,
  /**
   * Ticks de la ventana, para calcular el TWAP. Sin ellos se cae al ultimo precio, que es la regla
   * ANTIGUA — se conserva solo como red: dejar trades sin resolver seria peor, y el verificador
   * oficial corrige lo que salga mal.
   */
  windowTicks?: readonly AnalyticsTickPoint[],
): SimResolution | undefined {
  const tradeAsset = trade.asset ?? marketSymbolFromSlug(trade.slug);
  if (
    (tradeAsset && latestTick.market !== tradeAsset) ||
    trade.resolved ||
    nowMs < trade.endMs ||
    // Waiting for a tick at-or-after the boundary confirms the close value is final...
    latestTick.timestampMs < trade.endMs ||
    !hasResolvablePosition(trade)
  ) {
    return undefined;
  }

  // ...but the winner is judged by the price AT the close, i.e. the last tick at-or-before endMs — the
  // official resolution uses the oracle value in effect when the window ended. Using the first tick
  // AFTER the boundary flipped photo-finish windows (a real trade was scored as a $5 loss while
  // Polymarket paid out $20 for it). Falls back to latestTick when close history is unavailable
  // (e.g. right after a restart); the official-resolution verifier corrects live trades if needed.
  const referenceTick = closeTick && closeTick.timestampMs <= trade.endMs ? closeTick : latestTick;

  // Desde el 2026-08-07 Polymarket resuelve por TWAP: gana "Up" si el promedio ponderado por tiempo
  // de la ventana supera el precio de APERTURA. Comparar el ultimo precio, que es lo que se hacia
  // antes, cambia el ganador en al menos el 11% de las ventanas.
  //
  // Se exige cobertura suficiente antes de fiarse: un TWAP calculado sobre un trozo de la ventana no
  // es el TWAP de la ventana, y usarlo como si lo fuera es peor que la regla vieja, porque parece
  // correcto. Sin cobertura se cae al ultimo precio y el verificador oficial lo corrige.
  const medida = windowTicks ? windowTwap(windowTicks, trade.windowStartMs, trade.endMs) : undefined;
  const usaTwap = medida !== undefined && medida.coverage >= MIN_TWAP_COVERAGE;
  const precioJuez = usaTwap ? medida.twap : referenceTick.value;
  const winningOutcome: Outcome = precioJuez >= trade.openingPrice ? "UP" : "DOWN";
  return {
    resolvedAtMs: nowMs,
    // `finalPrice` sigue siendo el precio de cierre observado: es el dato crudo, no el juicio. El
    // veredicto va en `winningOutcome`, y mezclarlos haria irreproducible cual de las dos reglas se
    // aplico a cada trade.
    finalPrice: referenceTick.value,
    finalTickTimestampMs: referenceTick.timestampMs,
    twapPrice: usaTwap ? medida.twap : undefined,
    twapCoverage: medida?.coverage,
    winningOutcome,
    won: winningOutcome === trade.outcome,
  };
}

export function parseClobAmount(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  const text = typeof value === "string" ? value.trim() : undefined;
  const numeric = typeof value === "number" ? value : Number(text);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return undefined;
  }
  if (text?.includes(".")) {
    return numeric;
  }
  return Number.isInteger(numeric) && numeric >= 10 ** CLOB_AMOUNT_DECIMALS
    ? numeric / 10 ** CLOB_AMOUNT_DECIMALS
    : numeric;
}

function unwrapOrderResponse(value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }
  const nested = value.response;
  return isRecord(nested) ? nested : value;
}

function getProperty(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

function getString(value: unknown, key: string): string | undefined {
  const property = getProperty(value, key);
  return typeof property === "string" ? property : undefined;
}

function getArray(value: unknown, key: string): unknown[] {
  const property = getProperty(value, key);
  return Array.isArray(property) ? property : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

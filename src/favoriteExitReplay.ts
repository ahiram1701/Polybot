import { decideFavoriteExit, type FavoriteExitReason } from "./favoriteExit.js";
import type { FavoriteSignal } from "./favoriteReplay.js";
import { calculateTradeFeeUsd, defaultTakerFeeRateBps } from "./fees.js";
import type { AnalyticsQuotePoint, AnalyticsSample, MarketSymbol, OrderbookQuote } from "./types.js";
import { readWindowCertainty } from "./windowCertainty.js";

/**
 * La SALIDA del favorito, replicada sobre las ventanas ya observadas. Hermano de `favoriteReplay`.
 *
 * Existe porque ningun script del repo simulaba `decideFavoriteExit`. Las tablas que justificaban la
 * salida (152 entradas, vender con certeza <= 0 daba +0,5686 frente a +0,4623 aguantando) salieron
 * de scripts sin versionar y sobre el universo equivocado: "aguantando hasta el cierre", sin la ventana
 * de entrada ni la banda. Replicada de verdad, sobre las entradas que el bot hace, ninguna variante
 * mejora a aguantar: el ledger lo confirma (156 salidas reales, -5,50 $ frente a aguantar) y este
 * modulo lo reproduce (-4,01 $ con las entradas de 80 s y z>=1,5).
 *
 * Misma regla dura que `favoriteReplay`: no se reimplementa la decision, se LLAMA a la de produccion
 * —`decideFavoriteExit`, `readWindowCertainty`, `calculateTradeFeeUsd`—.
 *
 * Tres limitaciones, escritas para que nadie las lea como exactitud:
 *
 * 1. LIBRO COMPRADOR APROXIMADO. La muestra graba la profundidad compradora en dolares
 *    (`upBidDepthUsd`) pero no los niveles. Se modela como UN nivel al mejor bid con tamaño
 *    `profundidad / bid`, que es optimista en el precio medio de una venta grande. Con 5 $ de stake la
 *    posicion es pequeña frente a la profundidad tipica, asi que el error es de centimos.
 * 2. SIN REENTRADA. Tras vender, la ventana se da por cerrada. En el ledger las reentradas tras salida
 *    sumaron -1,49 $ en 29 ventanas: no cambian la conclusion, pero no estan aqui.
 * 3. SIN LATENCIA. Se vende al libro del mismo instante en que se decide.
 */

/**
 * Umbral de certeza que nunca se alcanza. `decideFavoriteExit` cae a su default con un `-Infinity`
 * (no es finito), asi que "apagar el disparador por certeza" se expresa con un numero finito enorme.
 */
export const CERTEZA_NUNCA = -1e9;

export interface ExitReplayPolicy {
  /** Se vende con la certeza en este valor o por debajo. `CERTEZA_NUNCA` lo apaga. */
  exitCertainty: number;
  /** Se vende con el ask propio en este valor o por debajo. `0` lo apaga. */
  stopAsk: number;
  /** El resto, `undefined` = el default de `favoriteExit`, igual que en produccion. */
  minSecondsToEnd?: number;
  minBid?: number;
  minSellFillRatio?: number;
  maxAskSum?: number;
  maxSpread?: number;
  minHoldMs?: number;
  /** Historia para estimar sigma. `CERTEZA_HISTORIA_MS / 1000` en produccion: 180. */
  historiaSegundos?: number;
}

export interface ExitReplaySale {
  motivo: FavoriteExitReason;
  secondsToEnd: number;
  sharesSold: number;
  proceedsUsd: number;
  feeUsd: number;
  averagePrice: number;
}

export interface ExitReplayResult {
  market: MarketSymbol;
  windowStartMs: number;
  /** Si el lado comprado acabo ganando. Una venta con `won` es una venta que costo dinero. */
  won: boolean;
  /** Neto aguantando hasta la resolucion: la vara contra la que se mide cualquier salida. */
  holdNetUsd: number;
  netUsd: number;
  sale?: ExitReplaySale;
}

/**
 * Lo que habria pasado con UNA entrada bajo una politica de salida.
 *
 * `undefined` si la muestra no es la de la señal o no contiene la cotizacion de entrada: sin ella no
 * se sabe desde cuando se tiene la posicion, y adivinarlo seria mirar el futuro o el pasado.
 * Sin politica, devuelve el resultado de aguantar.
 */
export function replayFavoriteExit(args: {
  sample: AnalyticsSample;
  signal: FavoriteSignal;
  policy?: ExitReplayPolicy;
  stakeUsd: number;
}): ExitReplayResult | undefined {
  const { sample, signal, policy, stakeUsd } = args;
  if (sample.slug !== signal.slug) {
    return undefined;
  }
  const entrada = sample.quotes.find((punto) => punto.secondsToEnd === signal.secondsToEnd);
  if (!entrada) {
    return undefined;
  }

  const feeRateBps = defaultTakerFeeRateBps(sample.market);
  const shares = stakeUsd / signal.ask;
  const feeEntradaUsd = calculateTradeFeeUsd({ shares, price: signal.ask, feeRateBps });
  const holdNetUsd = (signal.won ? shares : 0) - stakeUsd - feeEntradaUsd;
  const base = { market: sample.market, windowStartMs: sample.windowStartMs, won: signal.won, holdNetUsd };
  if (!policy) {
    return { ...base, netUsd: holdNetUsd };
  }

  // Solo lo POSTERIOR a la entrada. `decideFavoriteExit` ya bloquea con `demasiado_pronto` cualquier
  // instante anterior, pero ese guarda es de produccion y podria cambiar; este filtro es el que hace que
  // el replay no pueda vender una posicion antes de tenerla.
  const despues = sample.quotes
    .filter((punto) => punto.timestampMs > entrada.timestampMs)
    .sort((izq, der) => izq.timestampMs - der.timestampMs);
  // Spot, como `leerCerteza` en produccion. Ver `adaptarTicks` en `favoriteReplay`.
  const ticks = sample.ticks.map((tick) => ({ timestampMs: tick.timestampMs, value: tick.price }));

  for (const punto of despues) {
    const certeza = readWindowCertainty({
      ticks,
      openingPrice: sample.openingPrice,
      outcome: signal.outcome,
      nowMs: punto.timestampMs,
      endMs: sample.endMs,
      historiaSegundos: policy.historiaSegundos,
    });
    const decision = decideFavoriteExit({
      posicion: { outcome: signal.outcome, shares, createdAtMs: entrada.timestampMs },
      quotes: librosAproximados(punto, shares),
      nowMs: punto.timestampMs,
      endMs: sample.endMs,
      stopAsk: policy.stopAsk,
      certeza: certeza?.z,
      exitCertainty: policy.exitCertainty,
      minSecondsToEnd: policy.minSecondsToEnd,
      minBid: policy.minBid,
      minSellFillRatio: policy.minSellFillRatio,
      maxAskSum: policy.maxAskSum,
      maxSpread: policy.maxSpread,
      minHoldMs: policy.minHoldMs,
    });
    if (!decision.plan) {
      continue;
    }

    const { sharesVendibles, proceedsUsd, precioMedioSalida, motivo } = decision.plan;
    const feeUsd = calculateTradeFeeUsd({ shares: sharesVendibles, price: precioMedioSalida, feeRateBps });
    // Una venta parcial deja el resto dentro: redime a 1 si el lado gana, igual que en `calculateTradePnl`.
    const restantes = Math.max(0, shares - sharesVendibles);
    const netUsd = proceedsUsd - feeUsd + (signal.won ? restantes : 0) - stakeUsd - feeEntradaUsd;
    return {
      ...base,
      netUsd,
      sale: {
        motivo,
        secondsToEnd: punto.secondsToEnd,
        sharesSold: sharesVendibles,
        proceedsUsd,
        feeUsd,
        averagePrice: precioMedioSalida,
      },
    };
  }
  return { ...base, netUsd: holdNetUsd };
}

export interface ExitReplaySummary {
  entradas: number;
  ventas: number;
  /** Ventas de lados que acabaron GANANDO. Cada una cuesta, de media, el doble de lo que ahorra una buena. */
  ventasQueGanaban: number;
  holdNetUsd: number;
  netUsd: number;
  /** Neto con la politica menos neto aguantando. Negativo = la salida cuesta dinero. */
  deltaUsd: number;
}

export function summarizeExitReplay(results: readonly ExitReplayResult[]): ExitReplaySummary {
  let ventas = 0;
  let ventasQueGanaban = 0;
  let holdNetUsd = 0;
  let netUsd = 0;
  for (const resultado of results) {
    holdNetUsd += resultado.holdNetUsd;
    netUsd += resultado.netUsd;
    if (resultado.sale) {
      ventas += 1;
      if (resultado.won) {
        ventasQueGanaban += 1;
      }
    }
  }
  return { entradas: results.length, ventas, ventasQueGanaban, holdNetUsd, netUsd, deltaUsd: netUsd - holdNetUsd };
}

/**
 * Los dos libros del instante, con el lado comprador reducido a un nivel. Ver la limitacion 1.
 *
 * Sin profundidad grabada se asume que el nivel absorbe la posicion entera. Es la lectura optimista, y
 * es a proposito: si la salida no gana ni asi, no gana.
 */
function librosAproximados(punto: AnalyticsQuotePoint, shares: number): { UP: OrderbookQuote; DOWN: OrderbookQuote } {
  return {
    UP: lado(punto.upBestAsk, punto.upBestBid, punto.upBidDepthUsd, punto.timestampMs, shares),
    DOWN: lado(punto.downBestAsk, punto.downBestBid, punto.downBidDepthUsd, punto.timestampMs, shares),
  };
}

function lado(
  bestAsk: number | undefined,
  bestBid: number | undefined,
  profundidadUsd: number | undefined,
  quotedAtMs: number,
  shares: number,
): OrderbookQuote {
  const niveles =
    typeof bestBid === "number" && bestBid > 0
      ? [{ price: bestBid, size: typeof profundidadUsd === "number" ? profundidadUsd / bestBid : shares }]
      : [];
  return {
    tokenId: "replay",
    quotedAtMs,
    bestAsk,
    bestBid,
    availableUsdUnderCap: 0,
    availableUsdAllLevels: 0,
    estimatedSharesForAmount: 0,
    rawAskLevels: [],
    rawBidLevels: niveles,
    availableBidUsdAllLevels: typeof profundidadUsd === "number" ? profundidadUsd : 0,
  };
}

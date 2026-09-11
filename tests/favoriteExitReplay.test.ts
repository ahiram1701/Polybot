import { describe, expect, it } from "vitest";

import { CERTEZA_NUNCA, replayFavoriteExit, summarizeExitReplay } from "../src/favoriteExitReplay.js";
import type { FavoriteSignal } from "../src/favoriteReplay.js";
import { calculateTradeFeeUsd } from "../src/fees.js";
import type { AnalyticsQuotePoint, AnalyticsSample, AnalyticsTickPoint } from "../src/types.js";

const END_MS = 300_000;
const OPENING = 100;
const STAKE = 5;
const ASK = 0.85;
const SHARES = STAKE / ASK;
const FEE_ENTRADA = calculateTradeFeeUsd({ shares: SHARES, price: ASK, feeRateBps: 700 });
/** La politica que corria en produccion hasta que se apagaron las salidas. */
const POLITICA = { exitCertainty: 0, stopAsk: 0.35 };

/**
 * Sube limpio hasta 120 en los primeros 200 s y en el segundo 205 se desploma a 90, al otro lado de la
 * apertura. Desde ahi la certeza del lado UP es negativa: es el caso que la salida existe para cubrir.
 */
function ticksQueSeDanLaVuelta(): AnalyticsTickPoint[] {
  const puntos: AnalyticsTickPoint[] = [];
  for (let i = 0; i <= 60; i += 1) {
    const timestampMs = i * 5_000;
    const price = i <= 40 ? OPENING + i * 0.5 : 90 + (i % 2 === 0 ? 0.01 : -0.01);
    puntos.push({ timestampMs, secondsToEnd: (END_MS - timestampMs) / 1000, price, distanceUsd: price - OPENING });
  }
  return puntos;
}

function quote(secondsToEnd: number, up: { ask: number; bid: number; depth?: number }, down: { ask: number; bid: number }): AnalyticsQuotePoint {
  return {
    timestampMs: END_MS - secondsToEnd * 1000,
    secondsToEnd,
    upBestAsk: up.ask,
    upBestBid: up.bid,
    upBidDepthUsd: up.depth,
    downBestAsk: down.ask,
    downBestBid: down.bid,
  };
}

/** La cotizacion en la que se compro: UP a 0,85 con 100 s por delante. */
const ENTRADA = quote(100, { ask: ASK, bid: 0.84, depth: 500 }, { ask: 0.14, bid: 0.13 });

/** El libro ya desplomado: UP con el bid en 0,28. Suma de asks 1,01, spread de dos centimos. */
function desplome(secondsToEnd: number, depth = 100): AnalyticsQuotePoint {
  return quote(secondsToEnd, { ask: 0.3, bid: 0.28, depth }, { ask: 0.71, bid: 0.69 });
}

function muestra(quotesDespues: AnalyticsQuotePoint[]): AnalyticsSample {
  return {
    version: 1,
    market: "BTC",
    slug: "btc-updown-5m-0",
    windowStartMs: 0,
    endMs: END_MS,
    openingPrice: OPENING,
    openingTickTimestampMs: 0,
    ticks: ticksQueSeDanLaVuelta(),
    quotes: [ENTRADA, ...quotesDespues],
  };
}

function senal(won: boolean): FavoriteSignal {
  return {
    predicted: ASK,
    won,
    ask: ASK,
    windowStartMs: 0,
    market: "BTC",
    slug: "btc-updown-5m-0",
    outcome: "UP",
    secondsToEnd: 100,
    z: 5,
    breakEven: ASK * (1 + 0.07 * (1 - ASK)),
  };
}

describe("replayFavoriteExit", () => {
  it("vende cuando la certeza cae y liquida contra el bid, con las dos comisiones", () => {
    const r = replayFavoriteExit({ sample: muestra([desplome(70)]), signal: senal(false), policy: POLITICA, stakeUsd: STAKE });

    const feeSalida = calculateTradeFeeUsd({ shares: SHARES, price: 0.28, feeRateBps: 700 });
    expect(r?.sale?.motivo).toBe("certeza_perdida");
    expect(r?.sale?.secondsToEnd).toBe(70);
    expect(r?.sale?.sharesSold).toBeCloseTo(SHARES, 10);
    expect(r?.netUsd).toBeCloseTo(SHARES * 0.28 - feeSalida - STAKE - FEE_ENTRADA, 8);
    expect(r?.holdNetUsd).toBeCloseTo(-STAKE - FEE_ENTRADA, 8);
    // El lado perdia: vender ahorra dinero frente a aguantar. Es la salida BUENA.
    expect(r!.netUsd).toBeGreaterThan(r!.holdNetUsd);
  });

  it("sin politica aguanta hasta la resolucion", () => {
    const r = replayFavoriteExit({ sample: muestra([desplome(70)]), signal: senal(false), stakeUsd: STAKE });

    expect(r?.sale).toBeUndefined();
    expect(r?.netUsd).toBe(r?.holdNetUsd);
  });

  it("con los dos disparadores apagados no vende nunca", () => {
    const r = replayFavoriteExit({
      sample: muestra([desplome(70)]),
      signal: senal(false),
      policy: { exitCertainty: CERTEZA_NUNCA, stopAsk: 0 },
      stakeUsd: STAKE,
    });

    expect(r?.sale).toBeUndefined();
  });

  // El post-only de los ultimos segundos: una venta taker ahi se rechazaria.
  it("nunca vende con menos de minSecondsToEnd por delante", () => {
    const r = replayFavoriteExit({ sample: muestra([desplome(30)]), signal: senal(false), policy: POLITICA, stakeUsd: STAKE });

    expect(r?.sale).toBeUndefined();
    expect(r?.netUsd).toBe(r?.holdNetUsd);
  });

  it("una cotizacion anterior a la entrada no provoca ninguna venta", () => {
    // El desplome esta a 120 s, ANTES de comprar a 100 s. No hay posicion que vender todavia.
    const r = replayFavoriteExit({ sample: muestra([desplome(120)]), signal: senal(false), policy: POLITICA, stakeUsd: STAKE });

    expect(r?.sale).toBeUndefined();
  });

  it("una venta parcial deja el resto dentro, y ese resto redime si el lado gana", () => {
    // 1,54 $ de profundidad a 0,28 son 5,5 participaciones de 5,88: un 93,5%, por encima del 90% minimo.
    const r = replayFavoriteExit({ sample: muestra([desplome(70, 1.54)]), signal: senal(true), policy: POLITICA, stakeUsd: STAKE });

    const vendidas = 1.54 / 0.28;
    const feeSalida = calculateTradeFeeUsd({ shares: vendidas, price: 0.28, feeRateBps: 700 });
    expect(r?.sale?.sharesSold).toBeCloseTo(vendidas, 8);
    expect(r?.netUsd).toBeCloseTo(1.54 - feeSalida + (SHARES - vendidas) - STAKE - FEE_ENTRADA, 8);
    // El lado GANABA: vender costo dinero. Es la salida MALA, la que se come lo que ahorran las buenas.
    expect(r!.netUsd).toBeLessThan(r!.holdNetUsd);
  });

  it("devuelve undefined si la muestra no contiene la cotizacion de entrada", () => {
    const sinEntrada: AnalyticsSample = { ...muestra([desplome(70)]), quotes: [desplome(70)] };

    expect(replayFavoriteExit({ sample: sinEntrada, signal: senal(false), policy: POLITICA, stakeUsd: STAKE })).toBeUndefined();
  });
});

describe("summarizeExitReplay", () => {
  it("cuenta las ventas que costaron dinero y el efecto total frente a aguantar", () => {
    const buena = replayFavoriteExit({ sample: muestra([desplome(70)]), signal: senal(false), policy: POLITICA, stakeUsd: STAKE })!;
    const mala = replayFavoriteExit({ sample: muestra([desplome(70)]), signal: senal(true), policy: POLITICA, stakeUsd: STAKE })!;
    const aguantada = replayFavoriteExit({ sample: muestra([desplome(30)]), signal: senal(true), policy: POLITICA, stakeUsd: STAKE })!;

    const resumen = summarizeExitReplay([buena, mala, aguantada]);

    expect(resumen.entradas).toBe(3);
    expect(resumen.ventas).toBe(2);
    expect(resumen.ventasQueGanaban).toBe(1);
    expect(resumen.deltaUsd).toBeCloseTo(buena.netUsd - buena.holdNetUsd + (mala.netUsd - mala.holdNetUsd), 8);
  });
});

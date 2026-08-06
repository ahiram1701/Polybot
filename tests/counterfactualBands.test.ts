import { describe, expect, it } from "vitest";

import {
  evaluateBandsCounterfactually,
  proposeBandsToProbe,
  type CounterfactualBand,
  type SignalSource,
} from "../src/counterfactualBands.js";
import { simulateGate, summarizeGateTrades, type HistoricalSignal, type SimulatedTrade } from "../src/gateSimulation.js";
import type { MarketSymbol, Outcome } from "../src/types.js";

const PARAMS = { safetyMargin: 0.03, minExpectedRoi: 0.01, stakeUsd: 5, feeRateBps: 700 };

function señal(ask: number, won: boolean, windowStartMs: number): HistoricalSignal {
  return { predicted: 0, won, ask, windowStartMs };
}

describe("simulateGate", () => {
  it("ignora las señales fuera de la ventana de ask evaluada", () => {
    const señales = Array.from({ length: 40 }, (_u, i) => señal(i % 2 === 0 ? 0.5 : 0.95, true, i * 1000));
    const dentro = simulateGate(señales, { ...PARAMS, minAsk: 0.4, maxAsk: 0.6 });
    expect(dentro.every((trade) => trade.ask === 0.5)).toBe(true);
  });

  it("no opera la primera señal: sin nada previo no hay probabilidad que estimar", () => {
    // Es la garantia de que no hay look-ahead. Con una sola señal no puede salir ninguna operacion.
    expect(simulateGate([señal(0.5, true, 1)], { ...PARAMS, minAsk: 0, maxAsk: 1 })).toHaveLength(0);
  });

  it("una racha ganadora barata acaba pasando el gate", () => {
    const señales = Array.from({ length: 60 }, (_u, i) => señal(0.5, true, i * 1000));
    expect(simulateGate(señales, { ...PARAMS, minAsk: 0, maxAsk: 1 }).length).toBeGreaterThan(0);
  });

  it("una racha PERDEDORA no pasa el gate por muchas señales que haya", () => {
    const señales = Array.from({ length: 60 }, (_u, i) => señal(0.5, false, i * 1000));
    expect(simulateGate(señales, { ...PARAMS, minAsk: 0, maxAsk: 1 })).toHaveLength(0);
  });
});

describe("summarizeGateTrades: la t distingue ventaja de suerte", () => {
  const trade = (netUsd: number): SimulatedTrade => ({
    ask: 0.9,
    won: netUsd > 0,
    adjusted: 0.95,
    netUsd,
    stakeUsd: 5,
    windowStartMs: 0,
  });

  it("resultados consistentes dan t alta", () => {
    const resumen = summarizeGateTrades([...Array.from({ length: 39 }, () => trade(0.5)), trade(0.4)]);
    expect(resumen.netPerTradeUsd).toBeGreaterThan(0.4);
    expect(resumen.tStat).toBeGreaterThan(10);
  });

  it("varianza cero es confianza MAXIMA, no un dato ausente", () => {
    // Devolver undefined aqui hacia que los filtros lo leyeran como 0 y rechazaran a un ganador
    // perfectamente consistente: justo al reves de lo que dice el dato.
    const resumen = summarizeGateTrades(Array.from({ length: 40 }, () => trade(0.5)));
    expect(resumen.tStat).toBe(Number.POSITIVE_INFINITY);
    const perdedor = summarizeGateTrades(Array.from({ length: 40 }, () => trade(-0.5)));
    expect(perdedor.tStat).toBe(Number.NEGATIVE_INFINITY);
  });

  /**
   * El caso que motivo añadir la t: en la zona de ask alto se acierta el 99% cobrando poco y se pierde
   * todo en las raras. El neto total puede salir positivo y aun asi ser indistinguible de la suerte.
   */
  it("muchas ganancias diminutas y pocas perdidas enormes dan t baja aunque el neto sea positivo", () => {
    const trades = [...Array.from({ length: 38 }, () => trade(0.3)), trade(-5), trade(-5)];
    const resumen = summarizeGateTrades(trades);
    expect(resumen.netUsd).toBeGreaterThan(0);
    expect(resumen.tStat!).toBeLessThan(1.5);
  });
});

/** Fuente falsa: permite probar el evaluador sin leer los 252 MB de analitica. */
function fuente(porMercado: Partial<Record<MarketSymbol, HistoricalSignal[]>>): SignalSource {
  return {
    async replaySignals(market: MarketSymbol, outcome: Outcome) {
      // Todas las señales se devuelven en UP para no duplicarlas al unir ambos lados.
      return outcome === "UP" ? (porMercado[market] ?? []) : [];
    },
  };
}

describe("evaluateBandsCounterfactually", () => {
  /**
   * EL requisito. El autoajuste solo veia trades ejecutados, y como el bot nunca opera fuera de su
   * ventana, una banda de fuera tenia n=0 y era invisible para siempre. Con el techo de BTC en 0,80 la
   * banda 0,85-0,92 valia +$15 y no habia forma de enterarse.
   */
  it("evalua una banda en la que NUNCA se ha operado", async () => {
    const señales = Array.from({ length: 80 }, (_u, i) => señal(0.88, true, i * 1000));
    const bandas = await evaluateBandsCounterfactually(
      fuente({ BTC: señales }),
      "BTC",
      { entryWindowSeconds: 34, minDistanceUsd: 49 },
      { safetyMargin: 0.03, minExpectedRoi: 0.01, stakeUsd: 5 },
    );
    const banda = bandas.find((b) => b.lo === 0.85 && b.hi === 0.9)!;
    expect(banda.overall.trades).toBeGreaterThan(0);
  });

  it("parte el historico en dos mitades con operaciones en ambas", async () => {
    const señales = Array.from({ length: 80 }, (_u, i) => señal(0.5, true, i * 1000));
    const bandas = await evaluateBandsCounterfactually(
      fuente({ ETH: señales }),
      "ETH",
      { entryWindowSeconds: 42, minDistanceUsd: 0.7 },
      { safetyMargin: 0.03, minExpectedRoi: 0.01, stakeUsd: 5 },
    );
    const conOperaciones = bandas.filter((b) => b.overall.trades > 0);
    expect(conOperaciones.length).toBeGreaterThan(0);
    for (const banda of conOperaciones) {
      expect(banda.inSample.trades + banda.outOfSample.trades).toBe(banda.overall.trades);
    }
  });
});

describe("proposeBandsToProbe", () => {
  function banda(overrides: Partial<CounterfactualBand> & { lo: number; hi: number }): CounterfactualBand {
    const vacio = { trades: 0, wins: 0, netUsd: 0, stakeUsd: 0 };
    return { overall: vacio, inSample: vacio, outOfSample: vacio, ...overrides };
  }
  const buena = (lo: number, hi: number) =>
    banda({
      lo,
      hi,
      inSample: { trades: 50, wins: 40, netUsd: 20, stakeUsd: 250, netPerTradeUsd: 0.4, tStat: 2 },
      outOfSample: { trades: 50, wins: 40, netUsd: 20, stakeUsd: 250, netPerTradeUsd: 0.4, tStat: 2 },
    });

  it("propone una banda de fuera que gana en ambas mitades con muestra y t suficientes", () => {
    expect(proposeBandsToProbe([buena(0.85, 0.9)], { floor: 0.7, cap: 0.8 })).toHaveLength(1);
  });

  it("NO propone una banda que ya esta dentro de la ventana: no hay nada que abrir", () => {
    expect(proposeBandsToProbe([buena(0.75, 0.8)], { floor: 0.7, cap: 0.8 })).toHaveLength(0);
  });

  /** Maldicion del ganador: se elige PORQUE gano, y fuera de muestra revierte. Ya costo $28,55. */
  it("NO propone una banda que solo gana en la primera mitad", () => {
    const soloDentro = banda({
      lo: 0.85,
      hi: 0.9,
      inSample: { trades: 50, wins: 45, netUsd: 40, stakeUsd: 250, netPerTradeUsd: 0.8, tStat: 3 },
      outOfSample: { trades: 50, wins: 20, netUsd: -12, stakeUsd: 250, netPerTradeUsd: -0.24, tStat: -1 },
    });
    expect(proposeBandsToProbe([soloDentro], { floor: 0.7, cap: 0.8 })).toHaveLength(0);
  });

  it("NO propone con t baja aunque el neto sea positivo: eso es suerte, no ventaja", () => {
    const ruidosa = banda({
      lo: 0.85,
      hi: 0.9,
      inSample: { trades: 50, wins: 40, netUsd: 20, stakeUsd: 250, netPerTradeUsd: 0.4, tStat: 2 },
      outOfSample: { trades: 50, wins: 40, netUsd: 20, stakeUsd: 250, netPerTradeUsd: 0.4, tStat: 0.6 },
    });
    expect(proposeBandsToProbe([ruidosa], { floor: 0.7, cap: 0.8 })).toHaveLength(0);
  });

  it("NO propone algo real pero trivial: sondear cuesta semanas", () => {
    const trivial = banda({
      lo: 0.94,
      hi: 0.97,
      inSample: { trades: 90, wins: 88, netUsd: 4, stakeUsd: 450, netPerTradeUsd: 0.044, tStat: 3 },
      outOfSample: { trades: 118, wins: 116, netUsd: 5.1, stakeUsd: 590, netPerTradeUsd: 0.043, tStat: 3 },
    });
    expect(proposeBandsToProbe([trivial], { floor: 0.7, cap: 0.85 })).toHaveLength(0);
  });

  it("NO propone sin muestra fuera de muestra suficiente", () => {
    const poca = banda({
      lo: 0.9,
      hi: 0.94,
      inSample: { trades: 23, wins: 20, netUsd: 8, stakeUsd: 115, netPerTradeUsd: 0.35, tStat: 2 },
      outOfSample: { trades: 12, wins: 10, netUsd: 4.9, stakeUsd: 60, netPerTradeUsd: 0.41, tStat: 2 },
    });
    expect(proposeBandsToProbe([poca], { floor: 0.7, cap: 0.85 })).toHaveLength(0);
  });
});

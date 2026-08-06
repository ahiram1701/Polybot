import { describe, expect, it } from "vitest";

import { startBandProgram, type BandProgram } from "../src/bandProbeProgram.js";
import { effectiveAskWindow, isProbeEntry, windowAfterConfirmedBand } from "../src/probeWindow.js";

const CONFIGURADA = { floor: 0.7, cap: 0.85 };

function enSondeo(lo: number, hi: number): BandProgram {
  return startBandProgram({
    market: "ETH",
    lo,
    hi,
    expectedNetPerTradeUsd: 0.3,
    outOfSampleTrades: 73,
    reason: "x",
    nowMs: 0,
  });
}

describe("effectiveAskWindow", () => {
  it("sin sondeo devuelve la ventana configurada tal cual", () => {
    expect(effectiveAskWindow(CONFIGURADA)).toEqual(CONFIGURADA);
  });

  /**
   * `getQuote` recibe el tope para calcular la profundidad disponible bajo el. Cotizar con el tope
   * viejo devolveria "sin liquidez" para justo los precios que se quieren sondear, y el sondeo no
   * ocurriria jamas. Por eso el ensanchado tiene que pasar por la cotizacion, no solo por el filtro.
   */
  it("ensancha el techo hasta cubrir la banda en sondeo", () => {
    expect(effectiveAskWindow(CONFIGURADA, enSondeo(0.85, 0.9))).toEqual({ floor: 0.7, cap: 0.9 });
  });

  it("ensancha el piso cuando la banda esta por debajo", () => {
    expect(effectiveAskWindow(CONFIGURADA, enSondeo(0.6, 0.7))).toEqual({ floor: 0.6, cap: 0.85 });
  });

  it("un programa ya decidido no ensancha nada", () => {
    const cerrado = { ...enSondeo(0.85, 0.9), status: "confirmed" as const };
    expect(effectiveAskWindow(CONFIGURADA, cerrado)).toEqual(CONFIGURADA);
  });
});

describe("isProbeEntry", () => {
  it("una entrada dentro de la ventana normal NO gasta presupuesto de sondeo", () => {
    expect(isProbeEntry(0.8, CONFIGURADA, enSondeo(0.85, 0.9))).toBe(false);
  });

  it("una entrada que solo cabe por el sondeo SI lo gasta", () => {
    expect(isProbeEntry(0.87, CONFIGURADA, enSondeo(0.85, 0.9))).toBe(true);
  });

  it("fuera de la banda y fuera de la ventana no es sondeo: no deberia haber llegado ahi", () => {
    expect(isProbeEntry(0.97, CONFIGURADA, enSondeo(0.85, 0.9))).toBe(false);
  });

  it("sin sondeo en curso nada es sondeo", () => {
    expect(isProbeEntry(0.87, CONFIGURADA)).toBe(false);
  });
});

describe("windowAfterConfirmedBand", () => {
  it("abre UN PASO, no la banda entera", () => {
    // Moverse despacio deja margen para revertir antes de que un error salga caro.
    expect(windowAfterConfirmedBand(CONFIGURADA, enSondeo(0.85, 0.95), 0.05)).toEqual({ floor: 0.7, cap: 0.9 });
  });

  it("no se pasa de la banda confirmada si el paso es mayor que lo que falta", () => {
    expect(windowAfterConfirmedBand(CONFIGURADA, enSondeo(0.85, 0.87), 0.05)).toEqual({ floor: 0.7, cap: 0.87 });
  });

  it("baja el piso un paso cuando la banda esta por debajo", () => {
    expect(windowAfterConfirmedBand(CONFIGURADA, enSondeo(0.5, 0.7), 0.05)).toEqual({ floor: 0.65, cap: 0.85 });
  });

  it("una banda ya contenida no mueve la ventana", () => {
    expect(windowAfterConfirmedBand(CONFIGURADA, enSondeo(0.75, 0.8), 0.05)).toEqual(CONFIGURADA);
  });
});

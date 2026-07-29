import { describe, expect, it } from "vitest";

import type { AskBandRow, AskBandSummary } from "../src/askBands.js";
import { recommendAskCap, recommendAskWindow } from "../src/askCapTuner.js";

function band(lo: number, hi: number, trades: number, winRate: number, netUsd?: number): AskBandRow {
  const breakEvenRate = (lo + hi) / 2; // Break-even = ask medio de la banda: usa el punto medio.
  return {
    lo,
    hi,
    trades,
    wins: Math.round(trades * winRate),
    winRate,
    breakEvenRate,
    // Por defecto el dinero es COHERENTE con el edge (batir el break-even => gano). Pasa `netUsd`
    // explicito para el caso interesante: una banda que gana en win% pero pierde dinero.
    netUsd: netUsd ?? trades * (winRate - breakEvenRate) * 10,
  };
}

function summary(bands: AskBandRow[]): AskBandSummary {
  return { mode: "live", totalTrades: bands.reduce((sum, row) => sum + row.trades, 0), bands };
}

describe("askCapTuner", () => {
  it("returns nothing without enough total trades", () => {
    expect(recommendAskCap(summary([band(0.45, 0.55, 30, 0.8)]), 0.65)).toBeUndefined();
  });

  it("extends the cap while sampled bands beat break-even and stops at the first that does not", () => {
    const bands = summary([
      band(0, 0.45, 25, 0.4), // be 0.225, edge +17pp -> paga
      band(0.45, 0.55, 30, 0.62), // be 0.5, edge +12pp -> paga
      band(0.55, 0.65, 30, 0.65), // be 0.6, edge +5pp -> paga
      band(0.65, 0.7, 25, 0.6), // be 0.675, edge -7pp -> CORTA aqui
      band(0.7, 0.75, 25, 0.9), // rentable pero inalcanzable tras el corte
    ]);
    const reco = recommendAskCap(bands, 0.55);
    expect(reco?.targetCap).toBe(0.65);
    expect(reco?.nextCap).toBe(0.6); // paso maximo 0.05 por aplicacion
  });

  it("ignores thin bands (no evidence) without breaking the chain", () => {
    const bands = summary([
      band(0.45, 0.55, 40, 0.62),
      band(0.55, 0.65, 5, 0.1), // n<20: ni extiende ni corta
      band(0.65, 0.7, 40, 0.75), // be 0.675, edge +7.5pp -> extiende
    ]);
    const reco = recommendAskCap(bands, 0.55);
    expect(reco?.targetCap).toBe(0.7);
  });

  it("lowers the cap when nothing above the floor pays, one step at a time", () => {
    const bands = summary([band(0.45, 0.55, 40, 0.45), band(0.55, 0.65, 40, 0.5)]); // ambas pierden
    const reco = recommendAskCap(bands, 0.65);
    expect(reco?.targetCap).toBe(0.45); // piso
    expect(reco?.nextCap).toBe(0.6); // baja de a 0.05
  });

  it("clamps the target to the ceiling and reports no-op when already there", () => {
    const bands = summary([
      band(0.45, 0.55, 40, 0.7),
      band(0.55, 0.65, 40, 0.75),
      band(0.65, 0.7, 40, 0.78),
      band(0.7, 0.75, 40, 0.82),
      band(0.75, 0.8, 40, 0.85),
      band(0.8, 1, 40, 0.99),
    ]);
    const reco = recommendAskCap(bands, 0.85);
    expect(reco).toBeUndefined(); // target = techo 0.85 = actual -> nada que hacer
  });
});

describe("recommendAskWindow (piso + techo)", () => {
  it("sube el piso cuando la cola barata pierde y deja el techo ancho", () => {
    // Esto es justo lo que el tuner de solo-techo no podia expresar (y por eso perdio en replay).
    const bands = summary([
      band(0, 0.45, 30, 0.1), // be 0.225 -> pierde: queda FUERA
      band(0.45, 0.55, 30, 0.62), // paga: abre la ventana
      band(0.55, 0.65, 30, 0.68), // paga: extiende
      band(0.65, 0.7, 25, 0.6), // be 0.675 -> corta aqui
    ]);
    const reco = recommendAskWindow(bands, { floor: 0.01, cap: 0.65 });
    expect(reco?.targetFloor).toBe(0.45);
    expect(reco?.targetCap).toBe(0.65);
    expect(reco?.nextFloor).toBe(0.06); // paso maximo 0.05 por borde
    expect(reco?.nextCap).toBe(0.65);
  });

  it("baja el techo cuando la cola cara pierde", () => {
    const bands = summary([
      band(0.3, 0.45, 30, 0.5), // be 0.375 -> paga
      band(0.45, 0.55, 30, 0.6), // paga
      band(0.55, 0.65, 30, 0.55), // be 0.6 -> pierde: corta
    ]);
    const reco = recommendAskWindow(bands, { floor: 0.3, cap: 0.8 });
    expect(reco?.targetCap).toBe(0.55);
    expect(reco?.nextCap).toBe(0.75); // baja de a 0.05
  });

  it("rechaza ventanas demasiado estrechas (anti auto-estrangulamiento)", () => {
    const bands = summary([
      band(0, 0.45, 40, 0.1),
      band(0.45, 0.55, 40, 0.62), // unica banda que paga -> ancho 0.10 < 0.15
      band(0.55, 0.65, 40, 0.4),
    ]);
    expect(recommendAskWindow(bands, { floor: 0.01, cap: 0.8 })).toBeUndefined();
  });

  it("no recomienda sin muestra suficiente ni cuando ninguna banda paga", () => {
    expect(recommendAskWindow(summary([band(0.45, 0.55, 20, 0.9)]), { floor: 0.3, cap: 0.55 })).toBeUndefined();
    const losing = summary([band(0.3, 0.55, 40, 0.2), band(0.55, 0.8, 40, 0.3)]);
    expect(recommendAskWindow(losing, { floor: 0.3, cap: 0.8 })).toBeUndefined();
  });

  it("no abre el piso hacia una banda barata que PERDIO DINERO aunque gane en win%", () => {
    // El caso real de ETH: la banda barata mezclaba una zona rentable con un pozo (19% de aciertos
    // contra 42.5% de break-even) y el agregado pasaba el filtro de win-rate mientras sangraba. El
    // tuner bajaba el piso ahi una y otra vez. El dinero realizado manda sobre el win% agregado.
    const bands = summary([
      band(0, 0.45, 30, 0.28, -56), // +5.5pp sobre break-even 0.225 PERO -$56 realizados
      band(0.45, 0.55, 30, 0.62), // paga de verdad: aqui debe abrir
      band(0.55, 0.65, 30, 0.68),
    ]);
    const reco = recommendAskWindow(bands, { floor: 0.45, cap: 0.65 });
    // Sin candado el piso objetivo habria sido 0 (clamp 0.20); con candado se queda en la banda sana.
    expect(reco?.targetFloor ?? 0.45).toBe(0.45);
  });
});

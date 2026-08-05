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

describe("recommendAskWindow: contencion de bandas", () => {
  it("no achaca al tramo de dentro las perdidas de la parte ya excluida", () => {
    // El fallo que costaba dinero: con el suelo en 0.40, la banda [0,0.45] perdia mucho, pero el 89%
    // de esa banda queda FUERA de la ventana. Recortar por ella subia el suelo a 0.45 y tiraba un
    // tramo que fuera de muestra era rentable (-$18.31 medido).
    const bands = summary([
      band(0, 0.45, 71, 0.1), // pierde, pero casi toda por debajo del suelo actual
      band(0.45, 0.55, 60, 0.62),
      band(0.55, 0.65, 60, 0.68),
    ]);
    expect(recommendAskWindow(bands, { floor: 0.4, cap: 0.65 })).toBeUndefined();
  });

  it("si la banda perdedora SI cabe dentro de la ventana, recorta", () => {
    const bands = summary([
      band(0.45, 0.55, 40, 0.2), // dentro de [0.45,0.75] y perdiendo -> fuera
      band(0.55, 0.65, 40, 0.68),
      band(0.65, 0.75, 40, 0.78),
    ]);
    // La ventana debe quedar en [0.55,0.75]: 0.20 de ancho, por encima del minimo anti-estrangulamiento.
    const reco = recommendAskWindow(bands, { floor: 0.45, cap: 0.75 });
    expect(reco?.targetFloor).toBe(0.55);
    expect(reco?.targetCap).toBe(0.75);
  });
});

describe("recommendAskWindow: no es un trinquete", () => {
  it("devuelve la ventana a su base cuando la evidencia del recorte desaparece", () => {
    // La ventana venia recortada a [0.55,0.75] por una mala racha. Ahora ninguna banda pierde con
    // muestra suficiente, asi que el recorte ya no se sostiene y debe deshacerse hacia la base.
    const bands = summary([
      band(0.45, 0.55, 40, 0.62),
      band(0.55, 0.65, 40, 0.68),
      band(0.65, 0.75, 40, 0.78),
    ]);
    const reco = recommendAskWindow(bands, { floor: 0.55, cap: 0.75 }, { floor: 0.45, cap: 0.75 });
    expect(reco?.targetFloor).toBe(0.45); // vuelve a la base
    expect(reco?.nextFloor).toBe(0.5); // de a 0.05, sin saltos
  });

  it("no reabre MAS ALLA de la base aunque todas las bandas paguen", () => {
    const bands = summary([
      band(0.3, 0.45, 40, 0.6),
      band(0.45, 0.55, 40, 0.62),
      band(0.55, 0.65, 40, 0.68),
    ]);
    // Base [0.45,0.65]: la banda barata paga, pero el tuner no puede invadir territorio no aprobado.
    const reco = recommendAskWindow(bands, { floor: 0.45, cap: 0.65 }, { floor: 0.45, cap: 0.65 });
    expect(reco).toBeUndefined();
  });

  it("un recorte repetido no se acumula: siempre se mide contra la base", () => {
    const bands = summary([
      band(0.45, 0.55, 40, 0.2), // pierde
      band(0.55, 0.65, 40, 0.68),
      band(0.65, 0.75, 40, 0.78),
    ]);
    const baseline = { floor: 0.45, cap: 0.75 };
    const first = recommendAskWindow(bands, baseline, baseline);
    const second = recommendAskWindow(bands, { floor: first!.targetFloor, cap: first!.targetCap }, baseline);
    // El objetivo no se mueve por haberlo aplicado ya: el recorte es el mismo, no uno encima de otro.
    expect(second?.targetFloor ?? first!.targetFloor).toBe(first!.targetFloor);
  });
});

/**
 * La estrategia se movio a la banda cara ([0.85, 0.95]) porque la comision es maxima en 0.50. Los
 * candados del tuner estaban calibrados para una ventana centrada y lo apagaban por completo ahi.
 */
describe("recommendAskWindow: ventana estrecha en la banda cara", () => {
  const caras = summary([
    band(0.85, 0.9, 40, 0.5, -30), // pierde dinero de verdad
    band(0.9, 0.94, 80, 0.97, 25),
    band(0.94, 0.97, 80, 0.99, 10),
  ]);

  it("recorta dentro de una ventana de solo 0.10 de ancho", () => {
    const reco = recommendAskWindow(caras, { floor: 0.85, cap: 0.95 });
    expect(reco?.targetFloor).toBe(0.9);
    expect(reco?.targetCap).toBe(0.95);
  });

  it("no baja el techo por debajo de la ventana aprobada", () => {
    // Con WINDOW_MAX en 0.85 el techo se recortaba a 0.85 y se comia la franja rentable entera.
    const reco = recommendAskWindow(caras, { floor: 0.85, cap: 0.95 });
    expect(reco?.targetCap).toBeGreaterThan(0.85);
  });

  it("sigue negandose a estrangular la ventana aunque sea estrecha", () => {
    // Todas las bandas de dentro pierden: el recorte dejaria una ventana practicamente nula.
    const todasPierden = summary([
      band(0.85, 0.9, 40, 0.1, -30),
      band(0.9, 0.94, 40, 0.1, -30),
    ]);
    expect(recommendAskWindow(todasPierden, { floor: 0.85, cap: 0.94 })).toBeUndefined();
  });

  it("no se anula por el redondeo binario de los precios", () => {
    // 0.95 - 0.90 da 0.049999999999999934 en coma flotante: comparado crudo contra un minimo de 0.05
    // la recomendacion se perdia por un error de representacion, no por politica.
    expect(recommendAskWindow(caras, { floor: 0.85, cap: 0.95 })).toBeDefined();
  });
});

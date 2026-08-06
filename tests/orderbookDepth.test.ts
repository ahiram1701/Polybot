import { describe, expect, it } from "vitest";

import { averageFillPrice, DEPTH_PROBE_USD } from "../src/orderbookService.js";

/**
 * Cierra el agujero que documenta `realizedGuard.ts` y que ya costo dinero el 2026-08-05: la analitica
 * solo guardaba el MEJOR precio, asi que un backtest sobre ella asumia relleno perfecto y gratis. Cerca
 * del cierre el libro se adelgaza y el precio cotizado no es el que se consigue — el simulador salia
 * mas optimista justo donde la realidad es peor, y empujaba la ventana hacia ahi.
 */
describe("averageFillPrice", () => {
  it("con profundidad de sobra en el mejor nivel, paga el mejor precio", () => {
    expect(averageFillPrice([{ price: 0.5, size: 1000 }], 5)).toBeCloseTo(0.5, 6);
  });

  it("baja por el libro y el precio medio sale PEOR que el mejor", () => {
    // $2 al mejor precio y el resto mas caro: exactamente el caso que el mejor-precio esconde.
    const media = averageFillPrice(
      [
        { price: 0.5, size: 4 },
        { price: 0.6, size: 100 },
      ],
      5,
    )!;
    expect(media).toBeGreaterThan(0.5);
    // 4 acciones a 0.50 = $2; quedan $3 a 0.60 = 5 acciones. Total 9 acciones por $5.
    expect(media).toBeCloseTo(5 / 9, 6);
  });

  it("devuelve undefined si el libro no da para el tamaño: media compra no responde la pregunta", () => {
    // Leer un precio medio sobre un relleno parcial es justo como se cuela un backtest optimista.
    expect(averageFillPrice([{ price: 0.5, size: 2 }], 5)).toBeUndefined();
  });

  it("libro vacio es undefined, no cero", () => {
    expect(averageFillPrice([], 5)).toBeUndefined();
  });

  it("ignora niveles con precio o tamaño no positivos en vez de romperse", () => {
    const media = averageFillPrice(
      [
        { price: 0, size: 100 },
        { price: -1, size: 100 },
        { price: 0.5, size: 0 },
        { price: 0.5, size: 1000 },
      ],
      5,
    );
    expect(media).toBeCloseTo(0.5, 6);
  });

  it("el tamaño de referencia es una constante, no el tamaño de operacion", () => {
    // Si dependiera de un ajuste que el usuario cambia, las muestras viejas y nuevas medirian cosas
    // distintas y el historico dejaria de ser comparable consigo mismo.
    expect(DEPTH_PROBE_USD).toBe(5);
  });
});

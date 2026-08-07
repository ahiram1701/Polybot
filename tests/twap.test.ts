import { describe, expect, it } from "vitest";

import { priceNeededToFlip, timeWeightedAveragePrice, windowTwap } from "../src/twap.js";
import type { AnalyticsTickPoint } from "../src/types.js";

const T0 = Date.UTC(2026, 7, 7, 0, 0, 0);

function tick(offsetSeconds: number, price: number): AnalyticsTickPoint {
  return {
    timestampMs: T0 + offsetSeconds * 1000,
    secondsToEnd: 300 - offsetSeconds,
    price,
    distanceUsd: 0,
  };
}

describe("timeWeightedAveragePrice", () => {
  /**
   * El punto entero de la funcion. Los ticks no llegan a intervalos regulares —el feed tiene huecos y
   * la parte temprana de la ventana se submuestrea— asi que una media aritmetica daria el mismo peso a
   * un tick que representa 1 segundo que a otro que representa 15. Eso no es el TWAP.
   */
  it("pondera por TIEMPO, no por numero de ticks", () => {
    // 100 durante 10s, luego 200 durante 1s. La media aritmetica de los 3 puntos daria ~133.
    const twap = timeWeightedAveragePrice([
      { timestampMs: 0, price: 100 },
      { timestampMs: 10_000, price: 100 },
      { timestampMs: 11_000, price: 200 },
    ])!;
    expect(twap).toBeLessThan(120);
    // Trapecios: (100*10s) + (150*1s) = 1150 sobre 11s
    expect(twap).toBeCloseTo(1150 / 11, 6);
  });

  it("un precio constante da ese precio", () => {
    expect(timeWeightedAveragePrice([
      { timestampMs: 0, price: 64_000 },
      { timestampMs: 300_000, price: 64_000 },
    ])).toBeCloseTo(64_000, 6);
  });

  it("sin ticks devuelve undefined, NO cero", () => {
    // Inventar un precio aqui es como se cuelan los ceros que luego parecen caidas del 100%.
    expect(timeWeightedAveragePrice([])).toBeUndefined();
  });

  it("un solo tick devuelve su precio: es lo mejor disponible", () => {
    expect(timeWeightedAveragePrice([{ timestampMs: 5, price: 42 }])).toBe(42);
  });

  it("ordena por tiempo aunque lleguen desordenados", () => {
    const desordenado = timeWeightedAveragePrice([
      { timestampMs: 10_000, price: 100 },
      { timestampMs: 0, price: 200 },
    ]);
    expect(desordenado).toBeCloseTo(150, 6);
  });

  it("ignora marcas de tiempo repetidas en vez de dividir por cero", () => {
    expect(timeWeightedAveragePrice([
      { timestampMs: 1_000, price: 10 },
      { timestampMs: 1_000, price: 20 },
    ])).toBe(10);
  });
});

describe("windowTwap", () => {
  it("informa de la COBERTURA junto al numero", () => {
    // Solo el ultimo tercio, que es como se grababa antes del 2026-08-07: el TWAP resultante describe
    // ese tramo, no la ventana. Devolverlo sin decirlo seria vender una extrapolacion como medida.
    const parcial = windowTwap([tick(200, 100), tick(300, 110)], T0, T0 + 300_000)!;
    expect(parcial.coverage).toBeCloseTo(1 / 3, 2);

    const completo = windowTwap([tick(0, 100), tick(150, 105), tick(300, 110)], T0, T0 + 300_000)!;
    expect(completo.coverage).toBeCloseTo(1, 2);
  });

  it("descarta ticks fuera de la ventana", () => {
    const resultado = windowTwap([tick(-50, 999), tick(0, 100), tick(300, 100)], T0, T0 + 300_000)!;
    expect(resultado.twap).toBeCloseTo(100, 6);
  });

  it("sin ticks dentro devuelve undefined", () => {
    expect(windowTwap([tick(-50, 100)], T0, T0 + 300_000)).toBeUndefined();
  });
});

describe("priceNeededToFlip", () => {
  /**
   * El numero que convierte la regla nueva en oportunidad: a 40s del cierre ya ha transcurrido el 87%
   * del promedio, asi que voltear el resultado exige un movimiento enorme en lo que queda.
   */
  it("exige un movimiento mucho mayor cuanto menos tiempo queda", () => {
    const necesario = priceNeededToFlip({
      twapSoFar: 100.1,
      openingPrice: 100,
      elapsedMs: 260_000,
      remainingMs: 40_000,
    })!;
    // El TWAP va 0.1 por encima; con solo 40s de 300 hay que bajar 6.5x esa distancia.
    expect(necesario).toBeCloseTo(100 - 0.1 * (260 / 40), 6);
    expect(necesario).toBeLessThan(99.4);
  });

  it("con la ventana recien empezada basta un movimiento pequeño", () => {
    const pronto = priceNeededToFlip({ twapSoFar: 100.1, openingPrice: 100, elapsedMs: 30_000, remainingMs: 270_000 })!;
    expect(pronto).toBeGreaterThan(99.9);
  });

  it("sin tiempo restante no hay nada que voltear", () => {
    expect(priceNeededToFlip({ twapSoFar: 100.1, openingPrice: 100, elapsedMs: 300_000, remainingMs: 0 })).toBeUndefined();
  });
});

import { describe, expect, it } from "vitest";

import { priceNeededToFlip, timeWeightedAveragePrice, twapVerdict, windowTwap } from "../src/twap.js";
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

/**
 * La consecuencia util del cambio a TWAP. Al entrar ya ha transcurrido la mayor parte del promedio,
 * asi que el resultado suele estar decidido — y ahora se puede CALCULAR en vez de estimarlo con
 * momentum, que nunca paso de t≈1,5.
 *
 * Se usa SOLO para vetar. Es la misma asimetria que rige el resto del sistema: descartar con evidencia
 * fuerte es barato; abrir con evidencia debil es como se pierde dinero.
 */
describe("twapVerdict", () => {
  const windowStartMs = T0;
  const endMs = T0 + 300_000;

  function serie(precios: Array<[number, number]>): AnalyticsTickPoint[] {
    return precios.map(([seg, price]) => ({
      timestampMs: windowStartMs + seg * 1000,
      secondsToEnd: 300 - seg,
      price,
      distanceUsd: 0,
    }));
  }

  const base = {
    market: "BTC",
    openingPrice: 100,
    windowStartMs,
    endMs,
    nowMs: windowStartMs + 260_000,
    minCoverage: 0.8,
  };

  it("declara decidida una ventana que exige un movimiento imposible", () => {
    // TWAP claramente por encima de la apertura con 40s por delante: voltearlo exigiria sostener un
    // precio muchisimo mas abajo, mas de lo que BTC se mueve en ese tiempo.
    const ticks = serie(Array.from({ length: 27 }, (_u, i) => [i * 10, 100.5] as [number, number]));
    const v = twapVerdict({ ...base, ticks })!;
    expect(v.leader).toBe("UP");
    expect(v.decided).toBe(true);
    expect(v.requiredMoveBps).toBeGreaterThan(v.plausibleMoveBps);
  });

  it("NO la declara decidida cuando el TWAP roza la apertura", () => {
    // A un par de bps: un movimiento normal todavia puede voltearlo, asi que vetar seria pasarse.
    const ticks = serie(Array.from({ length: 27 }, (_u, i) => [i * 10, 100.002] as [number, number]));
    const v = twapVerdict({ ...base, ticks })!;
    expect(v.decided).toBe(false);
  });

  it("a media ventana NO opina, aunque el TWAP este lejos de la apertura", () => {
    // El umbral sale de medir movimientos a 40s. Estirarlo a 270s seria hacerlo trabajar casi 7 veces
    // mas alla de donde hay datos, y con eso el veto declararia "decidido" a media ventana apoyandose
    // en una extrapolacion. Callar lejos del cierre es distinto de afirmar que no esta decidido.
    const ticks = serie(Array.from({ length: 7 }, (_u, i) => [i * 5, 100.5] as [number, number]));
    const v = twapVerdict({ ...base, ticks, nowMs: windowStartMs + 30_000 })!;
    expect(v.decided).toBe(false);
    // El numero se sigue calculando: sirve como feature aunque no se use para vetar.
    expect(v.requiredMoveBps).toBeGreaterThan(0);
  });

  it("sin cobertura suficiente NO opina", () => {
    // Un TWAP sobre medio rango no es el TWAP del rango; actuar sobre el seria peor que no mirarlo,
    // porque parece un dato.
    const soloElFinal = serie([[250, 100.5], [260, 100.5]]);
    expect(twapVerdict({ ...base, ticks: soloElFinal })).toBeUndefined();
  });

  it("el umbral depende del mercado: DOGE se mueve mas que BTC", () => {
    const ticks = serie(Array.from({ length: 27 }, (_u, i) => [i * 10, 100.5] as [number, number]));
    const btc = twapVerdict({ ...base, ticks })!;
    const doge = twapVerdict({ ...base, market: "DOGE", ticks })!;
    expect(doge.plausibleMoveBps).toBeGreaterThan(btc.plausibleMoveBps);
  });

  it("un mercado desconocido no revienta: usa un umbral por defecto", () => {
    const ticks = serie(Array.from({ length: 27 }, (_u, i) => [i * 10, 100.5] as [number, number]));
    expect(twapVerdict({ ...base, market: "XYZ", ticks })?.plausibleMoveBps).toBeGreaterThan(0);
  });
});

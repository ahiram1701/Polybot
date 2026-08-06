import { beforeEach, describe, expect, it } from "vitest";

import {
  getBtcUpDownSlugFromStartMs,
  getCurrentBtcUpDownSlug,
  getCurrentUpDownSlug,
  getUpDownSlugFromStartMs,
  getWindowEndMs,
  getWindowStartMs,
  getWindowStartMsFromSlug,
  dailySpendKey,
  localDayRange,
  resetLocalDayRangeCache,
} from "../src/time.js";

describe("BTC 5m window helpers", () => {
  it("rounds timestamps down to the active five-minute window", () => {
    const insideWindow = Date.UTC(2026, 4, 7, 4, 27, 12, 345);
    const start = Date.UTC(2026, 4, 7, 4, 25, 0, 0);

    expect(getWindowStartMs(insideWindow)).toBe(start);
    expect(getWindowEndMs(insideWindow)).toBe(start + 5 * 60 * 1000);
  });

  it("builds and parses Polymarket BTC 5m slugs", () => {
    const start = Date.UTC(2026, 4, 7, 4, 25, 0, 0);
    const slug = "btc-updown-5m-1778127900";

    expect(getBtcUpDownSlugFromStartMs(start)).toBe(slug);
    expect(getCurrentBtcUpDownSlug(start + 42_000)).toBe(slug);
    expect(getWindowStartMsFromSlug(slug)).toBe(start);
  });

  it("builds DOGE and ETH 5m slugs with Polymarket prefixes", () => {
    const start = Date.UTC(2026, 4, 7, 4, 25, 0, 0);

    expect(getUpDownSlugFromStartMs("DOGE", start)).toBe("doge-updown-5m-1778127900");
    expect(getUpDownSlugFromStartMs("ETH", start)).toBe("eth-updown-5m-1778127900");
    expect(getCurrentUpDownSlug("DOGE", start + 42_000)).toBe("doge-updown-5m-1778127900");
    expect(getWindowStartMsFromSlug("eth-updown-5m-1778127900")).toBe(start);
  });
});

/**
 * El cortacircuitos de riesgo formateaba la fecha de CADA trade para compararla con la de hoy. Con
 * zona horaria eso cuesta ~0,32 ms por llamada, asi que con 1.323 trades salian 164,7 ms por iteracion
 * del bucle: el 16% de cada segundo, creciendo con el historial. Medido tras el cambio: 0,96 ms.
 *
 * El rango se busca por biseccion en vez de calcularlo con aritmetica de husos, porque la aritmetica
 * se rompe justo en los casos de abajo.
 */
describe("localDayRange", () => {
  beforeEach(() => {
    resetLocalDayRangeCache();
  });

  it("el rango contiene el instante consultado y dura menos de 26h", () => {
    const ahora = Date.UTC(2026, 7, 6, 18, 0, 0);
    const rango = localDayRange(ahora, "America/Mexico_City");
    expect(rango.startMs).toBeLessThanOrEqual(ahora);
    expect(rango.endMs).toBeGreaterThan(ahora);
    expect(rango.endMs - rango.startMs).toBeLessThanOrEqual(26 * 3_600_000);
  });

  it("coincide EXACTAMENTE con la clave de dia en los bordes", () => {
    const ahora = Date.UTC(2026, 7, 6, 18, 0, 0);
    const tz = "America/Mexico_City";
    const rango = localDayRange(ahora, tz);
    // El primer ms dentro ya es hoy; el anterior, ayer. Sin esto el rango podria estar desplazado.
    expect(dailySpendKey(rango.startMs, tz)).toBe(rango.key);
    expect(dailySpendKey(rango.startMs - 1, tz)).not.toBe(rango.key);
    expect(dailySpendKey(rango.endMs, tz)).not.toBe(rango.key);
    expect(dailySpendKey(rango.endMs - 1, tz)).toBe(rango.key);
  });

  it("acierta en zonas con desfase de media hora y de 45 minutos", () => {
    // Aqui la medianoche local NO cae en una hora UTC entera: la aritmetica por horas falla.
    for (const tz of ["Asia/Kolkata", "Asia/Kathmandu", "Pacific/Chatham"]) {
      resetLocalDayRangeCache();
      const ahora = Date.UTC(2026, 7, 6, 12, 0, 0);
      const rango = localDayRange(ahora, tz);
      expect(dailySpendKey(rango.startMs, tz)).toBe(rango.key);
      expect(dailySpendKey(rango.startMs - 1, tz)).not.toBe(rango.key);
      expect(dailySpendKey(rango.endMs - 1, tz)).toBe(rango.key);
    }
  });

  it("acierta el dia del cambio de hora, que dura 23h o 25h", () => {
    // 2026-03-29: la UE adelanta el reloj. Ese dia local dura 23 horas.
    resetLocalDayRangeCache();
    const tz = "Europe/Madrid";
    const rango = localDayRange(Date.UTC(2026, 2, 29, 12, 0, 0), tz);
    expect(rango.endMs - rango.startMs).toBe(23 * 3_600_000);
    expect(dailySpendKey(rango.startMs, tz)).toBe(rango.key);
    expect(dailySpendKey(rango.endMs - 1, tz)).toBe(rango.key);
  });

  it("sin zona horaria mantiene el corte UTC de siempre", () => {
    const rango = localDayRange(Date.UTC(2026, 7, 6, 18, 0, 0));
    expect(rango.startMs).toBe(Date.UTC(2026, 7, 6, 0, 0, 0));
    expect(rango.endMs).toBe(Date.UTC(2026, 7, 7, 0, 0, 0));
  });

  it("el cache se invalida al salir del dia, no devuelve el de ayer", () => {
    const tz = "America/Mexico_City";
    const primero = localDayRange(Date.UTC(2026, 7, 6, 18, 0, 0), tz);
    const siguiente = localDayRange(primero.endMs + 1_000, tz);
    expect(siguiente.key).not.toBe(primero.key);
    expect(siguiente.startMs).toBe(primero.endMs);
  });

  it("el cache se invalida al cambiar de zona horaria", () => {
    const ahora = Date.UTC(2026, 7, 6, 18, 0, 0);
    const mexico = localDayRange(ahora, "America/Mexico_City");
    const tokio = localDayRange(ahora, "Asia/Tokyo");
    expect(tokio.startMs).not.toBe(mexico.startMs);
  });
});

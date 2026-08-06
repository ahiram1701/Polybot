import { describe, expect, it } from "vitest";

import { AskWindowDeadlockDetector, DEADLOCK_STREAK, describeDeadlock } from "../src/askWindowDeadlock.js";

/**
 * Paso de verdad: el autoajuste predictivo subio la distancia de BTC a 49 USD — lo que empuja el lado
 * del momentum a costar 0.96+ — mientras el de ask bajaba el techo a 0.80. Cada cambio era defendible
 * por separado; juntos hacian imposible operar BTC, y el 100% de sus señales murio en
 * `no_ask_liquidity_under_cap` durante horas sin que nada lo detectara.
 */
describe("AskWindowDeadlockDetector", () => {
  it("no avisa mientras la racha sea corta: rechazar por precio es normal", () => {
    const detector = new AskWindowDeadlockDetector();
    for (let i = 0; i < DEADLOCK_STREAK - 1; i += 1) {
      detector.recordRejected("BTC", 0.97);
    }
    expect(detector.takeDeadlock("BTC", 0.7, 0.8)).toBeUndefined();
  });

  it("avisa al cruzar la racha, con el rango de precios observado", () => {
    const detector = new AskWindowDeadlockDetector();
    for (let i = 0; i < DEADLOCK_STREAK; i += 1) {
      detector.recordRejected("BTC", 0.94 + i * 0.001);
    }
    const deadlock = detector.takeDeadlock("BTC", 0.7, 0.8);
    expect(deadlock?.market).toBe("BTC");
    expect(deadlock?.rejected).toBe(DEADLOCK_STREAK);
    expect(deadlock?.observedMinAsk).toBeCloseTo(0.94, 2);
    expect(deadlock?.observedMaxAsk).toBeGreaterThan(0.94);
  });

  it("avisa UNA vez, no en cada iteracion", () => {
    const detector = new AskWindowDeadlockDetector();
    for (let i = 0; i < DEADLOCK_STREAK + 10; i += 1) {
      detector.recordRejected("BTC", 0.97);
    }
    expect(detector.takeDeadlock("BTC", 0.7, 0.8)).toBeDefined();
    expect(detector.takeDeadlock("BTC", 0.7, 0.8)).toBeUndefined();
  });

  it("una sola entrada aceptada reinicia la racha: la ventana funciona", () => {
    const detector = new AskWindowDeadlockDetector();
    for (let i = 0; i < DEADLOCK_STREAK - 1; i += 1) {
      detector.recordRejected("BTC", 0.97);
    }
    detector.recordAccepted("BTC");
    detector.recordRejected("BTC", 0.97);
    expect(detector.takeDeadlock("BTC", 0.7, 0.8)).toBeUndefined();
  });

  it("cuenta por mercado: BTC bloqueado no implica ETH bloqueado", () => {
    const detector = new AskWindowDeadlockDetector();
    for (let i = 0; i < DEADLOCK_STREAK; i += 1) {
      detector.recordRejected("BTC", 0.97);
    }
    expect(detector.takeDeadlock("BTC", 0.7, 0.8)).toBeDefined();
    expect(detector.takeDeadlock("ETH", 0.7, 0.8)).toBeUndefined();
  });

  it("el mensaje dice el rango observado y la ventana, que es lo accionable", () => {
    const texto = describeDeadlock({
      market: "BTC",
      rejected: 40,
      observedMinAsk: 0.94,
      observedMaxAsk: 0.99,
      floor: 0.7,
      cap: 0.8,
    });
    expect(texto).toContain("BTC");
    expect(texto).toContain("0.94");
    expect(texto).toContain("0.99");
    expect(texto).toContain("[0.70, 0.80]");
  });

  it("sin precio observado (nunca hubo liquidez) el aviso lo dice en vez de inventar un rango", () => {
    const detector = new AskWindowDeadlockDetector();
    for (let i = 0; i < DEADLOCK_STREAK; i += 1) {
      detector.recordRejected("DOGE", undefined);
    }
    const deadlock = detector.takeDeadlock("DOGE", 0.85, 0.95)!;
    expect(deadlock.observedMaxAsk).toBe(0);
    expect(describeDeadlock(deadlock)).toContain("no hubo liquidez");
  });
});

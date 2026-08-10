import { describe, expect, it } from "vitest";

import { startEventLoopLagMonitor } from "../src/eventLoopLag.js";

/**
 * Existe para distinguir las dos causas de una iteracion lenta, que hoy se confunden: esperar a la red
 * deja el bucle libre, mientras que el trabajo sincrono lo bloquea y detiene hasta los `setTimeout`.
 * Hay picos de captura de 41 segundos con timeouts de 2s en las peticiones — un timeout que no salta
 * en 41s solo se explica si nada corria, pero sin medirlo era una hipotesis.
 */
describe("monitor de retraso del bucle de eventos", () => {
  it("sin muestras todavia no inventa un cero", async () => {
    const monitor = startEventLoopLagMonitor(20);
    // Recien arrancado no ha pasado ni un intervalo: `undefined` es honesto, `0` seria mentir.
    expect(monitor.read()).toBeUndefined();
    monitor.stop();
  });

  it("una espera ASINCRONA no cuenta como bloqueo", async () => {
    const monitor = startEventLoopLagMonitor(20);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const lectura = monitor.read();
    monitor.stop();
    // El bucle estuvo libre todo el rato, aunque el reloj de pared avanzara.
    expect(lectura).toBeDefined();
    expect(lectura!.p50Ms).toBeLessThan(50);
  });

  it("un bloqueo SINCRONO si aparece", async () => {
    const monitor = startEventLoopLagMonitor(20);
    await new Promise((resolve) => setTimeout(resolve, 60));
    // Quemar CPU de verdad: es lo que impide que corra nada mas, timeouts incluidos.
    const hasta = Date.now() + 250;
    while (Date.now() < hasta) {
      // bucle vacio a proposito
    }
    await new Promise((resolve) => setTimeout(resolve, 60));
    const lectura = monitor.read();
    monitor.stop();
    expect(lectura!.maxMs).toBeGreaterThan(100);
  });

  it("reset vacia el histograma para que cada ventana sea independiente", async () => {
    const monitor = startEventLoopLagMonitor(20);
    // Espera ACTIVA con fecha limite, no un sleep fijo. Con toda la bateria corriendo en paralelo, 60 ms
    // no bastan siempre para que el histograma tome su primera muestra, y el test fallaba solo bajo
    // carga — es decir, contaba mentiras sobre el codigo en vez de sobre el reloj.
    const limite = Date.now() + 5_000;
    while (monitor.read() === undefined && Date.now() < limite) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(monitor.read()).toBeDefined();
    monitor.reset();
    // Sin esto, un bloqueo viejo seguiria apareciendo como maximo para siempre.
    expect(monitor.read()).toBeUndefined();
    monitor.stop();
  });
});

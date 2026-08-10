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
    const ESPERA_MS = 300;
    const monitor = startEventLoopLagMonitor(20);
    await new Promise((resolve) => setTimeout(resolve, ESPERA_MS));
    const lectura = monitor.read();
    monitor.stop();
    // El bucle estuvo libre todo el rato, aunque el reloj de pared avanzara.
    expect(lectura).toBeDefined();
    // El umbral va atado a la ESPERA, no a un 50 fijo.
    //
    // Este monitor mide el bucle del PROCESO entero, que comparte CPU con los demas workers de vitest.
    // Con dos baterias completas a la vez el p50 llegaba a 59-70 ms y el test fallaba — sin que nada
    // estuviera mal en el codigo. Lo que la prueba afirma es que dormir no bloquea: si el bucle
    // hubiera estado parado durante la espera, el p50 rondaria los 300 ms, no los 70. La mitad
    // discrimina eso de sobra y deja el doble de margen sobre lo peor observado bajo carga.
    expect(lectura!.p50Ms).toBeLessThan(ESPERA_MS / 2);
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

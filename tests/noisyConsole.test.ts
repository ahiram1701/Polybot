import { afterEach, describe, expect, it, vi } from "vitest";

import { installNoisyConsoleAggregator } from "../src/noisyConsole.js";
import { logger } from "../src/logger.js";

let aggregator: { restore: () => void; flush: () => void } | undefined;

afterEach(() => {
  aggregator?.restore();
  aggregator = undefined;
  vi.restoreAllMocks();
});

/**
 * Durante el corte de red del 2026-08-08 el SDK del CLOB escribio 250.000 lineas en 30 minutos y dejo
 * el log en 76 MB. No es solo ruido: llena disco y come CPU escribiendo, justo cuando el proceso ya
 * esta peor, y entierra las lineas que si explican lo que pasa.
 */
describe("agregador de consola ruidosa", () => {
  it("no escribe una linea por cada error repetido", () => {
    const escrituras: unknown[][] = [];
    vi.spyOn(console, "log").mockImplementation((...args) => void escrituras.push(args));
    aggregator = installNoisyConsoleAggregator(60_000);

    for (let i = 0; i < 1000; i += 1) {
      console.log("[CLOB Client] request error", { error: "ECONNRESET" });
    }
    expect(escrituras).toHaveLength(0);
  });

  it("cuenta y resume en vez de silenciar: la señal se conserva", () => {
    const avisos: Array<{ msg: string; meta: unknown }> = [];
    vi.spyOn(logger, "warn").mockImplementation((msg: string, meta?: unknown) => void avisos.push({ msg, meta }));
    aggregator = installNoisyConsoleAggregator(60_000);

    for (let i = 0; i < 7; i += 1) {
      console.log("[CLOB Client] request error", { error: "ECONNRESET" });
    }
    aggregator.flush();

    expect(avisos).toHaveLength(1);
    expect(JSON.stringify(avisos[0].meta)).toContain("7");
  });

  it("separa causas distintas: un DNS caido no es lo mismo que un reset", () => {
    const avisos: Array<{ meta: unknown }> = [];
    vi.spyOn(logger, "warn").mockImplementation((_msg: string, meta?: unknown) => void avisos.push({ meta }));
    aggregator = installNoisyConsoleAggregator(60_000);

    console.log("[CLOB Client] request error", { error: "getaddrinfo ENOTFOUND" });
    console.log("[CLOB Client] request error", { error: "read ECONNRESET" });
    aggregator.flush();

    const texto = JSON.stringify(avisos[0].meta);
    expect(texto).toContain("ENOTFOUND");
    expect(texto).toContain("ECONNRESET");
  });

  it("deja pasar intacto todo lo que no es ruidoso", () => {
    const escrituras: unknown[][] = [];
    vi.spyOn(console, "log").mockImplementation((...args) => void escrituras.push(args));
    aggregator = installNoisyConsoleAggregator(60_000);

    console.log("mensaje normal del bot");
    expect(escrituras).toHaveLength(1);
    expect(escrituras[0][0]).toBe("mensaje normal del bot");
  });

  it("restaurar devuelve la consola original y vuelca lo pendiente", () => {
    const avisos: string[] = [];
    vi.spyOn(logger, "warn").mockImplementation((msg: string) => void avisos.push(msg));
    const agg = installNoisyConsoleAggregator(60_000);
    console.log("[CLOB Client] request error", { error: "x" });
    agg.restore();
    expect(avisos).toHaveLength(1);
  });
});

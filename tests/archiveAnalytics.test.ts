import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { archivarAnalitica, ejecutarArchivado } from "../src/archiveAnalytics.js";
import { invalidateAnalyticsReadCache, serializeAnalyticsSamples } from "../src/analyticsRecorder.js";
import type { AnalyticsSample } from "../src/types.js";

const temps: string[] = [];
afterEach(async () => {
  invalidateAnalyticsReadCache();
  await Promise.all(temps.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});

function muestra(windowStartMs: number): AnalyticsSample {
  return {
    version: 1,
    market: "BTC",
    slug: `btc-updown-5m-${Math.floor(windowStartMs / 1000)}`,
    windowStartMs,
    endMs: windowStartMs + 300_000,
    openingPrice: 100,
    openingTickTimestampMs: windowStartMs,
    ticks: [],
    quotes: [],
    finalPrice: 101,
    finalTickTimestampMs: windowStartMs + 300_001,
    winningOutcome: "UP",
    resolvedAtMs: windowStartMs + 300_002,
  };
}

async function escribirVivo(dataDir: string, muestras: AnalyticsSample[]): Promise<void> {
  await writeFile(join(dataDir, "analytics.jsonl"), serializeAnalyticsSamples(muestras), "utf8");
  invalidateAnalyticsReadCache();
}

async function lineasArchivo(dataDir: string): Promise<number> {
  const texto = await readFile(join(dataDir, "archive", "analytics-archive.jsonl"), "utf8");
  return texto.split("\n").filter((l) => l.trim()).length;
}

describe("archivador de analitica", () => {
  const base = Date.UTC(2026, 7, 17, 9, 0, 0);

  it("archiva todo la primera vez y NADA la segunda", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "polybot-archivo-"));
    temps.push(dataDir);
    await escribirVivo(dataDir, [muestra(base), muestra(base + 300_000), muestra(base + 600_000)]);

    expect((await archivarAnalitica(dataDir)).nuevas).toBe(3);
    // Sin esto el archivo se duplicaria en cada pasada y acabaria siendo inservible en silencio.
    expect((await archivarAnalitica(dataDir)).nuevas).toBe(0);
    expect(await lineasArchivo(dataDir)).toBe(3);
  });

  it("solo anade las ventanas NUEVAS", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "polybot-archivo-"));
    temps.push(dataDir);
    await escribirVivo(dataDir, [muestra(base), muestra(base + 300_000)]);
    await archivarAnalitica(dataDir);

    await escribirVivo(dataDir, [muestra(base + 300_000), muestra(base + 600_000), muestra(base + 900_000)]);
    expect((await archivarAnalitica(dataDir)).nuevas).toBe(2);
    expect(await lineasArchivo(dataDir)).toBe(4);
  });

  it("conserva lo ya archivado aunque la retencion lo haya borrado del fichero vivo", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "polybot-archivo-"));
    temps.push(dataDir);
    await escribirVivo(dataDir, [muestra(base), muestra(base + 300_000)]);
    await archivarAnalitica(dataDir);

    // La poda se llevo las viejas: el fichero vivo ya solo tiene la nueva. Es EL caso que motiva todo
    // esto, y el archivo no puede encogerse con el.
    await escribirVivo(dataDir, [muestra(base + 600_000)]);
    await archivarAnalitica(dataDir);
    expect(await lineasArchivo(dataDir)).toBe(3);
  });

  it("sin fichero vivo no rompe ni crea un archivo vacio a medias", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "polybot-archivo-"));
    temps.push(dataDir);
    await mkdir(dataDir, { recursive: true });
    const r = await archivarAnalitica(dataDir);
    expect(r.nuevas).toBe(0);
  });
});

/**
 * El archivo es la unica memoria larga del proyecto: el fichero vivo es una ventana rodante que se
 * recicla sola. Su unico rastro era una linea en `archive.log` que no mira nadie, y el 2026-08-25 el
 * archivador llevaba CATORCE HORAS caido sin que nadie se enterara.
 */
describe("cuando el archivador falla, avisa por Telegram", () => {
  function notificadorFalso() {
    const enviados: Array<Record<string, unknown>> = [];
    return {
      enviados,
      notifier: { notify: async (m: Record<string, unknown>) => { enviados.push(m); } },
    };
  }

  const config = { dataDir: "/no/importa" };

  it("avisa con nivel error y explica que el histórico deja de acumularse", async () => {
    const { enviados, notifier } = notificadorFalso();
    const ok = await ejecutarArchivado(config, {
      archivar: async () => { throw new Error("Cannot create a string longer than 0x1fffffe8 characters"); },
      notifier: notifier as never,
    });

    expect(ok).toBe(false);
    expect(enviados).toHaveLength(1);
    expect(enviados[0]!.level).toBe("error");
    // `system` y no `trade`: los avisos de sistema nunca se agrupan en el resumen periodico, que es
    // justo donde un fallo asi se quedaria esperando cuatro horas.
    expect(enviados[0]!.category).toBe("system");
    expect(String(enviados[0]!.body)).toContain("0x1fffffe8");
    expect(String(enviados[0]!.body)).toContain("NO se acumula");
  });

  it("NO avisa cuando la pasada va bien: un canal que habla siempre se deja de leer", async () => {
    const { enviados, notifier } = notificadorFalso();
    const ok = await ejecutarArchivado(config, {
      archivar: async () => ({ nuevas: 12, total: 10_000 }),
      notifier: notifier as never,
    });
    expect(ok).toBe(true);
    expect(enviados).toEqual([]);
  });

  it("que Telegram este caido no tapa el fallo que se venia a contar", async () => {
    const ok = await ejecutarArchivado(config, {
      archivar: async () => { throw new Error("disco lleno"); },
      notifier: { notify: async () => { throw new Error("Telegram 502"); } } as never,
    });
    // Sigue devolviendo false —el archivado fallo— en vez de propagar el error del aviso, que mandaria
    // al log un motivo equivocado y dejaria al envoltorio contando otra historia.
    expect(ok).toBe(false);
  });
});

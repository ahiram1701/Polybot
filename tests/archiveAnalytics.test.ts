import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  archivadorDesatendido,
  archivarAnalitica,
  ejecutarArchivado,
  ultimaPasadaArchivado,
} from "../src/archiveAnalytics.js";
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

/**
 * Los dos huecos que el aviso desde dentro del script no puede cubrir: que Node no llegue a arrancar y
 * que la tarea programada no se dispare. Desde fuera son el mismo silencio, y el segundo es el peor
 * porque no deja ni rastro. Los dos se responden con la misma pregunta: cuando fue la ultima pasada.
 */
describe("vigilancia: el archivador que no corre", () => {
  const HORA = 3_600_000;
  const AHORA = Date.UTC(2026, 7, 26, 12, 0, 0);
  const DESPIERTO = 48 * HORA;

  it("no avisa mientras las pasadas lleguen a su hora", () => {
    // Corre dos veces al dia; doce horas es lo normal.
    expect(
      archivadorDesatendido({ ultimaPasadaMs: AHORA - 12 * HORA, nowMs: AHORA, msDesdeArranque: DESPIERTO }).avisar,
    ).toBe(false);
    // Y una pasada perdida tampoco: el margen esta puesto para que un retraso del planificador no
    // dispare un aviso falso, que es como se mata un canal de avisos.
    expect(
      archivadorDesatendido({ ultimaPasadaMs: AHORA - 25 * HORA, nowMs: AHORA, msDesdeArranque: DESPIERTO }).avisar,
    ).toBe(false);
  });

  it("avisa cuando se pasa del limite, y dice cuantas horas", () => {
    const v = archivadorDesatendido({ ultimaPasadaMs: AHORA - 30 * HORA, nowMs: AHORA, msDesdeArranque: DESPIERTO });
    expect(v.avisar).toBe(true);
    expect(v.motivo).toBe("demasiado_tiempo");
    expect(v.horas).toBe(30);
  });

  it("sin rastro de ninguna pasada avisa, pero NO nada mas arrancar", () => {
    // Un bot recien levantado no sabe nada todavia; concluir ahi que nadie ha archivado convertiria
    // cada reinicio en un aviso falso.
    expect(
      archivadorDesatendido({ ultimaPasadaMs: undefined, nowMs: AHORA, msDesdeArranque: 5 * HORA }).avisar,
    ).toBe(false);
    const v = archivadorDesatendido({ ultimaPasadaMs: undefined, nowMs: AHORA, msDesdeArranque: DESPIERTO });
    expect(v.avisar).toBe(true);
    expect(v.motivo).toBe("nunca_corrio");
  });

  it("el latido se escribe aunque la pasada no tenga NADA que archivar", async () => {
    // Es la razon de existir del latido. La fecha del archivo solo se mueve cuando hay algo que
    // añadir, asi que un dia con el bot parado la dejaria igual de quieta que una tarea deshabilitada.
    const dataDir = await mkdtemp(join(tmpdir(), "polybot-latido-"));
    temps.push(dataDir);
    await mkdir(join(dataDir, "archive"), { recursive: true });
    await writeFile(join(dataDir, "analytics.jsonl"), "", "utf8");

    const antes = Date.now();
    const ok = await ejecutarArchivado({ dataDir }, { notifier: { notify: async () => {} } as never });
    expect(ok).toBe(true);

    const latido = await ultimaPasadaArchivado(dataDir);
    expect(latido).toBeGreaterThanOrEqual(antes);
    // Y con ese latido fresco, la vigilancia calla.
    expect(
      archivadorDesatendido({ ultimaPasadaMs: latido, nowMs: Date.now(), msDesdeArranque: DESPIERTO }).avisar,
    ).toBe(false);
  });

  it("si no hay latido todavia, se cae a la fecha del archivo en vez de dar por perdida la señal", async () => {
    // Instalaciones anteriores al latido: peor señal, pero infinitamente mejor que empezar gritando.
    const dataDir = await mkdtemp(join(tmpdir(), "polybot-latido-viejo-"));
    temps.push(dataDir);
    await mkdir(join(dataDir, "archive"), { recursive: true });
    await writeFile(join(dataDir, "archive", "analytics-archive.jsonl"), "algo\n", "utf8");
    const leido = await ultimaPasadaArchivado(dataDir);
    expect(leido).toBeGreaterThan(0);
  });

  it("sin archivo ni latido devuelve undefined, que NO es 'hace mucho'", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "polybot-latido-vacio-"));
    temps.push(dataDir);
    expect(await ultimaPasadaArchivado(dataDir)).toBeUndefined();
  });
});

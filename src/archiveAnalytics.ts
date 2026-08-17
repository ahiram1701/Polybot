/**
 * Archiva las muestras de analitica antes de que la retencion las borre.
 *
 * El fichero vivo esta acotado a `maxAnalyticsSamples` (10.000). Cuando se llena, cada muestra nueva
 * borra la mas vieja — asi que a partir de ese punto **esperar mas tiempo no acumula mas datos, los
 * recicla**. Con ~730 muestras al dia eso son unas dos semanas de memoria, y validar una estrategia
 * fuera de muestra necesita mas.
 *
 * Este archivador copia lo nuevo a `data/archive/analytics-archive.jsonl`, que no tiene tope. No pasa
 * por la API a proposito: lee el fichero directamente, asi que funciona aunque el bot este parado — y
 * si el bot esta parado es justo cuando mas urge no perder lo que ya hay.
 *
 * Es **incremental**: solo escribe las ventanas mas nuevas que la ultima archivada. Volcar las 10.000
 * cada vez serian 326 MB de los que el 90% ya estaria dentro.
 *
 * Uso: `npx tsx src/archiveAnalytics.ts`
 */
import { appendFile, mkdir, open, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

import { readAnalyticsSamples, serializeAnalyticsSamples } from "./analyticsRecorder.js";
import { loadConfig } from "./config.js";
import { logger } from "./logger.js";
import type { AnalyticsSample } from "./types.js";

/** Cuantos bytes del final del archivo se leen para averiguar hasta donde llego la ultima pasada. */
const COLA_BYTES = 512 * 1024;

/**
 * `windowStartMs` de la muestra mas reciente ya archivada.
 *
 * Se lee de la COLA del fichero, no del fichero entero: el archivo crece sin limite por diseño, y
 * releerlo completo en cada pasada convertiria el archivador en el problema que viene a evitar.
 * Las muestras se escriben en orden ascendente, asi que el maximo esta al final.
 */
async function ultimaArchivada(path: string): Promise<number> {
  let tamano: number;
  try {
    tamano = (await stat(path)).size;
  } catch {
    return 0; // aun no existe: se archiva todo
  }
  const desde = Math.max(0, tamano - COLA_BYTES);
  const fh = await open(path, "r");
  try {
    const buffer = Buffer.alloc(tamano - desde);
    await fh.read(buffer, 0, buffer.length, desde);
    let max = 0;
    for (const linea of buffer.toString("utf8").split("\n")) {
      if (!linea.trim()) continue;
      try {
        const registro = JSON.parse(linea) as { sample?: AnalyticsSample } & Partial<AnalyticsSample>;
        const inicio = registro.sample?.windowStartMs ?? registro.windowStartMs;
        if (typeof inicio === "number" && inicio > max) {
          max = inicio;
        }
      } catch {
        // Una linea partida por el corte de la cola no es un error: la siguiente entera vale igual.
      }
    }
    return max;
  } finally {
    await fh.close();
  }
}

export async function archivarAnalitica(dataDir: string): Promise<{ nuevas: number; total: number }> {
  const origen = join(dataDir, "analytics.jsonl");
  const destino = join(dataDir, "archive", "analytics-archive.jsonl");

  const muestras = await readAnalyticsSamples(origen);
  const corte = await ultimaArchivada(destino);
  const nuevas = muestras
    .filter((muestra) => muestra.windowStartMs > corte)
    .sort((izquierda, derecha) => izquierda.windowStartMs - derecha.windowStartMs);

  if (nuevas.length > 0) {
    await mkdir(dirname(destino), { recursive: true });
    // Se reutiliza el mismo serializador que la exportacion de la UI, asi que el archivo se puede
    // reimportar con `POST /api/analysis/samples/import` sin conversiones.
    await appendFile(destino, serializeAnalyticsSamples(nuevas), "utf8");
  }
  return { nuevas: nuevas.length, total: muestras.length };
}

async function main(): Promise<void> {
  const { config } = loadConfig(["--mode", "sim"]);
  const { nuevas, total } = await archivarAnalitica(config.dataDir);
  logger.info("Analitica archivada.", {
    nuevas,
    enElFicheroVivo: total,
    destino: join(config.dataDir, "archive", "analytics-archive.jsonl"),
  });
}

if (process.argv[1]?.includes("archiveAnalytics")) {
  void main();
}

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
import { createDynamicNotifier } from "./notifier.js";
import type { Notifier } from "./notifier.js";
import type { AnalyticsSample, BotConfig } from "./types.js";

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

/**
 * Una pasada de archivado, avisando por Telegram si falla.
 *
 * El aviso no es un adorno. Este archivo es la unica memoria larga del proyecto —el fichero vivo es
 * una ventana rodante que se recicla sola— y su unico rastro era una linea en `archive.log` que no
 * mira nadie. El 2026-08-25 el archivador llevaba **catorce horas caido** por el fallo de los 512 MB
 * (`EXCEPCION: node:buffer:891`) y solo se descubrio mirando el log a mano por otro motivo. Hubo otro
 * fallo el 22 que nunca se vio.
 *
 * Se avisa SOLO al fallar. Un aviso diario de "todo bien" se deja de leer en una semana, y entonces el
 * canal ya no sirve para lo que se creo.
 *
 * **Lo que este aviso NO cubre**, y conviene saberlo: si el proceso de Node no llega a arrancar —npx
 * roto, el disco lleno— nadie puede avisar desde dentro, y queda solo la linea de `archive.log`. Y si
 * la tarea programada no llega a dispararse (equipo apagado, tarea deshabilitada) tampoco hay fallo
 * que notificar: el silencio no se distingue del exito. Para eso haria falta vigilar la ANTIGUEDAD del
 * archivo, que es otra cosa y no esta hecha.
 *
 * `deps` existe para poder probar el camino de fallo sin red ni credenciales.
 */
export async function ejecutarArchivado(
  config: Pick<BotConfig, "dataDir" | "telegramBotToken" | "telegramChatId" | "publicUrl">,
  deps: { archivar?: typeof archivarAnalitica; notifier?: Notifier } = {},
): Promise<boolean> {
  const archivar = deps.archivar ?? archivarAnalitica;
  try {
    const { nuevas, total } = await archivar(config.dataDir);
    logger.info("Analitica archivada.", {
      nuevas,
      enElFicheroVivo: total,
      destino: join(config.dataDir, "archive", "analytics-archive.jsonl"),
    });
    return true;
  } catch (error) {
    const detalle = error instanceof Error ? error.message : String(error);
    logger.error("El archivado de analitica FALLO.", { error: detalle });
    // El aviso va en su propio try: que Telegram este caido no puede tapar el fallo que se venia a
    // contar, ni convertir un fallo de archivado en una excepcion distinta que despiste al leer el log.
    try {
      const notifier = deps.notifier ?? createDynamicNotifier(config);
      await notifier.notify({
        level: "error",
        category: "system",
        title: "Archivador de analitica caido",
        body:
          `No se pudo archivar: ${detalle}\n\n` +
          "Mientras siga asi NO se acumula histórico: el fichero vivo recicla las muestras viejas y " +
          "lo que se cae de el se pierde. Revisa data/archive/archive.log.",
      });
    } catch (falloAviso) {
      logger.warn("Ademas, no se pudo avisar por Telegram del fallo del archivador.", {
        error: falloAviso instanceof Error ? falloAviso.message : String(falloAviso),
      });
    }
    return false;
  }
}

async function main(): Promise<void> {
  const { config } = loadConfig(["--mode", "sim"]);
  // Codigo de salida distinto de 0 para que el envoltorio de PowerShell lo registre como FALLO.
  if (!(await ejecutarArchivado(config))) {
    process.exitCode = 1;
  }
}

if (process.argv[1]?.includes("archiveAnalytics")) {
  void main().catch((error: unknown) => {
    // Aqui solo se llega si fallo algo ANTES de poder avisar (leer la configuracion, por ejemplo).
    logger.error("El archivado de analitica fallo antes de poder avisar.", {
      error: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
  });
}

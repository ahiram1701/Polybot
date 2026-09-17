import { mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";

// Under load (AV scans, many overlapping writers) 200ms of total backoff proved flaky on Windows;
// the tail retries make the worst case ~1.6s, which beats failing a state write.
const RETRY_DELAYS_MS = [10, 30, 80, 200, 400, 900];
// Windows-specific transient failures: AV/indexer holds a brief lock on the temp or target (EPERM/
// EACCES/EBUSY), or a rename lands on a vanished path (ENOENT). All are safe to retry.
const RETRYABLE_CODES = new Set(["EPERM", "EACCES", "EBUSY", "ENOENT"]);

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// In-process serialization per target path: overlapping async writers (state saves, settings, fx
// cache) queue behind each other instead of racing renames on Windows — the last write still wins,
// but no writer can observe another's half-finished rename.
const writeQueues = new Map<string, Promise<void>>();

/**
 * Write a file atomically: write to a UNIQUE temp path, then rename over the target. Writers to the
 * SAME path are serialized in-process; the rename itself retries the transient Windows lock failures
 * (EPERM/EACCES/EBUSY from AV/indexers) with a short backoff.
 */
export function writeFileAtomic(path: string, contents: string): Promise<void> {
  const previous = writeQueues.get(path) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(() => writeFileAtomicUnqueued(path, contents));
  writeQueues.set(path, current);
  void current.finally(() => {
    if (writeQueues.get(path) === current) {
      writeQueues.delete(path);
    }
  });
  return current;
}

async function writeFileAtomicUnqueued(path: string, contents: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let lastError: unknown;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      await writeFile(tempPath, contents, "utf8");
      await rename(tempPath, path);
      return;
    } catch (error) {
      lastError = error;
      const code = (error as NodeJS.ErrnoException).code;
      if (!code || !RETRYABLE_CODES.has(code) || attempt === RETRY_DELAYS_MS.length) {
        await rm(tempPath, { force: true }).catch(() => undefined);
        throw error;
      }
      await delay(RETRY_DELAYS_MS[attempt]);
    }
  }
  await rm(tempPath, { force: true }).catch(() => undefined);
  throw lastError;
}

/**
 * Como `writeFileAtomic`, pero el contenido llega POR LINEAS y nunca existe entero en memoria.
 *
 * Existe porque `writeFileAtomic` recibe un `string`, y construirlo es un techo duro: Node no puede
 * crear cadenas de mas de 512 MB (`0x1fffffe8`). El 2026-09-17 eso dejo el bot 7,5 horas sin operar —
 * `analytics.jsonl` llego a 736 MB, la poda intentaba serializar las 10.000 muestras que conserva en
 * una sola cadena, fallaba con `Invalid string length` y el fichero solo podia crecer. Es el MISMO
 * punto muerto que la lectura por tramos ya resolvio en agosto, por la otra mitad: no sirve de nada
 * poder leer un fichero que no se puede reescribir.
 *
 * El reintento cubre el `rename`, no la escritura: las cerraduras transitorias de Windows aparecen al
 * renombrar sobre el destino, y repetir un volcado de cientos de MB por un EPERM seria peor que el mal.
 */
export function writeLinesAtomic(path: string, lines: Iterable<string>, lineasPorLote = 200): Promise<void> {
  const previous = writeQueues.get(path) ?? Promise.resolve();
  const current = previous
    .catch(() => undefined)
    .then(() => writeLinesAtomicUnqueued(path, lines, lineasPorLote));
  writeQueues.set(path, current);
  void current.finally(() => {
    if (writeQueues.get(path) === current) {
      writeQueues.delete(path);
    }
  });
  return current;
}

async function writeLinesAtomicUnqueued(path: string, lines: Iterable<string>, lineasPorLote: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const handle = await open(tempPath, "w");
    try {
      let lote: string[] = [];
      for (const line of lines) {
        lote.push(line);
        if (lote.length >= lineasPorLote) {
          await handle.write(`${lote.join("\n")}\n`);
          lote = [];
        }
      }
      if (lote.length > 0) {
        await handle.write(`${lote.join("\n")}\n`);
      }
    } finally {
      await handle.close();
    }
    await renameConReintentos(tempPath, path);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** El `rename` con el mismo retroceso que `writeFileAtomic`: EPERM/EACCES/EBUSY/ENOENT son transitorios. */
async function renameConReintentos(tempPath: string, path: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      await rename(tempPath, path);
      return;
    } catch (error) {
      lastError = error;
      const code = (error as NodeJS.ErrnoException).code;
      if (!code || !RETRYABLE_CODES.has(code) || attempt === RETRY_DELAYS_MS.length) {
        throw error;
      }
      await delay(RETRY_DELAYS_MS[attempt]);
    }
  }
  throw lastError;
}

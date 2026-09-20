/**
 * La analitica, leida en FLUJO: una muestra cada vez, nunca todas a la vez.
 *
 * POR QUE EXISTE. `readAnalyticsSamples` devuelve el fichero entero como array y ademas lo cachea. Eso
 * vale para el bot, que trabaja con la analitica viva podada a 5.000 muestras, pero no para un backtest:
 * el 2026-09-19 el archivo pesaba 900 MB y el fichero vivo 371 MB, 17.812 muestras entre los dos. Cada
 * muestra son ~125 ticks y ~260 cotizaciones, asi que en objetos de JavaScript eso multiplica por varias
 * veces el tamaño en disco, y la maquina tiene 3,8 GB. Medido: el simulador del freno cargando las dos
 * fuentes con `readAnalyticsSamples` se comio la memoria, empujo la maquina al swap y dejo de responder
 * hasta el propio WSL. No fue lentitud, fue que no cabia.
 *
 * Aqui no se reimplementa el parseo ni la validacion: se LLAMA a `parseAnalyticsLine` y a
 * `isResolvedAnalyticsSample`, los mismos que usa el lector del bot. Lo unico que cambia es que la
 * muestra se entrega y se suelta.
 *
 * COMO SE ELIGE LA COPIA BUENA. Una misma ventana puede estar en los dos ficheros, y una de las dos
 * copias puede ser una reescritura degradada —ya paso: una copia con menos cotizaciones tapaba a la
 * completa que si estaba archivada—. La regla es la misma que ya aplicaban los smokes: dentro de un
 * fichero gana la ULTIMA linea del slug (es lo que hace `readAnalyticsSamples`), y entre ficheros gana la
 * copia con MAS detalle (ticks + cotizaciones), con el desempate a favor del ultimo fichero de la lista.
 *
 * El indice se construye SIN parsear el JSON: contar `"secondsToEnd":` da exactamente
 * ticks.length + quotes.length, porque ese campo aparece una vez en cada tick y una vez en cada
 * cotizacion y en ningun otro sitio de la muestra. Sobre 1,3 GB eso son segundos en vez de minutos, y
 * sobre todo no reserva memoria por muestra.
 */
import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import { createInterface } from "node:readline";

import { isResolvedAnalyticsSample, parseAnalyticsLine } from "./analyticsRecorder.js";
import type { AnalyticsSample } from "./types.js";

/** Donde vive una muestra: fichero, byte de inicio y longitud exacta de la linea. */
export interface UbicacionMuestra {
  path: string;
  offset: number;
  largo: number;
  slug: string;
  windowStartMs: number;
  /** ticks + cotizaciones. Es lo que decide cual de dos copias del mismo slug es la buena. */
  detalle: number;
}

const MARCA_DETALLE = '"secondsToEnd":';

function contarDetalle(linea: string): number {
  let total = 0;
  let desde = 0;
  for (;;) {
    const encontrado = linea.indexOf(MARCA_DETALLE, desde);
    if (encontrado === -1) {
      return total;
    }
    total += 1;
    desde = encontrado + MARCA_DETALLE.length;
  }
}

/**
 * Donde esta cada ventana, en orden cronologico y ya sin duplicados.
 *
 * Los ficheros se recorren en el orden dado. El resultado va ordenado por `windowStartMs` porque el
 * replay del favorito construye su historial walk-forward y solo significa algo si las ventanas le
 * llegan en el orden en que ocurrieron; el fichero archivado, medido, trae una linea fuera de sitio.
 */
export async function indexarMuestras(paths: readonly string[]): Promise<UbicacionMuestra[]> {
  const elegidas = new Map<string, UbicacionMuestra>();

  for (const path of paths) {
    // Dentro de un mismo fichero manda la ultima linea del slug, igual que `readAnalyticsSamples`.
    const delFichero = new Map<string, UbicacionMuestra>();
    let offset = 0;
    let stream;
    try {
      stream = createReadStream(path);
    } catch {
      continue;
    }
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const linea of rl) {
        const largo = Buffer.byteLength(linea, "utf8");
        const inicio = offset;
        offset += largo + 1;
        if (!linea) {
          continue;
        }
        const recortado = /"slug":"([^"]+)"/.exec(linea)?.[1];
        const windowStartMs = Number(/"windowStartMs":(\d+)/.exec(linea)?.[1]);
        if (!recortado || !Number.isFinite(windowStartMs)) {
          continue;
        }
        // COPIA OBLIGATORIA. Un trozo de mas de 12 caracteres sacado con una expresion regular no es una
        // cadena nueva en V8: es una "sliced string" que apunta a la original y LA MANTIENE VIVA. Guardar
        // 17.812 slugs asi retiene las 17.812 lineas enteras —~76 KB cada una— y el indice, que deberia
        // ocupar un par de megas, se comia 1,5 GB y moria por falta de memoria. Medido, no supuesto.
        const slug = Buffer.from(recortado, "utf8").toString("utf8");
        delFichero.set(slug, { path, offset: inicio, largo, slug, windowStartMs, detalle: contarDetalle(linea) });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      continue;
    }

    for (const ubicacion of delFichero.values()) {
      const previa = elegidas.get(ubicacion.slug);
      // `>=`: a igualdad de detalle gana el fichero mas reciente de la lista.
      if (!previa || ubicacion.detalle >= previa.detalle) {
        elegidas.set(ubicacion.slug, ubicacion);
      }
    }
  }

  return [...elegidas.values()].sort(
    (izq, der) => izq.windowStartMs - der.windowStartMs || izq.slug.localeCompare(der.slug),
  );
}

/**
 * Las muestras validas, en orden cronologico, una cada vez.
 *
 * Segunda pasada: cada linea se lee por su posicion exacta, se parsea y se suelta. Si las posiciones
 * estuvieran corridas —un fichero con finales de linea de Windows, por ejemplo— lo que se lea no sera
 * JSON y eso se nota aqui y no en una tabla rara tres pantallas mas abajo, asi que se avisa en vez de
 * tragar.
 */
export async function* muestrasEnOrden(
  paths: readonly string[],
  filtro?: (ubicacion: UbicacionMuestra) => boolean,
): AsyncGenerator<AnalyticsSample> {
  const ubicaciones = (await indexarMuestras(paths)).filter((u) => !filtro || filtro(u));
  const handles = new Map<string, Awaited<ReturnType<typeof open>>>();
  try {
    let ilegibles = 0;
    for (const ubicacion of ubicaciones) {
      let handle = handles.get(ubicacion.path);
      if (!handle) {
        handle = await open(ubicacion.path, "r");
        handles.set(ubicacion.path, handle);
      }
      const buffer = Buffer.alloc(ubicacion.largo);
      await handle.read(buffer, 0, ubicacion.largo, ubicacion.offset);
      const sample = parseAnalyticsLine(buffer.toString("utf8"));
      if (!sample) {
        ilegibles += 1;
        if (ilegibles > 10) {
          throw new Error(
            `El indice no cuadra con el fichero: ${ilegibles} lineas ilegibles leyendo por posicion en ${ubicacion.path}`,
          );
        }
        continue;
      }
      if (isResolvedAnalyticsSample(sample)) {
        yield sample;
      }
    }
  } finally {
    for (const handle of handles.values()) {
      await handle.close();
    }
  }
}

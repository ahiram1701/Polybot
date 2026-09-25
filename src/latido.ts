import { writeFile } from "node:fs/promises";

import { logger } from "./logger.js";

/**
 * El latido: un fichero con la hora, reescrito cada pocos segundos, para que algo de FUERA pueda saber
 * si esta pila sigue viva sin depender de la red.
 *
 * POR QUE EXISTE, y viene de dos averias reales. El vigilante de Windows comprobaba
 * `http://127.0.0.1:8787` para decidir si Polybot vivia, y esa pregunta mezcla dos cosas distintas:
 * "el proceso esta vivo" y "el reenvio de localhost de WSL a Windows funciona". El 2026-09-24 se rompio
 * lo segundo —el bot respondia HTTP 200 DENTRO de la distro y desde Windows no— y el vigilante lo leyo
 * como "caido": llamo a `wsl.exe`, que desde la sesion 0 no se engancha a la distro sino que la tumba y
 * la vuelve a levantar. Doce horas reiniciando el bot cada cinco minutos.
 *
 * El latido corta ese nudo: se escribe en un fichero del disco de Windows montado en el contenedor, asi
 * que el vigilante lo lee SIN tocar la red y SIN invocar `wsl.exe`. Si la marca esta fresca, la pila
 * vive y no hay nada que arreglar, se rompa lo que se rompa por el camino de la red.
 *
 * LO ESCRIBE EL SERVIDOR, NO EL BUCLE DE TRADING, y es deliberado: la pregunta que responde es "sigue
 * en pie el proceso", no "esta operando". Si alguien para el bot a proposito, el latido debe seguir —
 * despertar la distro por eso seria deshacer una decision del dueño.
 *
 * NUNCA TUMBA EL PROCESO. Un fallo al escribir se anota una vez y se sigue: el latido es un diagnostico,
 * y un diagnostico que mata a su paciente no vale nada. Tampoco se escribe con `writeLinesAtomic` ni
 * nada parecido: el lector mira la FECHA del fichero, no su contenido, asi que una escritura a medias
 * es inofensiva y el contenido solo esta para que un humano lo entienda al abrirlo.
 */
export interface LatidoOptions {
  /** Ruta del fichero. Vacia o ausente = latido apagado. */
  path?: string;
  intervaloMs?: number;
  /** Solo para tests. */
  ahora?: () => Date;
  escribir?: (path: string, contenido: string) => Promise<void>;
}

export const INTERVALO_LATIDO_MS = 30_000;

export function iniciarLatido(options: LatidoOptions): () => void {
  const path = options.path?.trim();
  if (!path) {
    return () => {};
  }

  const ahora = options.ahora ?? (() => new Date());
  const escribir = options.escribir ?? ((destino, contenido) => writeFile(destino, contenido, "utf8"));
  let yaAvisado = false;

  const latir = async (): Promise<void> => {
    try {
      await escribir(path, `${ahora().toISOString()}\n`);
      yaAvisado = false;
    } catch (error) {
      // Una vez y no cada 30 s: un disco lleno no mejora por escribirlo 2.880 veces al dia en el log.
      if (!yaAvisado) {
        yaAvisado = true;
        logger.warn("No se pudo escribir el latido.", { path, error: (error as Error).message });
      }
    }
  };

  void latir();
  const timer = setInterval(() => void latir(), options.intervaloMs ?? INTERVALO_LATIDO_MS);
  // Que un latido no impida cerrar el proceso: quien manda es el servidor, no su diagnostico.
  timer.unref();
  return () => clearInterval(timer);
}

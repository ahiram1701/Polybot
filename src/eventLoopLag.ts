import { monitorEventLoopDelay, type IntervalHistogram } from "node:perf_hooks";

/**
 * Retraso REAL del bucle de eventos: cuanto tarda Node en atender lo que ya deberia haber atendido.
 *
 * Distingue las dos causas de una iteracion lenta, que hasta ahora se confundian:
 *
 *  - **Esperar a la red** deja el bucle libre. Los cronometros por fase suben, pero este no.
 *  - **Trabajo sincrono** lo bloquea. Nada corre — ni siquiera los `setTimeout`, asi que los propios
 *    timeouts de las cotizaciones dejan de dispararse.
 *
 * Esa distincion es la que falta hoy: hay picos de captura de 41 segundos con timeouts de 2s en las
 * peticiones. Un timeout de 2s que no salta en 41 segundos solo se explica si el bucle estaba parado,
 * pero sin medirlo es una hipotesis. Con esto pasa a ser un dato.
 *
 * Ya me equivoque una vez esta misma sesion dando por hecha la causa de estas paradas —culpe a los
 * mercados de 15m y los datos lo desmintieron—, asi que primero se mide.
 */

export interface EventLoopLag {
  /** Retraso mediano en ms. Sano = practicamente cero. */
  p50Ms: number;
  p99Ms: number;
  /** El peor bloqueo observado desde el ultimo reinicio de la ventana. */
  maxMs: number;
}

export interface EventLoopLagMonitor {
  /** Lectura actual, o `undefined` si aun no hay muestras. */
  read(): EventLoopLag | undefined;
  /** Vacia el histograma. Se llama al publicar, para que cada ventana sea independiente. */
  reset(): void;
  stop(): void;
}

/**
 * Arranca el monitor. `resolution` es cada cuanto se toma muestra: 20ms es fino para detectar
 * bloqueos de decimas de segundo y su coste es despreciable.
 */
export function startEventLoopLagMonitor(resolutionMs = 20): EventLoopLagMonitor {
  const histogram: IntervalHistogram = monitorEventLoopDelay({ resolution: resolutionMs });
  histogram.enable();
  return {
    read() {
      // `count` a cero significa que no ha pasado ni un intervalo todavia.
      if (histogram.count === 0) {
        return undefined;
      }
      return {
        // El histograma cuenta en NANOsegundos.
        p50Ms: redondear(histogram.percentile(50) / 1e6),
        p99Ms: redondear(histogram.percentile(99) / 1e6),
        maxMs: redondear(histogram.max / 1e6),
      };
    },
    reset() {
      histogram.reset();
    },
    stop() {
      histogram.disable();
    },
  };
}

function redondear(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 10) / 10 : 0;
}

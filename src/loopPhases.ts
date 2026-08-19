/**
 * Cronometro por fases de una iteracion del bucle.
 *
 * Existe por un fallo de medicion concreto: el bucle solo cronometraba `capture` y `decide`, y sobre
 * 400 iteraciones lentas reales esas dos sumaban 2.011 ms de una mediana de 5.992 ms. El 94% del
 * tiempo lento no lo explicaba ninguna fase medida, asi que "por que va lento el bucle" solo se podia
 * responder adivinando: la peticion a gamma (timeout de 5s) y la verificacion de resoluciones caian
 * fuera de los dos cronometros.
 *
 * La pieza que evita que vuelva a pasar no es tener mas fases — es `unaccountedMs`. Anadir trabajo sin
 * cronometrarlo ya no lo esconde: lo empuja a ese contador, que se publica en el log junto al resto.
 */

export const LOOP_PHASES = ["fetch", "reconcile", "resolve", "capture", "decide", "verify", "maker"] as const;

export type LoopPhase = (typeof LOOP_PHASES)[number];

export type LoopPhaseMs = Record<LoopPhase, number>;

export function emptyPhases(): LoopPhaseMs {
  return { fetch: 0, reconcile: 0, resolve: 0, capture: 0, decide: 0, verify: 0, maker: 0 };
}

export class PhaseTimer {
  private readonly elapsed: LoopPhaseMs = emptyPhases();

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * Cronometra una fase. Se acumula, no se sobrescribe: `verify` corre en dos sitios distintos segun
   * si hubo mercados, y las dos veces cuentan.
   *
   * Mide tambien cuando lanza — una fase que revienta a los 5s de timeout es justo la que hay que ver.
   */
  async time<T>(phase: LoopPhase, run: () => Promise<T>): Promise<T> {
    const startedAt = this.now();
    try {
      return await run();
    } finally {
      this.elapsed[phase] += this.now() - startedAt;
    }
  }

  phases(): LoopPhaseMs {
    return { ...this.elapsed };
  }
}

export function totalPhaseMs(phases: LoopPhaseMs): number {
  return LOOP_PHASES.reduce((sum, phase) => sum + phases[phase], 0);
}

/**
 * Tiempo de la iteracion que no cae en ninguna fase. Nunca negativo: el total se mide en un `finally`
 * exterior, asi que un redondeo puede dejarlo un pelo por debajo de la suma de las partes.
 */
export function unaccountedMs(totalMs: number, phases: LoopPhaseMs): number {
  return Math.max(0, totalMs - totalPhaseMs(phases));
}

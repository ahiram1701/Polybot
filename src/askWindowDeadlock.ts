import type { MarketSymbol } from "./types.js";

/**
 * Detecta que la ventana de ask configurada excluye TODAS las señales de un mercado.
 *
 * Es un fallo silencioso y permanente: cada señal se registra como un skip normal
 * (`no_ask_liquidity_under_cap`, `best_ask_above_cap`, `best_ask_below_floor`) y el bot sigue como si
 * nada, mientras ese mercado no puede operar nunca.
 *
 * Ocurrio de verdad: el autoajuste predictivo subio la distancia de BTC a 49 USD — lo que empuja el
 * lado del momentum a costar 0.96 o mas — mientras el autoajuste de ask bajaba el techo a 0.80. Cada
 * cambio era defendible por separado; juntos hacian imposible operar BTC. Nadie lo detecto porque
 * ningun componente comprobaba la COMBINACION.
 *
 * La causa raiz ya esta corregida (el motor de recomendaciones simula con la ventana real, asi que un
 * candidato imposible sale con cero operaciones y no se elige). Esto es la red de seguridad para el
 * caso de que una configuracion imposible llegue por otra via — un ajuste manual, por ejemplo.
 */

/** Señales seguidas fuera de la ventana antes de considerarlo un bloqueo y no mala suerte. */
export const DEADLOCK_STREAK = 40;

export interface AskWindowStatus {
  market: MarketSymbol;
  rejected: number;
  observedMinAsk: number;
  observedMaxAsk: number;
  floor: number;
  cap: number;
}

export class AskWindowDeadlockDetector {
  private readonly streaks = new Map<MarketSymbol, { rejected: number; min: number; max: number }>();
  private readonly reported = new Set<MarketSymbol>();

  /** Una señal que SI pudo entrar: la ventana funciona, se reinicia la racha. */
  recordAccepted(market: MarketSymbol): void {
    this.streaks.delete(market);
    this.reported.delete(market);
  }

  /**
   * Una señal rechazada por el precio. `ask` puede faltar (no habia liquidez bajo el tope), en cuyo
   * caso solo cuenta para la racha: sin precio observado no se puede afirmar cuanto habria que mover
   * la ventana.
   */
  recordRejected(market: MarketSymbol, ask?: number): AskWindowStatus | undefined {
    const streak = this.streaks.get(market) ?? { rejected: 0, min: Number.POSITIVE_INFINITY, max: 0 };
    streak.rejected += 1;
    if (ask !== undefined && Number.isFinite(ask)) {
      streak.min = Math.min(streak.min, ask);
      streak.max = Math.max(streak.max, ask);
    }
    this.streaks.set(market, streak);
    return undefined;
  }

  /**
   * `undefined` mientras no haya bloqueo o ya se haya avisado. Solo devuelve algo la primera vez que
   * se cruza el umbral, para no repetir el aviso en cada iteracion.
   */
  takeDeadlock(market: MarketSymbol, floor: number, cap: number): AskWindowStatus | undefined {
    const streak = this.streaks.get(market);
    if (!streak || streak.rejected < DEADLOCK_STREAK || this.reported.has(market)) {
      return undefined;
    }
    this.reported.add(market);
    return {
      market,
      rejected: streak.rejected,
      observedMinAsk: Number.isFinite(streak.min) ? streak.min : 0,
      observedMaxAsk: streak.max,
      floor,
      cap,
    };
  }
}

/** Mensaje accionable: dice el rango observado y hacia donde habria que mover la ventana. */
export function describeDeadlock(status: AskWindowStatus): string {
  const rango =
    status.observedMaxAsk > 0
      ? `los asks observados van de ${status.observedMinAsk.toFixed(2)} a ${status.observedMaxAsk.toFixed(2)}`
      : "no hubo liquidez bajo el tope en ninguna";
  return (
    `${status.market}: ${status.rejected} señales seguidas descartadas por precio con la ventana ` +
    `[${status.floor.toFixed(2)}, ${status.cap.toFixed(2)}] — ${rango}. ` +
    `Ese mercado no puede operar: o la ventana no cubre donde cotiza, o la distancia exigida es tan ` +
    `grande que el lado del momentum sale siempre caro.`
  );
}

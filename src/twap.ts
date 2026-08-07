/**
 * Precio medio ponderado por TIEMPO de una serie de ticks.
 *
 * Desde el 2026-08-07 Polymarket resuelve los up/down de cripto asi: la ventana gana "Up" si el TWAP
 * del rango es mayor o igual que el precio al INICIO del rango. Antes se comparaba el ultimo precio
 * contra la apertura, que es una regla completamente distinta — medido sobre el historico, cambia el
 * ganador en al menos el 11% de las ventanas.
 *
 * Ponderar por tiempo y no por numero de ticks es el punto entero. Los ticks no llegan a intervalos
 * regulares (el feed tiene huecos, y ademas la parte temprana de la ventana se submuestrea a
 * proposito), asi que una media aritmetica daria el mismo peso a un tick que representa 1 segundo que
 * a otro que representa 15. Eso no es el TWAP: es otro numero que se le parece.
 */
import type { AnalyticsTickPoint } from "./types.js";

export interface TwapPoint {
  timestampMs: number;
  price: number;
}

/**
 * TWAP por integracion trapezoidal, o `undefined` si no hay con que calcularlo.
 *
 * Un solo tick devuelve su propio precio: es la mejor estimacion disponible, aunque sin intervalo que
 * ponderar. Cero ticks devuelve `undefined` en vez de 0 — inventar un precio aqui es exactamente como
 * se cuelan los ceros que luego parecen caidas.
 */
export function timeWeightedAveragePrice(points: readonly TwapPoint[]): number | undefined {
  const ordenados = [...points]
    .filter((point) => Number.isFinite(point.price) && Number.isFinite(point.timestampMs))
    .sort((left, right) => left.timestampMs - right.timestampMs);
  if (ordenados.length === 0) {
    return undefined;
  }
  if (ordenados.length === 1) {
    return ordenados[0].price;
  }

  let area = 0;
  let duracionMs = 0;
  for (let i = 1; i < ordenados.length; i += 1) {
    const dt = ordenados[i].timestampMs - ordenados[i - 1].timestampMs;
    if (dt <= 0) {
      continue;
    }
    area += ((ordenados[i].price + ordenados[i - 1].price) / 2) * dt;
    duracionMs += dt;
  }
  // Todos los ticks con la misma marca de tiempo: no hay intervalo, pero si precio.
  return duracionMs > 0 ? area / duracionMs : ordenados[0].price;
}

export interface WindowTwap {
  twap: number;
  /** Fraccion de la ventana cubierta por ticks. Baja = el TWAP es una extrapolacion, no una medida. */
  coverage: number;
  firstTickMs: number;
  lastTickMs: number;
}

/**
 * TWAP de una ventana, con la COBERTURA al lado.
 *
 * La cobertura es tan importante como el numero. Hasta el 2026-08-07 solo se grababan los ultimos
 * 120s de cada ventana de 300s — cobertura del 37% — asi que un "TWAP" calculado sobre el historico
 * antiguo describe el ultimo tercio, no la ventana. Devolverlo sin decirlo seria presentar una
 * extrapolacion como una medida, que es justo el error que ya costo dinero con la profundidad del
 * libro.
 */
export function windowTwap(
  ticks: readonly AnalyticsTickPoint[],
  windowStartMs: number,
  endMs: number,
): WindowTwap | undefined {
  const dentro = ticks.filter((tick) => tick.timestampMs >= windowStartMs && tick.timestampMs <= endMs);
  const twap = timeWeightedAveragePrice(dentro);
  if (twap === undefined) {
    return undefined;
  }
  const duracion = endMs - windowStartMs;
  const primero = Math.min(...dentro.map((tick) => tick.timestampMs));
  const ultimo = Math.max(...dentro.map((tick) => tick.timestampMs));
  return {
    twap,
    coverage: duracion > 0 ? Math.min(1, (ultimo - primero) / duracion) : 0,
    firstTickMs: primero,
    lastTickMs: ultimo,
  };
}

/**
 * Cuanto tendria que apartarse el precio, de aqui al cierre, para que el TWAP final cruce la apertura.
 *
 * Es EL numero que hace util la regla nueva. A 40s del cierre de una ventana de 300s ya ha transcurrido
 * el 87% del promedio: para voltear el resultado, lo que queda tendria que moverse varias veces la
 * separacion actual y en sentido contrario. Dicho de otro modo, al entrar el resultado ya esta casi
 * decidido — y se puede calcular en vez de adivinar.
 *
 * Devuelve el precio que habria que mantener durante el tramo restante para dejar el TWAP final
 * exactamente en la apertura. `undefined` si no queda tiempo (ya no hay nada que mover).
 */
export function priceNeededToFlip(args: {
  twapSoFar: number;
  openingPrice: number;
  elapsedMs: number;
  remainingMs: number;
}): number | undefined {
  if (args.remainingMs <= 0 || args.elapsedMs <= 0) {
    return undefined;
  }
  const total = args.elapsedMs + args.remainingMs;
  // twapFinal = (twapSoFar*elapsed + x*remaining) / total = opening  ->  despejar x
  return (args.openingPrice * total - args.twapSoFar * args.elapsedMs) / args.remainingMs;
}

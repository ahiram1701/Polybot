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

/**
 * Movimiento de precio en 40s que solo se supera el 0,5% de las veces, en bps y por mercado.
 *
 * Medido sobre los ticks del historico (BTC n=302.129, ETH n=93.346, DOGE n=93.995). Los maximos
 * observados fueron 45,1 / 49,3 / 44,4 bps, asi que estos percentiles dejan mucho margen por debajo
 * de "imposible".
 *
 * Es deliberadamente CONSERVADOR para lo que se usa: mide cuanto puede moverse el precio en un
 * instante, mientras que voltear un TWAP exige SOSTENER un precio de media durante todo el tramo que
 * queda, que es mucho mas dificil. O sea que la probabilidad real de voltear es bastante menor que la
 * que sugiere este numero, y el veto se equivoca hacia el lado seguro.
 */
export const PLAUSIBLE_MOVE_BPS_40S: Record<string, number> = { BTC: 13.1, ETH: 17.8, DOGE: 17.7 };

const REFERENCE_HORIZON_MS = 40_000;

/**
 * Hasta donde se puede estirar la medida de 40s antes de que deje de ser una medida.
 *
 * El escalado por raiz del tiempo es razonable cerca del horizonte medido y pura fe lejos de el:
 * llevarlo a 270s seria hacerlo trabajar casi 7 veces mas alla de donde hay datos, y con eso el veto
 * declararia "decidido" a media ventana. Mas alla de este limite no se opina — que es distinto de
 * opinar que no esta decidido.
 *
 * No estorba en la practica: el bot entra a 34-42s del cierre, muy dentro del tramo medido.
 */
const MAX_DECIDED_REMAINING_MS = 90_000;

/** Movimiento plausible en el tramo restante. Escala con la raiz del tiempo, como la volatilidad. */
export function plausibleMoveBps(market: string, remainingMs: number): number {
  const base = PLAUSIBLE_MOVE_BPS_40S[market] ?? 20;
  return base * Math.sqrt(Math.max(0, remainingMs) / REFERENCE_HORIZON_MS);
}

export interface TwapVerdict {
  /** Ganador si la ventana cerrase con el TWAP actual. */
  leader: "UP" | "DOWN";
  twapSoFar: number;
  /** Cuanto tendria que apartarse el precio, en bps, para que el TWAP final cruce la apertura. */
  requiredMoveBps: number;
  plausibleMoveBps: number;
  /** El movimiento necesario esta fuera de lo que este mercado hace en ese tiempo. */
  decided: boolean;
}

/**
 * NO USAR PARA DECIDIR ENTRADAS. Se construyo sobre una lectura equivocada de las reglas y se retiro
 * del camino de decision el 2026-08-08; se conserva solo como feature de analitica.
 *
 * El error: se asumio que la ventana la decide el promedio de los 300 segundos, y de ahi salia que al
 * entrar "el 87% ya estaba decidido". Es falso. El config del mercado dice
 * `twapLookbackSeconds: 30` (60 en los de 15m) y la documentacion lo confirma — "the 30-second and
 * 60-second values are LOOKBACK WINDOWS, not publication cadences". La referencia es una media corta
 * en cada extremo, asi que a 40s del cierre la ventana que decide ni siquiera ha empezado.
 *
 * Ademas la documentacion pide expresamente NO reconstruir el valor ("do not independently reproduce
 * the value without a specification from Chainlink"): Polymarket publica la serie ya calculada.
 *
 * Que dice el TWAP EN CURSO sobre como va a acabar la ventana.
 *
 * Es la consecuencia util del cambio de Polymarket. A 40s del cierre de una ventana de 300s ya ha
 * transcurrido el 87% del promedio: para voltear el resultado, el tramo restante tendria que
 * sostener un precio ~6,5 veces mas lejos que la separacion actual. Dicho de otro modo, al entrar el
 * resultado ya suele estar decidido — y ahora se puede CALCULAR en vez de estimarlo con momentum.
 *
 * `undefined` cuando no hay cobertura suficiente: un TWAP sobre medio rango no es el TWAP del rango,
 * y actuar sobre el seria peor que no mirarlo, porque parece un dato.
 */
export function twapVerdict(args: {
  market: string;
  ticks: readonly AnalyticsTickPoint[];
  openingPrice: number;
  windowStartMs: number;
  endMs: number;
  nowMs: number;
  minCoverage: number;
}): TwapVerdict | undefined {
  const hastaAhora = args.ticks.filter((tick) => tick.timestampMs <= args.nowMs);
  const medida = windowTwap(hastaAhora, args.windowStartMs, args.nowMs);
  if (!medida || !(args.openingPrice > 0)) {
    return undefined;
  }
  const elapsedMs = args.nowMs - args.windowStartMs;
  const remainingMs = args.endMs - args.nowMs;
  if (elapsedMs <= 0 || remainingMs <= 0) {
    return undefined;
  }
  // La cobertura se mide sobre lo TRANSCURRIDO, no sobre la ventana entera: a mitad de ventana lo
  // maximo posible es la mitad, y exigir la ventana completa apagaria el veto justo cuando sirve.
  const cubierto = (medida.lastTickMs - medida.firstTickMs) / elapsedMs;
  if (cubierto < args.minCoverage) {
    return undefined;
  }

  const precioParaVoltear = priceNeededToFlip({
    twapSoFar: medida.twap,
    openingPrice: args.openingPrice,
    elapsedMs,
    remainingMs,
  });
  if (precioParaVoltear === undefined) {
    return undefined;
  }
  const ultimoPrecio = hastaAhora[hastaAhora.length - 1]?.price ?? medida.twap;
  const requiredMoveBps = (Math.abs(precioParaVoltear - ultimoPrecio) / ultimoPrecio) * 10_000;
  const plausible = plausibleMoveBps(args.market, remainingMs);
  return {
    leader: medida.twap >= args.openingPrice ? "UP" : "DOWN",
    twapSoFar: medida.twap,
    requiredMoveBps,
    plausibleMoveBps: plausible,
    decided: remainingMs <= MAX_DECIDED_REMAINING_MS && requiredMoveBps > plausible,
  };
}

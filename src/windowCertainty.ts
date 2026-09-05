import type { Outcome } from "./types.js";

/**
 * Cuanto de DECIDIDA esta ya una ventana, en unidades de lo que todavia puede moverse.
 *
 * La estrategia del favorito no es "predecir hacia donde va": es subirse a lo que ya va ganando cuando
 * es casi seguro que va a ganar. Esa frase tiene una traduccion exacta, y es esta:
 *
 *     z = distancia al strike / (sigma por segundo x raiz de los segundos que quedan)
 *
 * El denominador es cuanto se espera que el precio se mueva en el tiempo que falta. Asi que z dice, en
 * una sola cifra, "cuantos movimientos tipicos tendria que hacer el precio EN CONTRA para darle la
 * vuelta a esto". Un z de 2 con quince segundos por delante y un z de 2 con cuatro minutos son la
 * misma certeza, aunque la distancia en dolares sea completamente distinta.
 *
 * Por que hace falta un modulo nuevo si el bot ya mide la distancia: la mide en DOLARES, y la filtra
 * con umbrales fijos por mercado (`minDistanceUsdByMarket`: BTC 20, ETH 0,1, DOGE 0,00003). Esos
 * numeros no son comparables entre mercados —dependen de la escala del precio— ni entre el principio y
 * el final de la ventana, que es donde toda la diferencia esta. Normalizar por `sigma x raiz(T)` es lo
 * unico que convierte esa medida ya existente en la que separa las ventanas que ganan de las que no.
 *
 * Medido sobre 1.484 ventanas de `data/analytics.jsonl`, aguantando hasta el cierre:
 *
 *   umbral z    operaciones   aciertos   neto por operacion   1a mitad   2a mitad (fuera de muestra)
 *   sin filtro       1484       70,4%         -0,0670          -0,1391        +0,0051
 *   z >= 0,5          508       82,5%         +0,2301          +0,1201        +0,3481
 *   z >= 1,0          152       91,4%         +0,4623          +0,2355        +0,6610
 *   z >= 1,5           43      100,0%         +0,7372          +0,3882        +0,9885
 *
 * Monotono y positivo en las DOS mitades. Con z >= 1 el favorito acierta el 91,4% mientras el precio
 * medio del libro (0,83) solo cobra el 84,4%: el mercado infravalora la certeza. Y al reves, con z < 0
 * —el precio ya cruzado al lado malo pero el libro todavia marcando favorito— el acierto cae al 53,4%
 * contra un 62,0% de equilibrio. Esas son las que sangran.
 */
export interface WindowCertainty {
  /** Distancia al strike en unidades de lo que aun puede moverse. Signo A FAVOR del lado que se mira. */
  z: number;
  /** La distancia cruda, con signo a favor del lado. Se expone para el log: z sin ella no se audita. */
  distanceUsd: number;
  sigmaPorSegundo: number;
  segundosAlCierre: number;
  /** Cuantos saltos entraron en la estimacion de sigma. Pocos = lectura ruidosa. */
  muestras: number;
}

/**
 * Minimo de saltos para estimar la volatilidad.
 *
 * Con menos, la desviacion tipica es mas ruido que medida y z sale de un denominador inventado. Seis
 * es lo que hay al principio de una ventana con el feed a ~5s por tick, o sea el punto donde la
 * lectura empieza a significar algo.
 */
export const DEFAULT_MIN_MUESTRAS = 6;

/**
 * Cuanta historia se mira para estimar sigma, en segundos.
 *
 * Tres minutos: suficiente para que la desviacion tipica no dependa de dos saltos sueltos, y lo
 * bastante corto para que siga siendo la volatilidad de AHORA. Un mercado de 5 minutos que se agita en
 * el ultimo minuto no se parece al de hace media hora.
 */
export const DEFAULT_HISTORIA_SEGUNDOS = 180;

export function readWindowCertainty(args: {
  /** Historia de la ventana, en cualquier orden: se ordena aqui. */
  ticks: ReadonlyArray<{ timestampMs: number; value: number }>;
  /** El precio de apertura contra el que resuelve el mercado. */
  openingPrice: number;
  /** El lado cuya certeza se pregunta. El signo de `z` sale a favor de ESTE lado. */
  outcome: Outcome;
  nowMs: number;
  endMs: number;
  minMuestras?: number;
  historiaSegundos?: number;
}): WindowCertainty | undefined {
  const segundosAlCierre = (args.endMs - args.nowMs) / 1000;
  if (!Number.isFinite(segundosAlCierre) || segundosAlCierre <= 0) {
    return undefined;
  }
  if (!Number.isFinite(args.openingPrice) || args.openingPrice <= 0) {
    return undefined;
  }

  const minMuestras = resolveEntero(args.minMuestras, DEFAULT_MIN_MUESTRAS);
  const historiaMs = resolvePositivo(args.historiaSegundos, DEFAULT_HISTORIA_SEGUNDOS) * 1000;

  const serie = args.ticks
    .filter((t) => Number.isFinite(t.timestampMs) && Number.isFinite(t.value) && t.value > 0)
    .filter((t) => t.timestampMs <= args.nowMs && t.timestampMs >= args.nowMs - historiaMs)
    .sort((a, b) => a.timestampMs - b.timestampMs);
  if (serie.length < minMuestras + 1) {
    return undefined;
  }

  // Saltos normalizados por raiz del tiempo: es lo que hace comparables dos intervalos de duracion
  // distinta. El feed no entrega ticks a cadencia fija, asi que sin esto la sigma dependeria de cuando
  // llegaron los mensajes y no de cuanto se movio el precio.
  const saltos: number[] = [];
  for (let i = 1; i < serie.length; i += 1) {
    const dtSegundos = (serie[i].timestampMs - serie[i - 1].timestampMs) / 1000;
    if (dtSegundos > 0) {
      saltos.push((serie[i].value - serie[i - 1].value) / Math.sqrt(dtSegundos));
    }
  }
  if (saltos.length < minMuestras) {
    return undefined;
  }

  const media = saltos.reduce((suma, x) => suma + x, 0) / saltos.length;
  const varianza = saltos.reduce((suma, x) => suma + (x - media) ** 2, 0) / (saltos.length - 1);
  const sigmaPorSegundo = Math.sqrt(varianza);
  // Una sigma de cero no es "certeza infinita", es un feed congelado repitiendo el mismo valor. Dejarla
  // pasar daria z infinito y convertiria una averia en la señal mas fuerte posible.
  if (!Number.isFinite(sigmaPorSegundo) || sigmaPorSegundo <= 0) {
    return undefined;
  }

  const ultimo = serie[serie.length - 1].value;
  const bruta = ultimo - args.openingPrice;
  const distanceUsd = args.outcome === "UP" ? bruta : -bruta;

  return {
    z: distanceUsd / (sigmaPorSegundo * Math.sqrt(segundosAlCierre)),
    distanceUsd,
    sigmaPorSegundo,
    segundosAlCierre,
    muestras: saltos.length,
  };
}

function resolveEntero(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback;
}

function resolvePositivo(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

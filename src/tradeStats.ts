/**
 * Medidas honestas para evaluar una corrida de trades.
 *
 * Existe porque la evaluacion anterior estaba sesgada: se usaba "quitar los 5 mejores" como prueba de
 * que el resultado era suerte. Pero las perdidas de Polybot estan TOPADAS en el stake (-$5) mientras
 * las ganancias llegan a +$14, asi que recortar UNA SOLA cola penaliza estructuralmente a cualquier
 * estrategia con downside limitado. Medido sobre 116 trades reales: quitar los 5 mejores costaba
 * $51.65 y quitar los 5 peores solo devolvia $25.00 — el doble de impacto por el mismo numero de
 * operaciones. Con el recorte simetrico el resultado pasaba de -$3.07 a +$21.93.
 *
 * Por la misma razon el estadistico t es flojo aqui: asume normalidad y esta distribucion es asimetrica
 * por construccion. El bootstrap no asume forma alguna, asi que es la vara correcta.
 */

export interface TrimmedResult {
  /** Neto tras recortar `k` operaciones por CADA cola. */
  netUsd: number;
  /** Cuantas quedaron dentro del recorte. */
  count: number;
  trimmedPerTail: number;
}

/**
 * Recorta las `k` mejores Y las `k` peores. Recortar solo la cola alta es la trampa que motiva este
 * modulo. Si no quedan suficientes operaciones, devuelve el total sin recortar.
 */
export function trimmedNet(nets: number[], k = 5): TrimmedResult {
  if (k <= 0 || nets.length <= 2 * k) {
    return { netUsd: sum(nets), count: nets.length, trimmedPerTail: 0 };
  }
  const sorted = [...nets].sort((a, b) => a - b);
  const kept = sorted.slice(k, sorted.length - k);
  return { netUsd: sum(kept), count: kept.length, trimmedPerTail: k };
}

export interface BootstrapCI {
  /** Neto medio observado. */
  meanUsd: number;
  lowerUsd: number;
  upperUsd: number;
  /** Fraccion de remuestreos con neto TOTAL positivo: "que tan seguido esto sale ganando". */
  positiveShare: number;
}

/**
 * Intervalo de confianza por remuestreo sobre el NETO TOTAL de la corrida (no sobre la media por
 * trade), que es la cifra que al usuario le importa. Determinista: usa un PRNG sembrado para que dos
 * corridas sobre los mismos datos den el mismo numero y las decisiones sean reproducibles.
 */
export function bootstrapCI(nets: number[], options: { iterations?: number; seed?: number; confidence?: number } = {}): BootstrapCI {
  const iterations = options.iterations ?? 5_000;
  const confidence = options.confidence ?? 0.95;
  const n = nets.length;
  if (n === 0) {
    return { meanUsd: 0, lowerUsd: 0, upperUsd: 0, positiveShare: 0 };
  }
  const rand = mulberry32(options.seed ?? 12345);
  const totals: number[] = [];
  let positives = 0;
  for (let iter = 0; iter < iterations; iter += 1) {
    let total = 0;
    for (let i = 0; i < n; i += 1) {
      total += nets[Math.floor(rand() * n)];
    }
    totals.push(total);
    if (total > 0) positives += 1;
  }
  totals.sort((a, b) => a - b);
  const tail = (1 - confidence) / 2;
  return {
    meanUsd: sum(nets),
    lowerUsd: totals[Math.floor(tail * iterations)],
    upperUsd: totals[Math.min(iterations - 1, Math.floor((1 - tail) * iterations))],
    positiveShare: positives / iterations,
  };
}

export interface WinLossProfile {
  wins: number;
  losses: number;
  averageWinUsd: number;
  averageLossUsd: number;
  /** |ganancia media| / |perdida media|. ~1 = pagos simetricos en promedio. */
  payoffRatio: number;
  /** Mayor ganancia y mayor perdida: revela si la cola alta es mas larga que la baja. */
  bestUsd: number;
  worstUsd: number;
}

export function winLossProfile(nets: number[]): WinLossProfile {
  const wins = nets.filter((x) => x > 0);
  const losses = nets.filter((x) => x <= 0);
  const averageWinUsd = wins.length > 0 ? sum(wins) / wins.length : 0;
  const averageLossUsd = losses.length > 0 ? sum(losses) / losses.length : 0;
  return {
    wins: wins.length,
    losses: losses.length,
    averageWinUsd,
    averageLossUsd,
    payoffRatio: averageLossUsd !== 0 ? Math.abs(averageWinUsd / averageLossUsd) : 0,
    bestUsd: nets.length > 0 ? Math.max(...nets) : 0,
    worstUsd: nets.length > 0 ? Math.min(...nets) : 0,
  };
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

/** PRNG pequeño y sembrable: el bootstrap tiene que ser reproducible para decidir sobre el. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

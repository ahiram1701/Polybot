/**
 * Modelo direccional probabilistico: estima P(gana este lado) desde la FORMA de la ventana, en vez
 * de la regla binaria actual ("¿se movio >= X en los ultimos N segundos?" + win rate de una cubeta).
 *
 * Motivacion, medida en esta misma sesion: el gate actual tira casi toda la informacion disponible
 * (usa un numero, la distancia, y descarta trayectoria, volatilidad, spread y tiempo restante), su
 * discriminacion es pobre y depende de un umbral hecho a mano que el autoajuste movia sin parar.
 *
 * El ask entra como feature A PROPOSITO: el ask ES la probabilidad que el mercado ya asigna. Si el
 * modelo no logra superarlo fuera de muestra, no hay ventaja que extraer y eso tambien es una
 * respuesta. Todo aqui es puro y testeable; el entrenamiento walk-forward vive en el backtest.
 */
import type { AnalyticsSample, Outcome } from "./types.js";

export const FEATURE_NAMES = [
  "distanceNorm",
  "secondsToEnd",
  "velocityNorm",
  "volatility",
  "maxExcursionNorm",
  "reversals",
  "ask",
  "spread",
] as const;

export interface FeatureRow {
  x: number[];
  /** 1 si ese lado gano. */
  y: number;
  ask: number;
  windowStartMs: number;
}

function stdev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return Math.sqrt(values.reduce((a, v) => a + (v - mean) ** 2, 0) / (values.length - 1));
}

/**
 * Features observables en el instante de decision (`targetSecondsToEnd` antes del cierre). Solo usa
 * ticks y quotes ANTERIORES o iguales a ese instante: nada de mirar al futuro.
 */
export function extractFeatures(
  sample: AnalyticsSample,
  outcome: Outcome,
  targetSecondsToEnd: number,
): FeatureRow | undefined {
  if (!sample.winningOutcome || !Number.isFinite(sample.openingPrice) || sample.openingPrice <= 0) {
    return undefined;
  }
  const ticks = sample.ticks.filter((tick) => tick.secondsToEnd >= targetSecondsToEnd);
  if (ticks.length < 3) {
    return undefined;
  }
  const quotes = sample.quotes.filter((quote) => quote.secondsToEnd >= targetSecondsToEnd);
  const quote = quotes[quotes.length - 1];
  const ask = outcome === "UP" ? quote?.upBestAsk : quote?.downBestAsk;
  const bid = outcome === "UP" ? quote?.upBestBid : quote?.downBestBid;
  if (!Number.isFinite(ask) || (ask as number) <= 0 || (ask as number) >= 1) {
    return undefined;
  }

  const prices = ticks.map((tick) => tick.price);
  const last = prices[prices.length - 1];
  const diffs = prices.slice(1).map((price, index) => price - prices[index]);
  // Volatilidad en unidades relativas al precio de apertura, para que BTC/ETH/DOGE sean comparables.
  const vol = Math.max(stdev(diffs) / sample.openingPrice, 1e-9);
  const sign = outcome === "UP" ? 1 : -1;

  const distanceNorm = ((last - sample.openingPrice) / sample.openingPrice / vol) * sign;
  // Velocidad reciente: ultimos ~5 ticks, tambien normalizada.
  const recent = prices.slice(-6);
  const velocityNorm =
    recent.length >= 2
      ? (((recent[recent.length - 1] - recent[0]) / sample.openingPrice) / vol / (recent.length - 1)) * sign
      : 0;
  const excursions = prices.map((price) => ((price - sample.openingPrice) / sample.openingPrice) * sign);
  const maxExcursionNorm = Math.max(...excursions) / vol;
  let reversals = 0;
  for (let i = 1; i < diffs.length; i += 1) {
    if (diffs[i] !== 0 && diffs[i - 1] !== 0 && Math.sign(diffs[i]) !== Math.sign(diffs[i - 1])) {
      reversals += 1;
    }
  }

  return {
    x: [
      distanceNorm,
      targetSecondsToEnd,
      velocityNorm,
      vol * 1000, // escala legible
      maxExcursionNorm,
      reversals / Math.max(1, diffs.length),
      ask as number,
      Number.isFinite(bid) ? (ask as number) - (bid as number) : 0,
    ],
    y: sample.winningOutcome === outcome ? 1 : 0,
    ask: ask as number,
    windowStartMs: sample.windowStartMs,
  };
}

export interface LogisticModel {
  weights: number[];
  bias: number;
  mean: number[];
  scale: number[];
}

const sigmoid = (z: number): number => 1 / (1 + Math.exp(-Math.max(-30, Math.min(30, z))));

/**
 * Regresion logistica con L2, descenso de gradiente sobre features estandarizadas. Deliberadamente
 * simple: con unos miles de muestras y 8 features, algo mas expresivo se sobreajusta — y esta sesion
 * ya demostro lo facil que es engañarse aqui.
 */
export function fitLogistic(
  rows: FeatureRow[],
  options: { iterations?: number; learningRate?: number; l2?: number } = {},
): LogisticModel {
  const iterations = options.iterations ?? 400;
  const learningRate = options.learningRate ?? 0.3;
  const l2 = options.l2 ?? 1e-3;
  const dim = rows[0]?.x.length ?? 0;
  const mean = Array.from({ length: dim }, (_v, j) => rows.reduce((a, r) => a + r.x[j], 0) / rows.length);
  const scale = Array.from({ length: dim }, (_v, j) => {
    const s = stdev(rows.map((r) => r.x[j]));
    return s > 1e-9 ? s : 1;
  });
  const norm = (x: number[]): number[] => x.map((v, j) => (v - mean[j]) / scale[j]);

  const weights = new Array<number>(dim).fill(0);
  let bias = 0;
  const xs = rows.map((r) => norm(r.x));
  for (let iter = 0; iter < iterations; iter += 1) {
    const gradW = new Array<number>(dim).fill(0);
    let gradB = 0;
    for (let i = 0; i < rows.length; i += 1) {
      let z = bias;
      for (let j = 0; j < dim; j += 1) z += weights[j] * xs[i][j];
      const err = sigmoid(z) - rows[i].y;
      for (let j = 0; j < dim; j += 1) gradW[j] += err * xs[i][j];
      gradB += err;
    }
    for (let j = 0; j < dim; j += 1) {
      weights[j] -= learningRate * (gradW[j] / rows.length + l2 * weights[j]);
    }
    bias -= learningRate * (gradB / rows.length);
  }
  return { weights, bias, mean, scale };
}

export function predictLogistic(model: LogisticModel, x: number[]): number {
  let z = model.bias;
  for (let j = 0; j < model.weights.length; j += 1) {
    z += model.weights[j] * ((x[j] - model.mean[j]) / model.scale[j]);
  }
  return sigmoid(z);
}

/** Log-loss: la vara honesta para comparar probabilidades (penaliza la confianza equivocada). */
export function logLoss(predictions: number[], labels: number[]): number {
  let total = 0;
  for (let i = 0; i < predictions.length; i += 1) {
    const p = Math.min(Math.max(predictions[i], 1e-6), 1 - 1e-6);
    total += -(labels[i] * Math.log(p) + (1 - labels[i]) * Math.log(1 - p));
  }
  return total / Math.max(1, predictions.length);
}

/**
 * Expansion no lineal: cuadrados e interacciones con el ask. Una regresion logistica sobre estas
 * features puede representar relaciones curvas y condicionales ("el momentum importa SOLO cuando el
 * ask esta barato"), que es justo lo que un modelo lineal no puede expresar. Es la forma mas barata
 * de preguntar si la linealidad era la limitacion, sin traer un arbol ni una dependencia nueva.
 */
export function expandFeatures(x: number[]): number[] {
  const ask = x[6];
  const out = [...x];
  // Cuadrados de las features direccionales (curvatura).
  for (const j of [0, 2, 4]) {
    out.push(x[j] * x[j]);
  }
  // Interacciones con el ask: deja que el peso del momentum dependa del precio.
  for (const j of [0, 2, 3, 4]) {
    out.push(x[j] * ask);
  }
  return out;
}


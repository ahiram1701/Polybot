import type { AnalyticsSample, Outcome } from "./types.js";

/**
 * QUIEN GANO DE VERDAD una ventana de analitica.
 *
 * `sample.winningOutcome` NO sirve para puntuar una estrategia: lo calcula el propio bot como
 * `finalPrice >= openingPrice` usando SU tick de apertura, que se captura con una tolerancia de
 * varios segundos alrededor del inicio de ventana (mediana ~-4s en ETH/DOGE). Contrastado contra la
 * resolucion oficial de Polymarket se equivoca en el 12.5% de los casos (ETH: 13.7%), y los fallos se
 * concentran justo donde el movimiento es pequeño — que es exactamente donde entra el bot.
 *
 * El problema no es solo de medicion: la etiqueta se deriva del MISMO precio de apertura que genera
 * la señal, asi que cuando la apertura esta desviada, la señal y la etiqueta se equivocan JUNTAS y en
 * la misma direccion. Un backtest puntuado con ella se auto-confirma y muestra un edge que no existe
 * (medido: +74% ROI con la etiqueta propia vs -2.7% con un juez independiente sobre las mismas
 * entradas).
 *
 * El juez independiente es el propio libro de ordenes: en los ultimos segundos converge a 0/1, asi
 * que el lado que cotiza caro es el ganador. Validado contra la resolucion oficial: 98.6% de acierto
 * con confianza >=0.98 (cobertura 83% de las muestras), 97.3% con >=0.9 (cobertura 91%).
 */
export interface SampleTruth {
  outcome: Outcome;
  /** |P(UP) - P(DOWN)| implicita en el libro: 1 = totalmente resuelto, 0 = empate. */
  confidence: number;
  secondsToEnd: number;
}

export const DEFAULT_TRUTH_CONFIDENCE = 0.98;

/**
 * Ganador implicito en el libro de ordenes al cierre, o `undefined` si el libro nunca fue lo bastante
 * concluyente (empate real o datos incompletos). NUNCA inventa un ganador: quien llama debe decidir
 * que hacer con las ventanas sin veredicto en lugar de asumir que se ganaron.
 */
export function resolveSampleTruth(
  sample: AnalyticsSample,
  minConfidence = DEFAULT_TRUTH_CONFIDENCE,
  maxSecondsToEnd = 30,
): SampleTruth | undefined {
  const near = sample.quotes
    .filter((quote) => quote.secondsToEnd >= 0 && quote.secondsToEnd <= maxSecondsToEnd)
    .sort((left, right) => left.secondsToEnd - right.secondsToEnd);

  for (const quote of near) {
    const up = midPrice(quote.upBestBid, quote.upBestAsk);
    const down = midPrice(quote.downBestBid, quote.downBestAsk);
    // Un solo lado basta: el par es complementario, si UP cotiza ~0.99 el ganador es UP.
    const upScore = up ?? (down !== undefined ? 1 - down : undefined);
    const downScore = down ?? (up !== undefined ? 1 - up : undefined);
    if (upScore === undefined || downScore === undefined) {
      continue;
    }
    const confidence = Math.abs(upScore - downScore);
    if (confidence < minConfidence) {
      continue;
    }
    return {
      outcome: upScore > downScore ? "UP" : "DOWN",
      confidence,
      secondsToEnd: quote.secondsToEnd,
    };
  }
  return undefined;
}

/**
 * El ganador que se debe usar para PUNTUAR una muestra (entrenar el modelo, medir win rate, calcular
 * EV). Devuelve `undefined` cuando no hay veredicto fiable: esa muestra no debe entrenar nada.
 *
 * Deliberadamente NO cae de vuelta a `sample.winningOutcome`. Ese fallback seria peor que descartar
 * la muestra: sus errores no son aleatorios, van correlacionados con la señal (misma apertura mal
 * medida), asi que meterlos ENSEÑA al modelo justo el sesgo que le hace comprar barato lo que pierde.
 * Con un 83-91% de cobertura sobran muestras para no necesitar las dudosas.
 */
export function scoringOutcome(
  sample: AnalyticsSample,
  minConfidence = DEFAULT_TRUTH_CONFIDENCE,
): Outcome | undefined {
  return resolveSampleTruth(sample, minConfidence)?.outcome;
}

function midPrice(bid: number | undefined, ask: number | undefined): number | undefined {
  if (bid != null && ask != null) {
    return (bid + ask) / 2;
  }
  return bid ?? ask;
}

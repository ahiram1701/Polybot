import { BAND_EDGES } from "./askBands.js";
import { defaultTakerFeeRateBps } from "./fees.js";
import { simulateGate, summarizeGateTrades, type GateOutcome, type HistoricalSignal } from "./gateSimulation.js";
import type { MarketSymbol, Outcome } from "./types.js";

/**
 * Evalua CADA banda de ask sobre el historico de analitica, se haya operado o no.
 *
 * Es la pieza que le faltaba al autoajuste. Su unica fuente era `summarizeAskBands`, que filtra el
 * ledger de trades EJECUTADOS; como el bot nunca opera fuera de su ventana, una banda fuera de ella
 * tiene n=0 y no puede evaluarse jamas. Con el techo de BTC en 0,80, la banda 0,85-0,92 — que resulto
 * valer +$15 — era literalmente invisible.
 *
 * Aqui la fuente son las ~20k ventanas observadas, que existen se opere o no, y el juez es el gate de
 * produccion (`simulateGate`), no un modelo simplificado.
 *
 * AVISO que condiciona como se usa esto: la analitica anterior a 2026-08-06 guarda solo el MEJOR
 * precio del libro, asi que sobre esas muestras la simulacion asume relleno perfecto y gratis. Cerca
 * del cierre el libro se adelgaza, o sea que es mas optimista justo donde la realidad es peor. Por eso
 * esto PROPONE y no decide: abrir una banda exige ademas sondeos reales.
 */

export interface CounterfactualBand {
  lo: number;
  hi: number;
  /** Todo el periodo. */
  overall: GateOutcome;
  /** Primera mitad cronologica: la que elige. */
  inSample: GateOutcome;
  /** Segunda mitad: la que confirma. Una banda que solo gana en la primera es ruido de barrido. */
  outOfSample: GateOutcome;
}

export interface CounterfactualParams {
  safetyMargin: number;
  minExpectedRoi: number;
  stakeUsd: number;
  rejectEdgeAbove?: number;
}

/** Motor de analisis, inyectado para poder probar esto sin leer 252 MB de disco. */
export interface SignalSource {
  replaySignals(
    market: MarketSymbol,
    outcome: Outcome,
    params: { entryWindowSeconds: number; minDistanceUsd: number },
    quotesAtOrBefore?: boolean,
  ): Promise<HistoricalSignal[]>;
}

const OUTCOMES: Outcome[] = ["UP", "DOWN"];

export async function evaluateBandsCounterfactually(
  source: SignalSource,
  market: MarketSymbol,
  entry: { entryWindowSeconds: number; minDistanceUsd: number },
  params: CounterfactualParams,
): Promise<CounterfactualBand[]> {
  // `quotesAtOrBefore = true` SIEMPRE: emparejar por cercania puede coger un quote posterior a la
  // señal, que es informacion que el bot no tenia al decidir. Comparar configuraciones con datos del
  // futuro es como se fabrican ventajas que luego no existen.
  const signals: HistoricalSignal[] = [];
  for (const outcome of OUTCOMES) {
    signals.push(...(await source.replaySignals(market, outcome, entry, true)));
  }
  signals.sort((left, right) => left.windowStartMs - right.windowStartMs);

  const feeRateBps = defaultTakerFeeRateBps(market);
  const corte = medianaTemporal(signals);
  const bandas: CounterfactualBand[] = [];

  for (let i = 0; i < BAND_EDGES.length - 1; i += 1) {
    const lo = BAND_EDGES[i];
    const hi = BAND_EDGES[i + 1];
    const trades = simulateGate(signals, {
      minAsk: lo,
      maxAsk: hi,
      safetyMargin: params.safetyMargin,
      minExpectedRoi: params.minExpectedRoi,
      stakeUsd: params.stakeUsd,
      feeRateBps,
      rejectEdgeAbove: params.rejectEdgeAbove,
    });
    bandas.push({
      lo,
      hi,
      overall: summarizeGateTrades(trades),
      inSample: summarizeGateTrades(trades.filter((trade) => trade.windowStartMs < corte)),
      outOfSample: summarizeGateTrades(trades.filter((trade) => trade.windowStartMs >= corte)),
    });
  }
  return bandas;
}

/**
 * Corte por la MITAD CRONOLOGICA de las señales, no por la mitad del calendario: los periodos con
 * pocas señales dejarian una de las dos mitades casi vacia y la confirmacion no significaria nada.
 */
function medianaTemporal(signals: readonly HistoricalSignal[]): number {
  if (signals.length === 0) {
    return 0;
  }
  return signals[Math.floor(signals.length / 2)].windowStartMs;
}

export interface BandProposal {
  lo: number;
  hi: number;
  /** Neto por operacion que la banda promete, medido FUERA de muestra. Es lo que hay que cumplir. */
  expectedNetPerTradeUsd: number;
  outOfSampleTrades: number;
  reason: string;
}

/** Operaciones minimas fuera de muestra para que una banda pueda proponerse siquiera. */
export const MIN_OUT_OF_SAMPLE_TRADES = 30;

/**
 * t minimo del neto por operacion fuera de muestra.
 *
 * El "gana en ambas mitades" a secas no basta en la zona de ask alto, que es justo donde mas bandas
 * aparecen: ahi se acierta el 99% cobrando poco y se pierde todo en las raras, asi que un neto positivo
 * puede ser suerte — se vio en ETH 0,90-0,94, que daba -$7,32 dentro de muestra y +$24,17 fuera. Un
 * cambio de signo asi entre mitades es la firma del ruido, no de una ventaja.
 */
export const MIN_OUT_OF_SAMPLE_T = 1.5;

/**
 * Neto minimo por operacion para que merezca la pena sondear.
 *
 * No es un filtro estadistico sino economico: confirmar una banda cuesta una o dos semanas de sondeos
 * acotados, y gastarlas en algo que promete $0,04 por operacion es tirar el tiempo aunque sea real.
 */
export const MIN_ECONOMIC_NET_PER_TRADE_USD = 0.1;

/**
 * Bandas que estan FUERA de la ventana en vigor y que se ganaron el derecho a ser sondeadas.
 *
 * El liston es deliberadamente asimetrico respecto al de estrechar. Estrechar se justifica con
 * evidencia de perdida realizada, que es barata y fiable; abrir apuesta dinero contra una simulacion
 * que sabemos optimista, asi que se exige que la banda gane en las DOS mitades del historico. Una que
 * solo gana en la primera es la maldicion del ganador — se elige porque tuvo suerte — y esa version del
 * autoajuste ya perdio $28,55 en replay.
 */
export function proposeBandsToProbe(
  bands: readonly CounterfactualBand[],
  currentWindow: { floor: number; cap: number },
  minOutOfSampleTrades = MIN_OUT_OF_SAMPLE_TRADES,
): BandProposal[] {
  const propuestas: BandProposal[] = [];
  for (const band of bands) {
    const yaOperada = band.lo >= currentWindow.floor && band.hi <= currentWindow.cap;
    if (yaOperada) {
      continue;
    }
    if (band.outOfSample.trades < minOutOfSampleTrades) {
      continue;
    }
    if (band.inSample.netUsd <= 0 || band.outOfSample.netUsd <= 0) {
      continue;
    }
    if ((band.outOfSample.tStat ?? 0) < MIN_OUT_OF_SAMPLE_T) {
      continue;
    }
    if ((band.outOfSample.netPerTradeUsd ?? 0) < MIN_ECONOMIC_NET_PER_TRADE_USD) {
      continue;
    }
    propuestas.push({
      lo: band.lo,
      hi: band.hi,
      expectedNetPerTradeUsd: band.outOfSample.netUsd / band.outOfSample.trades,
      outOfSampleTrades: band.outOfSample.trades,
      reason:
        `Gana en ambas mitades: dentro $${band.inSample.netUsd.toFixed(2)} (n=${band.inSample.trades}), ` +
        `fuera $${band.outOfSample.netUsd.toFixed(2)} (n=${band.outOfSample.trades}, t=${(band.outOfSample.tStat ?? 0).toFixed(1)})`,
    });
  }
  return propuestas;
}

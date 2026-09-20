import { scoringOutcome } from "./analyticsTruth.js";
import { calculateAdjustedWinProbability } from "./expectedValue.js";
import { selectFavoriteOutcome } from "./favoriteSelector.js";
import { calculateTradeFeeUsd, defaultTakerFeeRateBps } from "./fees.js";
import { readWindowCertainty } from "./windowCertainty.js";
import type {
  AnalyticsQuotePoint,
  AnalyticsSample,
  AnalyticsTickPoint,
  MarketSymbol,
  OrderbookQuote,
  Outcome,
} from "./types.js";

/**
 * El camino del FAVORITO, replicado sobre las ventanas ya observadas. UNA sola implementacion.
 *
 * Existe porque no habia ninguna. Todo el arsenal de backtest del repo —`gateReplay`, `outOfSample`,
 * `askBandScan`, `evGateBacktest`— cuelga de `StrategyAnalysisEngine.replaySignals`, que reconstruye
 * la señal con `findSignalTick`, o sea por distancia de Chainlink: el camino DIRECCIONAL. El favorito
 * elige lado por el precio del libro, asi que ese replay no lo ve. La consecuencia practica es que
 * cada ajuste del favorito se ha decidido con una tabla escrita a mano, cada una sobre un universo
 * distinto, sin particion fuera de muestra y sin poder comparar dos configuraciones entre si.
 *
 * Eso ya costo una conclusion equivocada. La tabla que justifica `FAVORITE_MIN_CERTAINTY=1` —91,4% de
 * aciertos, +0,4623 $/op— se midio sobre 1.484 ventanas "aguantando hasta el cierre", sin la ventana
 * de entrada ni la banda que produccion aplica. Restringida al universo que el bot opera de verdad,
 * esa misma ventaja se queda en +0,015 $/op y deja de ser monotona. La tabla no era falsa: medía otra
 * cosa. Este modulo existe para que la proxima no pueda hacerlo.
 *
 * REGLA DURA: aqui no se reimplementa ninguna decision, se LLAMA a la de produccion —
 * `selectFavoriteOutcome`, `readWindowCertainty`, `scoringOutcome`, `calculateTradeFeeUsd`. Es el
 * aviso que ya lleva escrito `gateSimulation.ts`: una tabla que evaluaba banda+momentum sin el gate
 * real declaro perdedora la ventana de DOGE, y al replicar el gate de verdad esos mismos trades
 * ganaban $24. Un modelo simplificado no responde la pregunta que se le hace, aunque lo parezca.
 *
 * Dos invariantes, y son las que hacen que el resultado signifique algo:
 *
 * 1. SIN LOOK-AHEAD. Solo entran quotes y ticks en o ANTES del instante evaluado. El emparejamiento
 *    por cercania de `findClosestQuote` puede elegir un libro hasta 12 s POSTERIOR a la decision, que
 *    es informacion que el bot no tenia — el mismo fallo que ya se corrigio en `getOpeningTick` y por
 *    el que `replaySignals` gano su `quotesAtOrBefore`.
 * 2. UNA ENTRADA POR VENTANA, la primera que califica. Es lo que hace el bot: `market_already_traded`
 *    cierra el tramo en cuanto opera. Evaluar todas las cotizaciones y quedarse con la mejor seria
 *    elegir con el diario del lunes.
 *
 * LO QUE ESTE REPLAY NO INCLUYE: el gate de EV (`evaluateExpectedValue`), que en produccion corre
 * DESPUES de todo esto. Queda fuera a proposito y no por simplificar — se compone: estas señales
 * llevan `predicted` calculado walk-forward, asi que pasarlas por `simulateGate` aplica el gate de EV
 * real sin duplicarlo. Medir las dos cosas por separado es justamente lo que enseña cuanto aporta,
 * que es la leccion de DOGE.
 */

export interface FavoriteReplayParams {
  /** Solo se mira dentro de los ultimos `entryWindowSeconds` de la ventana. En produccion, 120. */
  entryWindowSeconds: number;
  /** Suelo de la ventana: el bot no entra pegado al cierre (`minSecondsToEndForEntry`). */
  minSecondsToEnd: number;
  minAsk: number;
  maxAsk: number;
  maxAskSum: number;
  /** `DEFAULT_MAX_ASK_SPREAD` de `botRunner`. Ninguna tabla anterior del favorito lo incluia. */
  maxAskSpread: number;
  /**
   * `FAVORITE_MIN_CERTAINTY`. Con `-Infinity` el filtro queda apagado sin tocar el resto del camino,
   * que es la unica forma honesta de preguntar cuanto aporta: comparar contra "sin filtro" y no
   * contra otra configuracion que ademas cambia la banda.
   */
  minCertainty: number;
  /** Historia para estimar sigma. `CERTEZA_HISTORIA_MS / 1000` en produccion: 180. */
  historiaSegundos?: number;
}

/**
 * Una entrada que el favorito habria hecho. Es un `HistoricalSignal` de `gateSimulation` con el
 * contexto que hace falta para auditar la decision, asi que entra en `simulateGate` sin adaptadores.
 */
export interface FavoriteSignal {
  predicted: number;
  won: boolean;
  ask: number;
  windowStartMs: number;
  market: MarketSymbol;
  slug: string;
  outcome: Outcome;
  secondsToEnd: number;
  /** Certeza al entrar. `undefined` = no habia con que estimarla, y eso NO bloquea. */
  z?: number;
  /**
   * Que hay que acertar para empatar tras comision: `ask x (1 + tasa x (1 - ask))`.
   *
   * Viaja con la señal porque el acierto a secas no dice nada aqui. Un 84% suena bien y es una perdida
   * si el ask medio era 0,86: la unica cifra que informa es la VENTAJA, acierto menos esto.
   */
  breakEven: number;
}

/**
 * Por que no entro cada ventana.
 *
 * Sin esto, una configuracion que no opera nada es indistinguible de una averia del replay: las dos
 * se ven igual, cero trades.
 */
export type FavoriteReplaySkips = Record<string, number>;

export interface FavoriteReplayResult {
  signals: FavoriteSignal[];
  skips: FavoriteReplaySkips;
  /** Ventanas miradas. El denominador de la tasa de ejecucion. */
  windows: number;
}

/**
 * Las entradas que el favorito habria hecho, en orden cronologico.
 *
 * `predicted` se construye walk-forward y POR MERCADO: cada señal solo ve los aciertos de las
 * anteriores del suyo, igual que `replaySignals`. BTC no debe aprender de la racha de DOGE, y sin esa
 * separacion la probabilidad estimada se contamina con el futuro.
 */
export function replayFavoriteSignals(
  samples: readonly AnalyticsSample[],
  params: FavoriteReplayParams,
): FavoriteReplayResult {
  const replay = crearReplayFavorito(params);
  for (const sample of [...samples].sort((izq, der) => izq.windowStartMs - der.windowStartMs)) {
    replay.observa(sample);
  }
  return replay.resultado();
}

export interface ReplayFavoritoIncremental {
  /** Una ventana mas, y ya en orden cronologico. */
  observa(sample: AnalyticsSample): void;
  resultado(): FavoriteReplayResult;
}

/**
 * El mismo replay, pero muestra a muestra, para quien no puede tener todas a la vez en memoria.
 *
 * `replayFavoriteSignals` ordena y va llamando aqui: hay UNA sola implementacion de la decision. Lo que
 * cambia es quien manda las ventanas. El backtest sobre el historico completo son 1,3 GB de JSONL que no
 * caben como objetos en esta maquina (ver `analyticsStream.ts`), asi que las lee en flujo y las entrega
 * aqui de una en una.
 *
 * CONDICION: las ventanas tienen que llegar EN ORDEN. El historial que alimenta `predicted` es
 * walk-forward, o sea que una ventana solo debe ver las anteriores; darselas desordenadas le enseña el
 * futuro sin que nada chille.
 */
export function crearReplayFavorito(params: FavoriteReplayParams): ReplayFavoritoIncremental {
  const signals: FavoriteSignal[] = [];
  const skips: FavoriteReplaySkips = {};
  const historial = new Map<MarketSymbol, { wins: number; trades: number }>();
  let windows = 0;

  const anota = (motivo: string): void => {
    skips[motivo] = (skips[motivo] ?? 0) + 1;
  };

  const observa = (sample: AnalyticsSample): void => {
    windows += 1;
    // Sin veredicto fiable la muestra no puede puntuar nada. `scoringOutcome` NUNCA cae de vuelta a
    // `winningOutcome`: sus errores van correlacionados con la señal y enseñarian el sesgo entero.
    const verdad = scoringOutcome(sample);
    if (!verdad) {
      anota("sin_veredicto");
      return;
    }

    const entrada = primeraEntrada(sample, params);
    if (typeof entrada === "string") {
      anota(entrada);
      return;
    }

    const previo = historial.get(sample.market) ?? { wins: 0, trades: 0 };
    const won = entrada.outcome === verdad;
    // La primera de cada mercado solo alimenta el historial: sin nada previo no hay probabilidad que
    // estimar. Mismo corte que `replaySignals` y `simulateGate`.
    if (previo.trades > 0) {
      signals.push({
        predicted: calculateAdjustedWinProbability(previo.wins, previo.trades, entrada.ask),
        won,
        ask: entrada.ask,
        windowStartMs: sample.windowStartMs,
        market: sample.market,
        slug: sample.slug,
        outcome: entrada.outcome,
        secondsToEnd: entrada.secondsToEnd,
        z: entrada.z,
        breakEven: breakEvenWinRate(entrada.ask, entrada.feeRateBps),
      });
    }
    historial.set(sample.market, { wins: previo.wins + (won ? 1 : 0), trades: previo.trades + 1 });
  };

  return { observa, resultado: () => ({ signals, skips, windows }) };
}

interface Entrada {
  outcome: Outcome;
  ask: number;
  secondsToEnd: number;
  z?: number;
  feeRateBps: number;
}

/**
 * La PRIMERA cotizacion de la ventana que pasa el gate entero, o el motivo del ultimo descarte.
 *
 * Se recorre de mas a menos `secondsToEnd`, o sea hacia adelante en el tiempo: el bot entra en cuanto
 * puede y no espera a la mejor cotizacion de la ventana.
 */
function primeraEntrada(sample: AnalyticsSample, params: FavoriteReplayParams): Entrada | string {
  const dentro = sample.quotes
    .filter((punto) => punto.secondsToEnd <= params.entryWindowSeconds && punto.secondsToEnd >= params.minSecondsToEnd)
    .sort((izq, der) => der.secondsToEnd - izq.secondsToEnd);
  if (dentro.length === 0) {
    return "sin_quotes_en_ventana";
  }

  let ultimoMotivo = "sin_quotes_en_ventana";
  for (const punto of dentro) {
    const decision = selectFavoriteOutcome({
      quotes: adaptarQuotes(punto),
      minAsk: params.minAsk,
      maxAsk: params.maxAsk,
      maxAskSum: params.maxAskSum,
    });
    if (!decision.selection) {
      ultimoMotivo = `favorite_${decision.reason}`;
      continue;
    }

    const { outcome, askPrice } = decision.selection;
    const bid = outcome === "UP" ? punto.upBestBid : punto.downBestBid;
    // Igual que `buildTradeCandidate`: un bid AUSENTE no rechaza. Cerca del cierre el lado ganador se
    // queda sin libro con normalidad, y convertir esa laguna en un veto seria inventar politica.
    if (params.maxAskSpread > 0 && typeof bid === "number" && bid > 0 && askPrice - bid > params.maxAskSpread) {
      ultimoMotivo = "spread_too_wide";
      continue;
    }

    const certeza = readWindowCertainty({
      // Se pasan TODOS los ticks: `readWindowCertainty` ya recorta a los que estan en o antes de
      // `nowMs`. Filtrar aqui tambien seria reimplementar su guarda, que es lo que este modulo evita.
      ticks: adaptarTicks(sample.ticks),
      openingPrice: sample.openingPrice,
      outcome,
      nowMs: punto.timestampMs,
      endMs: sample.endMs,
      historiaSegundos: params.historiaSegundos,
    });
    // Una lectura AUSENTE no bloquea, exactamente como en `buildTradeSignal`: seria convertir una
    // laguna del feed en politica de riesgo. Una lectura que SI sale y da poco es informacion.
    if (certeza && certeza.z < params.minCertainty) {
      ultimoMotivo = "favorite_ventana_no_decidida";
      continue;
    }

    return {
      outcome,
      ask: askPrice,
      secondsToEnd: punto.secondsToEnd,
      z: certeza?.z,
      feeRateBps: defaultTakerFeeRateBps(sample.market),
    };
  }
  return ultimoMotivo;
}

/**
 * `AnalyticsQuotePoint` visto como los dos libros que `selectFavoriteOutcome` espera.
 *
 * Los campos de profundidad van a cero porque el selector solo mira `bestAsk`, y rellenarlos con un
 * numero inventado seria peor que dejarlos vacios: alguien los leeria despues creyendo que miden algo.
 * La profundidad real de la muestra vive en `upAskDepthUsd`/`downAskDepthUsd` y no se toca aqui.
 */
function adaptarQuotes(punto: AnalyticsQuotePoint): Partial<Record<Outcome, OrderbookQuote>> {
  return {
    UP: adaptarLado(punto.upBestAsk, punto.upBestBid, punto.timestampMs),
    DOWN: adaptarLado(punto.downBestAsk, punto.downBestBid, punto.timestampMs),
  };
}

function adaptarLado(bestAsk: number | undefined, bestBid: number | undefined, quotedAtMs: number): OrderbookQuote {
  return {
    tokenId: "replay",
    quotedAtMs,
    bestAsk,
    bestBid,
    availableUsdUnderCap: 0,
    availableUsdAllLevels: 0,
    estimatedSharesForAmount: 0,
    rawAskLevels: [],
    rawBidLevels: [],
    availableBidUsdAllLevels: 0,
  };
}

/**
 * Los ticks SPOT de la muestra, que es la serie sobre la que produccion mide la certeza hoy:
 * `leerCerteza` llama a `getTickAtOrBefore`, no a `getTwapAtOrBefore`.
 *
 * Se replica lo que hace el bot, no lo que quiza deberia hacer. Cambiar la serie aqui mediria una
 * estrategia que nadie ejecuta, y la muestra ya trae `twapPrice` para cuando toque preguntar eso —
 * pero sera una pregunta aparte, con produccion movida detras.
 */
function adaptarTicks(ticks: readonly AnalyticsTickPoint[]): Array<{ timestampMs: number; value: number }> {
  return ticks.map((tick) => ({ timestampMs: tick.timestampMs, value: tick.price }));
}

/** Acierto necesario para empatar tras comision: `ask x (1 + tasa x (1 - ask))`. */
export function breakEvenWinRate(ask: number, feeRateBps: number): number {
  const tasa = Number.isFinite(feeRateBps) && feeRateBps > 0 ? feeRateBps / 10_000 : 0;
  return ask * (1 + tasa * (1 - ask));
}

/**
 * Las señales liquidadas SIN gate de EV, en el formato que entiende `summarizeGateTrades`.
 *
 * Es el otro extremo de la comparacion: `simulateGate` sobre las mismas señales aplica el gate de EV.
 * Ver las dos cifras juntas es lo unico que dice si ese gate aporta o solo recorta muestra.
 */
export function settleFavoriteSignals(
  signals: readonly FavoriteSignal[],
  options: { stakeUsd: number; feeRateBps: number },
): Array<{ ask: number; won: boolean; adjusted: number; netUsd: number; stakeUsd: number; windowStartMs: number }> {
  return signals.map((signal) => {
    const shares = options.stakeUsd / signal.ask;
    const fee = calculateTradeFeeUsd({ shares, price: signal.ask, feeRateBps: options.feeRateBps });
    return {
      ask: signal.ask,
      won: signal.won,
      adjusted: signal.predicted,
      netUsd: (signal.won ? shares : 0) - options.stakeUsd - fee,
      stakeUsd: options.stakeUsd + fee,
      windowStartMs: signal.windowStartMs,
    };
  });
}

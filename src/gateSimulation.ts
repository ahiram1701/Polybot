import { applyCalibration, buildCalibrationMap, type CalibrationSample } from "./calibration.js";
import { calculateAdjustedWinProbability } from "./expectedValue.js";
import { calculateTradeFeeUsd } from "./fees.js";

/**
 * El gate de entrada, simulado sobre señales historicas. UNA sola implementacion, compartida por todo
 * lo que necesite responder "¿que habria hecho el bot con esta configuracion?".
 *
 * Existe porque tener dos implementaciones ya se equivoco: una tabla que evaluaba banda+momentum sin
 * el gate de EV concluyo que la ventana de DOGE era perdedora, y al replicar el gate REAL resulto que
 * esos mismos trades ganaban $24 — el gate ya estaba filtrando lo malo. Un modelo simplificado no
 * responde la pregunta que se le hace, aunque lo parezca.
 *
 * Sin look-ahead por construccion: en cada señal la probabilidad y el mapa de calibracion se
 * construyen SOLO con las señales anteriores.
 */

export interface GateParams {
  /** Ventana de ask a evaluar. */
  minAsk: number;
  maxAsk: number;
  /**
   * Todos SIN valor por defecto a proposito. Son ajustes de produccion, y un default aqui es
   * exactamente como se cuela una simulacion que evalua una configuracion que nadie ejecuta — el mismo
   * fallo que tenia el backtest del tuner comparando contra un tope fijo impreso como "(actual)".
   */
  safetyMargin: number;
  minExpectedRoi: number;
  stakeUsd: number;
  feeRateBps: number;
  /** Descarta ventajas implausibles. `undefined` = sin rechazo. */
  rejectEdgeAbove?: number;
}

export interface HistoricalSignal {
  predicted: number;
  won: boolean;
  ask: number;
  windowStartMs: number;
}

export interface SimulatedTrade {
  ask: number;
  won: boolean;
  /** Probabilidad ya calibrada con la que se decidio entrar. */
  adjusted: number;
  netUsd: number;
  stakeUsd: number;
  windowStartMs: number;
}

/**
 * Las señales que el gate HABRIA operado, en orden cronologico.
 *
 * Las señales entran sin filtrar por ventana de ask: el filtro se aplica aqui, con `params`. Eso es lo
 * que permite preguntar por una banda que hoy no se opera — que es justo lo que el autoajuste no podia
 * hacer, porque su unica fuente eran los trades ya ejecutados.
 */
export function simulateGate(signals: readonly HistoricalSignal[], params: GateParams): SimulatedTrade[] {
  const history: CalibrationSample[] = [];
  const salida: SimulatedTrade[] = [];
  let priorWins = 0;
  let priorTrades = 0;

  for (const signal of signals) {
    const { ask, won } = signal;
    // El historial que alimenta la estimacion se restringe a la ventana evaluada, igual que produccion.
    // Sin este filtro entran las ventanas carisimas (0.9+), que casi siempre ganan, la probabilidad
    // estimada se dispara y todo declara una ventaja enorme.
    if (ask < params.minAsk || ask > params.maxAsk) {
      continue;
    }
    // La primera señal solo alimenta el historial: sin nada previo no hay probabilidad que estimar.
    if (priorTrades === 0) {
      priorTrades += 1;
      priorWins += won ? 1 : 0;
      continue;
    }

    const predicted = calculateAdjustedWinProbability(priorWins, priorTrades, ask);
    const adjusted = applyCalibration(buildCalibrationMap(history), predicted);
    const edge = adjusted - ask;
    const expectedRoi = adjusted / ask - 1;
    const feeFraction = (params.feeRateBps / 10_000) * (1 - ask);
    const pasa =
      adjusted >= ask + params.safetyMargin &&
      expectedRoi >= params.minExpectedRoi + feeFraction &&
      !(params.rejectEdgeAbove !== undefined && edge > params.rejectEdgeAbove);

    if (pasa) {
      const shares = params.stakeUsd / ask;
      const fee = calculateTradeFeeUsd({ shares, price: ask, feeRateBps: params.feeRateBps });
      salida.push({
        ask,
        won,
        adjusted,
        netUsd: (won ? shares : 0) - params.stakeUsd - fee,
        stakeUsd: params.stakeUsd + fee,
        windowStartMs: signal.windowStartMs,
      });
    }

    history.push({ predicted, won });
    priorTrades += 1;
    priorWins += won ? 1 : 0;
  }

  return salida;
}

export interface GateOutcome {
  trades: number;
  wins: number;
  netUsd: number;
  stakeUsd: number;
  roiPct?: number;
  /** Neto medio por operacion y su error estandar. */
  netPerTradeUsd?: number;
  /**
   * t del neto por operacion contra cero. Imprescindible en la zona de ask alto: ahi se gana el 99%
   * de las veces cobrando poco y se pierde el 100% en las raras, asi que el neto total puede ser
   * positivo y aun asi ser indistinguible de la suerte — dos perdidas mas le dan la vuelta al signo.
   * El numero de operaciones no basta para verlo; el reparto del resultado, si.
   */
  tStat?: number;
}

export function summarizeGateTrades(trades: readonly SimulatedTrade[]): GateOutcome {
  let wins = 0;
  let netUsd = 0;
  let stakeUsd = 0;
  for (const trade of trades) {
    netUsd += trade.netUsd;
    stakeUsd += trade.stakeUsd;
    if (trade.won) {
      wins += 1;
    }
  }
  const n = trades.length;
  const netPerTradeUsd = n > 0 ? netUsd / n : undefined;
  let tStat: number | undefined;
  if (n >= 2 && netPerTradeUsd !== undefined) {
    const varianza = trades.reduce((sum, t) => sum + (t.netUsd - netPerTradeUsd) ** 2, 0) / (n - 1);
    const errorEstandar = Math.sqrt(varianza / n);
    if (errorEstandar > 0) {
      tStat = netPerTradeUsd / errorEstandar;
    } else {
      // Varianza cero es confianza MAXIMA, no ausencia de informacion. Devolver `undefined` aqui hacia
      // que un ganador perfectamente consistente cayera al `?? 0` de los filtros y quedara rechazado,
      // que es justo al reves de lo que dice el dato. El minimo de muestra ya cubre el caso de "pocas
      // operaciones identicas por casualidad".
      tStat = netPerTradeUsd === 0 ? 0 : netPerTradeUsd > 0 ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
    }
  }
  return {
    trades: n,
    wins,
    netUsd,
    stakeUsd,
    roiPct: stakeUsd > 0 ? netUsd / stakeUsd : undefined,
    netPerTradeUsd,
    tStat,
  };
}

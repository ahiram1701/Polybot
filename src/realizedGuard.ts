/**
 * Veto del autoajuste basado en operaciones REALMENTE ejecutadas.
 *
 * Existe por un fallo que costo dinero: el 2026-08-05 el autoajuste movio la ventana de ETH de 60s a
 * 26s y el ledger mostraba que esa region habia perdido $41.22 en 127 operaciones (42.5% de acierto),
 * mientras la region descartada habia ganado $64.61 en 198. El motor la prefirio igual, y no por un
 * error de calculo: mide sobre las muestras de analitica, que guardan SOLO el mejor precio del libro.
 * Ahi todo relleno es perfecto y gratis. Cerca del cierre el libro se adelgaza y el precio cotizado no
 * es el que se consigue, asi que el simulador es mas optimista justo donde la realidad es peor — y
 * empuja hacia ventanas tardias.
 *
 * El ledger no tiene ese problema: cada operacion camina el libro de verdad
 * (`estimatedSharesForAmount`), pasa el gate de EV, el guardia de spread y el de relleno minimo. Esto
 * vale igual en sim que en live; la diferencia no es el modo, es observacion pasiva contra ejecucion.
 *
 * Es SOLO un veto: puede bloquear un cambio, nunca justificarlo. Si no hay muestra suficiente no opina
 * y decide el resto de guardas.
 */
import { calculateTradePnl } from "./pnl.js";
import type { MarketSymbol, TradeAttempt } from "./types.js";

/** Operaciones minimas dentro de la region para que el veto tenga voz. Por debajo, se abstiene. */
export const REALIZED_GUARD_MIN_TRADES = 25;

export interface RealizedRegion {
  tradeCount: number;
  netUsd: number;
  winRate: number;
}

/**
 * Rendimiento realizado de las operaciones que la config candidata HABRIA tomado: las que entraron
 * dentro de su ventana y superaban su distancia minima. Es la condicion de entrada del candidato
 * aplicada al historial de ejecuciones.
 */
export function realizedForCandidate(
  trades: TradeAttempt[],
  market: MarketSymbol,
  candidate: { entryWindowSeconds: number; minDistanceUsd: number },
): RealizedRegion {
  let tradeCount = 0;
  let netUsd = 0;
  let wins = 0;
  for (const trade of trades) {
    if (trade.asset !== market || trade.kind === "arb" || !trade.resolved) {
      continue;
    }
    const secondsToEnd = (trade.endMs - trade.createdAtMs) / 1000;
    if (!Number.isFinite(secondsToEnd) || secondsToEnd <= 0 || secondsToEnd > candidate.entryWindowSeconds) {
      continue;
    }
    if (Math.abs(trade.distanceUsd ?? 0) < candidate.minDistanceUsd) {
      continue;
    }
    const net = calculateTradePnl(trade).netUsd ?? 0;
    tradeCount += 1;
    netUsd += net;
    if (net > 0) wins += 1;
  }
  return { tradeCount, netUsd, winRate: tradeCount > 0 ? wins / tradeCount : 0 };
}

/**
 * `false` solo cuando hay evidencia suficiente de que la region candidata PIERDE dinero de verdad.
 * Sin muestra, se abstiene (`true`): callar no es aprobar, es no tener nada que decir.
 */
export function passesRealizedGuard(
  region: RealizedRegion,
  minTrades: number = REALIZED_GUARD_MIN_TRADES,
): boolean {
  if (region.tradeCount < minTrades) {
    return true;
  }
  return region.netUsd > 0;
}

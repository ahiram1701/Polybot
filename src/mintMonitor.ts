import { calculateTradeFeeUsd, defaultTakerFeeRateBps } from "./fees.js";
import { proceedsFromSelling } from "./orderbookService.js";
import type { MarketSymbol, OrderbookQuote, Outcome } from "./types.js";

/**
 * MINT-arb: el arbitraje de set completo al REVES.
 *
 * Acuñar un set cuesta exactamente $1 en cadena (`splitPosition` del contrato de tokens
 * condicionales) y entrega una participacion de cada lado. Si los dos lados juntos se pueden VENDER
 * por mas de $1 tras comisiones, la diferencia es beneficio sin riesgo direccional — igual que el
 * arbitraje de compra que ya opera [arbMonitor.ts](src/arbMonitor.ts), pero por el otro lado del
 * libro.
 *
 * Por que merece la pena mirarlo: sobre el historico completo aparece con frecuencia comparable al de
 * compra (199 momentos frente a 200), y su mejor caso es mayor ($0,55/set frente a $0,46).
 *
 * Por que el riesgo esta acotado: un set acuñado SIEMPRE redime $1 al cierre. Si los bids se evaporan
 * entre acuñar y vender, no se pierde el principal — se mantiene el set hasta la resolucion y el coste
 * es el gas. Lo que si hay que evitar es vender UNA sola pata: eso deja posicion direccional, y es el
 * mismo peligro que ya vigila el contador de patas sueltas del arbitraje de compra.
 *
 * Esta clase NO mueve dinero: solo detecta y mide, para responder con datos reales cuantos dolares
 * caben antes de escribir nada en cadena.
 */

export interface MintOpportunity {
  at: number;
  market: MarketSymbol;
  slug: string;
  secondsToEnd: number;
  upBid: number;
  downBid: number;
  /** Ingresos brutos por set al MEJOR bid de cada lado, antes de comisiones. */
  grossPerSet: number;
  feePerSet: number;
  /** Beneficio por set al mejor bid: `grossPerSet - feePerSet - 1`. */
  netPerSet: number;
  /**
   * Sets que caben de verdad bajando por AMBOS libros compradores, y el neto TOTAL a ese tamaño. Es la
   * diferencia entre esto y `netPerSet x sets`: los niveles de abajo pagan menos, asi que el neto real
   * siempre es menor que el que sugiere el mejor bid.
   */
  maxSetsByDepth: number;
  netUsdAtDepth: number;
  /** Precio del peor nivel tocado en cada lado al vender `maxSetsByDepth`. */
  worstUpBid?: number;
  worstDownBid?: number;
}

/**
 * Sets que se pueden vender antes de que el neto marginal deje de compensar. Se busca el tamaño que
 * MAXIMIZA el neto total, no el mayor que sigue siendo positivo: vender hasta el ultimo nivel rentable
 * puede dejar menos dinero que parar antes, porque los niveles baratos diluyen la media.
 */
function bestSize(
  upLevels: Array<{ price: number; size: number }>,
  downLevels: Array<{ price: number; size: number }>,
  feeRateBps: number,
): { sets: number; netUsd: number; worstUp?: number; worstDown?: number } {
  // Candidatos: cada frontera de nivel de cualquiera de los dos libros. El optimo siempre cae en una
  // de ellas, porque entre fronteras el neto es lineal en el numero de sets.
  const fronteras = new Set<number>();
  let acumulado = 0;
  for (const level of upLevels) {
    acumulado += level.size;
    fronteras.add(acumulado);
  }
  acumulado = 0;
  for (const level of downLevels) {
    acumulado += level.size;
    fronteras.add(acumulado);
  }

  let mejor = { sets: 0, netUsd: 0, worstUp: undefined as number | undefined, worstDown: undefined as number | undefined };
  for (const sets of fronteras) {
    if (sets <= 0) {
      continue;
    }
    const up = proceedsFromSelling(upLevels, sets);
    const down = proceedsFromSelling(downLevels, sets);
    // Solo cuentan los tamaños que AMBOS libros pueden absorber: media pata no es un arbitraje.
    if (up.sharesSold < sets || down.sharesSold < sets) {
      continue;
    }
    const fee =
      calculateTradeFeeUsd({ shares: up.sharesSold, price: up.proceedsUsd / up.sharesSold, feeRateBps }) +
      calculateTradeFeeUsd({ shares: down.sharesSold, price: down.proceedsUsd / down.sharesSold, feeRateBps });
    // Acuñar cuesta $1 por set, exactamente.
    const netUsd = up.proceedsUsd + down.proceedsUsd - fee - sets;
    if (netUsd > mejor.netUsd) {
      mejor = { sets, netUsd, worstUp: up.worstPrice, worstDown: down.worstPrice };
    }
  }
  return mejor;
}

export function detectMintArb(args: {
  market: MarketSymbol;
  slug: string;
  endMs: number;
  nowMs: number;
  quotes: Partial<Record<Outcome, OrderbookQuote>>;
}): MintOpportunity | undefined {
  const up = args.quotes.UP;
  const down = args.quotes.DOWN;
  // Defensivo a proposito: esto corre dentro de la fase de captura, que evalua los tres mercados en
  // paralelo. Una excepcion aqui no se queda en "sin oportunidad" — tumba la iteracion COMPLETA y deja
  // al bot ciego tambien para el direccional y el arbitraje de compra. Ninguna deteccion vale eso.
  const upBids = up?.rawBidLevels ?? [];
  const downBids = down?.rawBidLevels ?? [];
  if (!up?.bestBid || !down?.bestBid || upBids.length === 0 || downBids.length === 0) {
    return undefined;
  }

  const feeRateBps = defaultTakerFeeRateBps(args.market);
  const feePerSet =
    calculateTradeFeeUsd({ shares: 1, price: up.bestBid, feeRateBps }) +
    calculateTradeFeeUsd({ shares: 1, price: down.bestBid, feeRateBps });
  const grossPerSet = up.bestBid + down.bestBid;
  const netPerSet = grossPerSet - feePerSet - 1;
  if (netPerSet <= 0) {
    return undefined;
  }

  const mejor = bestSize(upBids, downBids, feeRateBps);
  if (mejor.sets <= 0) {
    return undefined;
  }

  return {
    at: args.nowMs,
    market: args.market,
    slug: args.slug,
    secondsToEnd: Math.round(((args.endMs - args.nowMs) / 1000) * 10) / 10,
    upBid: up.bestBid,
    downBid: down.bestBid,
    grossPerSet: round4(grossPerSet),
    feePerSet: round4(feePerSet),
    netPerSet: round4(netPerSet),
    maxSetsByDepth: Math.floor(mejor.sets * 100) / 100,
    netUsdAtDepth: round4(mejor.netUsd),
    worstUpBid: mejor.worstUp,
    worstDownBid: mejor.worstDown,
  };
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

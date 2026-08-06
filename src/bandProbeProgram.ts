import { calculateTradePnl, isCompleteArbPair } from "./pnl.js";
import type { MarketSymbol, TradeAttempt } from "./types.js";

/**
 * El lazo que permite que el autoajuste se aplique solo sin que un error de medicion entre a ciegas.
 *
 * La idea no es acertar siempre — esta sesion ya colo tres mediciones equivocadas — sino que
 * equivocarse SE NOTE y se deshaga. Antes de tocar nada, el tuner escribe que espera conseguir; luego
 * la realidad lo confirma o lo tumba.
 *
 * Registrar la prediccion ANTES de sondear no es ceremonia: si se apunta despues, uno acaba buscando
 * en los resultados la lectura que confirme lo que ya queria hacer. Escrita de antemano, el numero es
 * una apuesta que se gana o se pierde.
 */

/** Sondeos resueltos antes de decidir. Por debajo, el programa sigue abierto sin veredicto. */
export const MIN_PROBE_TRADES = 20;

/**
 * Fraccion de lo prometido que hay que entregar para confirmar.
 *
 * El filtro que de verdad importa NO es "¿gana dinero?" sino "¿entrega lo que prometio?". La analitica
 * historica guarda solo el mejor precio del libro, asi que la simulacion asume relleno perfecto y sale
 * optimista justo cerca del cierre, donde el libro se adelgaza. Si una banda promete $0,29 por
 * operacion y entrega $0,03, el modelo esta sistematicamente inflado aunque el signo sea positivo — y
 * eso es lo que hay que cazar antes de abrir la ventana del todo.
 */
export const MIN_DELIVERED_FRACTION = 0.5;

/** Un rechazo veta la banda este tiempo. No es para siempre: con datos nuevos puede rehabilitarse. */
export const REJECTION_COOLDOWN_MS = 14 * 24 * 60 * 60 * 1000;

export type BandProgramStatus = "probing" | "confirmed" | "rejected";

export interface BandProgram {
  market: MarketSymbol;
  lo: number;
  hi: number;
  /** Momento en que se registro la prediccion. Solo cuentan los trades POSTERIORES. */
  createdAtMs: number;
  /** La apuesta, escrita antes de sondear. */
  expectedNetPerTradeUsd: number;
  /** De cuantas operaciones fuera de muestra salia esa prediccion. */
  outOfSampleTrades: number;
  reason: string;
  status: BandProgramStatus;
  decidedAtMs?: number;
  /** Lo que la realidad devolvio, relleno al decidir. */
  realizedNetPerTradeUsd?: number;
  realizedTrades?: number;
  verdict?: string;
}

export function startBandProgram(args: {
  market: MarketSymbol;
  lo: number;
  hi: number;
  expectedNetPerTradeUsd: number;
  outOfSampleTrades: number;
  reason: string;
  nowMs: number;
}): BandProgram {
  return {
    market: args.market,
    lo: args.lo,
    hi: args.hi,
    createdAtMs: args.nowMs,
    expectedNetPerTradeUsd: args.expectedNetPerTradeUsd,
    outOfSampleTrades: args.outOfSampleTrades,
    reason: args.reason,
    status: "probing",
  };
}

export interface RealizedInBand {
  trades: number;
  netUsd: number;
  netPerTradeUsd?: number;
}

/**
 * Lo REALMENTE conseguido dentro de la banda desde que se registro la prediccion.
 *
 * No hace falta marcar los trades como sondeos: basta con filtrar por mercado, precio de entrada y
 * fecha. Menos estado que mantener y menos sitios donde una etiqueta pueda quedarse sin poner.
 *
 * El arbitraje queda fuera a proposito: su `bestAsk` es el coste del PAR completo (~0,93), asi que
 * caeria en la banda alta y contaminaria justo la tabla que decide la ventana direccional.
 */
export function realizedInBand(trades: readonly TradeAttempt[], program: BandProgram): RealizedInBand {
  let count = 0;
  let netUsd = 0;
  for (const trade of trades) {
    if (trade.asset !== program.market || !trade.resolved || isCompleteArbPair(trade)) {
      continue;
    }
    if (trade.createdAtMs < program.createdAtMs) {
      continue;
    }
    const ask = trade.bestAsk;
    if (typeof ask !== "number" || ask < program.lo || ask > program.hi) {
      continue;
    }
    count += 1;
    netUsd += calculateTradePnl(trade).netUsd ?? 0;
  }
  return { trades: count, netUsd, netPerTradeUsd: count > 0 ? netUsd / count : undefined };
}

/**
 * Compara la realidad con la prediccion registrada y decide. Devuelve el programa sin tocar mientras
 * no haya muestra: callar no es aprobar.
 */
export function decideBandProgram(
  program: BandProgram,
  realized: RealizedInBand,
  nowMs: number,
  minProbeTrades = MIN_PROBE_TRADES,
): BandProgram {
  if (program.status !== "probing" || realized.trades < minProbeTrades) {
    return program;
  }

  const conseguido = realized.netPerTradeUsd ?? 0;
  const minimoExigido = program.expectedNetPerTradeUsd * MIN_DELIVERED_FRACTION;
  const decidido = {
    ...program,
    decidedAtMs: nowMs,
    realizedNetPerTradeUsd: conseguido,
    realizedTrades: realized.trades,
  };

  if (conseguido <= 0) {
    return {
      ...decidido,
      status: "rejected",
      verdict: `Prometia $${program.expectedNetPerTradeUsd.toFixed(3)}/trade y pierde dinero ($${conseguido.toFixed(3)}) en ${realized.trades} sondeos`,
    };
  }
  if (conseguido < minimoExigido) {
    // Positivo pero muy por debajo de lo prometido: el modelo esta inflado, que es exactamente el
    // sesgo de relleno que la analitica sin profundidad no puede ver.
    return {
      ...decidido,
      status: "rejected",
      verdict: `Entrega $${conseguido.toFixed(3)}/trade de los $${program.expectedNetPerTradeUsd.toFixed(3)} prometidos (menos de la mitad) en ${realized.trades} sondeos`,
    };
  }
  return {
    ...decidido,
    status: "confirmed",
    verdict: `Cumple: $${conseguido.toFixed(3)}/trade frente a $${program.expectedNetPerTradeUsd.toFixed(3)} prometidos en ${realized.trades} sondeos`,
  };
}

/**
 * `true` si esta banda no puede volver a proponerse todavia.
 *
 * El veto caduca a proposito. Un rechazo dice "con estos datos no se sostiene", no "nunca jamas": el
 * mercado cambia y cerrar la puerta para siempre es como el autoajuste acababa clavado en una ventana
 * cada vez mas estrecha.
 */
export function isBandBlacklisted(
  programs: readonly BandProgram[],
  market: MarketSymbol,
  lo: number,
  hi: number,
  nowMs: number,
  cooldownMs = REJECTION_COOLDOWN_MS,
): boolean {
  return programs.some(
    (program) =>
      program.market === market &&
      program.lo === lo &&
      program.hi === hi &&
      program.status === "rejected" &&
      nowMs - (program.decidedAtMs ?? program.createdAtMs) < cooldownMs,
  );
}

/** Programa en curso para un mercado, si lo hay. Solo uno a la vez: dos sondeos simultaneos en el
 * mismo mercado se contaminan entre si y ninguna de las dos predicciones seria interpretable. */
export function activeProgram(programs: readonly BandProgram[], market: MarketSymbol): BandProgram | undefined {
  return programs.find((program) => program.market === market && program.status === "probing");
}

/**
 * Vigilancia POSTERIOR a abrir la ventana: la misma comparacion, aplicada de forma continua.
 *
 * Un cambio confirmado no queda bendecido para siempre. Si la banda deja de pagar con muestra
 * suficiente, esto devuelve el programa a "rejected" para que quien lo aplico lo deshaga. Es la ultima
 * red: un error que haya burlado el contrafactual, la particion fuera de muestra y los sondeos sigue
 * teniendo que sobrevivir al dinero real, y ahi no hay donde esconderse.
 */
export function reviewConfirmedProgram(
  program: BandProgram,
  realized: RealizedInBand,
  nowMs: number,
  minTrades = MIN_PROBE_TRADES,
): BandProgram {
  if (program.status !== "confirmed" || realized.trades < minTrades) {
    return program;
  }
  const conseguido = realized.netPerTradeUsd ?? 0;
  if (conseguido > 0) {
    return program;
  }
  return {
    ...program,
    status: "rejected",
    decidedAtMs: nowMs,
    realizedNetPerTradeUsd: conseguido,
    realizedTrades: realized.trades,
    verdict: `Revertido: tras abrirse, la banda pierde $${Math.abs(conseguido).toFixed(3)}/trade en ${realized.trades} operaciones`,
  };
}

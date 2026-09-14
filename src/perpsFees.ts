/**
 * Comisiones de Perps. Modulo APARTE de `fees.ts`, y no por orden.
 *
 * La formula del binario es `participaciones x tasa x p x (1-p)`, maxima en 0,50 y casi nula en los
 * extremos, porque `p` es una PROBABILIDAD entre 0 y 1. En perps `p` es el precio de BTC en dolares:
 * meter 118.000 en `p x (1-p)` no da una comision alta, da una comision negativa de nueve cifras.
 *
 * Aqui la regla es lineal sobre el nocional y la publica el exchange:
 *   fee = abs(precio x cantidad) x tasa
 *
 * Las tasas son por tramos de volumen de 30 dias y se reevaluan cada dia UTC. En el tramo mas alto la
 * tasa maker es NEGATIVA: es un rebate, el maker cobra. Por eso el tipo es `number` con signo y no un
 * "bps positivo" — un `Math.abs` defensivo aqui convertiria un ingreso en un gasto.
 */

/** Tramos publicados (volumen 30d en USD -> tasa en tanto por uno). De mayor a menor volumen. */
export const PERPS_FEE_TIERS: ReadonlyArray<{ minVolume30dUsd: number; taker: number; maker: number }> = [
  { minVolume30dUsd: 1_000_000_000, taker: 0.000200, maker: -0.000050 },
  { minVolume30dUsd: 500_000_000, taker: 0.000250, maker: 0.000000 },
  { minVolume30dUsd: 100_000_000, taker: 0.000270, maker: 0.000020 },
  { minVolume30dUsd: 25_000_000, taker: 0.000300, maker: 0.000050 },
  { minVolume30dUsd: 5_000_000, taker: 0.000350, maker: 0.000080 },
  { minVolume30dUsd: 1_000_000, taker: 0.000370, maker: 0.000100 },
  { minVolume30dUsd: 0, taker: 0.000400, maker: 0.000125 },
];

/**
 * Tramo base: el de volumen cero. Es el que aplica a esta cuenta y el que debe usar el simulador.
 *
 * Suponer un tramo mejor "porque algun dia" es el mismo error que un backtest que asume relleno
 * perfecto: abarata cada operacion simulada y empuja hacia estrategias que solo salen a cuenta con
 * comisiones que esta cuenta no tiene.
 */
export const PERPS_BASE_TAKER_RATE = 0.000400;
export const PERPS_BASE_MAKER_RATE = 0.000125;

export function perpsFeeRate(args: { volume30dUsd?: number; maker?: boolean }): number {
  const volumen = Number.isFinite(args.volume30dUsd) ? (args.volume30dUsd as number) : 0;
  const tramo = PERPS_FEE_TIERS.find((entry) => volumen >= entry.minVolume30dUsd) ?? PERPS_FEE_TIERS[PERPS_FEE_TIERS.length - 1];
  return args.maker === true ? tramo.maker : tramo.taker;
}

/**
 * Comision de una operacion, en dolares. Positiva = se paga; negativa = rebate de maker.
 *
 * `price` y `quantity` van por separado en vez de un `notionalUsd` ya calculado a proposito: es la
 * forma en que la publica el exchange, y multiplicar en el mismo sitio donde se aplica la tasa evita
 * que alguien pase un nocional calculado con otro precio (el de marca, por ejemplo) sin notarlo.
 */
export function calculatePerpsFeeUsd(args: { price: number; quantity: number; feeRate: number }): number {
  if (!Number.isFinite(args.feeRate) || args.feeRate === 0) {
    return 0;
  }
  if (!Number.isFinite(args.price) || !Number.isFinite(args.quantity)) {
    return 0;
  }
  return roundFee(Math.abs(args.price * args.quantity) * args.feeRate);
}

function roundFee(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

/**
 * Coste del funding de un periodo. Positivo = lo paga esta posicion.
 *
 * Un LARGO paga cuando la tasa es positiva; un CORTO cobra. Se calcula sobre el NOCIONAL, no sobre el
 * margen: con 10x de palanca, un 0,01% de funding se come el 0,1% del colateral. Es la diferencia que
 * hace que el funding sea despreciable de lejos y decisivo apalancado.
 */
export function calculateFundingCostUsd(args: {
  side: "LONG" | "SHORT";
  notionalUsd: number;
  fundingRate: number;
}): number {
  if (!Number.isFinite(args.fundingRate) || !Number.isFinite(args.notionalUsd)) {
    return 0;
  }
  const signo = args.side === "LONG" ? 1 : -1;
  return roundFee(signo * Math.abs(args.notionalUsd) * args.fundingRate);
}

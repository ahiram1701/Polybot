import type { MarketSymbol } from "./types.js";

/**
 * Comision TAKER de los mercados cripto: 7%.
 *
 * VERIFICADO contra la documentacion, no deducido: la formula publicada es
 * `fee = participaciones x tasa x p x (1-p)` y el ejemplo trabajado dice "maximo $1,75 por 100
 * participaciones al 50%". Comprobacion: 100 x 0,07 x 0,5 x 0,5 = 1,75. Cuadra exacto, asi que la tasa
 * es 0,07 y la formula de abajo es la correcta.
 *
 * NO usar `taker_base_fee` del CLOB para esto. Ese campo devuelve 1000 en estos mercados, que a primera
 * vista parece "10% y aqui esta mal puesto un 700" — y esa lectura ya me llevo a afirmar dos veces que
 * las comisiones estaban infravaloradas un 43%. Era falso: el campo esta en otras unidades. El ejemplo
 * numerico de la doc es la fuente que zanja la discusion, porque se puede comprobar.
 *
 * Los MAKER no pagan comision ("makers are never charged fees") y ademas cobran un 20% de lo recaudado
 * en cripto. Si algun dia se pone una orden en reposo, su coste de entrada NO es este numero.
 */
const CRYPTO_TAKER_FEE_RATE_BPS = 700;

export function defaultTakerFeeRateBps(market: MarketSymbol | undefined): number {
  return market === "BTC" || market === "ETH" || market === "DOGE" ? CRYPTO_TAKER_FEE_RATE_BPS : 0;
}

export function calculateTradeFeeUsd(args: { shares: number; price: number; feeRateBps: number }): number {
  if (!Number.isFinite(args.feeRateBps) || args.feeRateBps <= 0) {
    return 0;
  }
  const feeRate = args.feeRateBps / 10_000;
  return roundFee(args.shares * feeRate * args.price * (1 - args.price));
}

function roundFee(value: number): number {
  return Math.round(value * 100_000) / 100_000;
}

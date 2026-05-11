import type { MarketSymbol } from "./types.js";

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

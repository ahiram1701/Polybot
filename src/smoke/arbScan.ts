import { join } from "node:path";

import { readAnalyticsSamples } from "../analyticsRecorder.js";
import { loadConfig } from "../config.js";
import { SUPPORTED_MARKETS } from "../markets.js";

/**
 * Complete-set arbitrage scan over the recorded quotes. Two structural opportunities on a binary
 * market whose pair always redeems for exactly $1:
 *   BUY-arb : ask(UP) + ask(DOWN) + takerFees < 1  -> buy both sides, guaranteed profit at resolution.
 *   MINT-arb: bid(UP) + bid(DOWN) - takerFees > 1  -> mint a set for $1, sell both sides immediately.
 * Taker fee per share mirrors fees.ts: 7% x p x (1-p) on each leg's execution price.
 *
 * Honest limitation: analytics quotes store BEST prices only (no depth), so this measures how OFTEN
 * and how WIDE the door opens — not how many dollars fit through it per occurrence.
 *
 * Run: npx tsx src/smoke/arbScan.ts
 */
const FEE_RATE = 0.07;

interface Bucket {
  quotePoints: number;
  buyMoments: number;
  buyWindows: Set<string>;
  buyProfitSum: number;
  buyProfitMax: number;
  buyMomentsNoFee: number;
  mintMoments: number;
  mintWindows: Set<string>;
  mintProfitMax: number;
}

function emptyBucket(): Bucket {
  return {
    quotePoints: 0,
    buyMoments: 0,
    buyWindows: new Set(),
    buyProfitSum: 0,
    buyProfitMax: 0,
    buyMomentsNoFee: 0,
    mintMoments: 0,
    mintWindows: new Set(),
    mintProfitMax: 0,
  };
}

function takerFee(price: number): number {
  return FEE_RATE * price * (1 - price);
}

async function main(): Promise<void> {
  const { config } = loadConfig(["--mode", "sim"]);
  const samples = await readAnalyticsSamples(join(config.dataDir, "analytics.jsonl"));
  const buckets = new Map(SUPPORTED_MARKETS.map((market) => [market, emptyBucket()]));

  for (const sample of samples) {
    const bucket = buckets.get(sample.market);
    if (!bucket) {
      continue;
    }
    for (const quote of sample.quotes) {
      const { upBestAsk, downBestAsk, upBestBid, downBestBid } = quote;
      if (upBestAsk === undefined || downBestAsk === undefined) {
        continue;
      }
      bucket.quotePoints += 1;

      const buyCost = upBestAsk + downBestAsk + takerFee(upBestAsk) + takerFee(downBestAsk);
      const buyProfit = 1 - buyCost;
      if (upBestAsk + downBestAsk < 1) {
        bucket.buyMomentsNoFee += 1;
      }
      if (buyProfit > 0) {
        bucket.buyMoments += 1;
        bucket.buyWindows.add(sample.slug);
        bucket.buyProfitSum += buyProfit;
        bucket.buyProfitMax = Math.max(bucket.buyProfitMax, buyProfit);
      }

      if (upBestBid !== undefined && downBestBid !== undefined) {
        const mintProfit = upBestBid + downBestBid - takerFee(upBestBid) - takerFee(downBestBid) - 1;
        if (mintProfit > 0) {
          bucket.mintMoments += 1;
          bucket.mintWindows.add(sample.slug);
          bucket.mintProfitMax = Math.max(bucket.mintProfitMax, mintProfit);
        }
      }
    }
  }

  console.log(`Muestras: ${samples.length}\n`);
  console.log("mercado | quotes    | BUY-arb (post-fee)                 | BUY sin fee | MINT-arb (post-fee)");
  for (const market of SUPPORTED_MARKETS) {
    const b = buckets.get(market)!;
    const buyRate = b.quotePoints > 0 ? (100 * b.buyMoments) / b.quotePoints : 0;
    const avgProfit = b.buyMoments > 0 ? b.buyProfitSum / b.buyMoments : 0;
    console.log(
      `${market.padEnd(7)} | ${String(b.quotePoints).padStart(9)} | ` +
        `${String(b.buyMoments).padStart(5)} momentos (${buyRate.toFixed(3)}%) en ${b.buyWindows.size} ventanas, ` +
        `avg $${avgProfit.toFixed(4)}/set, max $${b.buyProfitMax.toFixed(4)} | ` +
        `${String(b.buyMomentsNoFee).padStart(6)} | ` +
        `${b.mintMoments} momentos en ${b.mintWindows.size} ventanas, max $${b.mintProfitMax.toFixed(4)}`,
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

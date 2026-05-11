import { ChainlinkPriceFeed } from "../chainlinkPriceFeed.js";
import { loadConfig } from "../config.js";
import { MarketWatcher } from "../marketWatcher.js";
import { OrderbookService } from "../orderbookService.js";

async function main(): Promise<void> {
  const { config } = loadConfig(["--mode", "sim"]);
  const watcher = new MarketWatcher(config.gammaHost);
  const market = await watcher.getCurrentMarket();
  if (!market) {
    throw new Error("Current BTC 5m market was not found.");
  }

  const orderbook = OrderbookService.create(config.clobHost);
  const quoteAmountUsd = Math.max(config.simTradeAmountUsd, market.orderMinSize);
  const [upQuote, downQuote] = await Promise.all([
    orderbook.getQuote(market.outcomes.UP.tokenId, quoteAmountUsd, config.maxAskPrice),
    orderbook.getQuote(market.outcomes.DOWN.tokenId, quoteAmountUsd, config.maxAskPrice),
  ]);

  const feed = new ChainlinkPriceFeed(config.rtdsUrl);
  feed.start();
  try {
    const tick = await feed.waitForTick(20_000);
    console.log(
      JSON.stringify(
        {
          market: {
            slug: market.slug,
            title: market.title,
            end: new Date(market.endMs).toISOString(),
            acceptingOrders: market.acceptingOrders,
            active: market.active,
            closed: market.closed,
            orderMinSize: market.orderMinSize,
            tickSize: market.tickSize,
            upToken: market.outcomes.UP.tokenId,
            downToken: market.outcomes.DOWN.tokenId,
          },
          orderbook: {
            quoteAmountUsd,
            up: {
              bestAsk: upQuote.bestAsk,
              bestBid: upQuote.bestBid,
              availableUsdUnderCap: upQuote.availableUsdUnderCap,
            },
            down: {
              bestAsk: downQuote.bestAsk,
              bestBid: downQuote.bestBid,
              availableUsdUnderCap: downQuote.availableUsdUnderCap,
            },
          },
          chainlink: {
            value: tick.value,
            tickTimestamp: new Date(tick.timestampMs).toISOString(),
            receivedAt: new Date(tick.receivedAtMs).toISOString(),
          },
        },
        null,
        2,
      ),
    );
  } finally {
    feed.stop();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});

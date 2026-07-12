import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";

import {
  AnalyticsRecorder,
  importAnalyticsSamples,
  parseAnalyticsSamplesText,
  readAnalyticsSamples,
  serializeAnalyticsSamples,
  trimAnalyticsFileToMostRecent,
} from "../src/analyticsRecorder.js";
import type {
  MarketInfo,
  MarketSymbol,
  OrderbookQuote,
  Outcome,
  PriceTick,
  TradeAttempt,
  WindowOpening,
} from "../src/types.js";

const temps: string[] = [];

afterEach(async () => {
  await Promise.all(temps.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("AnalyticsRecorder", () => {
  it("writes resolved market samples with ticks and quotes", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "polybot-analytics-"));
    temps.push(dataDir);
    const recorder = new AnalyticsRecorder(dataDir);
    const windowStartMs = Date.UTC(2026, 4, 8, 12, 0, 0);
    const market = marketInfo("BTC", windowStartMs);
    const opening = openingInfo(market);
    const tick = priceTick("BTC", windowStartMs + 260_000, 125);

    await recorder.observeMarket({
      market,
      opening,
      tick,
      quotes: quotes(),
      nowMs: tick.timestampMs,
    });
    await recorder.observeMarket({
      market,
      opening,
      tick: priceTick("BTC", market.endMs, 130),
      quotes: {},
      nowMs: market.endMs,
    });

    const samples = await recorder.readSamples();
    expect(samples).toHaveLength(1);
    expect(samples[0]).toMatchObject({
      market: "BTC",
      slug: market.slug,
      openingPrice: 100,
      finalPrice: 130,
      winningOutcome: "UP",
    });
    expect(samples[0].ticks).toHaveLength(1);
    expect(samples[0].quotes[0].upBestAsk).toBe(0.52);
  });

  it("keeps samples grouped by market slug", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "polybot-analytics-"));
    temps.push(dataDir);
    const recorder = new AnalyticsRecorder(dataDir);
    const btc = marketInfo("BTC", Date.UTC(2026, 4, 8, 12, 0, 0));
    const eth = marketInfo("ETH", Date.UTC(2026, 4, 8, 12, 5, 0));

    await resolveSample(recorder, btc);
    await resolveSample(recorder, eth);

    const samples = await recorder.readSamples();
    expect(samples.map((sample) => sample.slug)).toEqual([btc.slug, eth.slug]);
    expect(samples.map((sample) => sample.market)).toEqual(["BTC", "ETH"]);
  });

  it("restores active samples after a recorder restart", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "polybot-analytics-"));
    temps.push(dataDir);
    const windowStartMs = Date.UTC(2026, 4, 8, 12, 0, 0);
    const market = marketInfo("BTC", windowStartMs);
    const opening = openingInfo(market);

    await new AnalyticsRecorder(dataDir).observeMarket({
      market,
      opening,
      tick: priceTick("BTC", market.endMs - 20_000, 125),
      quotes: quotes(),
      nowMs: market.endMs - 20_000,
    });
    await new AnalyticsRecorder(dataDir).observeMarket({
      market,
      opening,
      tick: priceTick("BTC", market.endMs, 130),
      quotes: {},
      nowMs: market.endMs,
    });

    const samples = await new AnalyticsRecorder(dataDir).readSamples();
    expect(samples).toHaveLength(1);
    expect(samples[0]).toMatchObject({
      slug: market.slug,
      finalPrice: 130,
      winningOutcome: "UP",
    });
    expect(samples[0].ticks).toHaveLength(1);
    expect(samples[0].quotes[0].upBestAsk).toBe(0.52);
  });

  it("writes a fallback analytics sample from a resolved trade", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "polybot-analytics-"));
    temps.push(dataDir);
    const windowStartMs = Date.UTC(2026, 4, 8, 12, 0, 0);
    const market = marketInfo("BTC", windowStartMs);
    const trade = tradeAttempt(market, "DOWN");

    await new AnalyticsRecorder(dataDir).recordResolvedTrade(trade, {
      resolvedAtMs: market.endMs + 1_000,
      finalPrice: 88,
      finalTickTimestampMs: market.endMs,
      winningOutcome: "DOWN",
      won: true,
    });

    const samples = await new AnalyticsRecorder(dataDir).readSamples();
    expect(samples).toHaveLength(1);
    expect(samples[0]).toMatchObject({
      slug: market.slug,
      market: "BTC",
      openingPrice: 100,
      finalPrice: 88,
      winningOutcome: "DOWN",
    });
    expect(samples[0].ticks[0]).toMatchObject({
      price: 90,
      distanceUsd: -10,
    });
    expect(samples[0].quotes[0].downBestAsk).toBe(0.47);
  });

  it("serializes and parses wrapped analytics samples for export", async () => {
    const sample = analyticsSample(marketInfo("BTC", Date.UTC(2026, 4, 8, 12, 0, 0)));

    const contents = serializeAnalyticsSamples([sample], new Date(Date.UTC(2026, 4, 8, 12, 1, 0)));
    const parsed = parseAnalyticsSamplesText(contents);

    expect(contents).toContain('"type":"analytics_sample"');
    expect(parsed.skippedInvalidCount).toBe(0);
    expect(parsed.duplicateCount).toBe(0);
    expect(parsed.samples).toEqual([sample]);
  });

  it("imports raw and wrapped samples while skipping invalid lines and duplicate slugs", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "polybot-analytics-"));
    temps.push(dataDir);
    const analyticsPath = join(dataDir, "analytics.jsonl");
    const earlier = analyticsSample(marketInfo("BTC", Date.UTC(2026, 4, 8, 12, 0, 0)), { finalPrice: 120 });
    const firstEth = analyticsSample(marketInfo("ETH", Date.UTC(2026, 4, 8, 12, 5, 0)), { finalPrice: 210 });
    const latestEth = analyticsSample(marketInfo("ETH", Date.UTC(2026, 4, 8, 12, 5, 0)), { finalPrice: 220 });

    const result = await importAnalyticsSamples(
      analyticsPath,
      [
        JSON.stringify({ type: "analytics_sample", sample: firstEth }),
        "not-json",
        JSON.stringify(earlier),
        JSON.stringify(latestEth),
      ].join("\n"),
      new Date(Date.UTC(2026, 4, 8, 12, 10, 0)),
    );

    expect(result).toMatchObject({
      importedCount: 2,
      duplicateCount: 1,
      skippedInvalidCount: 1,
      totalKnownSamples: 2,
      validSampleCount: 3,
    });
    const samples = await readAnalyticsSamples(analyticsPath);
    expect(samples.map((sample) => sample.slug)).toEqual([earlier.slug, latestEth.slug]);
    expect(samples[1].finalPrice).toBe(220);
  });

  it("reads incrementally: appends appear, partial lines wait, and a compacted file reloads", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "polybot-analytics-"));
    temps.push(dataDir);
    const analyticsPath = join(dataDir, "analytics.jsonl");
    const base = Date.UTC(2026, 4, 8, 12, 0, 0);
    const first = analyticsSample(marketInfo("BTC", base));
    const second = analyticsSample(marketInfo("ETH", base + 300_000));
    const third = analyticsSample(marketInfo("DOGE", base + 600_000));

    await writeFile(analyticsPath, serializeAnalyticsSamples([first]), "utf8");
    expect((await readAnalyticsSamples(analyticsPath)).map((sample) => sample.slug)).toEqual([first.slug]);

    // A complete appended line shows up on the next read (tail-only parse).
    await appendFile(analyticsPath, serializeAnalyticsSamples([second]), "utf8");
    expect((await readAnalyticsSamples(analyticsPath)).map((sample) => sample.slug)).toEqual([
      first.slug,
      second.slug,
    ]);

    // A PARTIAL line (writer mid-append) must not be consumed until its newline lands.
    const thirdLine = serializeAnalyticsSamples([third]);
    await appendFile(analyticsPath, thirdLine.slice(0, 25), "utf8");
    expect(await readAnalyticsSamples(analyticsPath)).toHaveLength(2);
    await appendFile(analyticsPath, thirdLine.slice(25), "utf8");
    expect((await readAnalyticsSamples(analyticsPath)).map((sample) => sample.slug)).toEqual([
      first.slug,
      second.slug,
      third.slug,
    ]);

    // Compaction rewrites the file smaller: the cache must detect it and fully reload.
    await writeFile(analyticsPath, serializeAnalyticsSamples([third]), "utf8");
    expect((await readAnalyticsSamples(analyticsPath)).map((sample) => sample.slug)).toEqual([third.slug]);
  });

  it("trims the analytics file to the most recent samples and collapses duplicate slugs", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "polybot-analytics-"));
    temps.push(dataDir);
    const analyticsPath = join(dataDir, "analytics.jsonl");
    const base = Date.UTC(2026, 4, 8, 12, 0, 0);
    const samples = Array.from({ length: 12 }, (_value, index) =>
      analyticsSample(marketInfo("BTC", base + index * 300_000)),
    );
    // Append the oldest sample a second time (newer finalPrice) to exercise slug de-duplication.
    const duplicate = { ...samples[0], finalPrice: 999 };
    await writeFile(analyticsPath, serializeAnalyticsSamples([...samples, duplicate]), "utf8");

    const kept = await trimAnalyticsFileToMostRecent(analyticsPath, 5);

    expect(kept).toBe(5);
    const remaining = await readAnalyticsSamples(analyticsPath);
    expect(remaining).toHaveLength(5);
    expect(remaining.map((sample) => sample.windowStartMs)).toEqual(
      samples.slice(-5).map((sample) => sample.windowStartMs),
    );
  });

  it("leaves the analytics file untouched when within the limit", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "polybot-analytics-"));
    temps.push(dataDir);
    const analyticsPath = join(dataDir, "analytics.jsonl");
    const base = Date.UTC(2026, 4, 8, 12, 0, 0);
    const samples = Array.from({ length: 3 }, (_value, index) =>
      analyticsSample(marketInfo("ETH", base + index * 300_000)),
    );
    await writeFile(analyticsPath, serializeAnalyticsSamples(samples), "utf8");

    const kept = await trimAnalyticsFileToMostRecent(analyticsPath, 5);

    expect(kept).toBe(3);
    expect(await readAnalyticsSamples(analyticsPath)).toHaveLength(3);
  });

  it("prunes resolved samples to the configured limit as the recorder writes", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "polybot-analytics-"));
    temps.push(dataDir);
    const recorder = new AnalyticsRecorder(dataDir, 3, 0);
    const base = Date.UTC(2026, 4, 8, 12, 0, 0);

    for (let index = 0; index < 6; index += 1) {
      await resolveSample(recorder, marketInfo("BTC", base + index * 300_000));
    }

    const samples = await recorder.readSamples();
    expect(samples.length).toBeLessThanOrEqual(3);
    expect(Math.max(...samples.map((sample) => sample.windowStartMs))).toBe(base + 5 * 300_000);
  });

  it("does not import analytics samples already known by slug", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "polybot-analytics-"));
    temps.push(dataDir);
    const analyticsPath = join(dataDir, "analytics.jsonl");
    const sample = analyticsSample(marketInfo("BTC", Date.UTC(2026, 4, 8, 12, 0, 0)));

    await importAnalyticsSamples(analyticsPath, JSON.stringify(sample));
    const duplicateResult = await importAnalyticsSamples(analyticsPath, JSON.stringify(sample));

    expect(duplicateResult.importedCount).toBe(0);
    expect(duplicateResult.duplicateCount).toBe(1);
    expect(duplicateResult.totalKnownSamples).toBe(1);
  });
});

async function resolveSample(recorder: AnalyticsRecorder, market: MarketInfo): Promise<void> {
  const opening = openingInfo(market);
  await recorder.observeMarket({
    market,
    opening,
    tick: priceTick(market.asset, market.endMs - 30_000, 110),
    quotes: quotes(),
    nowMs: market.endMs - 30_000,
  });
  await recorder.observeMarket({
    market,
    opening,
    tick: priceTick(market.asset, market.endMs, 112),
    quotes: {},
    nowMs: market.endMs,
  });
}

function marketInfo(asset: MarketSymbol, windowStartMs: number): MarketInfo {
  const prefix = asset.toLowerCase();
  return {
    asset,
    slug: `${prefix}-updown-5m-${Math.floor(windowStartMs / 1000)}`,
    title: `${asset} Up or Down`,
    conditionId: `${asset}-condition`,
    windowStartMs,
    endMs: windowStartMs + 300_000,
    eventStartTimeMs: windowStartMs,
    acceptingOrders: true,
    active: true,
    closed: false,
    tickSize: "0.01",
    negRisk: false,
    orderMinSize: 1,
    outcomes: {
      UP: { outcome: "UP", label: "Up", tokenId: `${asset}-up` },
      DOWN: { outcome: "DOWN", label: "Down", tokenId: `${asset}-down` },
    },
  };
}

function openingInfo(market: MarketInfo): WindowOpening {
  return {
    asset: market.asset,
    slug: market.slug,
    windowStartMs: market.windowStartMs,
    openingPrice: 100,
    openingTickTimestampMs: market.windowStartMs,
    capturedAtMs: market.windowStartMs,
  };
}

function priceTick(market: MarketSymbol, timestampMs: number, value: number): PriceTick {
  return {
    market,
    symbol: market === "BTC" ? "btc/usd" : market === "ETH" ? "eth/usd" : "doge/usd",
    value,
    timestampMs,
    receivedAtMs: timestampMs,
  };
}

function quotes(): Partial<Record<Outcome, OrderbookQuote>> {
  return {
    UP: quote("up-token", 0.52),
    DOWN: quote("down-token", 0.48),
  };
}

function quote(tokenId: string, bestAsk: number): OrderbookQuote {
  return {
    tokenId,
    bestAsk,
    bestBid: bestAsk - 0.01,
    availableUsdUnderCap: 100,
    estimatedSharesForAmount: 1 / bestAsk,
    rawAskLevels: [{ price: bestAsk, size: 100 }],
  };
}

function analyticsSample(market: MarketInfo, overrides: Partial<ReturnType<typeof analyticsSampleShape>> = {}): ReturnType<typeof analyticsSampleShape> {
  return {
    ...analyticsSampleShape(market),
    ...overrides,
  };
}

function analyticsSampleShape(market: MarketInfo) {
  return {
    version: 1 as const,
    market: market.asset,
    slug: market.slug,
    windowStartMs: market.windowStartMs,
    endMs: market.endMs,
    openingPrice: 100,
    openingTickTimestampMs: market.windowStartMs,
    ticks: [
      {
        timestampMs: market.endMs - 30_000,
        secondsToEnd: 30,
        price: 112,
        distanceUsd: 12,
      },
    ],
    quotes: [
      {
        timestampMs: market.endMs - 30_000,
        secondsToEnd: 30,
        upBestAsk: 0.52,
        upBestBid: 0.51,
        downBestAsk: 0.49,
        downBestBid: 0.48,
      },
    ],
    finalPrice: 112,
    finalTickTimestampMs: market.endMs,
    winningOutcome: "UP" as const,
    resolvedAtMs: market.endMs + 1_000,
  };
}

function tradeAttempt(market: MarketInfo, outcome: Outcome): TradeAttempt {
  return {
    id: `${market.slug}-trade`,
    asset: market.asset,
    slug: market.slug,
    mode: "sim",
    conditionId: market.conditionId,
    outcome,
    tokenId: market.outcomes[outcome].tokenId,
    amountUsd: 1,
    maxAskPrice: 0.98,
    bestAsk: 0.47,
    estimatedShares: 2.12,
    openingPrice: 100,
    entryPrice: outcome === "UP" ? 110 : 90,
    distanceUsd: 10,
    entryWindowSeconds: 30,
    windowStartMs: market.windowStartMs,
    endMs: market.endMs,
    createdAtMs: market.endMs - 30_000,
  };
}

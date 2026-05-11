import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { secondsToEnd } from "./time.js";
import type {
  AnalyticsQuotePoint,
  AnalyticsSample,
  AnalyticsTickPoint,
  MarketInfo,
  OrderbookQuote,
  Outcome,
  PriceTick,
  WindowOpening,
} from "./types.js";

export const ANALYTICS_WINDOW_SECONDS = 60;

export interface AnalyticsObservation {
  market: MarketInfo;
  opening?: WindowOpening;
  tick?: PriceTick;
  quotes?: Partial<Record<Outcome, OrderbookQuote>>;
  nowMs: number;
}

export class AnalyticsRecorder {
  private readonly activeSamples = new Map<string, AnalyticsSample>();

  constructor(private readonly dataDir: string) {}

  get analyticsPath(): string {
    return join(this.dataDir, "analytics.jsonl");
  }

  async observeMarket(observation: AnalyticsObservation): Promise<void> {
    if (observation.tick) {
      await this.resolveClosedSamples(observation.tick, observation.nowMs);
      if (observation.tick.timestampMs >= observation.market.endMs) {
        return;
      }
    }
    if (!observation.opening) {
      return;
    }

    const sample = this.getOrCreateSample(observation.market, observation.opening);
    if (observation.tick) {
      this.recordTick(sample, observation.tick);
    }
    if (observation.quotes) {
      this.recordQuote(sample, observation.quotes, observation.nowMs);
    }
    if (observation.tick) {
      await this.resolveSampleIfClosed(sample, observation.tick, observation.nowMs);
    }
  }

  async readSamples(): Promise<AnalyticsSample[]> {
    return readAnalyticsSamples(this.analyticsPath);
  }

  private getOrCreateSample(market: MarketInfo, opening: WindowOpening): AnalyticsSample {
    const existing = this.activeSamples.get(market.slug);
    if (existing) {
      return existing;
    }

    const sample: AnalyticsSample = {
      version: 1,
      market: market.asset,
      slug: market.slug,
      windowStartMs: market.windowStartMs,
      endMs: market.endMs,
      openingPrice: opening.openingPrice,
      openingTickTimestampMs: opening.openingTickTimestampMs,
      ticks: [],
      quotes: [],
    };
    this.activeSamples.set(market.slug, sample);
    return sample;
  }

  private recordTick(sample: AnalyticsSample, tick: PriceTick): void {
    if (tick.market !== sample.market) {
      return;
    }
    const remainingSeconds = secondsToEnd(sample.endMs, tick.timestampMs);
    if (remainingSeconds < 0 || remainingSeconds > ANALYTICS_WINDOW_SECONDS) {
      return;
    }

    const point: AnalyticsTickPoint = {
      timestampMs: tick.timestampMs,
      secondsToEnd: remainingSeconds,
      price: tick.value,
      distanceUsd: tick.value - sample.openingPrice,
    };
    upsertByTimestamp(sample.ticks, point);
  }

  private recordQuote(
    sample: AnalyticsSample,
    quotes: Partial<Record<Outcome, OrderbookQuote>>,
    nowMs: number,
  ): void {
    const remainingSeconds = secondsToEnd(sample.endMs, nowMs);
    if (remainingSeconds <= 0 || remainingSeconds > ANALYTICS_WINDOW_SECONDS) {
      return;
    }

    const point: AnalyticsQuotePoint = {
      timestampMs: nowMs,
      secondsToEnd: remainingSeconds,
      upBestAsk: quotes.UP?.bestAsk,
      upBestBid: quotes.UP?.bestBid,
      downBestAsk: quotes.DOWN?.bestAsk,
      downBestBid: quotes.DOWN?.bestBid,
    };
    upsertByTimestamp(sample.quotes, point);
  }

  private async resolveClosedSamples(tick: PriceTick, nowMs: number): Promise<void> {
    const samples = [...this.activeSamples.values()].filter(
      (sample) => sample.market === tick.market && tick.timestampMs >= sample.endMs,
    );
    for (const sample of samples) {
      await this.resolveSampleIfClosed(sample, tick, nowMs);
    }
  }

  private async resolveSampleIfClosed(sample: AnalyticsSample, tick: PriceTick, nowMs: number): Promise<void> {
    if (tick.market !== sample.market || tick.timestampMs < sample.endMs || sample.resolvedAtMs) {
      return;
    }

    const resolved: AnalyticsSample = {
      ...sample,
      finalPrice: tick.value,
      finalTickTimestampMs: tick.timestampMs,
      winningOutcome: tick.value >= sample.openingPrice ? "UP" : "DOWN",
      resolvedAtMs: nowMs,
      ticks: sortByTimestamp(sample.ticks),
      quotes: sortByTimestamp(sample.quotes),
    };
    await this.appendSample(resolved);
    this.activeSamples.delete(sample.slug);
  }

  private async appendSample(sample: AnalyticsSample): Promise<void> {
    await mkdir(dirname(this.analyticsPath), { recursive: true });
    await appendFile(
      this.analyticsPath,
      `${JSON.stringify({ at: new Date().toISOString(), type: "analytics_sample", sample })}\n`,
      "utf8",
    );
  }
}

export async function readAnalyticsSamples(path: string): Promise<AnalyticsSample[]> {
  let contents = "";
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const latestBySlug = new Map<string, AnalyticsSample>();
  for (const line of contents.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    const sample = parseAnalyticsLine(line);
    if (sample?.resolvedAtMs && sample.winningOutcome) {
      latestBySlug.set(sample.slug, sample);
    }
  }
  return [...latestBySlug.values()].sort((left, right) => left.windowStartMs - right.windowStartMs);
}

function parseAnalyticsLine(line: string): AnalyticsSample | undefined {
  try {
    const parsed = JSON.parse(line) as unknown;
    const sample = isRecord(parsed) && isRecord(parsed.sample) ? parsed.sample : parsed;
    return isAnalyticsSample(sample) ? sample : undefined;
  } catch {
    return undefined;
  }
}

function isAnalyticsSample(value: unknown): value is AnalyticsSample {
  if (!isRecord(value)) {
    return false;
  }
  return (
    value.version === 1 &&
    typeof value.slug === "string" &&
    typeof value.market === "string" &&
    typeof value.windowStartMs === "number" &&
    typeof value.endMs === "number" &&
    typeof value.openingPrice === "number" &&
    Array.isArray(value.ticks) &&
    Array.isArray(value.quotes)
  );
}

function upsertByTimestamp<T extends { timestampMs: number }>(items: T[], item: T): void {
  const existingIndex = items.findIndex((existing) => existing.timestampMs === item.timestampMs);
  if (existingIndex >= 0) {
    items[existingIndex] = item;
    return;
  }
  items.push(item);
  items.sort((left, right) => left.timestampMs - right.timestampMs);
}

function sortByTimestamp<T extends { timestampMs: number }>(items: T[]): T[] {
  return [...items].sort((left, right) => left.timestampMs - right.timestampMs);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

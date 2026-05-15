import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { marketSymbolFromSlug } from "./markets.js";
import { secondsToEnd } from "./time.js";
import type {
  AnalyticsQuotePoint,
  AnalyticsSample,
  AnalyticsTickPoint,
  MarketInfo,
  OrderbookQuote,
  Outcome,
  PriceTick,
  TradeAttempt,
  WindowOpening,
} from "./types.js";

export const ANALYTICS_WINDOW_SECONDS = 60;
const MAX_SAMPLE_RESOLUTION_DELAY_MS = 10 * 60 * 1000;

export interface AnalyticsObservation {
  market: MarketInfo;
  opening?: WindowOpening;
  tick?: PriceTick;
  quotes?: Partial<Record<Outcome, OrderbookQuote>>;
  nowMs: number;
}

export class AnalyticsRecorder {
  private readonly activeSamples = new Map<string, AnalyticsSample>();
  private activeSamplesHydrated = false;

  constructor(private readonly dataDir: string) {}

  get analyticsPath(): string {
    return join(this.dataDir, "analytics.jsonl");
  }

  get activeSamplesPath(): string {
    return join(this.dataDir, "analytics-active.json");
  }

  async observeMarket(observation: AnalyticsObservation): Promise<void> {
    await this.hydrateActiveSamples();
    let changed = false;

    if (observation.tick) {
      changed = (await this.resolveClosedSamples(observation.tick, observation.nowMs)) || changed;
      if (observation.tick.timestampMs >= observation.market.endMs) {
        if (changed) {
          await this.persistActiveSamples();
        }
        return;
      }
    }
    if (!observation.opening) {
      if (changed) {
        await this.persistActiveSamples();
      }
      return;
    }

    const { sample, created } = this.getOrCreateSample(observation.market, observation.opening);
    changed = created || changed;
    if (observation.tick) {
      changed = this.recordTick(sample, observation.tick) || changed;
    }
    if (observation.quotes) {
      changed = this.recordQuote(sample, observation.quotes, observation.nowMs) || changed;
    }
    if (observation.tick) {
      changed = (await this.resolveSampleIfClosed(sample, observation.tick, observation.nowMs)) || changed;
    }
    if (changed) {
      await this.persistActiveSamples();
    }
  }

  async readSamples(): Promise<AnalyticsSample[]> {
    return readAnalyticsSamples(this.analyticsPath);
  }

  async recordResolvedTrade(trade: TradeAttempt, resolution: NonNullable<TradeAttempt["resolved"]>): Promise<void> {
    await this.hydrateActiveSamples();
    const market = trade.asset ?? marketSymbolFromSlug(trade.slug);
    if (
      !market ||
      !isFiniteNumber(trade.openingPrice) ||
      !isFiniteNumber(trade.entryPrice) ||
      resolution.finalTickTimestampMs - trade.endMs > MAX_SAMPLE_RESOLUTION_DELAY_MS
    ) {
      return;
    }

    const tickTimestampMs = clamp(
      isFiniteNumber(trade.createdAtMs) ? trade.createdAtMs : trade.endMs - 1,
      trade.windowStartMs + 1,
      trade.endMs - 1,
    );
    const quotePoint = isPositiveFiniteNumber(trade.bestAsk)
      ? [{
          timestampMs: tickTimestampMs,
          secondsToEnd: secondsToEnd(trade.endMs, tickTimestampMs),
          upBestAsk: trade.outcome === "UP" ? trade.bestAsk : undefined,
          downBestAsk: trade.outcome === "DOWN" ? trade.bestAsk : undefined,
        } satisfies AnalyticsQuotePoint]
      : [];

    await this.appendSample({
      version: 1,
      market,
      slug: trade.slug,
      windowStartMs: trade.windowStartMs,
      endMs: trade.endMs,
      openingPrice: trade.openingPrice,
      openingTickTimestampMs: trade.windowStartMs,
      ticks: [
        {
          timestampMs: tickTimestampMs,
          secondsToEnd: secondsToEnd(trade.endMs, tickTimestampMs),
          price: trade.entryPrice,
          distanceUsd: trade.entryPrice - trade.openingPrice,
        },
      ],
      quotes: quotePoint,
      finalPrice: resolution.finalPrice,
      finalTickTimestampMs: resolution.finalTickTimestampMs,
      winningOutcome: resolution.winningOutcome,
      resolvedAtMs: resolution.resolvedAtMs,
    });
  }

  private getOrCreateSample(market: MarketInfo, opening: WindowOpening): { sample: AnalyticsSample; created: boolean } {
    const existing = this.activeSamples.get(market.slug);
    if (existing) {
      return { sample: existing, created: false };
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
    return { sample, created: true };
  }

  private recordTick(sample: AnalyticsSample, tick: PriceTick): boolean {
    if (tick.market !== sample.market) {
      return false;
    }
    const remainingSeconds = secondsToEnd(sample.endMs, tick.timestampMs);
    if (remainingSeconds < 0 || remainingSeconds > ANALYTICS_WINDOW_SECONDS) {
      return false;
    }

    const point: AnalyticsTickPoint = {
      timestampMs: tick.timestampMs,
      secondsToEnd: remainingSeconds,
      price: tick.value,
      distanceUsd: tick.value - sample.openingPrice,
    };
    return upsertByTimestamp(sample.ticks, point);
  }

  private recordQuote(
    sample: AnalyticsSample,
    quotes: Partial<Record<Outcome, OrderbookQuote>>,
    nowMs: number,
  ): boolean {
    const remainingSeconds = secondsToEnd(sample.endMs, nowMs);
    if (remainingSeconds <= 0 || remainingSeconds > ANALYTICS_WINDOW_SECONDS) {
      return false;
    }

    const point: AnalyticsQuotePoint = {
      timestampMs: nowMs,
      secondsToEnd: remainingSeconds,
      upBestAsk: quotes.UP?.bestAsk,
      upBestBid: quotes.UP?.bestBid,
      downBestAsk: quotes.DOWN?.bestAsk,
      downBestBid: quotes.DOWN?.bestBid,
    };
    return upsertByTimestamp(sample.quotes, point);
  }

  private async resolveClosedSamples(tick: PriceTick, nowMs: number): Promise<boolean> {
    let changed = false;
    const samples = [...this.activeSamples.values()].filter(
      (sample) => sample.market === tick.market && tick.timestampMs >= sample.endMs,
    );
    for (const sample of samples) {
      changed = (await this.resolveSampleIfClosed(sample, tick, nowMs)) || changed;
    }
    return changed;
  }

  private async resolveSampleIfClosed(sample: AnalyticsSample, tick: PriceTick, nowMs: number): Promise<boolean> {
    if (tick.market !== sample.market || tick.timestampMs < sample.endMs || sample.resolvedAtMs) {
      return false;
    }
    if (tick.timestampMs - sample.endMs > MAX_SAMPLE_RESOLUTION_DELAY_MS) {
      this.activeSamples.delete(sample.slug);
      return true;
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
    return true;
  }

  private async appendSample(sample: AnalyticsSample): Promise<void> {
    await mkdir(dirname(this.analyticsPath), { recursive: true });
    await appendFile(
      this.analyticsPath,
      `${JSON.stringify({ at: new Date().toISOString(), type: "analytics_sample", sample })}\n`,
      "utf8",
    );
  }

  private async hydrateActiveSamples(): Promise<void> {
    if (this.activeSamplesHydrated) {
      return;
    }
    this.activeSamplesHydrated = true;
    let contents = "";
    try {
      contents = await readFile(this.activeSamplesPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw error;
    }

    const parsed = JSON.parse(contents) as unknown;
    if (!Array.isArray(parsed)) {
      return;
    }
    for (const item of parsed) {
      if (isAnalyticsSample(item) && !item.resolvedAtMs) {
        this.activeSamples.set(item.slug, item);
      }
    }
  }

  private async persistActiveSamples(): Promise<void> {
    await mkdir(dirname(this.activeSamplesPath), { recursive: true });
    const tempPath = `${this.activeSamplesPath}.tmp`;
    await writeFile(tempPath, `${JSON.stringify([...this.activeSamples.values()], null, 2)}\n`, "utf8");
    await rename(tempPath, this.activeSamplesPath);
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

function upsertByTimestamp<T extends { timestampMs: number }>(items: T[], item: T): boolean {
  const existingIndex = items.findIndex((existing) => existing.timestampMs === item.timestampMs);
  if (existingIndex >= 0) {
    items[existingIndex] = item;
    return true;
  }
  items.push(item);
  items.sort((left, right) => left.timestampMs - right.timestampMs);
  return true;
}

function sortByTimestamp<T extends { timestampMs: number }>(items: T[]): T[] {
  return [...items].sort((left, right) => left.timestampMs - right.timestampMs);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value > 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

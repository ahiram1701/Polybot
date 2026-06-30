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
const ANALYTICS_RECORD_TYPE = "analytics_sample";
// Retention: keep at most this many (most recent) resolved samples on disk so analytics.jsonl
// cannot grow without bound. The slack is a high-water margin so we rewrite the file rarely
// (~every ANALYTICS_PRUNE_SLACK new samples) instead of on every append.
const MAX_ANALYTICS_SAMPLES = 6000;
const ANALYTICS_PRUNE_SLACK = 600;

export interface AnalyticsObservation {
  market: MarketInfo;
  opening?: WindowOpening;
  tick?: PriceTick;
  quotes?: Partial<Record<Outcome, OrderbookQuote>>;
  nowMs: number;
}

export interface AnalyticsImportResult {
  importedCount: number;
  duplicateCount: number;
  skippedInvalidCount: number;
  totalKnownSamples: number;
  firstSampleAtMs?: number;
  lastSampleAtMs?: number;
  validSampleCount: number;
}

export interface ParsedAnalyticsSamples {
  samples: AnalyticsSample[];
  duplicateCount: number;
  skippedInvalidCount: number;
}

export class AnalyticsRecorder {
  private readonly activeSamples = new Map<string, AnalyticsSample>();
  private activeSamplesHydrated = false;
  private analyticsSampleCount?: number;

  constructor(
    private readonly dataDir: string,
    private readonly maxSamples = MAX_ANALYTICS_SAMPLES,
    private readonly pruneSlack = ANALYTICS_PRUNE_SLACK,
  ) {}

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
    await appendFile(this.analyticsPath, `${formatAnalyticsSampleLine(sample)}\n`, "utf8");
    await this.maybePruneAnalytics();
  }

  private async maybePruneAnalytics(): Promise<void> {
    // First append after start: reconcile the count against disk and trim any legacy backlog.
    if (this.analyticsSampleCount === undefined) {
      this.analyticsSampleCount = await trimAnalyticsFileToMostRecent(this.analyticsPath, this.maxSamples);
      return;
    }
    this.analyticsSampleCount += 1;
    if (this.analyticsSampleCount > this.maxSamples + this.pruneSlack) {
      this.analyticsSampleCount = await trimAnalyticsFileToMostRecent(this.analyticsPath, this.maxSamples);
    }
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
    if (sample && isResolvedAnalyticsSample(sample)) {
      latestBySlug.set(sample.slug, sample);
    }
  }
  return [...latestBySlug.values()].sort((left, right) => left.windowStartMs - right.windowStartMs);
}

export function serializeAnalyticsSamples(samples: AnalyticsSample[], at = new Date()): string {
  if (samples.length === 0) {
    return "";
  }
  return `${samples.map((sample) => formatAnalyticsSampleLine(sample, at)).join("\n")}\n`;
}

export function parseAnalyticsSamplesText(contents: string): ParsedAnalyticsSamples {
  const latestBySlug = new Map<string, AnalyticsSample>();
  let duplicateCount = 0;
  let skippedInvalidCount = 0;

  for (const line of contents.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    const sample = parseAnalyticsLine(line);
    if (!sample || !isResolvedAnalyticsSample(sample)) {
      skippedInvalidCount += 1;
      continue;
    }
    if (latestBySlug.has(sample.slug)) {
      duplicateCount += 1;
    }
    latestBySlug.set(sample.slug, sample);
  }

  return {
    samples: [...latestBySlug.values()].sort((left, right) => left.windowStartMs - right.windowStartMs),
    duplicateCount,
    skippedInvalidCount,
  };
}

export async function importAnalyticsSamples(
  path: string,
  contents: string,
  importedAt = new Date(),
): Promise<AnalyticsImportResult> {
  const parsed = parseAnalyticsSamplesText(contents);
  const existingSamples = await readAnalyticsSamples(path);
  const existingSlugs = new Set(existingSamples.map((sample) => sample.slug));
  const samplesToImport: AnalyticsSample[] = [];
  let duplicateCount = parsed.duplicateCount;

  for (const sample of parsed.samples) {
    if (existingSlugs.has(sample.slug)) {
      duplicateCount += 1;
      continue;
    }
    samplesToImport.push(sample);
  }

  if (samplesToImport.length > 0) {
    await appendAnalyticsSamples(path, samplesToImport, importedAt);
    await trimAnalyticsFileToMostRecent(path, MAX_ANALYTICS_SAMPLES);
  }

  const knownSamples = samplesToImport.length > 0 ? await readAnalyticsSamples(path) : existingSamples;
  const range = analyticsSampleRange(knownSamples);
  return {
    importedCount: samplesToImport.length,
    duplicateCount,
    skippedInvalidCount: parsed.skippedInvalidCount,
    totalKnownSamples: knownSamples.length,
    ...range,
    validSampleCount: parsed.samples.length + parsed.duplicateCount,
  };
}

export function analyticsSampleRange(
  samples: AnalyticsSample[],
): Pick<AnalyticsImportResult, "firstSampleAtMs" | "lastSampleAtMs"> {
  let firstSampleAtMs: number | undefined;
  let lastSampleAtMs: number | undefined;
  for (const sample of samples) {
    const sampleAtMs = sample.resolvedAtMs ?? sample.endMs ?? sample.windowStartMs;
    if (!isFiniteNumber(sampleAtMs)) {
      continue;
    }
    firstSampleAtMs = firstSampleAtMs === undefined ? sampleAtMs : Math.min(firstSampleAtMs, sampleAtMs);
    lastSampleAtMs = lastSampleAtMs === undefined ? sampleAtMs : Math.max(lastSampleAtMs, sampleAtMs);
  }
  return { firstSampleAtMs, lastSampleAtMs };
}

async function appendAnalyticsSamples(path: string, samples: AnalyticsSample[], at: Date): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, serializeAnalyticsSamples(samples, at), "utf8");
}

/**
 * Trim the analytics file so it keeps at most `maxSamples` of the most recent (highest windowStartMs)
 * resolved samples. Reads via readAnalyticsSamples (deduped + sorted ascending), keeps the tail, and
 * rewrites atomically via temp + rename. No-op when already within the limit. Returns the kept count.
 */
export async function trimAnalyticsFileToMostRecent(path: string, maxSamples: number): Promise<number> {
  const samples = await readAnalyticsSamples(path);
  if (samples.length <= maxSamples) {
    return samples.length;
  }
  const kept = samples.slice(-maxSamples);
  const tempPath = `${path}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(tempPath, serializeAnalyticsSamples(kept), "utf8");
  await rename(tempPath, path);
  return kept.length;
}

function formatAnalyticsSampleLine(sample: AnalyticsSample, at = new Date()): string {
  return JSON.stringify({ at: at.toISOString(), type: ANALYTICS_RECORD_TYPE, sample });
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
    isMarketSymbol(value.market) &&
    isFiniteNumber(value.windowStartMs) &&
    isFiniteNumber(value.endMs) &&
    isFiniteNumber(value.openingPrice) &&
    isFiniteNumber(value.openingTickTimestampMs) &&
    Array.isArray(value.ticks) &&
    value.ticks.every(isAnalyticsTickPoint) &&
    Array.isArray(value.quotes) &&
    value.quotes.every(isAnalyticsQuotePoint) &&
    (value.finalPrice === undefined || isFiniteNumber(value.finalPrice)) &&
    (value.finalTickTimestampMs === undefined || isFiniteNumber(value.finalTickTimestampMs)) &&
    (value.winningOutcome === undefined || isOutcome(value.winningOutcome)) &&
    (value.resolvedAtMs === undefined || isFiniteNumber(value.resolvedAtMs))
  );
}

function isResolvedAnalyticsSample(value: AnalyticsSample): boolean {
  return isFiniteNumber(value.resolvedAtMs) && isOutcome(value.winningOutcome);
}

function isAnalyticsTickPoint(value: unknown): value is AnalyticsTickPoint {
  return (
    isRecord(value) &&
    isFiniteNumber(value.timestampMs) &&
    isFiniteNumber(value.secondsToEnd) &&
    isFiniteNumber(value.price) &&
    isFiniteNumber(value.distanceUsd)
  );
}

function isAnalyticsQuotePoint(value: unknown): value is AnalyticsQuotePoint {
  return (
    isRecord(value) &&
    isFiniteNumber(value.timestampMs) &&
    isFiniteNumber(value.secondsToEnd) &&
    (value.upBestAsk === undefined || isFiniteNumber(value.upBestAsk)) &&
    (value.upBestBid === undefined || isFiniteNumber(value.upBestBid)) &&
    (value.downBestAsk === undefined || isFiniteNumber(value.downBestAsk)) &&
    (value.downBestBid === undefined || isFiniteNumber(value.downBestBid))
  );
}

function isMarketSymbol(value: unknown): value is AnalyticsSample["market"] {
  return value === "BTC" || value === "ETH" || value === "DOGE";
}

function isOutcome(value: unknown): value is Outcome {
  return value === "UP" || value === "DOWN";
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

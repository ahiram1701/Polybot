import type { MarketInfo, Outcome, OutcomeToken } from "./types.js";
import type { MarketSymbol } from "./types.js";
import {
  getUpDownSlugFromStartMs,
  getWindowEndMs,
  getWindowStartMs,
  getWindowStartMsFromSlug,
} from "./time.js";
import { marketSymbolFromSlug } from "./markets.js";

type FetchLike = typeof fetch;

export class MarketWatcher {
  private readonly cache = new Map<string, { expiresAtMs: number; market: MarketInfo | null }>();

  constructor(
    private readonly gammaHost: string,
    private readonly fetchFn: FetchLike = fetch,
    private readonly cacheTtlMs = 5_000,
  ) {}

  async getCurrentMarket(nowMs = Date.now(), market: MarketSymbol = "BTC"): Promise<MarketInfo | null> {
    return this.getMarketByWindowStartMs(getWindowStartMs(nowMs), nowMs, market);
  }

  async getCurrentMarkets(markets: MarketSymbol[], nowMs = Date.now()): Promise<MarketInfo[]> {
    const results = await Promise.all(
      markets.map((market) => this.getMarketByWindowStartMs(getWindowStartMs(nowMs), nowMs, market)),
    );
    return results.filter((market): market is MarketInfo => Boolean(market));
  }

  async getMarketByWindowStartMs(
    windowStartMs: number,
    nowMs = Date.now(),
    market: MarketSymbol = "BTC",
  ): Promise<MarketInfo | null> {
    const slug = getUpDownSlugFromStartMs(market, windowStartMs);
    return this.getMarketBySlug(slug, nowMs);
  }

  async getMarketBySlug(slug: string, nowMs = Date.now()): Promise<MarketInfo | null> {
    const cached = this.cache.get(slug);
    if (cached && cached.expiresAtMs > nowMs) {
      return cached.market;
    }

    // Cap the gamma request so a stall can't delay the loop (AbortSignal actually cancels the socket).
    const response = await this.fetchFn(`${this.gammaHost}/events/slug/${slug}`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (response.status === 404) {
      this.cache.set(slug, { expiresAtMs: nowMs + this.cacheTtlMs, market: null });
      return null;
    }
    if (!response.ok) {
      throw new Error(`Gamma API ${response.status} while fetching ${slug}: ${await response.text()}`);
    }

    const raw = (await response.json()) as unknown;
    const market = parseGammaEvent(raw, slug);
    this.cache.set(slug, { expiresAtMs: nowMs + this.cacheTtlMs, market });
    return market;
  }
}

export function parseGammaEvent(raw: unknown, slug: string): MarketInfo {
  const event = asRecord(raw, "event");
  const asset = marketSymbolFromSlug(slug);
  if (!asset) {
    throw new Error(`Unsupported crypto 5m slug: ${slug}`);
  }
  const markets = asArray(event.markets, "event.markets").map((market) => asRecord(market, "market"));
  const rawMarket = markets.find((market) => market.slug === slug) ?? markets[0];
  if (!rawMarket) {
    throw new Error(`Gamma event ${slug} does not contain markets.`);
  }

  const outcomes = parseStringArray(rawMarket.outcomes, "market.outcomes");
  const tokenIds = parseStringArray(rawMarket.clobTokenIds, "market.clobTokenIds");
  const outcomePrices = parseNumberArray(rawMarket.outcomePrices, "market.outcomePrices");
  if (outcomes.length !== tokenIds.length) {
    throw new Error(`Market ${slug} outcome/token count mismatch.`);
  }

  const outcomeTokens = {} as Record<Outcome, OutcomeToken>;
  outcomes.forEach((label, index) => {
    const outcome = normalizeOutcome(label);
    if (outcome) {
      outcomeTokens[outcome] = {
        outcome,
        label,
        tokenId: tokenIds[index],
        impliedPrice: outcomePrices[index],
      };
    }
  });

  if (!outcomeTokens.UP || !outcomeTokens.DOWN) {
    throw new Error(`Market ${slug} does not include Up and Down outcomes.`);
  }

  const windowStartMs = safeDateMs(rawMarket.eventStartTime ?? event.startTime, getWindowStartMsFromSlug(slug));
  const endMs = safeDateMs(rawMarket.endDate ?? event.endDate, getWindowEndMs(windowStartMs));
  const eventStartTimeMs = safeDateMs(rawMarket.eventStartTime ?? event.startTime, windowStartMs);

  return {
    asset,
    slug: String(rawMarket.slug ?? slug),
    title: String(rawMarket.question ?? event.title ?? slug),
    conditionId: String(rawMarket.conditionId ?? ""),
    windowStartMs,
    endMs,
    eventStartTimeMs,
    acceptingOrders: Boolean(rawMarket.acceptingOrders),
    active: Boolean(rawMarket.active),
    closed: Boolean(rawMarket.closed),
    tickSize: String(rawMarket.orderPriceMinTickSize ?? rawMarket.minimum_tick_size ?? "0.01"),
    negRisk: Boolean(rawMarket.negRisk),
    orderMinSize: Number(rawMarket.orderMinSize ?? 5),
    outcomes: outcomeTokens,
  };
}

function normalizeOutcome(label: string): Outcome | null {
  const normalized = label.trim().toUpperCase();
  if (normalized === "UP") {
    return "UP";
  }
  if (normalized === "DOWN") {
    return "DOWN";
  }
  return null;
}

function parseStringArray(value: unknown, label: string): string[] {
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  return asArray(parsed, label).map((item) => String(item));
}

function parseNumberArray(value: unknown, label: string): number[] {
  if (value === undefined || value === null || value === "") {
    return [];
  }
  const parsed = typeof value === "string" ? JSON.parse(value) : value;
  return asArray(parsed, label).map((item) => Number(item));
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function asArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array.`);
  }
  return value;
}

function safeDateMs(value: unknown, fallback: number): number {
  if (typeof value !== "string") {
    return fallback;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

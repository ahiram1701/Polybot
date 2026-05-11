import type {
  MarketDistanceSettings,
  MarketEntryWindowSettings,
  MarketSymbol,
  PriceFeedSymbol,
} from "./types.js";

export interface MarketDefinition {
  symbol: MarketSymbol;
  label: string;
  slugPrefix: string;
  priceFeedSymbol: PriceFeedSymbol;
  defaultMinDistanceUsd: number;
  defaultEntryWindowSeconds: number;
}

export const SUPPORTED_MARKETS = ["BTC", "ETH", "DOGE"] as const satisfies readonly MarketSymbol[];
export const DEFAULT_ENTRY_WINDOW_SECONDS = 20;

export const MARKET_DEFINITIONS: Record<MarketSymbol, MarketDefinition> = {
  BTC: {
    symbol: "BTC",
    label: "Bitcoin",
    slugPrefix: "btc",
    priceFeedSymbol: "btc/usd",
    defaultMinDistanceUsd: 20,
    defaultEntryWindowSeconds: DEFAULT_ENTRY_WINDOW_SECONDS,
  },
  ETH: {
    symbol: "ETH",
    label: "Ethereum",
    slugPrefix: "eth",
    priceFeedSymbol: "eth/usd",
    defaultMinDistanceUsd: 5,
    defaultEntryWindowSeconds: DEFAULT_ENTRY_WINDOW_SECONDS,
  },
  DOGE: {
    symbol: "DOGE",
    label: "Dogecoin",
    slugPrefix: "doge",
    priceFeedSymbol: "doge/usd",
    defaultMinDistanceUsd: 0.0005,
    defaultEntryWindowSeconds: DEFAULT_ENTRY_WINDOW_SECONDS,
  },
};

const PRICE_FEED_TO_MARKET = new Map<PriceFeedSymbol, MarketSymbol>(
  SUPPORTED_MARKETS.map((symbol) => [MARKET_DEFINITIONS[symbol].priceFeedSymbol, symbol]),
);

const SLUG_PREFIX_TO_MARKET = new Map<string, MarketSymbol>(
  SUPPORTED_MARKETS.map((symbol) => [MARKET_DEFINITIONS[symbol].slugPrefix, symbol]),
);

export function defaultMarketDistances(overrides: Partial<MarketDistanceSettings> = {}): MarketDistanceSettings {
  return {
    BTC: overrides.BTC ?? MARKET_DEFINITIONS.BTC.defaultMinDistanceUsd,
    ETH: overrides.ETH ?? MARKET_DEFINITIONS.ETH.defaultMinDistanceUsd,
    DOGE: overrides.DOGE ?? MARKET_DEFINITIONS.DOGE.defaultMinDistanceUsd,
  };
}

export function defaultMarketEntryWindows(
  overrides: Partial<MarketEntryWindowSettings> = {},
  fallbackSeconds = DEFAULT_ENTRY_WINDOW_SECONDS,
): MarketEntryWindowSettings {
  const fallback = isPositiveFiniteNumber(fallbackSeconds) ? fallbackSeconds : DEFAULT_ENTRY_WINDOW_SECONDS;
  return {
    BTC: isPositiveFiniteNumber(overrides.BTC) ? overrides.BTC : fallback,
    ETH: isPositiveFiniteNumber(overrides.ETH) ? overrides.ETH : fallback,
    DOGE: isPositiveFiniteNumber(overrides.DOGE) ? overrides.DOGE : fallback,
  };
}

export function normalizeEnabledMarkets(markets: unknown, fallback: MarketSymbol[] = ["BTC"]): MarketSymbol[] {
  const items = Array.isArray(markets)
    ? markets
    : typeof markets === "string"
      ? markets.split(",")
      : fallback;

  const normalized: MarketSymbol[] = [];
  for (const item of items) {
    const symbol = normalizeMarketSymbol(item);
    if (symbol && !normalized.includes(symbol)) {
      normalized.push(symbol);
    }
  }
  return normalized;
}

export function normalizeMarketSymbol(value: unknown): MarketSymbol | undefined {
  const normalized = String(value ?? "").trim().toUpperCase();
  return isMarketSymbol(normalized) ? normalized : undefined;
}

export function isMarketSymbol(value: string): value is MarketSymbol {
  return SUPPORTED_MARKETS.includes(value as MarketSymbol);
}

export function marketSymbolFromPriceFeedSymbol(symbol: string): MarketSymbol | undefined {
  return PRICE_FEED_TO_MARKET.get(symbol.toLowerCase() as PriceFeedSymbol);
}

export function marketSymbolFromSlug(slug: string): MarketSymbol | undefined {
  const prefix = slug.split("-updown-5m-")[0]?.toLowerCase();
  return SLUG_PREFIX_TO_MARKET.get(prefix);
}

export function getMarketDefinition(symbol: MarketSymbol): MarketDefinition {
  return MARKET_DEFINITIONS[symbol];
}

export function getMinDistanceUsd(
  distances: Partial<MarketDistanceSettings> | undefined,
  symbol: MarketSymbol,
): number {
  return distances?.[symbol] ?? MARKET_DEFINITIONS[symbol].defaultMinDistanceUsd;
}

export function getEntryWindowSeconds(
  windows: Partial<MarketEntryWindowSettings> | undefined,
  symbol: MarketSymbol,
  fallbackSeconds = MARKET_DEFINITIONS[symbol].defaultEntryWindowSeconds,
): number {
  const fallback = isPositiveFiniteNumber(fallbackSeconds)
    ? fallbackSeconds
    : MARKET_DEFINITIONS[symbol].defaultEntryWindowSeconds;
  const value = windows?.[symbol];
  return isPositiveFiniteNumber(value) ? value : fallback;
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

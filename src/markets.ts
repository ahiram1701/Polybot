import type {
  MarketDistanceSettings,
  MarketEntryWindowSettings,
  MarketOutcomeBooleanSettings,
  MarketOutcomeNumberSettings,
  MarketSymbol,
  Outcome,
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
/**
 * Segundos finales en los que el bot ya NO entra: cerca del cierre el libro se vacia y el precio
 * cotizado deja de ser el que se consigue.
 *
 * Vive aqui, y no en botRunner, porque los simuladores TIENEN que honrarlo. Cuando no lo hacian,
 * contaban como oportunidad los ticks de (0, ventana] mientras produccion solo opera en
 * (10, ventana]: para una ventana de 26s eso infla la oportunidad un 62%, y para una de 60s solo un
 * 20%. El sesgo no es ruido, empuja sistematicamente hacia ventanas cortas — que es justo lo que el
 * autoajuste venia recomendando.
 */
export const DEFAULT_MIN_SECONDS_TO_END = 10;
export const DEFAULT_MAX_ASK_PRICE = 0.98;
export const DEFAULT_TRADE_AMOUNT_USD = 1;
export const OUTCOMES = ["UP", "DOWN"] as const satisfies readonly Outcome[];

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

export type MarketOutcomeNumberOverrides = Partial<Record<MarketSymbol, Partial<Record<Outcome, number>>>>;
export type MarketOutcomeBooleanOverrides = Partial<Record<MarketSymbol, Partial<Record<Outcome, boolean>>>>;

export function defaultMarketOutcomeDistances(
  overrides: MarketOutcomeNumberOverrides = {},
  fallbackByMarket: MarketDistanceSettings = defaultMarketDistances(),
): MarketOutcomeNumberSettings {
  return defaultMarketOutcomeNumbers(overrides, (symbol) => fallbackByMarket[symbol], isPositiveFiniteNumber);
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

export function defaultMarketOutcomeEntryWindows(
  overrides: MarketOutcomeNumberOverrides = {},
  fallbackByMarket: MarketEntryWindowSettings = defaultMarketEntryWindows(),
): MarketOutcomeNumberSettings {
  return defaultMarketOutcomeNumbers(overrides, (symbol) => fallbackByMarket[symbol], isPositiveFiniteNumber);
}

export function defaultMarketOutcomeAmounts(
  overrides: MarketOutcomeNumberOverrides = {},
  fallbackAmountUsd = DEFAULT_TRADE_AMOUNT_USD,
): MarketOutcomeNumberSettings {
  const fallback = isPositiveFiniteNumber(fallbackAmountUsd) ? fallbackAmountUsd : DEFAULT_TRADE_AMOUNT_USD;
  return defaultMarketOutcomeNumbers(overrides, () => fallback, isPositiveFiniteNumber);
}

export function defaultMarketOutcomeMaxAskPrices(
  overrides: MarketOutcomeNumberOverrides = {},
  fallbackMaxAskPrice = DEFAULT_MAX_ASK_PRICE,
): MarketOutcomeNumberSettings {
  const fallback = isValidMaxAskPrice(fallbackMaxAskPrice) ? fallbackMaxAskPrice : DEFAULT_MAX_ASK_PRICE;
  return defaultMarketOutcomeNumbers(overrides, () => fallback, isValidMaxAskPrice);
}

export function defaultMarketOutcomeBooleans(
  overrides: MarketOutcomeBooleanOverrides = {},
  fallback = false,
): MarketOutcomeBooleanSettings {
  return {
    BTC: defaultOutcomeBooleans(overrides.BTC, fallback),
    ETH: defaultOutcomeBooleans(overrides.ETH, fallback),
    DOGE: defaultOutcomeBooleans(overrides.DOGE, fallback),
  };
}

export function defaultEnabledMarketOutcomes(
  overrides: MarketOutcomeBooleanOverrides = {},
  fallbackMarkets: MarketSymbol[] = ["BTC"],
): MarketOutcomeBooleanSettings {
  const enabledMarkets = normalizeEnabledMarkets(fallbackMarkets, []);
  return {
    BTC: defaultOutcomeBooleans(overrides.BTC, enabledMarkets.includes("BTC")),
    ETH: defaultOutcomeBooleans(overrides.ETH, enabledMarkets.includes("ETH")),
    DOGE: defaultOutcomeBooleans(overrides.DOGE, enabledMarkets.includes("DOGE")),
  };
}

export function getEnabledMarketsFromOutcomes(outcomes: MarketOutcomeBooleanSettings): MarketSymbol[] {
  return SUPPORTED_MARKETS.filter((market) => outcomes[market].UP || outcomes[market].DOWN);
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

export function getMarketOutcomeNumber(
  settings: Partial<Record<MarketSymbol, Partial<Record<Outcome, number>>>> | undefined,
  symbol: MarketSymbol,
  outcome: Outcome,
  fallback: number,
): number {
  const value = settings?.[symbol]?.[outcome];
  return isPositiveFiniteNumber(value) ? value : fallback;
}

export function getMarketOutcomeBoolean(
  settings: Partial<Record<MarketSymbol, Partial<Record<Outcome, boolean>>>> | undefined,
  symbol: MarketSymbol,
  outcome: Outcome,
  fallback = false,
): boolean {
  const value = settings?.[symbol]?.[outcome];
  return typeof value === "boolean" ? value : fallback;
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

function defaultMarketOutcomeNumbers(
  overrides: MarketOutcomeNumberOverrides,
  fallbackForMarket: (symbol: MarketSymbol) => number,
  isValid: (value: unknown) => value is number,
): MarketOutcomeNumberSettings {
  return {
    BTC: defaultOutcomeNumbers(overrides.BTC, fallbackForMarket("BTC"), isValid),
    ETH: defaultOutcomeNumbers(overrides.ETH, fallbackForMarket("ETH"), isValid),
    DOGE: defaultOutcomeNumbers(overrides.DOGE, fallbackForMarket("DOGE"), isValid),
  };
}

function defaultOutcomeNumbers(
  overrides: Partial<Record<Outcome, number>> | undefined,
  fallbackValue: number,
  isValid: (value: unknown) => value is number,
): Record<Outcome, number> {
  return {
    UP: isValid(overrides?.UP) ? overrides.UP : fallbackValue,
    DOWN: isValid(overrides?.DOWN) ? overrides.DOWN : fallbackValue,
  };
}

function defaultOutcomeBooleans(
  overrides: Partial<Record<Outcome, boolean>> | undefined,
  fallback: boolean,
): Record<Outcome, boolean> {
  return {
    UP: typeof overrides?.UP === "boolean" ? overrides.UP : fallback,
    DOWN: typeof overrides?.DOWN === "boolean" ? overrides.DOWN : fallback,
  };
}

function isValidMaxAskPrice(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 1;
}

function isPositiveFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

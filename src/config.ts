import "dotenv/config";

import { resolve } from "node:path";
import { z } from "zod";

import {
  defaultMarketDistances,
  defaultMarketEntryWindows,
  defaultEnabledMarketOutcomes,
  defaultMarketOutcomeAmounts,
  defaultMarketOutcomeDistances,
  defaultMarketOutcomeEntryWindows,
  defaultMarketOutcomeMaxAskPrices,
  getEnabledMarketsFromOutcomes,
  normalizeEnabledMarkets,
} from "./markets.js";
import type { BotConfig, Mode } from "./types.js";

const DEFAULT_GAMMA_HOST = "https://gamma-api.polymarket.com";
const DEFAULT_CLOB_HOST = "https://clob.polymarket.com";
const DEFAULT_RTDS_URL = "wss://ws-live-data.polymarket.com";
const DEFAULT_POLYGON_RPC_URL = "https://polygon-rpc.com";
const DEFAULT_OLLAMA_HOST = "https://ollama.com";
const DEFAULT_OLLAMA_MODEL = "gpt-oss:120b";

const optionalString = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().optional(),
);
const optionalPositiveNumber = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.coerce.number().positive().optional(),
);
const optionalAskPrice = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.coerce.number().gt(0).lte(1).optional(),
);
const optionalBoolean = z.preprocess(
  (value) => (value === "" || value === undefined ? undefined : String(value).toLowerCase()),
  z.enum(["true", "false"]).transform((value) => value === "true").optional(),
);
const optionalUrlString = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().url().optional(),
);

const envSchema = z.object({
  MODE: z.enum(["sim", "live"]).default("sim"),
  ENABLED_MARKETS: z.string().default("BTC"),
  ENABLED_BTC_UP: optionalBoolean,
  ENABLED_BTC_DOWN: optionalBoolean,
  ENABLED_ETH_UP: optionalBoolean,
  ENABLED_ETH_DOWN: optionalBoolean,
  ENABLED_DOGE_UP: optionalBoolean,
  ENABLED_DOGE_DOWN: optionalBoolean,
  MIN_BTC_DISTANCE_USD: z.coerce.number().positive().default(20),
  MIN_ETH_DISTANCE_USD: z.coerce.number().positive().default(5),
  MIN_DOGE_DISTANCE_USD: z.coerce.number().positive().default(0.0005),
  MIN_BTC_UP_DISTANCE_USD: optionalPositiveNumber,
  MIN_BTC_DOWN_DISTANCE_USD: optionalPositiveNumber,
  MIN_ETH_UP_DISTANCE_USD: optionalPositiveNumber,
  MIN_ETH_DOWN_DISTANCE_USD: optionalPositiveNumber,
  MIN_DOGE_UP_DISTANCE_USD: optionalPositiveNumber,
  MIN_DOGE_DOWN_DISTANCE_USD: optionalPositiveNumber,
  ENTRY_WINDOW_SECONDS: z.coerce.number().positive().default(20),
  ENTRY_WINDOW_SECONDS_BTC: optionalPositiveNumber,
  ENTRY_WINDOW_SECONDS_ETH: optionalPositiveNumber,
  ENTRY_WINDOW_SECONDS_DOGE: optionalPositiveNumber,
  ENTRY_WINDOW_SECONDS_BTC_UP: optionalPositiveNumber,
  ENTRY_WINDOW_SECONDS_BTC_DOWN: optionalPositiveNumber,
  ENTRY_WINDOW_SECONDS_ETH_UP: optionalPositiveNumber,
  ENTRY_WINDOW_SECONDS_ETH_DOWN: optionalPositiveNumber,
  ENTRY_WINDOW_SECONDS_DOGE_UP: optionalPositiveNumber,
  ENTRY_WINDOW_SECONDS_DOGE_DOWN: optionalPositiveNumber,
  SIM_TRADE_AMOUNT_USD: z.coerce.number().positive().default(1),
  SIM_TRADE_AMOUNT_USD_BTC_UP: optionalPositiveNumber,
  SIM_TRADE_AMOUNT_USD_BTC_DOWN: optionalPositiveNumber,
  SIM_TRADE_AMOUNT_USD_ETH_UP: optionalPositiveNumber,
  SIM_TRADE_AMOUNT_USD_ETH_DOWN: optionalPositiveNumber,
  SIM_TRADE_AMOUNT_USD_DOGE_UP: optionalPositiveNumber,
  SIM_TRADE_AMOUNT_USD_DOGE_DOWN: optionalPositiveNumber,
  LIVE_TRADE_AMOUNT_USD: z.coerce.number().positive().default(1),
  LIVE_TRADE_AMOUNT_USD_BTC_UP: optionalPositiveNumber,
  LIVE_TRADE_AMOUNT_USD_BTC_DOWN: optionalPositiveNumber,
  LIVE_TRADE_AMOUNT_USD_ETH_UP: optionalPositiveNumber,
  LIVE_TRADE_AMOUNT_USD_ETH_DOWN: optionalPositiveNumber,
  LIVE_TRADE_AMOUNT_USD_DOGE_UP: optionalPositiveNumber,
  LIVE_TRADE_AMOUNT_USD_DOGE_DOWN: optionalPositiveNumber,
  AUTO_MIN_LIVE: z
    .preprocess((value) => String(value ?? "true").toLowerCase(), z.enum(["true", "false"]))
    .transform((value) => value === "true")
    .default(true),
  MAX_ASK_PRICE: z.coerce.number().gt(0).lte(1).default(0.98),
  // Hard ceiling on the ask price for ANY trade and for what the auto-adjust may pick. High asks have
  // terrible reward/risk (at 0.90 one loss erases ~9 wins), so cap it: the reward per win (1/ask-1)
  // must be large enough to recover losses. Applies on top of per-market/outcome caps.
  MAX_ASK_PRICE_CEILING: z.coerce.number().gt(0).lte(1).default(0.85),
  // How far above the observed best-ask a live order may fill before stopping (anti-slippage).
  LIVE_MAX_SLIPPAGE: z.coerce.number().nonnegative().lt(1).default(0.02),
  MAX_ASK_PRICE_BTC_UP: optionalAskPrice,
  MAX_ASK_PRICE_BTC_DOWN: optionalAskPrice,
  MAX_ASK_PRICE_ETH_UP: optionalAskPrice,
  MAX_ASK_PRICE_ETH_DOWN: optionalAskPrice,
  MAX_ASK_PRICE_DOGE_UP: optionalAskPrice,
  MAX_ASK_PRICE_DOGE_DOWN: optionalAskPrice,
  REQUIRE_POSITIVE_EV: z
    .preprocess((value) => String(value ?? "true").toLowerCase(), z.enum(["true", "false"]))
    .transform((value) => value === "true")
    .default(true),
  EV_USE_SIMILARITY: z
    .preprocess((value) => String(value ?? "false").toLowerCase(), z.enum(["true", "false"]))
    .transform((value) => value === "true")
    .default(false),
  EV_SAFETY_MARGIN: z.coerce.number().gte(0).lt(1).default(0.03),
  MIN_DISTANCE_FLOOR_BTC: z.coerce.number().nonnegative().default(20),
  MIN_DISTANCE_FLOOR_ETH: z.coerce.number().nonnegative().default(0.1),
  MIN_DISTANCE_FLOOR_DOGE: z.coerce.number().nonnegative().default(0.00003),
  EV_MIN_EXPECTED_ROI: z.coerce.number().gte(0).lt(1).default(0.01),
  EV_MIN_HISTORY_TRADES: z.coerce.number().int().nonnegative().default(10),
  MIN_FILL_RATIO: z.coerce.number().min(0).max(1).default(0.5),
  DAILY_SPEND_LIMIT_USD: z.coerce.number().positive().default(50),
  MAX_DAILY_LOSS_USD: z.coerce.number().nonnegative().default(0),
  MAX_CONSECUTIVE_LOSSES: z.coerce.number().int().nonnegative().default(0),
  MAX_ANALYTICS_SAMPLES: z.coerce.number().int().positive().default(20_000),
  TICK_STALE_MS: z.coerce.number().positive().default(10_000),
  POLL_INTERVAL_MS: z.coerce.number().positive().default(1_000),
  OPENING_CAPTURE_GRACE_MS: z.coerce.number().positive().default(15_000),
  DATA_DIR: z.string().default("data"),
  GAMMA_HOST: z.string().url().default(DEFAULT_GAMMA_HOST),
  CLOB_HOST: z.string().url().default(DEFAULT_CLOB_HOST),
  RTDS_URL: z.string().url().default(DEFAULT_RTDS_URL),
  POLYGON_RPC_URL: z.string().url().default(DEFAULT_POLYGON_RPC_URL),
  OLLAMA_API_KEY: optionalString,
  OLLAMA_HOST: z.string().url().default(DEFAULT_OLLAMA_HOST),
  OLLAMA_MODEL: z.string().default(DEFAULT_OLLAMA_MODEL),
  POLYBOT_PUBLIC_URL: optionalUrlString,
  TELEGRAM_BOT_TOKEN: optionalString,
  TELEGRAM_CHAT_ID: optionalString,
  POLYMARKET_PRIVATE_KEY: optionalString,
  POLYMARKET_SIGNATURE_TYPE: z.coerce.number().int().min(0).max(3).default(0),
  POLYMARKET_FUNDER_ADDRESS: optionalString,
});

export interface CliArgs {
  mode?: Mode;
  confirmLive: boolean;
  once: boolean;
  help: boolean;
}

export function parseCliArgs(argv = process.argv.slice(2)): CliArgs {
  const parsed: CliArgs = {
    confirmLive: false,
    once: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--confirm-live") {
      parsed.confirmLive = true;
      continue;
    }
    if (arg === "--once") {
      parsed.once = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }
    if (arg === "--mode") {
      parsed.mode = parseMode(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg.startsWith("--mode=")) {
      parsed.mode = parseMode(arg.slice("--mode=".length));
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return parsed;
}

export function loadConfig(argv = process.argv.slice(2)): { config: BotConfig; cli: CliArgs } {
  const env = envSchema.parse(process.env);
  const cli = parseCliArgs(argv);
  const mode = cli.mode ?? env.MODE;
  const enabledMarkets = normalizeEnabledMarkets(env.ENABLED_MARKETS);
  const enabledMarketOutcomes = defaultEnabledMarketOutcomes(
    {
      BTC: { UP: env.ENABLED_BTC_UP, DOWN: env.ENABLED_BTC_DOWN },
      ETH: { UP: env.ENABLED_ETH_UP, DOWN: env.ENABLED_ETH_DOWN },
      DOGE: { UP: env.ENABLED_DOGE_UP, DOWN: env.ENABLED_DOGE_DOWN },
    },
    enabledMarkets,
  );
  const minDistanceUsdByMarket = defaultMarketDistances({
    BTC: env.MIN_BTC_DISTANCE_USD,
    ETH: env.MIN_ETH_DISTANCE_USD,
    DOGE: env.MIN_DOGE_DISTANCE_USD,
  });
  const entryWindowSecondsByMarket = defaultMarketEntryWindows(
    {
      BTC: env.ENTRY_WINDOW_SECONDS_BTC,
      ETH: env.ENTRY_WINDOW_SECONDS_ETH,
      DOGE: env.ENTRY_WINDOW_SECONDS_DOGE,
    },
    env.ENTRY_WINDOW_SECONDS,
  );
  const minDistanceUsdByMarketOutcome = defaultMarketOutcomeDistances(
    {
      BTC: { UP: env.MIN_BTC_UP_DISTANCE_USD, DOWN: env.MIN_BTC_DOWN_DISTANCE_USD },
      ETH: { UP: env.MIN_ETH_UP_DISTANCE_USD, DOWN: env.MIN_ETH_DOWN_DISTANCE_USD },
      DOGE: { UP: env.MIN_DOGE_UP_DISTANCE_USD, DOWN: env.MIN_DOGE_DOWN_DISTANCE_USD },
    },
    minDistanceUsdByMarket,
  );
  const entryWindowSecondsByMarketOutcome = defaultMarketOutcomeEntryWindows(
    {
      BTC: { UP: env.ENTRY_WINDOW_SECONDS_BTC_UP, DOWN: env.ENTRY_WINDOW_SECONDS_BTC_DOWN },
      ETH: { UP: env.ENTRY_WINDOW_SECONDS_ETH_UP, DOWN: env.ENTRY_WINDOW_SECONDS_ETH_DOWN },
      DOGE: { UP: env.ENTRY_WINDOW_SECONDS_DOGE_UP, DOWN: env.ENTRY_WINDOW_SECONDS_DOGE_DOWN },
    },
    entryWindowSecondsByMarket,
  );
  const simTradeAmountUsdByMarketOutcome = defaultMarketOutcomeAmounts(
    {
      BTC: { UP: env.SIM_TRADE_AMOUNT_USD_BTC_UP, DOWN: env.SIM_TRADE_AMOUNT_USD_BTC_DOWN },
      ETH: { UP: env.SIM_TRADE_AMOUNT_USD_ETH_UP, DOWN: env.SIM_TRADE_AMOUNT_USD_ETH_DOWN },
      DOGE: { UP: env.SIM_TRADE_AMOUNT_USD_DOGE_UP, DOWN: env.SIM_TRADE_AMOUNT_USD_DOGE_DOWN },
    },
    env.SIM_TRADE_AMOUNT_USD,
  );
  const liveTradeAmountUsdByMarketOutcome = defaultMarketOutcomeAmounts(
    {
      BTC: { UP: env.LIVE_TRADE_AMOUNT_USD_BTC_UP, DOWN: env.LIVE_TRADE_AMOUNT_USD_BTC_DOWN },
      ETH: { UP: env.LIVE_TRADE_AMOUNT_USD_ETH_UP, DOWN: env.LIVE_TRADE_AMOUNT_USD_ETH_DOWN },
      DOGE: { UP: env.LIVE_TRADE_AMOUNT_USD_DOGE_UP, DOWN: env.LIVE_TRADE_AMOUNT_USD_DOGE_DOWN },
    },
    env.LIVE_TRADE_AMOUNT_USD,
  );
  const maxAskPriceByMarketOutcome = defaultMarketOutcomeMaxAskPrices(
    {
      BTC: { UP: env.MAX_ASK_PRICE_BTC_UP, DOWN: env.MAX_ASK_PRICE_BTC_DOWN },
      ETH: { UP: env.MAX_ASK_PRICE_ETH_UP, DOWN: env.MAX_ASK_PRICE_ETH_DOWN },
      DOGE: { UP: env.MAX_ASK_PRICE_DOGE_UP, DOWN: env.MAX_ASK_PRICE_DOGE_DOWN },
    },
    env.MAX_ASK_PRICE,
  );

  const config: BotConfig = {
    mode,
    confirmLive: cli.confirmLive,
    minBtcDistanceUsd: env.MIN_BTC_DISTANCE_USD,
    enabledMarkets: getEnabledMarketsFromOutcomes(enabledMarketOutcomes),
    enabledMarketOutcomes,
    minDistanceUsdByMarket,
    minDistanceUsdByMarketOutcome,
    entryWindowSeconds: env.ENTRY_WINDOW_SECONDS,
    entryWindowSecondsByMarket,
    entryWindowSecondsByMarketOutcome,
    simTradeAmountUsd: env.SIM_TRADE_AMOUNT_USD,
    simTradeAmountUsdByMarketOutcome,
    liveTradeAmountUsd: env.LIVE_TRADE_AMOUNT_USD,
    liveTradeAmountUsdByMarketOutcome,
    autoMinLive: env.AUTO_MIN_LIVE,
    maxAskPrice: env.MAX_ASK_PRICE,
    maxAskPriceByMarketOutcome,
    maxAskPriceCeiling: env.MAX_ASK_PRICE_CEILING,
    liveMaxSlippage: env.LIVE_MAX_SLIPPAGE,
    requirePositiveEv: env.REQUIRE_POSITIVE_EV,
    evUseSimilarity: env.EV_USE_SIMILARITY,
    evSafetyMargin: env.EV_SAFETY_MARGIN,
    minDistanceFloorUsdByMarket: {
      BTC: env.MIN_DISTANCE_FLOOR_BTC,
      ETH: env.MIN_DISTANCE_FLOOR_ETH,
      DOGE: env.MIN_DISTANCE_FLOOR_DOGE,
    },
    evMinExpectedRoi: env.EV_MIN_EXPECTED_ROI,
    evMinHistoryTrades: env.EV_MIN_HISTORY_TRADES,
    minFillRatio: env.MIN_FILL_RATIO,
    dailySpendLimitUsd: env.DAILY_SPEND_LIMIT_USD,
    maxDailyLossUsd: env.MAX_DAILY_LOSS_USD,
    maxConsecutiveLosses: env.MAX_CONSECUTIVE_LOSSES,
    maxAnalyticsSamples: env.MAX_ANALYTICS_SAMPLES,
    tickStaleMs: env.TICK_STALE_MS,
    pollIntervalMs: env.POLL_INTERVAL_MS,
    openingCaptureGraceMs: env.OPENING_CAPTURE_GRACE_MS,
    dataDir: resolve(process.cwd(), env.DATA_DIR),
    gammaHost: env.GAMMA_HOST.replace(/\/$/, ""),
    clobHost: env.CLOB_HOST.replace(/\/$/, ""),
    rtdsUrl: env.RTDS_URL,
    polygonRpcUrl: env.POLYGON_RPC_URL,
    ollamaApiKey: env.OLLAMA_API_KEY,
    ollamaHost: env.OLLAMA_HOST.replace(/\/$/, ""),
    ollamaModel: env.OLLAMA_MODEL,
    publicUrl: env.POLYBOT_PUBLIC_URL,
    telegramBotToken: env.TELEGRAM_BOT_TOKEN,
    telegramChatId: env.TELEGRAM_CHAT_ID,
    privateKey: normalizePrivateKey(env.POLYMARKET_PRIVATE_KEY),
    signatureType: env.POLYMARKET_SIGNATURE_TYPE as 0 | 1 | 2 | 3,
    funderAddress: normalizeAddress(env.POLYMARKET_FUNDER_ADDRESS),
  };

  validateLiveConfig(config);
  return { config, cli };
}

export function usage(): string {
  return [
    "Usage:",
    "  npm run bot -- --mode sim",
    "  npm run bot -- --mode live --confirm-live",
    "  npm run smoke:market",
    "",
    "Optional:",
    "  --once            Run one bot loop iteration and exit.",
  ].join("\n");
}

function parseMode(value?: string): Mode {
  if (value === "sim" || value === "live") {
    return value;
  }
  throw new Error(`Invalid --mode value: ${value ?? "(missing)"}`);
}

function normalizePrivateKey(value?: string): `0x${string}` | undefined {
  if (!value) {
    return undefined;
  }
  const withPrefix = value.startsWith("0x") ? value : `0x${value}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(withPrefix)) {
    throw new Error("POLYMARKET_PRIVATE_KEY must be a 32-byte hex private key.");
  }
  return withPrefix as `0x${string}`;
}

function normalizeAddress(value?: string): `0x${string}` | undefined {
  if (!value) {
    return undefined;
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new Error("POLYMARKET_FUNDER_ADDRESS must be a 20-byte 0x-prefixed address.");
  }
  return value as `0x${string}`;
}

function validateLiveConfig(config: BotConfig): void {
  if (config.mode !== "live") {
    return;
  }
  if (!config.confirmLive) {
    throw new Error("Live mode requires --confirm-live.");
  }
  if (!config.privateKey) {
    throw new Error("Live mode requires POLYMARKET_PRIVATE_KEY.");
  }
  if (!config.funderAddress) {
    throw new Error("Live mode requires POLYMARKET_FUNDER_ADDRESS.");
  }
}

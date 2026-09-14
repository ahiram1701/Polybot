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
  // Suelo de ask por mercado/lado. Existe en BotConfig, y no solo en los settings de la UI, porque es
  // la BASE contra la que el tuner de ventana mide sus recortes. Si la base viviera en el mismo
  // fichero que el tuner escribe, cada recorte moveria la referencia del siguiente y los recortes se
  // acumularian: exactamente el trinquete que el tuner debe evitar.
  // Base ANCHA a proposito. El tuner solo recorta desde aqui, asi que dejar el suelo abierto le
  // permite APRENDER el suelo de cada mercado en vez de heredar el que yo elegi a mano: medido, la
  // banda [0,0.45] gana +$123.60 en BTC y pierde -$116.27 en ETH, de modo que el mismo suelo para los
  // dos es necesariamente el equivocado para uno. Ademas 0.01 y 0.70 son BORDES DE BANDA: una base a
  // media banda (0.25, pongamos) dejaria esa banda permanentemente inevaluable por el criterio de
  // contencion, y el tuner quedaria ciego justo donde ETH sangra.
  MIN_ASK_PRICE: z.coerce.number().gte(0).lt(1).default(0.01),
  MIN_ASK_PRICE_BTC_UP: optionalAskPrice,
  MIN_ASK_PRICE_BTC_DOWN: optionalAskPrice,
  MIN_ASK_PRICE_ETH_UP: optionalAskPrice,
  MIN_ASK_PRICE_ETH_DOWN: optionalAskPrice,
  MIN_ASK_PRICE_DOGE_UP: optionalAskPrice,
  MIN_ASK_PRICE_DOGE_DOWN: optionalAskPrice,
  // Ventana BASE del tuner de ask: el unico rango dentro del cual puede moverse. Es un dato aparte, y
  // no los defaults de arranque de arriba, porque esos valen 0.01/0.98 — reutilizarlos dejaria al
  // tuner "volver" hacia 0.98, la zona que en el ledger hizo 225 operaciones para ganar $8.68.
  //
  // Ancha a proposito, para que el tuner APRENDA cada borde en vez de heredar el que yo elegi a mano:
  // la banda barata gana +$123.60 en BTC y pierde -$116.27 en ETH, asi que un mismo suelo para ambos
  // es forzosamente el equivocado para uno. Techo en 0.70, un escalon sobre el 0.65 de hoy y lejos de
  // la zona sin dinero; el techo duro de MAX_ASK_PRICE_CEILING sigue por encima como red.
  //
  // Ambos son BORDES DE BANDA (0.45/0.55/0.65/0.70/0.75/0.80). Una base a media banda dejaria esa
  // banda permanentemente inevaluable por el criterio de contencion, y el tuner quedaria ciego justo
  // donde ETH sangra.
  ASK_WINDOW_BASELINE_MIN: z.coerce.number().gte(0).lt(1).default(0.01),
  ASK_WINDOW_BASELINE_MAX: z.coerce.number().gt(0).lte(1).default(0.7),
  // Estrategia "favorito": comprar el lado que el LIBRO ya declara ganador, cuando su ask entra en la
  // banda. No predice nada; replica la operativa manual. Apagada por defecto.
  //
  // El techo de 0.85 coincide con MAX_ASK_PRICE_CEILING a proposito: por encima de ahi el ceiling
  // duro rechazaria la entrada mas adelante de todos modos, y una banda que promete precios que otro
  // filtro va a tirar produce descartes silenciosos que parecen un bug del selector.
  FAVORITE_STRATEGY_ENABLED: z
    .preprocess((value) => String(value ?? "false").toLowerCase(), z.enum(["true", "false"]))
    .transform((value) => value === "true")
    .default(false),
  FAVORITE_MIN_ASK: z.coerce.number().gt(0).lt(1).default(0.76),
  FAVORITE_MAX_ASK: z.coerce.number().gt(0).lt(1).default(0.85),
  FAVORITE_MAX_ASK_SUM: z.coerce.number().positive().default(1.15),
  // Cierre separado para dinero real. Ver `favoriteAllowLive` en types.ts.
  // Tramo de maxima conviccion. Apagado de fabrica: multiplica el tamaño de la posicion.
  FAVORITE_MAX_SIZE_ENABLED: z
    .string()
    .optional()
    .transform((value) => value === "true")
    .pipe(z.boolean()),
  FAVORITE_MAX_SIZE_ASK: z.coerce.number().gt(0).lt(1).default(0.98),
  // Que FRACCION del capital libre se juega la conviccion. Ver `favoriteMaxSizeFraction` en types.ts.
  FAVORITE_MAX_SIZE_FRACTION: z.coerce.number().gt(0).lte(1).default(0.5),
  FAVORITE_ALLOW_LIVE: z
    .preprocess((value) => String(value ?? "false").toLowerCase(), z.enum(["true", "false"]))
    .transform((value) => value === "true")
    .default(false),
  // Salida por stop: vender cuando el ask del lado que se tiene cae por debajo del suelo de la banda
  // de compra. Abre el PRIMER camino de venta del bot, asi que viene apagada. Ver `favoriteExitEnabled`
  // en types.ts para el porque de cada umbral.
  FAVORITE_EXIT_ENABLED: z
    .preprocess((value) => String(value ?? "false").toLowerCase(), z.enum(["true", "false"]))
    .transform((value) => value === "true")
    .default(false),
  FAVORITE_EXIT_STOP_MARGIN: z.coerce.number().gte(0).lt(1).default(0.01),
  // Umbral ABSOLUTO. Sin valor, el stop se deriva de la banda. Ver `favoriteExitStopAsk` en types.ts.
  FAVORITE_EXIT_STOP_ASK: z.coerce.number().gt(0).lt(1).optional(),
  // Certeza minima de la ventana para entrar. Ver `favoriteMinCertainty` en types.ts. Admite negativos
  // porque un valor muy negativo es como se apaga el filtro.
  FAVORITE_MIN_CERTAINTY: z.coerce.number().default(1),
  // Certeza a la que se VENDE. Ver `favoriteExitCertainty` en types.ts.
  FAVORITE_EXIT_CERTAINTY: z.coerce.number().default(0),
  FAVORITE_EXIT_MIN_SECONDS: z.coerce.number().nonnegative().default(45),
  FAVORITE_EXIT_MIN_BID: z.coerce.number().gt(0).lt(1).default(0.05),
  FAVORITE_EXIT_MIN_FILL_RATIO: z.coerce.number().min(0).max(1).default(0.9),
  FAVORITE_EXIT_MAX_SPREAD: z.coerce.number().gt(0).lt(1).default(0.1),
  FAVORITE_EXIT_MIN_HOLD_SECONDS: z.coerce.number().nonnegative().default(10),
  // Cierre APARTE para dinero real, igual que FAVORITE_ALLOW_LIVE.
  FAVORITE_EXIT_ALLOW_LIVE: z
    .preprocess((value) => String(value ?? "false").toLowerCase(), z.enum(["true", "false"]))
    .transform((value) => value === "true")
    .default(false),
  REQUIRE_POSITIVE_EV: z
    .preprocess((value) => String(value ?? "true").toLowerCase(), z.enum(["true", "false"]))
    .transform((value) => value === "true")
    .default(true),
  EV_USE_SIMILARITY: z
    .preprocess((value) => String(value ?? "false").toLowerCase(), z.enum(["true", "false"]))
    .transform((value) => value === "true")
    .default(false),
  EV_CALIBRATION: z
    .preprocess((value) => String(value ?? "false").toLowerCase(), z.enum(["true", "false"]))
    .transform((value) => value === "true")
    .default(false),
  EV_SAFETY_MARGIN: z.coerce.number().gte(0).lt(1).default(0.03),
  MIN_DISTANCE_FLOOR_BTC: z.coerce.number().nonnegative().default(20),
  MIN_DISTANCE_FLOOR_ETH: z.coerce.number().nonnegative().default(0.1),
  MIN_DISTANCE_FLOOR_DOGE: z.coerce.number().nonnegative().default(0.00003),
  EV_MIN_EXPECTED_ROI: z.coerce.number().gte(0).lt(1).default(0.01),
  EV_MIN_HISTORY_TRADES: z.coerce.number().int().nonnegative().default(15),
  MIN_FILL_RATIO: z.coerce.number().min(0).max(1).default(0.5),
  DAILY_SPEND_LIMIT_USD: z.coerce.number().positive().default(50),
  MAX_DAILY_LOSS_USD: z.coerce.number().nonnegative().default(0),
  LIVE_BANKROLL_USD: z.coerce.number().nonnegative().default(0),
  MIN_BANKROLL_FOR_DIRECTIONAL_USD: z.coerce.number().nonnegative().default(10),
  MAX_CONSECUTIVE_LOSSES: z.coerce.number().int().nonnegative().default(0),
  RISK_HALT_COOLDOWN_HOURS: z.coerce.number().nonnegative().default(2),
  ARB_ENABLED: z
    .string()
    .optional()
    .transform((value) => value === "true" || value === "1"),
  ARB_MAX_USD_PER_OPPORTUNITY: z.coerce.number().positive().default(25),
  ARB_MIN_NET_PER_SET: z.coerce.number().nonnegative().default(0.02),
  // --- Perps (perpetuos de Polymarket). Apagado de fabrica; ver la seccion de ARQUITECTURA.md.
  PERPS_ENABLED: optionalBoolean,
  PERPS_MODE: z.enum(["sim", "live"]).optional(),
  PERPS_ALLOW_LIVE: optionalBoolean,
  // Declaracion del operador, no deteccion. Polymarket exige BLOQUEAR el envio de ordenes en las
  // jurisdicciones restringidas, no avisar — ver `PERPS_RESTRICTED_JURISDICTIONS`.
  POLYMARKET_PERPS_JURISDICTION_OK: optionalBoolean,
  PERPS_INSTRUMENTS: z.string().default("BTC-USD,ETH-USD"),
  PERPS_INTERVAL_MS: z.coerce.number().int().positive().default(5_000),
  // Tope del OPERADOR. El venue llega a 20x; 2 es un techo deliberadamente bajo para una plataforma
  // recien lanzada sobre la que no hay ni una medicion propia.
  PERPS_MAX_LEVERAGE: z.coerce.number().positive().default(2),
  PERPS_MAX_NOTIONAL_USD: z.coerce.number().nonnegative().default(0),
  PERPS_MAX_MARGIN_USD: z.coerce.number().nonnegative().default(0),
  MAX_PERPS_SAMPLES: z.coerce.number().int().positive().default(5_000),
  PERPS_HOST: optionalUrlString,
  PERPS_WS_URL: optionalUrlString,
  POLYBOT_TIMEZONE: z.string().default("auto"),
  AI_AUTO_TUNE_ASK_CAP: z
    .preprocess((value) => String(value ?? "false").toLowerCase(), z.enum(["true", "false"]))
    .transform((value) => value === "true")
    .default(false),
  // 10.000, no 20.000: a ese tope la proyeccion es de 608 MB, y podar un fichero asi congelaba el
  // bucle ~17 s. Un bot congelado no ve los arbitrajes, que duran segundos.
  MAX_ANALYTICS_SAMPLES: z.coerce.number().int().positive().default(10_000),
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
  const minAskPriceByMarketOutcome = defaultMarketOutcomeMaxAskPrices(
    {
      BTC: { UP: env.MIN_ASK_PRICE_BTC_UP, DOWN: env.MIN_ASK_PRICE_BTC_DOWN },
      ETH: { UP: env.MIN_ASK_PRICE_ETH_UP, DOWN: env.MIN_ASK_PRICE_ETH_DOWN },
      DOGE: { UP: env.MIN_ASK_PRICE_DOGE_UP, DOWN: env.MIN_ASK_PRICE_DOGE_DOWN },
    },
    env.MIN_ASK_PRICE,
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
    minAskPriceByMarketOutcome,
    askWindowBaseline: { floor: env.ASK_WINDOW_BASELINE_MIN, cap: env.ASK_WINDOW_BASELINE_MAX },
    maxAskPriceCeiling: env.MAX_ASK_PRICE_CEILING,
    favoriteStrategyEnabled: env.FAVORITE_STRATEGY_ENABLED,
    favoriteMinAsk: env.FAVORITE_MIN_ASK,
    favoriteMaxAsk: env.FAVORITE_MAX_ASK,
    favoriteMaxAskSum: env.FAVORITE_MAX_ASK_SUM,
    favoriteAllowLive: env.FAVORITE_ALLOW_LIVE,
    favoriteMaxSizeEnabled: env.FAVORITE_MAX_SIZE_ENABLED,
    favoriteMaxSizeAsk: env.FAVORITE_MAX_SIZE_ASK,
    favoriteMaxSizeFraction: env.FAVORITE_MAX_SIZE_FRACTION,
    favoriteExitEnabled: env.FAVORITE_EXIT_ENABLED,
    favoriteExitStopMargin: env.FAVORITE_EXIT_STOP_MARGIN,
    favoriteExitStopAsk: env.FAVORITE_EXIT_STOP_ASK,
    favoriteMinCertainty: env.FAVORITE_MIN_CERTAINTY,
    favoriteExitCertainty: env.FAVORITE_EXIT_CERTAINTY,
    favoriteExitMinSecondsToEnd: env.FAVORITE_EXIT_MIN_SECONDS,
    favoriteExitMinBid: env.FAVORITE_EXIT_MIN_BID,
    favoriteExitMinFillRatio: env.FAVORITE_EXIT_MIN_FILL_RATIO,
    favoriteExitMaxSpread: env.FAVORITE_EXIT_MAX_SPREAD,
    favoriteExitMinHoldSeconds: env.FAVORITE_EXIT_MIN_HOLD_SECONDS,
    favoriteExitAllowLive: env.FAVORITE_EXIT_ALLOW_LIVE,
    liveMaxSlippage: env.LIVE_MAX_SLIPPAGE,
    requirePositiveEv: env.REQUIRE_POSITIVE_EV,
    evUseSimilarity: env.EV_USE_SIMILARITY,
    evCalibration: env.EV_CALIBRATION,
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
    liveBankrollUsd: env.LIVE_BANKROLL_USD,
    minBankrollForDirectionalUsd: env.MIN_BANKROLL_FOR_DIRECTIONAL_USD,
    maxConsecutiveLosses: env.MAX_CONSECUTIVE_LOSSES,
    riskHaltCooldownHours: env.RISK_HALT_COOLDOWN_HOURS,
    arbEnabled: env.ARB_ENABLED,
    arbMaxUsdPerOpportunity: env.ARB_MAX_USD_PER_OPPORTUNITY,
    arbMinNetPerSet: env.ARB_MIN_NET_PER_SET,
    perpsEnabled: env.PERPS_ENABLED,
    perpsMode: env.PERPS_MODE,
    perpsAllowLive: env.PERPS_ALLOW_LIVE,
    perpsJurisdictionOk: env.POLYMARKET_PERPS_JURISDICTION_OK,
    perpsInstruments: env.PERPS_INSTRUMENTS.split(",")
      .map((symbol) => symbol.trim().toUpperCase())
      .filter((symbol) => symbol.length > 0),
    perpsIntervalMs: env.PERPS_INTERVAL_MS,
    perpsMaxLeverage: env.PERPS_MAX_LEVERAGE,
    perpsMaxNotionalUsd: env.PERPS_MAX_NOTIONAL_USD,
    perpsMaxMarginUsd: env.PERPS_MAX_MARGIN_USD,
    maxPerpsSamples: env.MAX_PERPS_SAMPLES,
    perpsHost: env.PERPS_HOST?.replace(/\/$/, ""),
    perpsWsUrl: env.PERPS_WS_URL,
    timezone: env.POLYBOT_TIMEZONE,
    aiAutoTuneAskCap: env.AI_AUTO_TUNE_ASK_CAP,
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
  // Perps se valida ANTES y al margen del modo global, porque su cierre live es independiente: igual
  // que `favoriteAllowLive`, `perpsAllowLive` puede estar abierto con el bot entero en sim.
  //
  // Y se valida al arrancar, no al mandar la primera orden. La diferencia importa: enterarse de que
  // falta la declaracion de jurisdiccion cuando ya hay una senal que ejecutar es enterarse tarde.
  validatePerpsLiveConfig(config);
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

/**
 * Perps en dinero real exige tres cosas, y ninguna se deduce de las otras.
 *
 * La de la jurisdiccion no es burocracia: Polymarket bloquea los perpetuos en EE. UU., Canada, Cuba,
 * Iran, Corea del Norte, Siria, Crimea, Donetsk y Lugansk, y su documentacion pide explicitamente
 * bloquear el ENVIO de ordenes, no ensenar un aviso. Se declara y no se detecta por el mismo criterio
 * que `POLYBOT_SUPERVISOR`: una deteccion que falla en silencio produce exactamente la mentira que la
 * comprobacion viene a evitar.
 */
function validatePerpsLiveConfig(config: BotConfig): void {
  if (config.perpsAllowLive !== true) {
    return;
  }
  if (config.perpsJurisdictionOk !== true) {
    throw new Error(
      "PERPS_ALLOW_LIVE requires POLYMARKET_PERPS_JURISDICTION_OK=true (Perps is blocked in the US, Canada and other jurisdictions).",
    );
  }
  if (!config.privateKey) {
    throw new Error("PERPS_ALLOW_LIVE requires POLYMARKET_PRIVATE_KEY.");
  }
  if (!config.funderAddress) {
    throw new Error("PERPS_ALLOW_LIVE requires POLYMARKET_FUNDER_ADDRESS.");
  }
}

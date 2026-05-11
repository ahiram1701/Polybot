import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";

import {
  defaultMarketDistances,
  defaultMarketEntryWindows,
  normalizeEnabledMarkets,
  SUPPORTED_MARKETS,
} from "../markets.js";
import type { BotConfig } from "../types.js";
import type { UiSettings } from "./shared.js";

const marketSymbolSchema = z.enum(SUPPORTED_MARKETS);
const marketDistancesSchema = z.object({
  BTC: z.coerce.number().positive(),
  ETH: z.coerce.number().positive(),
  DOGE: z.coerce.number().positive(),
});
const marketEntryWindowsSchema = z.object({
  BTC: z.coerce.number().positive(),
  ETH: z.coerce.number().positive(),
  DOGE: z.coerce.number().positive(),
});

const settingsSchema = z.object({
  minBtcDistanceUsd: z.coerce.number().positive(),
  enabledMarkets: z.array(marketSymbolSchema),
  minDistanceUsdByMarket: marketDistancesSchema,
  entryWindowSeconds: z.coerce.number().positive(),
  entryWindowSecondsByMarket: marketEntryWindowsSchema,
  simTradeAmountUsd: z.coerce.number().positive(),
  liveTradeAmountUsd: z.coerce.number().positive(),
  autoMinLive: z.boolean(),
  maxAskPrice: z.coerce.number().gt(0).lte(1),
  dailySpendLimitUsd: z.coerce.number().positive(),
  tickStaleMs: z.coerce.number().positive(),
  pollIntervalMs: z.coerce.number().positive(),
  openingCaptureGraceMs: z.coerce.number().positive(),
  aiAutoApplyLive: z.boolean().default(false),
  aiLastAppliedAtMs: z.coerce.number().positive().optional(),
});

export const patchSettingsSchema = settingsSchema.partial();

export class UiSettingsStore {
  constructor(private readonly dataDir: string) {}

  get settingsPath(): string {
    return join(this.dataDir, "ui-config.json");
  }

  async load(baseConfig: BotConfig): Promise<UiSettings> {
    const defaults = settingsFromConfig(baseConfig);
    try {
      const raw = JSON.parse(await readFile(this.settingsPath, "utf8")) as unknown;
      const saved = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
      const merged = { ...defaults, ...saved };
      if (!Object.prototype.hasOwnProperty.call(saved, "entryWindowSecondsByMarket")) {
        delete (merged as Record<string, unknown>).entryWindowSecondsByMarket;
      }
      return settingsSchema.parse(normalizeSettings(merged));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return defaults;
      }
      throw error;
    }
  }

  async save(settings: UiSettings): Promise<UiSettings> {
    const parsed = settingsSchema.parse(normalizeSettings(settings as unknown as Record<string, unknown>));
    await mkdir(dirname(this.settingsPath), { recursive: true });
    const tempPath = `${this.settingsPath}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
    await rename(tempPath, this.settingsPath);
    return parsed;
  }
}

export function settingsFromConfig(config: BotConfig): UiSettings {
  const minDistanceUsdByMarket = defaultMarketDistances(config.minDistanceUsdByMarket);
  const entryWindowSecondsByMarket = defaultMarketEntryWindows(
    config.entryWindowSecondsByMarket,
    config.entryWindowSeconds,
  );
  return {
    minBtcDistanceUsd: minDistanceUsdByMarket.BTC,
    enabledMarkets: normalizeEnabledMarkets(config.enabledMarkets),
    minDistanceUsdByMarket,
    entryWindowSeconds: entryWindowSecondsByMarket.BTC,
    entryWindowSecondsByMarket,
    simTradeAmountUsd: config.simTradeAmountUsd,
    liveTradeAmountUsd: config.liveTradeAmountUsd,
    autoMinLive: config.autoMinLive,
    maxAskPrice: config.maxAskPrice,
    dailySpendLimitUsd: config.dailySpendLimitUsd,
    tickStaleMs: config.tickStaleMs,
    pollIntervalMs: config.pollIntervalMs,
    openingCaptureGraceMs: config.openingCaptureGraceMs,
    aiAutoApplyLive: false,
  };
}

export function applySettings(config: BotConfig, settings: UiSettings): BotConfig {
  const minDistanceUsdByMarket = defaultMarketDistances(settings.minDistanceUsdByMarket);
  const entryWindowSecondsByMarket = defaultMarketEntryWindows(
    settings.entryWindowSecondsByMarket,
    settings.entryWindowSeconds,
  );
  return {
    ...config,
    minBtcDistanceUsd: minDistanceUsdByMarket.BTC,
    enabledMarkets: normalizeEnabledMarkets(settings.enabledMarkets, config.enabledMarkets),
    minDistanceUsdByMarket,
    entryWindowSeconds: entryWindowSecondsByMarket.BTC,
    entryWindowSecondsByMarket,
    simTradeAmountUsd: settings.simTradeAmountUsd,
    liveTradeAmountUsd: settings.liveTradeAmountUsd,
    autoMinLive: settings.autoMinLive,
    maxAskPrice: settings.maxAskPrice,
    dailySpendLimitUsd: settings.dailySpendLimitUsd,
    tickStaleMs: settings.tickStaleMs,
    pollIntervalMs: settings.pollIntervalMs,
    openingCaptureGraceMs: settings.openingCaptureGraceMs,
  };
}

function normalizeSettings(settings: Record<string, unknown>): Record<string, unknown> {
  const legacyBtcDistance = Number(settings.minBtcDistanceUsd);
  const savedDistances =
    settings.minDistanceUsdByMarket && typeof settings.minDistanceUsdByMarket === "object"
      ? (settings.minDistanceUsdByMarket as Partial<Record<string, unknown>>)
      : {};
  const savedBtcDistance = Number(savedDistances.BTC);
  const distances = defaultMarketDistances({
    BTC:
      Number.isFinite(savedBtcDistance) && savedBtcDistance > 0
        ? savedBtcDistance
        : Number.isFinite(legacyBtcDistance) && legacyBtcDistance > 0
          ? legacyBtcDistance
          : undefined,
    ETH: Number(savedDistances.ETH),
    DOGE: Number(savedDistances.DOGE),
  });

  if (!(Number.isFinite(distances.ETH) && distances.ETH > 0)) {
    distances.ETH = defaultMarketDistances().ETH;
  }
  if (!(Number.isFinite(distances.DOGE) && distances.DOGE > 0)) {
    distances.DOGE = defaultMarketDistances().DOGE;
  }

  const legacyEntryWindowSeconds = Number(settings.entryWindowSeconds);
  const fallbackEntryWindowSeconds =
    Number.isFinite(legacyEntryWindowSeconds) && legacyEntryWindowSeconds > 0
      ? legacyEntryWindowSeconds
      : defaultMarketEntryWindows().BTC;
  const savedEntryWindows =
    settings.entryWindowSecondsByMarket && typeof settings.entryWindowSecondsByMarket === "object"
      ? (settings.entryWindowSecondsByMarket as Partial<Record<string, unknown>>)
      : {};
  const entryWindowSecondsByMarket = defaultMarketEntryWindows(
    {
      BTC: Number(savedEntryWindows.BTC),
      ETH: Number(savedEntryWindows.ETH),
      DOGE: Number(savedEntryWindows.DOGE),
    },
    fallbackEntryWindowSeconds,
  );

  return {
    ...settings,
    minBtcDistanceUsd: distances.BTC,
    enabledMarkets: normalizeEnabledMarkets(settings.enabledMarkets),
    minDistanceUsdByMarket: {
      BTC: distances.BTC,
      ETH: distances.ETH,
      DOGE: distances.DOGE,
    },
    entryWindowSeconds: entryWindowSecondsByMarket.BTC,
    entryWindowSecondsByMarket,
    aiAutoApplyLive: Boolean(settings.aiAutoApplyLive),
    aiLastAppliedAtMs:
      Number.isFinite(Number(settings.aiLastAppliedAtMs)) && Number(settings.aiLastAppliedAtMs) > 0
        ? Number(settings.aiLastAppliedAtMs)
        : undefined,
  };
}

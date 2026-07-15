import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { writeFileAtomic } from "../atomicWrite.js";
import { z } from "zod";

import {
  defaultMarketDistances,
  defaultEnabledMarketOutcomes,
  defaultMarketEntryWindows,
  defaultMarketOutcomeAmounts,
  defaultMarketOutcomeBooleans,
  defaultMarketOutcomeDistances,
  defaultMarketOutcomeEntryWindows,
  defaultMarketOutcomeMaxAskPrices,
  getEnabledMarketsFromOutcomes,
  normalizeEnabledMarkets,
  SUPPORTED_MARKETS,
  type MarketOutcomeBooleanOverrides,
  type MarketOutcomeNumberOverrides,
} from "../markets.js";
import { isValidTimeZone } from "../timezone.js";
import type { BotConfig, Outcome } from "../types.js";
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
const outcomePositiveNumberSchema = z.object({
  UP: z.coerce.number().positive(),
  DOWN: z.coerce.number().positive(),
});
const outcomeAskPriceSchema = z.object({
  UP: z.coerce.number().gt(0).lte(1),
  DOWN: z.coerce.number().gt(0).lte(1),
});
const marketOutcomePositiveNumberSchema = z.object({
  BTC: outcomePositiveNumberSchema,
  ETH: outcomePositiveNumberSchema,
  DOGE: outcomePositiveNumberSchema,
});
const marketOutcomeAskPriceSchema = z.object({
  BTC: outcomeAskPriceSchema,
  ETH: outcomeAskPriceSchema,
  DOGE: outcomeAskPriceSchema,
});
const outcomeBooleanSchema = z.object({
  UP: z.boolean(),
  DOWN: z.boolean(),
});
const marketOutcomeBooleanSchema = z.object({
  BTC: outcomeBooleanSchema,
  ETH: outcomeBooleanSchema,
  DOGE: outcomeBooleanSchema,
});

const settingsSchema = z.object({
  minBtcDistanceUsd: z.coerce.number().positive(),
  enabledMarkets: z.array(marketSymbolSchema),
  enabledMarketOutcomes: marketOutcomeBooleanSchema,
  minDistanceUsdByMarket: marketDistancesSchema,
  minDistanceUsdByMarketOutcome: marketOutcomePositiveNumberSchema,
  entryWindowSeconds: z.coerce.number().positive(),
  entryWindowSecondsByMarket: marketEntryWindowsSchema,
  entryWindowSecondsByMarketOutcome: marketOutcomePositiveNumberSchema,
  simTradeAmountUsd: z.coerce.number().positive(),
  simTradeAmountUsdByMarketOutcome: marketOutcomePositiveNumberSchema,
  liveTradeAmountUsd: z.coerce.number().positive(),
  liveTradeAmountUsdByMarketOutcome: marketOutcomePositiveNumberSchema,
  autoMinLive: z.boolean(),
  maxAskPrice: z.coerce.number().gt(0).lte(1),
  maxAskPriceByMarketOutcome: marketOutcomeAskPriceSchema,
  // Ceiling default 0.85 keeps existing ui-config.json (without this key) at the recommended value.
  maxAskPriceCeiling: z.coerce.number().gt(0).lte(1).default(0.85),
  dailySpendLimitUsd: z.coerce.number().positive(),
  maxDailyLossUsd: z.coerce.number().nonnegative().default(0),
  riskHaltCooldownHours: z.coerce.number().nonnegative().default(2),
  arbEnabled: z.boolean().default(false),
  arbMaxUsdPerOpportunity: z.coerce.number().positive().default(25),
  arbMinNetPerSet: z.coerce.number().nonnegative().default(0.02),
  // IANA timezone or "auto" (system). Invalid names degrade to "auto" instead of rejecting the payload.
  timezone: z
    .string()
    .default("auto")
    .transform((value) => (value === "auto" || isValidTimeZone(value) ? value : "auto")),
  maxConsecutiveLosses: z.coerce.number().int().nonnegative().default(0),
  // EV gate (defaults chosen so existing ui-config.json without these keys gets the relaxed gate).
  requirePositiveEv: z.boolean().default(true),
  evUseSimilarity: z.boolean().default(false),
  evSafetyMargin: z.coerce.number().nonnegative().lt(1).default(0.03),
  evMinHistoryTrades: z.coerce.number().int().nonnegative().default(15),
  minFillRatio: z.coerce.number().min(0).max(1).default(0.5),
  evMinExpectedRoi: z.coerce.number().nonnegative().lt(1).default(0.01),
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
      for (const key of [
        "entryWindowSecondsByMarket",
        "enabledMarketOutcomes",
        "minDistanceUsdByMarketOutcome",
        "entryWindowSecondsByMarketOutcome",
        "simTradeAmountUsdByMarketOutcome",
        "liveTradeAmountUsdByMarketOutcome",
        "maxAskPriceByMarketOutcome",
      ]) {
        if (!Object.prototype.hasOwnProperty.call(saved, key)) {
          delete (merged as Record<string, unknown>)[key];
        }
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
    await writeFileAtomic(this.settingsPath, `${JSON.stringify(parsed, null, 2)}\n`);
    return parsed;
  }
}

export function settingsFromConfig(config: BotConfig): UiSettings {
  const minDistanceUsdByMarket = defaultMarketDistances(config.minDistanceUsdByMarket);
  const entryWindowSecondsByMarket = defaultMarketEntryWindows(
    config.entryWindowSecondsByMarket,
    config.entryWindowSeconds,
  );
  const enabledMarketOutcomes = defaultEnabledMarketOutcomes(
    config.enabledMarketOutcomes,
    normalizeEnabledMarkets(config.enabledMarkets),
  );
  return {
    minBtcDistanceUsd: minDistanceUsdByMarket.BTC,
    enabledMarkets: getEnabledMarketsFromOutcomes(enabledMarketOutcomes),
    enabledMarketOutcomes,
    minDistanceUsdByMarket,
    minDistanceUsdByMarketOutcome: defaultMarketOutcomeDistances(
      config.minDistanceUsdByMarketOutcome,
      minDistanceUsdByMarket,
    ),
    entryWindowSeconds: entryWindowSecondsByMarket.BTC,
    entryWindowSecondsByMarket,
    entryWindowSecondsByMarketOutcome: defaultMarketOutcomeEntryWindows(
      config.entryWindowSecondsByMarketOutcome,
      entryWindowSecondsByMarket,
    ),
    simTradeAmountUsd: config.simTradeAmountUsd,
    simTradeAmountUsdByMarketOutcome: defaultMarketOutcomeAmounts(
      config.simTradeAmountUsdByMarketOutcome,
      config.simTradeAmountUsd,
    ),
    liveTradeAmountUsd: config.liveTradeAmountUsd,
    liveTradeAmountUsdByMarketOutcome: defaultMarketOutcomeAmounts(
      config.liveTradeAmountUsdByMarketOutcome,
      config.liveTradeAmountUsd,
    ),
    autoMinLive: config.autoMinLive,
    maxAskPrice: config.maxAskPrice,
    maxAskPriceByMarketOutcome: defaultMarketOutcomeMaxAskPrices(
      config.maxAskPriceByMarketOutcome,
      config.maxAskPrice,
    ),
    maxAskPriceCeiling: config.maxAskPriceCeiling ?? 0.85,
    dailySpendLimitUsd: config.dailySpendLimitUsd,
    maxDailyLossUsd: config.maxDailyLossUsd ?? 0,
    riskHaltCooldownHours: config.riskHaltCooldownHours ?? 2,
    arbEnabled: config.arbEnabled ?? false,
    arbMaxUsdPerOpportunity: config.arbMaxUsdPerOpportunity ?? 25,
    arbMinNetPerSet: config.arbMinNetPerSet ?? 0.02,
    timezone: config.timezone ?? "auto",
    maxConsecutiveLosses: config.maxConsecutiveLosses ?? 0,
    requirePositiveEv: config.requirePositiveEv ?? true,
    evUseSimilarity: config.evUseSimilarity ?? false,
    evSafetyMargin: config.evSafetyMargin ?? 0.03,
    evMinHistoryTrades: config.evMinHistoryTrades ?? 15,
    minFillRatio: config.minFillRatio ?? 0.5,
    evMinExpectedRoi: config.evMinExpectedRoi ?? 0.01,
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
  const minDistanceUsdByMarketOutcome = defaultMarketOutcomeDistances(
    settings.minDistanceUsdByMarketOutcome,
    minDistanceUsdByMarket,
  );
  const entryWindowSecondsByMarketOutcome = defaultMarketOutcomeEntryWindows(
    settings.entryWindowSecondsByMarketOutcome,
    entryWindowSecondsByMarket,
  );
  const enabledMarketOutcomes = defaultEnabledMarketOutcomes(
    settings.enabledMarketOutcomes,
    normalizeEnabledMarkets(settings.enabledMarkets, config.enabledMarkets),
  );
  return {
    ...config,
    minBtcDistanceUsd: minDistanceUsdByMarket.BTC,
    enabledMarkets: getEnabledMarketsFromOutcomes(enabledMarketOutcomes),
    enabledMarketOutcomes,
    minDistanceUsdByMarket,
    minDistanceUsdByMarketOutcome,
    entryWindowSeconds: entryWindowSecondsByMarket.BTC,
    entryWindowSecondsByMarket,
    entryWindowSecondsByMarketOutcome,
    simTradeAmountUsd: settings.simTradeAmountUsd,
    simTradeAmountUsdByMarketOutcome: defaultMarketOutcomeAmounts(
      settings.simTradeAmountUsdByMarketOutcome,
      settings.simTradeAmountUsd,
    ),
    liveTradeAmountUsd: settings.liveTradeAmountUsd,
    liveTradeAmountUsdByMarketOutcome: defaultMarketOutcomeAmounts(
      settings.liveTradeAmountUsdByMarketOutcome,
      settings.liveTradeAmountUsd,
    ),
    autoMinLive: settings.autoMinLive,
    maxAskPrice: settings.maxAskPrice,
    maxAskPriceByMarketOutcome: defaultMarketOutcomeMaxAskPrices(
      settings.maxAskPriceByMarketOutcome,
      settings.maxAskPrice,
    ),
    maxAskPriceCeiling: settings.maxAskPriceCeiling,
    dailySpendLimitUsd: settings.dailySpendLimitUsd,
    maxDailyLossUsd: settings.maxDailyLossUsd,
    riskHaltCooldownHours: settings.riskHaltCooldownHours,
    arbEnabled: settings.arbEnabled,
    arbMaxUsdPerOpportunity: settings.arbMaxUsdPerOpportunity,
    arbMinNetPerSet: settings.arbMinNetPerSet,
    timezone: settings.timezone,
    maxConsecutiveLosses: settings.maxConsecutiveLosses,
    requirePositiveEv: settings.requirePositiveEv,
    evUseSimilarity: settings.evUseSimilarity,
    evSafetyMargin: settings.evSafetyMargin,
    evMinHistoryTrades: settings.evMinHistoryTrades,
    minFillRatio: settings.minFillRatio,
    evMinExpectedRoi: settings.evMinExpectedRoi,
    tickStaleMs: settings.tickStaleMs,
    pollIntervalMs: settings.pollIntervalMs,
    openingCaptureGraceMs: settings.openingCaptureGraceMs,
  };
}

function normalizeSettings(settings: Record<string, unknown>): Record<string, unknown> {
  const legacyBtcDistance = positiveNumberOrUndefined(settings.minBtcDistanceUsd);
  const savedDistances = objectRecord(settings.minDistanceUsdByMarket);
  const distances = defaultMarketDistances({
    BTC: positiveNumberOrUndefined(savedDistances.BTC) ?? legacyBtcDistance,
    ETH: positiveNumberOrUndefined(savedDistances.ETH),
    DOGE: positiveNumberOrUndefined(savedDistances.DOGE),
  });

  const legacyEntryWindowSeconds = positiveNumberOrUndefined(settings.entryWindowSeconds);
  const fallbackEntryWindowSeconds = legacyEntryWindowSeconds ?? defaultMarketEntryWindows().BTC;
  const savedEntryWindows = objectRecord(settings.entryWindowSecondsByMarket);
  const entryWindowSecondsByMarket = defaultMarketEntryWindows(
    {
      BTC: positiveNumberOrUndefined(savedEntryWindows.BTC),
      ETH: positiveNumberOrUndefined(savedEntryWindows.ETH),
      DOGE: positiveNumberOrUndefined(savedEntryWindows.DOGE),
    },
    fallbackEntryWindowSeconds,
  );

  const simTradeAmountUsdFallback = positiveNumberOrUndefined(settings.simTradeAmountUsd) ?? 1;
  const liveTradeAmountUsdFallback = positiveNumberOrUndefined(settings.liveTradeAmountUsd) ?? 1;
  const maxAskPriceFallback = askPriceOrUndefined(settings.maxAskPrice) ?? 0.98;
  const minDistanceUsdByMarketOutcome = defaultMarketOutcomeDistances(
    marketOutcomeOverrides(settings.minDistanceUsdByMarketOutcome),
    distances,
  );
  const entryWindowSecondsByMarketOutcome = defaultMarketOutcomeEntryWindows(
    marketOutcomeOverrides(settings.entryWindowSecondsByMarketOutcome),
    entryWindowSecondsByMarket,
  );
  const simTradeAmountUsdByMarketOutcome = defaultMarketOutcomeAmounts(
    marketOutcomeOverrides(settings.simTradeAmountUsdByMarketOutcome),
    simTradeAmountUsdFallback,
  );
  const liveTradeAmountUsdByMarketOutcome = defaultMarketOutcomeAmounts(
    marketOutcomeOverrides(settings.liveTradeAmountUsdByMarketOutcome),
    liveTradeAmountUsdFallback,
  );
  const maxAskPriceByMarketOutcome = defaultMarketOutcomeMaxAskPrices(
    marketOutcomeOverrides(settings.maxAskPriceByMarketOutcome),
    maxAskPriceFallback,
  );
  const enabledMarketOutcomes = defaultEnabledMarketOutcomes(
    marketOutcomeBooleanOverrides(settings.enabledMarketOutcomes),
    normalizeEnabledMarkets(settings.enabledMarkets),
  );
  return {
    ...settings,
    minBtcDistanceUsd: distances.BTC,
    enabledMarkets: getEnabledMarketsFromOutcomes(enabledMarketOutcomes),
    enabledMarketOutcomes,
    minDistanceUsdByMarket: {
      BTC: distances.BTC,
      ETH: distances.ETH,
      DOGE: distances.DOGE,
    },
    minDistanceUsdByMarketOutcome,
    entryWindowSeconds: entryWindowSecondsByMarket.BTC,
    entryWindowSecondsByMarket,
    entryWindowSecondsByMarketOutcome,
    simTradeAmountUsd: settings.simTradeAmountUsd,
    simTradeAmountUsdByMarketOutcome,
    liveTradeAmountUsd: settings.liveTradeAmountUsd,
    liveTradeAmountUsdByMarketOutcome,
    maxAskPrice: settings.maxAskPrice,
    maxAskPriceByMarketOutcome,
    aiAutoApplyLive: Boolean(settings.aiAutoApplyLive),
    aiLastAppliedAtMs:
      Number.isFinite(Number(settings.aiLastAppliedAtMs)) && Number(settings.aiLastAppliedAtMs) > 0
        ? Number(settings.aiLastAppliedAtMs)
        : undefined,
  };
}

function marketOutcomeOverrides(value: unknown): MarketOutcomeNumberOverrides {
  const record = objectRecord(value);
  return {
    BTC: outcomeOverrides(record.BTC),
    ETH: outcomeOverrides(record.ETH),
    DOGE: outcomeOverrides(record.DOGE),
  };
}

function marketOutcomeBooleanOverrides(value: unknown): MarketOutcomeBooleanOverrides {
  const record = objectRecord(value);
  return {
    BTC: outcomeBooleanOverrides(record.BTC),
    ETH: outcomeBooleanOverrides(record.ETH),
    DOGE: outcomeBooleanOverrides(record.DOGE),
  };
}

function outcomeOverrides(value: unknown): Partial<Record<Outcome, number>> {
  const record = objectRecord(value);
  return {
    UP: numberOrUndefined(record.UP),
    DOWN: numberOrUndefined(record.DOWN),
  };
}

function outcomeBooleanOverrides(value: unknown): Partial<Record<Outcome, boolean>> {
  const record = objectRecord(value);
  return {
    UP: booleanOrUndefined(record.UP),
    DOWN: booleanOrUndefined(record.DOWN),
  };
}

function objectRecord(value: unknown): Partial<Record<string, unknown>> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Partial<Record<string, unknown>>) : {};
}

function positiveNumberOrUndefined(value: unknown): number | undefined {
  const parsed = numberOrUndefined(value);
  return parsed !== undefined && parsed > 0 ? parsed : undefined;
}

function askPriceOrUndefined(value: unknown): number | undefined {
  const parsed = numberOrUndefined(value);
  return parsed !== undefined && parsed > 0 && parsed <= 1 ? parsed : undefined;
}

function numberOrUndefined(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function booleanOrUndefined(value: unknown): boolean | undefined {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") {
      return true;
    }
    if (normalized === "false") {
      return false;
    }
  }
  return undefined;
}

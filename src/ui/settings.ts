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
  minAskPriceByMarketOutcome: marketOutcomeAskPriceSchema.default({
    BTC: { UP: 0.01, DOWN: 0.01 },
    ETH: { UP: 0.01, DOWN: 0.01 },
    DOGE: { UP: 0.01, DOWN: 0.01 },
  }),
  // Ceiling default 0.85 keeps existing ui-config.json (without this key) at the recommended value.
  maxAskPriceCeiling: z.coerce.number().gt(0).lte(1).default(0.85),
  /**
   * Estrategia "favorito". Los rangos son los MISMOS que en `src/config.ts:143-155` a proposito: un
   * ajuste que el panel acepta y el arranque rechaza es un bot que se comporta distinto segun por
   * donde le llegue el valor.
   *
   * Los defaults dejan a un `ui-config.json` antiguo (sin estas claves) exactamente como estaba:
   * apagada, y con la banda que documenta `.env.example`.
   */
  favoriteStrategyEnabled: z.boolean().default(false),
  favoriteMinAsk: z.coerce.number().gt(0).lt(1).default(0.76),
  favoriteMaxAsk: z.coerce.number().gt(0).lt(1).default(0.85),
  favoriteMaxAskSum: z.coerce.number().positive().default(1.15),
  favoriteAllowLive: z.boolean().default(false),
  dailySpendLimitUsd: z.coerce.number().positive(),
  maxDailyLossUsd: z.coerce.number().nonnegative().default(0),
  liveBankrollUsd: z.coerce.number().nonnegative().default(0),
  minBankrollForDirectionalUsd: z.coerce.number().nonnegative().default(10),
  riskHaltCooldownHours: z.coerce.number().nonnegative().default(2),
  arbEnabled: z.boolean().default(false),
  /**
   * Modo de cada estrategia. "heredado" = usa el modo con el que arranco el bot, que es como se
   * comportaba antes de existir estos ajustes.
   */
  makerEnabled: z.boolean().default(false),
  makerMode: z.enum(["heredado", "sim", "live"]).default("sim"),
  makerCapitalUsd: z.coerce.number().nonnegative().default(40),
  makerRetireSecondsBeforeClose: z.coerce.number().int().nonnegative().default(30),
  makerMarketSource: z.enum(["cripto5m", "recompensas"]).default("recompensas"),
  makerStopBelowUsd: z.coerce.number().nonnegative().default(0),
  // El 0 se ACEPTA y se normaliza a 1 en vez de rechazarse: hay configuraciones guardadas con 0 y
  // `settingsSchema.parse` lanza, asi que un `min(1)` dejaria la UI sin poder cargar sus ajustes. Y 0
  // no es una opcion peor, es una que no funciona: produce un par que se cruza consigo mismo en todos
  // los medios donde cambia algo, y en los demas da el mismo precio que 1. Ver `TICKS_DEL_MEDIO`.
  makerTicksDelMedio: z.coerce.number().int().min(0).max(5).default(1).transform((v) => Math.max(1, v)),
  arbMode: z.enum(["heredado", "sim", "live"]).default("heredado"),
  directionalMode: z.enum(["heredado", "sim", "live"]).default("heredado"),
  arb15mEnabled: z.boolean().default(false),
  arbNakedLegHaltStreak: z.coerce.number().int().min(1).max(10).default(1),
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
  explorationEnabled: z.boolean().default(true),
  autoStartSimOnBoot: z.boolean().default(false),
  watchdogEnabled: z.boolean().default(true),
  evUseSimilarity: z.boolean().default(false),
  evCalibration: z.boolean().default(false),
  evSafetyMargin: z.coerce.number().nonnegative().lt(1).default(0.03),
  evMinHistoryTrades: z.coerce.number().int().nonnegative().default(15),
  minFillRatio: z.coerce.number().min(0).max(1).default(0.5),
  evMinExpectedRoi: z.coerce.number().nonnegative().lt(1).default(0.01),
  tickStaleMs: z.coerce.number().positive(),
  pollIntervalMs: z.coerce.number().positive(),
  openingCaptureGraceMs: z.coerce.number().positive(),
  minDistanceFloorUsdByMarket: marketDistancesSchema.default({ BTC: 20, ETH: 0.1, DOGE: 0.00003 }),
  liveMaxSlippage: z.coerce.number().nonnegative().lt(1).default(0.02),
  /**
   * Bajado de 20.000 a 10.000. Con la muestra en ~31 KB el tope anterior proyectaba 608 MB, y podar un
   * fichero asi congela el proceso ~17 segundos. El defecto del codigo no basta: este ajuste es el que
   * llega al grabador, y un valor guardado de 20.000 lo pisaria.
   */
  maxAnalyticsSamples: z.coerce.number().int().positive().default(10_000),
  aiAutoApplyLive: z.boolean().default(false),
  aiAutoTuneAskCap: z.boolean().default(false),
  /**
   * Interruptor SEPARADO del de estrechar, y separado a proposito.
   *
   * Los dos caminos no comparten ni riesgo ni maquinaria. Estrechar parte de `askWindowBaseline`, que
   * es una base GLOBAL mientras las ventanas son por mercado: cuando no encuentra bandas perdedoras
   * devuelve la ventana a esa base, o sea que empujaria BTC, ETH y DOGE hacia [0,65 - 0,96] sin
   * ninguna evidencia, deshaciendo el ajuste por mercado. Ademas, sobre la ventana desplegada el
   * backtest mide 0 ajustes: encenderlo no aporta nada medible.
   *
   * Sondear no usa esa base para nada y es donde esta el unico upside medido.
   */
  aiAutoProbeBands: z.boolean().default(false),
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
    minAskPriceByMarketOutcome: defaultMarketOutcomeMaxAskPrices(
      config.minAskPriceByMarketOutcome,
      0.01,
    ),
    maxAskPriceByMarketOutcome: defaultMarketOutcomeMaxAskPrices(
      config.maxAskPriceByMarketOutcome,
      config.maxAskPrice,
    ),
    maxAskPriceCeiling: config.maxAskPriceCeiling ?? 0.85,
    favoriteStrategyEnabled: Boolean(config.favoriteStrategyEnabled ?? false),
    favoriteMinAsk: config.favoriteMinAsk ?? 0.76,
    favoriteMaxAsk: config.favoriteMaxAsk ?? 0.85,
    favoriteMaxAskSum: config.favoriteMaxAskSum ?? 1.15,
    favoriteAllowLive: Boolean(config.favoriteAllowLive ?? false),
    dailySpendLimitUsd: config.dailySpendLimitUsd,
    maxDailyLossUsd: config.maxDailyLossUsd ?? 0,
    liveBankrollUsd: config.liveBankrollUsd ?? 0,
    minBankrollForDirectionalUsd: config.minBankrollForDirectionalUsd ?? 10,
    riskHaltCooldownHours: config.riskHaltCooldownHours ?? 2,
    arbEnabled: config.arbEnabled ?? false,
    makerEnabled: Boolean(config.makerEnabled ?? false),
    makerMode: config.makerMode ?? "sim",
    makerCapitalUsd: config.makerCapitalUsd ?? 40,
    makerRetireSecondsBeforeClose: config.makerRetireSecondsBeforeClose ?? 30,
    makerMarketSource: config.makerMarketSource ?? "recompensas",
    makerStopBelowUsd: config.makerStopBelowUsd ?? 0,
    makerTicksDelMedio: config.makerTicksDelMedio ?? 1,
    arbMode: config.arbMode ?? "heredado",
    directionalMode: config.directionalMode ?? "heredado",
    arb15mEnabled: Boolean(config.arb15mEnabled ?? false),
    arbNakedLegHaltStreak: config.arbNakedLegHaltStreak ?? 1,
    arbMaxUsdPerOpportunity: config.arbMaxUsdPerOpportunity ?? 25,
    arbMinNetPerSet: config.arbMinNetPerSet ?? 0.02,
    timezone: config.timezone ?? "auto",
    maxConsecutiveLosses: config.maxConsecutiveLosses ?? 0,
    requirePositiveEv: config.requirePositiveEv ?? true,
    explorationEnabled: config.explorationEnabled ?? true,
    autoStartSimOnBoot: false,
    watchdogEnabled: true,
    evUseSimilarity: config.evUseSimilarity ?? false,
    evCalibration: config.evCalibration ?? false,
    evSafetyMargin: config.evSafetyMargin ?? 0.03,
    evMinHistoryTrades: config.evMinHistoryTrades ?? 15,
    minFillRatio: config.minFillRatio ?? 0.5,
    evMinExpectedRoi: config.evMinExpectedRoi ?? 0.01,
    tickStaleMs: config.tickStaleMs,
    pollIntervalMs: config.pollIntervalMs,
    openingCaptureGraceMs: config.openingCaptureGraceMs,
    minDistanceFloorUsdByMarket: defaultMarketDistances(config.minDistanceFloorUsdByMarket),
    liveMaxSlippage: config.liveMaxSlippage ?? 0.02,
    maxAnalyticsSamples: config.maxAnalyticsSamples ?? 10_000,
    aiAutoApplyLive: false,
    aiAutoTuneAskCap: Boolean(config.aiAutoTuneAskCap ?? false),
    aiAutoProbeBands: Boolean(config.aiAutoProbeBands ?? false),
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
    // El PISO viajaba en settings pero nunca llegaba aqui, asi que el runner caia siempre al 0.01 por
    // defecto: el piso de ask no ha estado activo en produccion. Existe para bloquear las entradas
    // baratas de reversion, que el replay del ledger midio perdiendo 23 de 24 en ETH por debajo de
    // 0.30 — o sea que su ausencia deja pasar justo las peores.
    minAskPriceByMarketOutcome: settings.minAskPriceByMarketOutcome,
    maxAskPriceCeiling: settings.maxAskPriceCeiling,
    // La estrategia "favorito", con el mismo cuidado que el piso de ask de arriba: sin estas cinco
    // lineas el panel la enseñaria encendida y el runner seguiria eligiendo lado por la distancia.
    favoriteStrategyEnabled: settings.favoriteStrategyEnabled,
    favoriteMinAsk: settings.favoriteMinAsk,
    favoriteMaxAsk: settings.favoriteMaxAsk,
    favoriteMaxAskSum: settings.favoriteMaxAskSum,
    favoriteAllowLive: settings.favoriteAllowLive,
    dailySpendLimitUsd: settings.dailySpendLimitUsd,
    maxDailyLossUsd: settings.maxDailyLossUsd,
    liveBankrollUsd: settings.liveBankrollUsd,
    minBankrollForDirectionalUsd: settings.minBankrollForDirectionalUsd,
    riskHaltCooldownHours: settings.riskHaltCooldownHours,
    arbEnabled: settings.arbEnabled,
    // Sin esta linea el ajuste existe en la UI, se guarda, se muestra encendido... y el runner no se
    // entera. Es el MISMO fallo que tuvo el piso de ask: `applySettings` construye la config con la
    // que arranca el bot, y lo que no se copie aqui simplemente no existe para el.
    makerEnabled: settings.makerEnabled,
    makerMode: settings.makerMode === "heredado" ? undefined : settings.makerMode,
    makerCapitalUsd: settings.makerCapitalUsd,
    makerRetireSecondsBeforeClose: settings.makerRetireSecondsBeforeClose,
    makerMarketSource: settings.makerMarketSource,
    makerStopBelowUsd: settings.makerStopBelowUsd,
    makerTicksDelMedio: settings.makerTicksDelMedio,
    arbMode: settings.arbMode === "heredado" ? undefined : settings.arbMode,
    directionalMode: settings.directionalMode === "heredado" ? undefined : settings.directionalMode,
    arb15mEnabled: settings.arb15mEnabled,
    arbNakedLegHaltStreak: settings.arbNakedLegHaltStreak,
    arbMaxUsdPerOpportunity: settings.arbMaxUsdPerOpportunity,
    arbMinNetPerSet: settings.arbMinNetPerSet,
    timezone: settings.timezone,
    maxConsecutiveLosses: settings.maxConsecutiveLosses,
    requirePositiveEv: settings.requirePositiveEv,
    explorationEnabled: settings.explorationEnabled,
    evUseSimilarity: settings.evUseSimilarity,
    evCalibration: settings.evCalibration,
    evSafetyMargin: settings.evSafetyMargin,
    evMinHistoryTrades: settings.evMinHistoryTrades,
    minFillRatio: settings.minFillRatio,
    evMinExpectedRoi: settings.evMinExpectedRoi,
    tickStaleMs: settings.tickStaleMs,
    pollIntervalMs: settings.pollIntervalMs,
    openingCaptureGraceMs: settings.openingCaptureGraceMs,
    minDistanceFloorUsdByMarket: settings.minDistanceFloorUsdByMarket,
    liveMaxSlippage: settings.liveMaxSlippage,
    maxAnalyticsSamples: settings.maxAnalyticsSamples,
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
    minAskPriceByMarketOutcome: defaultMarketOutcomeMaxAskPrices(
      marketOutcomeOverrides(settings.minAskPriceByMarketOutcome),
      0.01,
    ),
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

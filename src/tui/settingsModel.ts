// Pure model for the Settings tab: turn a UiSettings into a flat list of navigable fields, and apply
// an edit back onto a full settings clone. We always work on (and send) the whole UiSettings object —
// the server recomputes `enabledMarkets` from `enabledMarketOutcomes` and merges partials in ways that
// are easy to get subtly wrong, so mirroring the web (edit a full draft, PUT it whole) is the safe path.

import type { MarketSymbol, Outcome } from "../types.js";
import type { UiSettings } from "../ui/shared.js";
import { fmtUsd } from "./theme.js";

export type FieldKind = "header" | "toggle" | "number";

export interface SettingsField {
  id: string;
  label: string;
  kind: FieldKind;
  /** Display value for toggle/number rows; undefined for headers. */
  value?: string;
  /** Headers are shown but skipped during navigation/editing. */
  editable: boolean;
}

const MARKETS: MarketSymbol[] = ["BTC", "ETH", "DOGE"];
const OUTCOMES: Outcome[] = ["UP", "DOWN"];

const TOGGLE_LABELS: Record<string, string> = {
  requirePositiveEv: "Gate de EV positivo",
  explorationEnabled: "Exploración de arranque en frío",
  autoStartSimOnBoot: "Reanudar sim al reiniciar",
  watchdogEnabled: "Watchdog (auto-reinicio)",
  evUseSimilarity: "Estimador por similitud (k-NN)",
  evCalibration: "Calibración empírica",
  autoMinLive: "Operar al mínimo del exchange",
  arbEnabled: "Arbitraje de set completo",
  aiAutoApplyLive: "Autoajuste predictivo",
  aiAutoTuneAskCap: "Autoajuste de la ventana de ask",
};

const TOGGLE_KEYS = Object.keys(TOGGLE_LABELS) as (keyof UiSettings)[];

function commonValue(settings: UiSettings, pick: (m: MarketSymbol, o: Outcome) => number): number | undefined {
  const values = MARKETS.flatMap((m) => OUTCOMES.map((o) => pick(m, o)));
  return values.every((v) => v === values[0]) ? values[0] : undefined;
}

function onOff(value: boolean): string {
  return value ? "ON" : "OFF";
}

/** Build the flat, ordered field list rendered in the Settings tab. Headers are interleaved for
 * grouping and are skipped by navigation. */
export function buildSettingsFields(settings: UiSettings): SettingsField[] {
  const fields: SettingsField[] = [];
  const header = (label: string): void => {
    fields.push({ id: `header:${label}`, label, kind: "header", editable: false });
  };
  const toggle = (key: keyof UiSettings): void => {
    fields.push({ id: String(key), label: TOGGLE_LABELS[key as string], kind: "toggle", value: onOff(Boolean(settings[key])), editable: true });
  };

  header("Estrategia");
  (["requirePositiveEv", "explorationEnabled", "autoStartSimOnBoot", "watchdogEnabled", "evUseSimilarity", "evCalibration", "autoMinLive", "arbEnabled"] as (keyof UiSettings)[]).forEach(toggle);

  header("Autoajuste");
  (["aiAutoApplyLive", "aiAutoTuneAskCap"] as (keyof UiSettings)[]).forEach(toggle);

  header("Límites y ventana (global)");
  fields.push({ id: "dailySpendLimitUsd", label: "Límite diario", kind: "number", value: fmtUsd(settings.dailySpendLimitUsd), editable: true });
  const floor = commonValue(settings, (m, o) => settings.minAskPriceByMarketOutcome[m][o]);
  const cap = commonValue(settings, (m, o) => settings.maxAskPriceByMarketOutcome[m][o]);
  fields.push({ id: "askFloorAll", label: "Ask piso (todos)", kind: "number", value: floor === undefined ? "mixto" : floor.toFixed(2), editable: true });
  fields.push({ id: "askCapAll", label: "Ask techo (todos)", kind: "number", value: cap === undefined ? "mixto" : cap.toFixed(2), editable: true });

  header("Mercados — activar / monto por trade");
  for (const m of MARKETS) {
    for (const o of OUTCOMES) {
      const enabled = settings.enabledMarketOutcomes[m][o];
      fields.push({ id: `enabled:${m}:${o}`, label: `${m} ${o} — activo`, kind: "toggle", value: onOff(enabled), editable: true });
      fields.push({
        id: `amount:${m}:${o}`,
        label: `${m} ${o} — monto`,
        kind: "number",
        value: fmtUsd(settings.liveTradeAmountUsdByMarketOutcome[m][o]),
        editable: true,
      });
    }
  }

  return fields;
}

export function isToggleId(id: string): boolean {
  return TOGGLE_KEYS.includes(id as keyof UiSettings) || id.startsWith("enabled:");
}

/** Flip a boolean field (a top-level toggle or a per-market/outcome enable) on a full settings clone. */
export function applyToggle(settings: UiSettings, id: string): UiSettings {
  const next = structuredClone(settings);
  if (id.startsWith("enabled:")) {
    const [, market, outcome] = id.split(":") as [string, MarketSymbol, Outcome];
    next.enabledMarketOutcomes[market][outcome] = !next.enabledMarketOutcomes[market][outcome];
    // Keep enabledMarkets consistent with the outcomes the user just changed (the server recomputes it
    // too, but sending a coherent object avoids any merge ambiguity).
    next.enabledMarkets = MARKETS.filter((m) => OUTCOMES.some((o) => next.enabledMarketOutcomes[m][o]));
    return next;
  }
  if (TOGGLE_KEYS.includes(id as keyof UiSettings)) {
    (next as unknown as Record<string, unknown>)[id] = !Boolean(settings[id as keyof UiSettings]);
    return next;
  }
  throw new Error(`Campo no alternable: ${id}`);
}

/** Apply a numeric edit to a full settings clone. Mirrors the web's global setters (cap clamped to the
 * hard ceiling; floor clamped to each side's cap) and keeps sim/live amounts identical. */
export function applyNumber(settings: UiSettings, id: string, value: number): UiSettings {
  if (!Number.isFinite(value)) {
    throw new Error("Valor no numérico.");
  }
  const next = structuredClone(settings);

  if (id === "dailySpendLimitUsd") {
    next.dailySpendLimitUsd = Math.max(0, value);
    return next;
  }
  if (id === "askCapAll") {
    const capped = Math.min(value, next.maxAskPriceCeiling);
    for (const m of MARKETS) {
      for (const o of OUTCOMES) {
        next.maxAskPriceByMarketOutcome[m][o] = capped;
      }
    }
    next.maxAskPrice = capped;
    return next;
  }
  if (id === "askFloorAll") {
    for (const m of MARKETS) {
      for (const o of OUTCOMES) {
        next.minAskPriceByMarketOutcome[m][o] = Math.min(value, next.maxAskPriceByMarketOutcome[m][o]);
      }
    }
    return next;
  }
  if (id.startsWith("amount:")) {
    const [, market, outcome] = id.split(":") as [string, MarketSymbol, Outcome];
    const amount = Math.max(0.1, value);
    next.liveTradeAmountUsdByMarketOutcome[market][outcome] = amount;
    next.simTradeAmountUsdByMarketOutcome[market][outcome] = amount;
    // Keep the scalar defaults aligned with BTC/UP, exactly like the web form does.
    next.liveTradeAmountUsd = next.liveTradeAmountUsdByMarketOutcome.BTC.UP;
    next.simTradeAmountUsd = next.simTradeAmountUsdByMarketOutcome.BTC.UP;
    return next;
  }
  throw new Error(`Campo numérico desconocido: ${id}`);
}

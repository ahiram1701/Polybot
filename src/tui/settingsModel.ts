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
  /**
   * Explicacion de una linea. La TUI no tiene tooltips, asi que hasta ahora no habia NINGUN sitio
   * donde poner ayuda — por eso el aviso de LIVE va metido dentro del propio valor. `renderSettings`
   * la pinta solo para la fila seleccionada: una linea por fila duplicaria una lista que ya no cabe.
   */
  help?: string;
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
  arb15mEnabled: "Arbitraje tambien en 15m (solo arbitraje)",
  aiAutoTuneAskCap: "Autoajuste de la ventana de ask (solo estrecha)",
  aiAutoProbeBands: "Sondeos de banda (puede abrir)",
};

const TOGGLE_KEYS = Object.keys(TOGGLE_LABELS) as (keyof UiSettings)[];

/**
 * Modos por estrategia. No son booleanos, asi que en vez de alternar CICLAN por los tres valores. Se
 * reaprovecha la fila de tipo "toggle" para no inventar un tipo de campo nuevo con su navegacion y sus
 * teclas: lo que importa es que la fila muestre siempre el valor actual, y lo hace.
 */
const MODE_KEYS = ["arbMode", "directionalMode"] as const;
const MODE_LABELS: Record<(typeof MODE_KEYS)[number], string> = {
  arbMode: "Modo del arbitraje",
  directionalMode: "Modo del direccional",
};
const MODE_CYCLE = ["heredado", "sim", "live"] as const;

/**
 * Los ajustes que acotan DINERO. Se listan en una tabla y no a mano porque el test de paridad recorre
 * esta misma lista: añadir aqui un limite obliga a que exista su fila, y no se puede quedar solo en la
 * web como paso con los nueve anteriores.
 *
 * Los rangos replican los del esquema zod (`src/ui/settings.ts`). Validar aqui tambien evita mandar un
 * PUT que el servidor va a rechazar despues.
 */
interface RiskFieldSpec {
  key: keyof UiSettings;
  label: string;
  help: string;
  min: number;
  max?: number;
  integer?: boolean;
  format: (value: number) => string;
}

const RISK_FIELDS: readonly RiskFieldSpec[] = [
  {
    key: "maxDailyLossUsd",
    label: "Pérdida diaria máx",
    help: "Para el DIRECCIONAL si la pérdida realizada del día lo cruza. 0 = desactivado. No frena el arbitraje.",
    min: 0,
    format: fmtUsd,
  },
  {
    key: "maxConsecutiveLosses",
    label: "Pérdidas seguidas máx",
    help: "Mismo freno que el anterior pero por racha en vez de por importe. 0 = desactivado.",
    min: 0,
    integer: true,
    format: (v) => String(v),
  },
  {
    key: "riskHaltCooldownHours",
    label: "Enfriamiento (horas)",
    help: "Tras saltar el freno, cuánto espera antes de rearmarse. No espera al día siguiente.",
    min: 0,
    format: (v) => `${v} h`,
  },
  {
    key: "minBankrollForDirectionalUsd",
    label: "Capital mín direccional",
    help: "Por debajo de esto el direccional NO opera en live. El arbitraje sí: es con lo que se crece.",
    min: 0,
    format: fmtUsd,
  },
  {
    key: "liveBankrollUsd",
    label: "Capital declarado",
    help: "Solo se usa si falla la lectura on-chain, para no confundir un RPC caído con quedarse sin fondos.",
    min: 0,
    format: fmtUsd,
  },
  {
    key: "liveMaxSlippage",
    label: "Deslizamiento máx",
    help: "Cuánto puede alejarse el precio de la orden del mejor ask observado.",
    min: 0,
    max: 0.99,
    format: (v) => v.toFixed(3),
  },
  {
    key: "arbMaxUsdPerOpportunity",
    label: "Arb — máx por oportunidad",
    help: "Presupuesto de las dos patas juntas. El colateral real leído on-chain lo acota además por debajo.",
    min: 0.01,
    format: fmtUsd,
  },
  {
    key: "arbMinNetPerSet",
    label: "Arb — ganancia mín por set",
    help: "Margen mínimo tras comisiones para mandar el par. Por debajo, solo se observa.",
    min: 0,
    max: 0.5,
    format: (v) => v.toFixed(3),
  },
  {
    key: "arbNakedLegHaltStreak",
    label: "Arb — patas sueltas antes de parar",
    help: "Si una pata llena y la otra no, queda una apuesta desnuda. Rearma al reiniciar el bot.",
    min: 1,
    max: 10,
    integer: true,
    format: (v) => String(v),
  },
];

const RISK_FIELD_BY_ID = new Map(RISK_FIELDS.map((field) => [String(field.key), field]));

/** Claves que acotan dinero. La usa el test de paridad entre la web y la TUI. */
export const TUI_RISK_KEYS: readonly string[] = RISK_FIELDS.map((field) => String(field.key));

function modeValueLabel(value: string): string {
  // El aviso va en el propio valor porque en la TUI no hay tooltip donde esconderlo.
  return value === "live" ? "LIVE ⚠ DINERO REAL" : value === "sim" ? "SIM (papel)" : "heredado";
}

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

  header("Modo por estrategia");
  for (const key of MODE_KEYS) {
    fields.push({
      id: String(key),
      label: MODE_LABELS[key],
      kind: "toggle",
      value: modeValueLabel(String(settings[key])),
      editable: true,
    });
  }

  header("Autoajuste");
  (["aiAutoApplyLive", "aiAutoTuneAskCap", "aiAutoProbeBands", "arb15mEnabled"] as (keyof UiSettings)[]).forEach(toggle);

  header("Límites y ventana (global)");
  fields.push({ id: "dailySpendLimitUsd", label: "Límite diario", kind: "number", value: fmtUsd(settings.dailySpendLimitUsd), editable: true });
  const floor = commonValue(settings, (m, o) => settings.minAskPriceByMarketOutcome[m][o]);
  const cap = commonValue(settings, (m, o) => settings.maxAskPriceByMarketOutcome[m][o]);
  fields.push({ id: "askFloorAll", label: "Ask piso (todos)", kind: "number", value: floor === undefined ? "mixto" : floor.toFixed(2), editable: true });
  fields.push({ id: "askCapAll", label: "Ask techo (todos)", kind: "number", value: cap === undefined ? "mixto" : cap.toFixed(2), editable: true });

  header("Límites de riesgo");
  for (const field of RISK_FIELDS) {
    fields.push({
      id: String(field.key),
      label: field.label,
      kind: "number",
      value: field.format(Number(settings[field.key])),
      help: field.help,
      editable: true,
    });
  }

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

/** Si el campo es el modo de una estrategia. Esos ciclan en vez de alternar, y pueden entrar en live. */
export function isModeId(id: string): boolean {
  return (MODE_KEYS as readonly string[]).includes(id);
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
  if ((MODE_KEYS as readonly string[]).includes(id)) {
    const actual = String(settings[id as keyof UiSettings]);
    const siguiente = MODE_CYCLE[(MODE_CYCLE.indexOf(actual as (typeof MODE_CYCLE)[number]) + 1) % MODE_CYCLE.length];
    (next as unknown as Record<string, unknown>)[id] = siguiente;
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
    // El esquema exige POSITIVO: con `Math.max(0, ...)` un 0 pasaba el cliente y el PUT fallaba
    // despues con un error de validacion que no explicaba nada.
    next.dailySpendLimitUsd = Math.max(0.01, value);
    return next;
  }
  const risk = RISK_FIELD_BY_ID.get(id);
  if (risk) {
    let clamped = Math.max(risk.min, risk.max === undefined ? value : Math.min(risk.max, value));
    if (risk.integer) {
      clamped = Math.round(clamped);
    }
    (next as unknown as Record<string, unknown>)[id] = clamped;
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

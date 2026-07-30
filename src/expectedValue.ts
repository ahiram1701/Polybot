import { applyCalibration, type CalibrationMap } from "./calibration.js";

export const DEFAULT_SAFETY_MARGIN = 0.02;
export const DEFAULT_MIN_EXPECTED_ROI = 0.01;
// Strength (in pseudo-trades) of the Bayesian prior used to shrink the raw win frequency. Kept at 2
// so that with the default 0.5 prior the estimate equals the classic Laplace (w+1)/(t+2) — no change
// for existing callers. When a market-implied prior (the ask) is supplied, thin setups anchor to the
// market price (edge ~0) instead of to 0.5, which is better calibrated for expensive favorites.
export const PRIOR_STRENGTH = 2;

export type AskGuidance = "preferred" | "cheap" | "expensive" | "avoid_098" | "avoid_099";

export type ExpectedValueDecisionReason =
  | "passes"
  | "insufficient_history"
  | "safety_margin"
  | "minimum_expected_value"
  | "avoid_098"
  | "avoid_099"
  | "implausible_edge";

export interface ExpectedValueInput {
  capitalUsd: number;
  askPrice: number;
  winCount: number;
  tradeCount: number;
  safetyMargin?: number;
  minExpectedRoi?: number;
  // Bayesian prior strength (pseudo-trades) for the win-rate shrinkage. Higher = more skeptical of thin
  // history, anchoring harder to the market-implied prior (the ask). Defaults to PRIOR_STRENGTH.
  priorStrength?: number;
  // Empirical calibration map (predicted → realized win rate). Applied to the adjusted probability
  // BEFORE the edge/ROI checks, so measured overconfidence tightens the gate automatically.
  calibration?: CalibrationMap;
  /**
   * Ceiling on how much better than the market (the ask) the model is allowed to claim to be.
   *
   * Measured on the ledger (2026-07-30): trades where the gate claimed an edge above 0.20 realized
   * **-17.6pp of discrimination and a -21.8pp bias** — they were the losing bucket, while claims of
   * 0-0.05 and 0.10-0.20 both worked. A 20+ point edge over the market price, inferred from a few
   * dozen observations, is noise dressed as skill.
   *
   * Se RECHAZA el trade, no se recorta la probabilidad: recortarla lo dejaba pasar igual (0.20 sigue
   * muy por encima del margen de seguridad) y no cambiaba nada. Walk-forward sobre 403 trades: pasar
   * de recorte a rechazo lleva el neto de +$28.28 a +$135.23 y el win rate de 45.9% a 51.6%. Todo el
   * rango 0.10-0.35 mejora, asi que el resultado no depende de acertar el umbral. Se elige 0.20
   * porque salio de un analisis anterior e independiente (el bucket edge>0.20 media -17.6pp de
   * discriminacion), no del pico de ese barrido.
   *
   * Tambien se probo y DESCARTO castigar la estimacion por su error estandar (cota inferior): el
   * error estandar se maximiza en p~0.5, que es donde viven los edges modestos que si funcionan, y
   * se anula en los extremos, que son los que pierden. Castigaba exactamente al reves: el neto caia
   * a -$56/-$132 y el win rate de los supervivientes bajaba a 22%. Undefined = sin techo.
   */
  maxClaimedEdge?: number;
}

export interface ExpectedValueSnapshot {
  capitalUsd: number;
  askPrice: number;
  winCount: number;
  tradeCount: number;
  realWinProbability?: number;
  /**
   * Probabilidad ANTES de aplicar la calibracion empirica. Es la que hay que usar para ENTRENAR el
   * mapa: entrenarlo con `adjustedWinProbability` (ya calibrada) lo hace perseguir un blanco que el
   * propio mapa mueve, y la correccion se queda corta para siempre (medido: el mapa quitaba ~9pp de
   * un error real de ~26pp).
   */
  rawWinProbability: number;
  adjustedWinProbability: number;
  breakEvenProbability: number;
  edge: number;
  expectedRoi: number;
  expectedValueUsd: number;
  winProfitUsd: number;
  lossUsd: number;
  safetyMargin: number;
  minExpectedRoi: number;
  minExpectedValueUsd: number;
  askGuidance: AskGuidance;
  passesBasicEntry: boolean;
  passesSafetyMargin: boolean;
  passesExpectedValue: boolean;
  passesRecommendedEntry: boolean;
  decisionReason: ExpectedValueDecisionReason;
}

export function calculateExpectedValue(input: ExpectedValueInput): ExpectedValueSnapshot {
  assertPositiveFinite(input.capitalUsd, "capitalUsd");
  assertProbabilityPrice(input.askPrice, "askPrice");
  assertNonNegativeInteger(input.winCount, "winCount");
  assertNonNegativeInteger(input.tradeCount, "tradeCount");
  if (input.winCount > input.tradeCount) {
    throw new Error("winCount cannot be greater than tradeCount.");
  }

  const safetyMargin = input.safetyMargin ?? DEFAULT_SAFETY_MARGIN;
  const minExpectedRoi = input.minExpectedRoi ?? DEFAULT_MIN_EXPECTED_ROI;
  assertNonNegativeFinite(safetyMargin, "safetyMargin");
  assertNonNegativeFinite(minExpectedRoi, "minExpectedRoi");

  const realWinProbability = calculateRealWinProbability(input.winCount, input.tradeCount);
  // Anchor the shrinkage prior to the market-implied probability (the ask): in an efficient market the
  // ask ≈ P(win), so a thin setup should start at the market price (edge ~0) rather than at 0.5.
  const rawWinProbability = calculateAdjustedWinProbability(
    input.winCount,
    input.tradeCount,
    input.askPrice,
    input.priorStrength,
  );
  const adjustedWinProbability = applyCalibration(input.calibration, rawWinProbability);
  const edge = adjustedWinProbability - input.askPrice;
  const expectedRoi = adjustedWinProbability / input.askPrice - 1;
  const expectedValueUsd = input.capitalUsd * expectedRoi;
  const minExpectedValueUsd = input.capitalUsd * minExpectedRoi;
  const passesBasicEntry = adjustedWinProbability > input.askPrice;
  const passesSafetyMargin = adjustedWinProbability >= input.askPrice + safetyMargin;
  const passesExpectedValue = expectedValueUsd >= minExpectedValueUsd;
  const askGuidance = getAskGuidance(input.askPrice);
  // Una ventaja declarada implausible se RECHAZA (no se recorta): recortarla dejaba pasar el trade
  // igual, y son justo los que perdian.
  const claimsImplausibleEdge =
    input.maxClaimedEdge !== undefined && Number.isFinite(input.maxClaimedEdge) && edge > input.maxClaimedEdge;
  const passesRecommendedEntry = passesSafetyMargin && passesExpectedValue && !claimsImplausibleEdge;

  return {
    capitalUsd: input.capitalUsd,
    askPrice: input.askPrice,
    winCount: input.winCount,
    tradeCount: input.tradeCount,
    realWinProbability,
    rawWinProbability,
    adjustedWinProbability,
    breakEvenProbability: input.askPrice,
    edge,
    expectedRoi,
    expectedValueUsd,
    winProfitUsd: input.capitalUsd * (1 / input.askPrice - 1),
    lossUsd: -input.capitalUsd,
    safetyMargin,
    minExpectedRoi,
    minExpectedValueUsd,
    askGuidance,
    passesBasicEntry,
    passesSafetyMargin,
    passesExpectedValue,
    passesRecommendedEntry,
    decisionReason: claimsImplausibleEdge
      ? "implausible_edge"
      : expectedValueDecisionReason({
      tradeCount: input.tradeCount,
      askGuidance,
      passesSafetyMargin,
      passesExpectedValue,
      passesRecommendedEntry,
    }),
  };
}

export function calculateRealWinProbability(winCount: number, tradeCount: number): number | undefined {
  assertNonNegativeInteger(winCount, "winCount");
  assertNonNegativeInteger(tradeCount, "tradeCount");
  if (winCount > tradeCount) {
    throw new Error("winCount cannot be greater than tradeCount.");
  }
  return tradeCount > 0 ? winCount / tradeCount : undefined;
}

export function calculateAdjustedWinProbability(
  winCount: number,
  tradeCount: number,
  priorProbability = 0.5,
  priorStrength: number = PRIOR_STRENGTH,
): number {
  assertNonNegativeInteger(winCount, "winCount");
  assertNonNegativeInteger(tradeCount, "tradeCount");
  if (winCount > tradeCount) {
    throw new Error("winCount cannot be greater than tradeCount.");
  }
  // Bayesian shrinkage toward `priorProbability` with strength `priorStrength` pseudo-trades. With the
  // default 0.5 prior and strength 2 this is exactly the classic Laplace estimate (w+1)/(t+2). A larger
  // strength anchors thin setups harder to the prior (the ask), i.e. is more skeptical of small samples.
  const strength = Number.isFinite(priorStrength) && priorStrength > 0 ? priorStrength : PRIOR_STRENGTH;
  const prior = Number.isFinite(priorProbability) ? Math.min(Math.max(priorProbability, 0.05), 0.95) : 0.5;
  return (winCount + strength * prior) / (tradeCount + strength);
}

export function getAskGuidance(askPrice: number): AskGuidance {
  assertProbabilityPrice(askPrice, "askPrice");
  if (askPrice >= 0.99) {
    return "avoid_099";
  }
  if (askPrice >= 0.98) {
    return "avoid_098";
  }
  if (askPrice > 0.95) {
    return "expensive";
  }
  if (askPrice >= 0.85) {
    return "preferred";
  }
  return "cheap";
}

function expectedValueDecisionReason(args: {
  tradeCount: number;
  askGuidance: AskGuidance;
  passesSafetyMargin: boolean;
  passesExpectedValue: boolean;
  passesRecommendedEntry: boolean;
}): ExpectedValueDecisionReason {
  if (args.passesRecommendedEntry) {
    return "passes";
  }
  if (args.tradeCount === 0) {
    return "insufficient_history";
  }
  if (args.askGuidance === "avoid_099") {
    return "avoid_099";
  }
  if (args.askGuidance === "avoid_098") {
    return "avoid_098";
  }
  if (!args.passesSafetyMargin) {
    return "safety_margin";
  }
  return "minimum_expected_value";
}

function assertProbabilityPrice(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0 || value > 1) {
    throw new Error(`${name} must be greater than 0 and less than or equal to 1.`);
  }
}

function assertPositiveFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be greater than 0.`);
  }
}

function assertNonNegativeFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be greater than or equal to 0.`);
  }
}

function assertNonNegativeInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }
}

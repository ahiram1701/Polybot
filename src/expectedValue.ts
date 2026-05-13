export const DEFAULT_SAFETY_MARGIN = 0.02;
export const DEFAULT_MIN_EXPECTED_ROI = 0.01;

export type AskGuidance = "preferred" | "cheap" | "expensive" | "avoid_098" | "avoid_099";

export type ExpectedValueDecisionReason =
  | "passes"
  | "insufficient_history"
  | "safety_margin"
  | "minimum_expected_value"
  | "avoid_098"
  | "avoid_099";

export interface ExpectedValueInput {
  capitalUsd: number;
  askPrice: number;
  winCount: number;
  tradeCount: number;
  safetyMargin?: number;
  minExpectedRoi?: number;
}

export interface ExpectedValueSnapshot {
  capitalUsd: number;
  askPrice: number;
  winCount: number;
  tradeCount: number;
  realWinProbability?: number;
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
  const adjustedWinProbability = calculateAdjustedWinProbability(input.winCount, input.tradeCount);
  const edge = adjustedWinProbability - input.askPrice;
  const expectedRoi = adjustedWinProbability / input.askPrice - 1;
  const expectedValueUsd = input.capitalUsd * expectedRoi;
  const minExpectedValueUsd = input.capitalUsd * minExpectedRoi;
  const passesBasicEntry = adjustedWinProbability > input.askPrice;
  const passesSafetyMargin = adjustedWinProbability >= input.askPrice + safetyMargin;
  const passesExpectedValue = expectedValueUsd >= minExpectedValueUsd;
  const askGuidance = getAskGuidance(input.askPrice);
  const passesRecommendedEntry = passesSafetyMargin && passesExpectedValue;

  return {
    capitalUsd: input.capitalUsd,
    askPrice: input.askPrice,
    winCount: input.winCount,
    tradeCount: input.tradeCount,
    realWinProbability,
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
    decisionReason: expectedValueDecisionReason({
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

export function calculateAdjustedWinProbability(winCount: number, tradeCount: number): number {
  assertNonNegativeInteger(winCount, "winCount");
  assertNonNegativeInteger(tradeCount, "tradeCount");
  if (winCount > tradeCount) {
    throw new Error("winCount cannot be greater than tradeCount.");
  }
  return (winCount + 1) / (tradeCount + 2);
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

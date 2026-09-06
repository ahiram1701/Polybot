import type { BandProgram } from "../bandProbeProgram.js";
import type { LogEntry } from "../logger.js";
import { calculateTradePnl, esSalidaTotal, isCompleteArbPair, type PnlResetAtMsByMode, type PnlSummary } from "../pnl.js";
import type { RiskHaltStatus } from "../riskCircuitBreaker.js";
import type { EffectiveModes } from "../ui/shared.js";
import type {
  MarketSymbol,
  Mode,
  Outcome,
  StrategyAnalysisResponse,
  StrategyCandidate,
  TradeAttempt,
} from "../types.js";
import { windowDurationFromSlug } from "../time.js";
import type { UiStatus } from "../ui/shared.js";

const DEFAULT_STRATEGY_LIMIT = 12;

const DEFAULT_LOG_SAMPLE = 60;

export interface CompactMarket {
  marketSymbol: MarketSymbol;
  /**
   * Duracion de la ventana ("5m" / "15m"). Sin esto, con las dos activas salen dos filas "BTC"
   * indistinguibles en la web, en la TUI y en lo que leen los agentes — mentir por ambiguedad.
   * Ausente en snapshots anteriores, que eran todos de 5m.
   */
  duration?: string;
  reason: string;
  inEntryWindow: boolean;
  secondsToEnd?: number;
  outcome?: Outcome;
  distanceUsd?: number;
  /** Precio SPOT del oraculo. NO es el que resuelve el mercado ni el que enseña la web. */
  tickValue?: number;
  /** Precio TWAP: la serie que RESUELVE, y la unica comparable con lo que muestra Polymarket. */
  twapValue?: number;
  /**
   * Mejor ask de cada lado, y el punto medio que Polymarket usa como "probabilidad".
   *
   * Sin esto no habia NINGUNA superficie de terminal donde ver "el favorito cotiza a 0,81" — que es
   * justo el numero del que depende la estrategia del favorito para decidir.
   */
  upAsk?: number;
  downAsk?: number;
  upMid?: number;
  downMid?: number;
}

export interface CompactPnl {
  realizedUsd: number;
  roiPct?: number;
  resolvedCount: number;
  wonCount: number;
  lostCount: number;
  pendingCount: number;
}

export interface RecentActivity {
  sampleSize: number;
  fromAt?: string;
  toAt?: string;
  skipReasonCounts: Record<string, number>;
  otherMessageCounts: Record<string, number>;
}

export interface CompactStatus {
  running: boolean;
  mode?: Mode;
  effectiveModes?: EffectiveModes;
  startedAtMs?: number;
  uptimeSeconds?: number;
  lastError?: string;
  snapshotError?: string;
  liveReady: boolean;
  dailySpendUsd: number;
  dailySpendLimitUsd?: number;
  markets: CompactMarket[];
  // Post-reset PnL: only trades since each mode's last P&L reset (see `pnlResetAtMs`).
  pnlByMode: { sim: CompactPnl; live: CompactPnl };
  // Lifetime PnL across all trades, ignoring the P&L reset.
  pnlHistoricalByMode: { sim: CompactPnl; live: CompactPnl };
  // When each mode's P&L was last reset (epoch ms); omitted = never reset.
  pnlResetAtMs: PnlResetAtMsByMode;
  riskHalt?: RiskHaltStatus;
  /**
   * Salud del bucle (ventana movil) y capital efectivo. Estaban solo en la UI web, asi que ni la TUI
   * ni los agentes que leen este resumen podian ver que el bot llevaba horas fallando iteraciones o
   * que el saldo no se estaba pudiendo leer — justo las dos cosas que explican "por que no opera"
   * cuando los motivos de skip no lo explican.
   */
  loopHealth?: { iterations: number; failed: number; failedPct: number; lagMaxMs?: number };
  bankroll?: { usd: number; source: "onchain" | "declared" | "unknown"; atMs?: number };
  /** Decisiones del autoajuste con su prediccion y lo realmente entregado. */
  bandPrograms?: BandProgram[];
  /**
   * La ultima pasada del maker. Estaba solo en la API: ni la TUI ni la web ni los agentes lo veian.
   *
   * Con el maker como unica estrategia esto es LO que hay que mirar, y ademas es lo unico que puede
   * enseñar la seleccion adversa mientras ocurre. El maker no escribe trades, asi que su actividad no
   * sale por ninguna de las vias por las que se ve el resto del bot: sin esto, dinero real en el libro
   * y un maker parado se ven exactamente igual.
   */
  makerSummary?: UiStatus["makerSummary"];
  recentActivity: RecentActivity;
}

/**
 * Project the full UiStatus (which can be ~150 KB, dominated by raw logs and market ticks/quotes)
 * into a small, decision-relevant snapshot for AI agents. Drops raw logs/ticks/quotes and folds the
 * recent skip reasons into a structured "why isn't it trading" summary.
 */
export function summarizeStatus(
  status: UiStatus,
  options: { logSampleSize?: number; nowMs?: number } = {},
): CompactStatus {
  const nowMs = options.nowMs ?? Date.now();
  const sampleSize = options.logSampleSize ?? DEFAULT_LOG_SAMPLE;

  return {
    running: status.running,
    mode: status.mode,
    // Modo REAL de cada estrategia. `mode` a secas es solo el de arranque y puede mentir: con el
    // arbitraje en live y el bot arrancado en sim, un agente que lea `mode` creeria que no hay dinero
    // en juego.
    effectiveModes: status.effectiveModes,
    startedAtMs: status.startedAtMs,
    uptimeSeconds:
      status.startedAtMs !== undefined ? Math.max(0, Math.round((nowMs - status.startedAtMs) / 1000)) : undefined,
    lastError: status.lastError,
    snapshotError: status.snapshotError,
    liveReady: status.liveReadiness?.ready ?? false,
    dailySpendUsd: round(status.dailySpendUsd) ?? 0,
    dailySpendLimitUsd: status.config?.dailySpendLimitUsd,
    markets: (status.markets ?? []).map((market) => ({
      marketSymbol: market.marketSymbol,
      duration: market.market?.slug ? windowDurationFromSlug(market.market.slug) : undefined,
      reason: market.signal.reason,
      inEntryWindow: market.signal.inEntryWindow,
      secondsToEnd: round(market.signal.secondsToEnd),
      outcome: market.signal.outcome,
      distanceUsd: round(market.signal.distanceUsd),
      tickValue: market.tick?.value,
      twapValue: market.twapTick?.value,
      upAsk: market.quotes?.UP?.bestAsk,
      downAsk: market.quotes?.DOWN?.bestAsk,
      upMid: market.quotes?.UP?.mid,
      downMid: market.quotes?.DOWN?.mid,
    })),
    pnlByMode: {
      sim: compactPnl(status.pnlByMode.sim),
      live: compactPnl(status.pnlByMode.live),
    },
    pnlHistoricalByMode: {
      sim: compactPnl(status.pnlHistoricalByMode.sim),
      live: compactPnl(status.pnlHistoricalByMode.live),
    },
    pnlResetAtMs: status.pnlResetAtMs ?? {},
    riskHalt: status.riskHalt,
    loopHealth: status.loopHealth,
    bankroll: status.bankroll,
    bandPrograms: status.bandPrograms,
    makerSummary: status.makerSummary,
    recentActivity: summarizeLogs(status.logs ?? [], sampleSize),
  };
}

/** Group the most recent log entries by skip reason (structured "why not trading"). */
export function summarizeLogs(logs: LogEntry[], sampleSize = DEFAULT_LOG_SAMPLE): RecentActivity {
  // UiStatus logs come newest-first, so the head is the most recent slice.
  const sample = logs.slice(0, Math.max(0, sampleSize));
  const skipReasonCounts: Record<string, number> = {};
  const otherMessageCounts: Record<string, number> = {};

  for (const entry of sample) {
    const reason = extractReason(entry);
    if (entry.message === "Skipped trade." && reason) {
      skipReasonCounts[reason] = (skipReasonCounts[reason] ?? 0) + 1;
    } else {
      otherMessageCounts[entry.message] = (otherMessageCounts[entry.message] ?? 0) + 1;
    }
  }

  return {
    sampleSize: sample.length,
    toAt: sample[0]?.at,
    fromAt: sample[sample.length - 1]?.at,
    skipReasonCounts,
    otherMessageCounts,
  };
}

function extractReason(entry: LogEntry): string | undefined {
  if (entry.meta && typeof entry.meta === "object") {
    const reason = (entry.meta as { reason?: unknown }).reason;
    if (typeof reason === "string") {
      return reason;
    }
  }
  return undefined;
}

function compactPnl(pnl: PnlSummary): CompactPnl {
  return {
    realizedUsd: round(pnl.realizedUsd) ?? 0,
    roiPct: pnl.roiPct,
    resolvedCount: pnl.resolvedCount,
    wonCount: pnl.wonCount,
    lostCount: pnl.lostCount,
    pendingCount: pnl.pendingCount,
  };
}

function round(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) ? Math.round(value * 100) / 100 : undefined;
}

export interface CompactTrade {
  id: string;
  market?: MarketSymbol;
  mode: Mode;
  /** "arb" = complete-set arbitrage: redeems $1/set regardless of the winner, so it is never a loss. */
  kind?: TradeAttempt["kind"];
  /**
   * Solo un par COMPLETO carece de riesgo direccional. Sin esta bandera una pata suelta se contaria
   * como arbitraje, que es exactamente al reves de donde esta el riesgo.
   */
  arbPairComplete?: boolean;
  outcome: Outcome;
  amountUsd: number;
  bestAsk?: number;
  distanceUsd?: number;
  entryWindowSeconds?: number;
  createdAtMs: number;
  resolved?: { won: boolean; winningOutcome: Outcome };
  /**
   * Se vendio ENTERA antes de que el mercado resolviera.
   *
   * Bandera propia y no derivable de `resolved`: una salida total no lo tiene, asi que sin esto las
   * pantallas que leen este resumen la pintaban "pendiente" pese a estar cerrada y cobrada.
   */
  exited?: boolean;
  netUsd?: number;
  // Slim view of the EV that gated the entry (full snapshot omitted).
  ev?: { edge?: number; expectedRoi?: number; adjustedWinProbability?: number; tradeCount: number };
}

/** Project a full TradeAttempt (with its ~20-field EV snapshot and long token/condition ids) into a
 * small agent-friendly record. */
export function summarizeTrade(trade: TradeAttempt): CompactTrade {
  const pnl = calculateTradePnl(trade);
  const ev = trade.expectedValue;
  return {
    id: trade.id,
    market: trade.asset,
    mode: trade.mode,
    kind: trade.kind,
    arbPairComplete: trade.arbPairComplete,
    outcome: trade.outcome,
    amountUsd: trade.amountUsd,
    bestAsk: trade.bestAsk,
    distanceUsd: round(trade.distanceUsd),
    entryWindowSeconds: trade.entryWindowSeconds,
    createdAtMs: trade.createdAtMs,
    resolved: trade.resolved
      ? { won: trade.resolved.won, winningOutcome: trade.resolved.winningOutcome }
      : undefined,
    exited: esSalidaTotal(trade) ? true : undefined,
    netUsd: round(pnl.netUsd),
    ev: ev
      ? {
          edge: round(ev.edge),
          expectedRoi: round(ev.expectedRoi),
          adjustedWinProbability: round(ev.adjustedWinProbability),
          tradeCount: ev.tradeCount,
        }
      : undefined,
  };
}

export interface CompactStrategy {
  market: MarketSymbol;
  outcome: Outcome;
  entryWindowSeconds: number;
  minDistanceUsd: number;
  maxAskPrice: number;
  isCurrent: boolean;
  confidence: string;
  qualityScore: number;
  evRoi?: number;
  winRate?: number;
  tradeCount: number;
  quoteCoverage?: number;
  edge?: number;
  passesRecommendedEntry?: boolean;
  riskFlags: string[];
}

function summarizeStrategy(candidate: StrategyCandidate): CompactStrategy {
  const m = candidate.metrics;
  return {
    market: candidate.market,
    outcome: candidate.outcome,
    entryWindowSeconds: candidate.entryWindowSeconds,
    minDistanceUsd: candidate.minDistanceUsd,
    maxAskPrice: candidate.maxAskPrice,
    isCurrent: candidate.isCurrent,
    confidence: candidate.confidence,
    qualityScore: round(candidate.qualityScore) ?? 0,
    evRoi: round(m.evRoi),
    winRate: round(m.winRate),
    tradeCount: m.tradeCount,
    quoteCoverage: round(m.quoteCoverage),
    edge: round(m.edge),
    passesRecommendedEntry: m.passesRecommendedEntry,
    riskFlags: candidate.riskFlags,
  };
}

/** Compact the ~200 KB strategy analysis into the summary plus the top-N ranked strategies and the
 * current per-market strategies, projected to decision-relevant fields. */
export function summarizeStrategyAnalysis(
  response: StrategyAnalysisResponse,
  limit = DEFAULT_STRATEGY_LIMIT,
): {
  generatedAtMs: number;
  summary: StrategyAnalysisResponse["summary"];
  topStrategies: CompactStrategy[];
  currentStrategies: CompactStrategy[];
} {
  const top = Math.max(1, limit);
  return {
    generatedAtMs: response.generatedAtMs,
    summary: response.summary,
    topStrategies: response.strategies.slice(0, top).map(summarizeStrategy),
    currentStrategies: response.currentStrategies.map(summarizeStrategy),
  };
}

export interface PnlKindSplit {
  arb: { netUsd: number; count: number };
  dir: { netUsd: number; count: number };
}

/** Operaciones acordadas antes de juzgar una tanda. Mismo numero que usa la UI web. */
export const VALIDATION_TARGET_TRADES = 50;

/**
 * Neto y numero de operaciones separando arbitraje de direccional, post-reset.
 *
 * Es EL numero de la estrategia arb-first: el total mezclado no dice cual de las dos genera el dinero.
 * Vivia solo en la UI web; la TUI y los agentes veian un unico total.
 *
 * La clasificacion la decide `isCompleteArbPair`, la misma funcion que usa el calculo de P&L, para que
 * las dos superficies no puedan discrepar sobre que cuenta como arbitraje.
 *
 * Una operacion cuenta cuando esta CERRADA, y cerrar tiene dos formas: resolver en el mercado o
 * venderse entera antes. La segunda solo existe en el direccional —un par completo se redime, no se
 * vende— asi que la salida se admite unicamente en ese cubo y el contador de validacion del arbitraje
 * queda exactamente como estaba: es el numero del go/no-go y no debe moverse por esto.
 */
export function splitCompactPnlByKind(
  trades: readonly CompactTrade[],
  mode: Mode,
  resetAtMsByMode: PnlResetAtMsByMode = {},
): PnlKindSplit {
  const split: PnlKindSplit = { arb: { netUsd: 0, count: 0 }, dir: { netUsd: 0, count: 0 } };
  const resetAtMs = resetAtMsByMode[mode];
  for (const trade of trades) {
    if (trade.mode !== mode) {
      continue;
    }
    if (resetAtMs !== undefined && trade.createdAtMs <= resetAtMs) {
      continue;
    }
    const esArb = isCompleteArbPair(trade);
    if (!trade.resolved && !(!esArb && trade.exited === true)) {
      continue;
    }
    const bucket = esArb ? split.arb : split.dir;
    bucket.netUsd += trade.netUsd ?? 0;
    bucket.count += 1;
  }
  return split;
}

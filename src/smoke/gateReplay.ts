/**
 * Replay del gate completo sobre TODAS las ventanas observadas, walk-forward.
 *
 * La via rapida para evaluar una configuracion: en vez de esperar dias a que el sim acumule 50
 * operaciones, replica el gate sobre las ~20k ventanas ya registradas y devuelve cientos de trades
 * simulados al instante, sobre datos de mercado reales.
 *
 * Sin look-ahead: en cada ventana la probabilidad y el mapa de calibracion se construyen SOLO con
 * ventanas anteriores. El gate replicado es el de produccion: shrinkage anclado al ask, calibracion
 * por mercado, ventana de ask [piso, techo], margen de seguridad, ROI minimo consciente de fees y
 * rechazo de la confianza implausible.
 *
 * Limitacion honesta: asume llenado al ask cotizado (sin slippage ni fills parciales). Eso se valido
 * aparte contra el live real y salio favorable (slippage medio -0.029, 6/30 peores, 3/30 parciales),
 * asi que para comparar CONFIGURACIONES entre si el sesgo es comun a todas y se cancela.
 */
import { buildCalibrationMap, applyCalibration, type CalibrationSample } from "../calibration.js";
import { calculateTradeFeeUsd, defaultTakerFeeRateBps } from "../fees.js";
import { calculateAdjustedWinProbability } from "../expectedValue.js";
import { StrategyAnalysisEngine } from "../strategyAnalysisEngine.js";
import type { MarketSymbol, Outcome } from "../types.js";

const SAFETY_MARGIN = 0.03;
const MIN_EXPECTED_ROI = 0.01;
const STAKE_USD = 5;
const REJECT_EDGE_ABOVE = 0.2;
const MARKETS: MarketSymbol[] = ["BTC", "ETH", "DOGE"];
const OUTCOMES: Outcome[] = ["UP", "DOWN"];

interface MarketConfig {
  entryWindowSeconds: number;
  minDistanceUsd: number;
  minAsk: number;
  maxAsk: number;
}
type Config = Record<MarketSymbol, MarketConfig>;

/** La configuracion CONGELADA que corre ahora (autoajustes apagados el 2026-08-01). */
const FROZEN: Config = {
  BTC: { entryWindowSeconds: 53, minDistanceUsd: 20, minAsk: 0.35, maxAsk: 0.6 },
  ETH: { entryWindowSeconds: 25, minDistanceUsd: 0.25, minAsk: 0.4, maxAsk: 0.6 },
  DOGE: { entryWindowSeconds: 120, minDistanceUsd: 0.00005, minAsk: 0.01, maxAsk: 0.65 },
};

function withEth(base: Config, patch: Partial<MarketConfig>): Config {
  return { ...base, ETH: { ...base.ETH, ...patch } };
}
function withBtc(base: Config, patch: Partial<MarketConfig>): Config {
  return { ...base, BTC: { ...base.BTC, ...patch } };
}

interface Result {
  trades: number;
  wins: number;
  netUsd: number;
  stakeUsd: number;
  predictedSum: number;
  perMarket: Map<MarketSymbol, { trades: number; wins: number; net: number }>;
  rows: { p: number; won: boolean }[];
}

async function replay(engine: StrategyAnalysisEngine, config: Config, rejectEdgeAbove?: number, strictQuotes = false): Promise<Result> {
  const out: Result = {
    trades: 0,
    wins: 0,
    netUsd: 0,
    stakeUsd: 0,
    predictedSum: 0,
    perMarket: new Map(),
    rows: [],
  };

  for (const market of MARKETS) {
    const cfg = config[market];
    const feeRateBps = defaultTakerFeeRateBps(market);
    // Une ambos lados y ordena por tiempo: la calibracion del mercado aprende de UP y DOWN a la vez,
    // igual que en produccion.
    const signals: { predicted: number; won: boolean; ask: number; windowStartMs: number }[] = [];
    for (const outcome of OUTCOMES) {
      signals.push(
        ...(await engine.replaySignals(
          market,
          outcome,
          { entryWindowSeconds: cfg.entryWindowSeconds, minDistanceUsd: cfg.minDistanceUsd },
          strictQuotes,
        )),
      );
    }
    signals.sort((left, right) => left.windowStartMs - right.windowStartMs);

    const history: CalibrationSample[] = [];
    // El historial que alimenta la estimacion se restringe a la VENTANA DE ASK configurada, igual que
    // produccion (estimateSetupWinRate filtra por ask <= cap). Sin este filtro entran las ventanas
    // carisimas (0.9+), que casi siempre ganan, y la probabilidad estimada se dispara a ~91%: todo
    // declararia un edge enorme y el rechazo de >0.20 tumbaria absolutamente todo.
    let priorWins = 0;
    let priorTrades = 0;
    const stats = out.perMarket.get(market) ?? { trades: 0, wins: 0, net: 0 };
    for (const signal of signals) {
      const { ask, won } = signal;
      if (ask < cfg.minAsk || ask > cfg.maxAsk) {
        continue;
      }
      if (priorTrades === 0) {
        priorTrades += 1;
        priorWins += won ? 1 : 0;
        continue;
      }
      const predicted = calculateAdjustedWinProbability(priorWins, priorTrades, ask);
      const adjusted = applyCalibration(buildCalibrationMap(history), predicted);
      const edge = adjusted - ask;
      const expectedRoi = adjusted / ask - 1;
      const feeFraction = (feeRateBps / 10_000) * (1 - ask);
      const passes =
        adjusted >= ask + SAFETY_MARGIN &&
        expectedRoi >= MIN_EXPECTED_ROI + feeFraction &&
        !(rejectEdgeAbove !== undefined && edge > rejectEdgeAbove);

      if (passes) {
        const shares = STAKE_USD / ask;
        const fee = calculateTradeFeeUsd({ shares, price: ask, feeRateBps });
        const net = (won ? shares : 0) - STAKE_USD - fee;
        out.trades += 1;
        out.stakeUsd += STAKE_USD + fee;
        out.netUsd += net;
        out.predictedSum += adjusted;
        if (won) out.wins += 1;
        out.rows.push({ p: adjusted, won });
        stats.trades += 1;
        stats.net += net;
        if (won) stats.wins += 1;
      }
      history.push({ predicted, won });
      priorTrades += 1;
      priorWins += won ? 1 : 0;
    }
    out.perMarket.set(market, stats);
  }
  return out;
}

function discrimination(rows: { p: number; won: boolean }[]): string {
  if (rows.length < 10) return `n=${rows.length}`;
  const sorted = [...rows].sort((a, b) => a.p - b.p);
  const half = Math.floor(sorted.length / 2);
  const lo = sorted.slice(0, half).filter((x) => x.won).length / half;
  const hi = sorted.slice(sorted.length - half).filter((x) => x.won).length / half;
  const d = (hi - lo) * 100;
  return `${d >= 0 ? "+" : ""}${d.toFixed(1)}pp`;
}

function line(name: string, r: Result): string {
  const roi = r.stakeUsd > 0 ? (100 * r.netUsd) / r.stakeUsd : 0;
  const win = r.trades > 0 ? (100 * r.wins) / r.trades : 0;
  const pred = r.trades > 0 ? (100 * r.predictedSum) / r.trades : 0;
  const gap = win - pred;
  const perMk = MARKETS.map((m) => {
    const s = r.perMarket.get(m);
    return s && s.trades ? `${m} ${s.trades}/$${s.net.toFixed(0)}` : `${m} -`;
  }).join(" ");
  return `${name.padEnd(30)} n=${String(r.trades).padStart(4)} net=$${r.netUsd.toFixed(2).padStart(9)} ROI=${roi.toFixed(1).padStart(6)}% win=${win.toFixed(1).padStart(5)}% brecha=${(gap >= 0 ? "+" : "") + gap.toFixed(1)}pp disc=${discrimination(r.rows).padStart(7)} | ${perMk}`;
}

async function main(): Promise<void> {
  const engine = new StrategyAnalysisEngine("data");
  console.log("PRUEBA: de donde sale el optimismo del replay");
  console.log("Referencia REAL del bot: sim ~51% de aciertos, live ~36%");
  console.log("");
  const casos: [string, boolean][] = [
    ["quote mas CERCANO (puede ser posterior)", false],
    ["quote SOLO en o antes de la senal", true],
  ];
  for (const [name, strict] of casos) {
    console.log(line(name, await replay(engine, FROZEN, undefined, strict)));
  }
}

await main();

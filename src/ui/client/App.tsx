import {
  AlertTriangle,
  ArrowDownNarrowWide,
  ArrowUpDown,
  ArrowUpNarrowWide,
  Bell,
  Brain,
  CheckCircle2,
  Download,
  DollarSign,
  Gauge,
  Moon,
  Pause,
  Play,
  Radio,
  RefreshCw,
  RotateCcw,
  Save,
  Send,
  Settings,
  ShieldAlert,
  Square,
  Sun,
  Table2,
  Terminal,
  Trash2,
  TrendingDown,
  TrendingUp,
  Upload,
} from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";

import type { LogEntry } from "../../logger.js";
import { summarizeLogs } from "../../agent/statusSummary.js";
import { calculateTradePnl, type PnlSummary, type TradePnl } from "../../pnl.js";
import { hasResolvablePosition } from "../../tradeResolution.js";
import type {
  MarketSymbol,
  Mode,
  OllamaTradeAnalysisResponse,
  Outcome,
  StrategyAnalysisResponse,
  StrategyCandidate,
  StrategyConfidence,
  StrategyRiskFlag,
  TradeAttempt,
} from "../../types.js";
import type {
  AnalysisImportResponse,
  MarketStatusSnapshot,
  StartBotRequest,
  TelegramNotificationPatch,
  TelegramNotificationSettings,
  UiSettings,
  UiStatus,
} from "../shared.js";

type Tab = "dashboard" | "trades" | "analysis" | "settings" | "telegram" | "logs";
type Theme = "light" | "dark";
type TradeMarketFilter = "ALL" | MarketSymbol;
type TradePnlFilter = "ALL" | "POSITIVE" | "NEGATIVE";
type TradeSortKey = "createdAtMs" | "entryWindowSeconds" | "stakeUsd" | "bestAsk" | "distanceUsd" | "payoutUsd" | "netUsd";
type TradeSortDirection = "asc" | "desc";
type StrategySortKey =
  | "evRoi"
  | "expectedRoi"
  | "expectedValueUsd"
  | "edge"
  | "averageAsk"
  | "realWinProbability"
  | "adjustedWinProbability"
  | "tradeCount"
  | "winRate"
  | "quoteCoverage"
  | "entryWindowSeconds"
  | "minDistanceUsd"
  | "maxAskPrice"
  | "maxDrawdown";
type StrategySortDirection = "asc" | "desc";
type StrategyQualityFilter = "RELIABLE" | "ALL" | "POSITIVE" | "CURRENT";
type OutcomeFilter = "ALL" | Outcome;
type AutoAdjustSettingKey = "autoAdjustLiveByMarketOutcome" | "autoAdjustAfterLossByMarketOutcome";

interface TradeSortState {
  key: TradeSortKey;
  direction: TradeSortDirection;
}

interface TradeAverages {
  entryWindowSeconds?: number;
  stakeUsd?: number;
  bestAsk?: number;
  distanceUsd?: number;
  payoutUsd?: number;
  netUsd?: number;
}

interface StrategySortState {
  key: StrategySortKey;
  direction: StrategySortDirection;
}

interface OllamaHistoryEntry {
  id: string;
  prompt: string;
  result: OllamaTradeAnalysisResponse;
}

interface StrategySettingsPreviewItem {
  label: string;
  current: string;
  next: string;
  changed: boolean;
}

const themeStorageKey = "polybot-theme";
const ollamaHistoryStorageKey = "polybot-ollama-history";
const analysisAutoRefreshMs = 60_000;

const emptySettings: UiSettings = {
  minBtcDistanceUsd: 20,
  enabledMarkets: ["BTC"],
  enabledMarketOutcomes: {
    BTC: { UP: true, DOWN: true },
    ETH: { UP: false, DOWN: false },
    DOGE: { UP: false, DOWN: false },
  },
  minDistanceUsdByMarket: {
    BTC: 20,
    ETH: 5,
    DOGE: 0.0005,
  },
  minDistanceUsdByMarketOutcome: {
    BTC: { UP: 20, DOWN: 20 },
    ETH: { UP: 5, DOWN: 5 },
    DOGE: { UP: 0.0005, DOWN: 0.0005 },
  },
  entryWindowSeconds: 20,
  entryWindowSecondsByMarket: {
    BTC: 20,
    ETH: 20,
    DOGE: 20,
  },
  entryWindowSecondsByMarketOutcome: {
    BTC: { UP: 20, DOWN: 20 },
    ETH: { UP: 20, DOWN: 20 },
    DOGE: { UP: 20, DOWN: 20 },
  },
  simTradeAmountUsd: 1,
  simTradeAmountUsdByMarketOutcome: {
    BTC: { UP: 1, DOWN: 1 },
    ETH: { UP: 1, DOWN: 1 },
    DOGE: { UP: 1, DOWN: 1 },
  },
  liveTradeAmountUsd: 1,
  liveTradeAmountUsdByMarketOutcome: {
    BTC: { UP: 1, DOWN: 1 },
    ETH: { UP: 1, DOWN: 1 },
    DOGE: { UP: 1, DOWN: 1 },
  },
  autoMinLive: true,
  autoAdjustLiveByMarketOutcome: {
    BTC: { UP: false, DOWN: false },
    ETH: { UP: false, DOWN: false },
    DOGE: { UP: false, DOWN: false },
  },
  autoAdjustAfterLossByMarketOutcome: {
    BTC: { UP: false, DOWN: false },
    ETH: { UP: false, DOWN: false },
    DOGE: { UP: false, DOWN: false },
  },
  maxAskPrice: 0.98,
  maxAskPriceByMarketOutcome: {
    BTC: { UP: 0.98, DOWN: 0.98 },
    ETH: { UP: 0.98, DOWN: 0.98 },
    DOGE: { UP: 0.98, DOWN: 0.98 },
  },
  maxAskPriceCeiling: 0.85,
  dailySpendLimitUsd: 50,
  maxDailyLossUsd: 0,
  maxConsecutiveLosses: 0,
  requirePositiveEv: true,
  evSafetyMargin: 0.03,
  evMinHistoryTrades: 10,
  evMinExpectedRoi: 0.01,
  tickStaleMs: 10_000,
  pollIntervalMs: 1_000,
  openingCaptureGraceMs: 15_000,
  aiAutoApplyLive: false,
};

const marketOptions: Array<{ symbol: MarketSymbol; label: string; step: number; min: number }> = [
  { symbol: "BTC", label: "Bitcoin", step: 1, min: 1 },
  { symbol: "ETH", label: "Ethereum", step: 0.5, min: 0.1 },
  { symbol: "DOGE", label: "Dogecoin", step: 0.0001, min: 0.0001 },
];

const outcomeOptions: Outcome[] = ["UP", "DOWN"];

const ollamaPromptOptions = [
  {
    label: "Resumen",
    prompt: "Resume las mejores estrategias confiables usando ROI EV, EV live, edge y probabilidad ajustada. Indica que mercados/lados parecen mas prometedores.",
  },
  {
    label: "Riesgos",
    prompt: "Detecta riesgos de sobreajuste, baja cobertura, pocos trades, drawdown, asks 0.98/0.99 y edge insuficiente. Indica que no deberia usarse todavia.",
  },
  {
    label: "Actual vs mejor",
    prompt: "Compara las estrategias actuales contra las mejores confiables por mercado/lado usando P real, P ajustada, edge, ROI EV y EV live.",
  },
  {
    label: "Plan de prueba",
    prompt: "Prop\u00f3n un plan de prueba conservador para validar estas estrategias sin aumentar riesgo live, priorizando EV positivo y margen de seguridad.",
  },
];

export function App() {
  const [status, setStatus] = useState<UiStatus | null>(null);
  const [trades, setTrades] = useState<TradeAttempt[]>([]);
  const [settings, setSettings] = useState<UiSettings>(emptySettings);
  const [analysis, setAnalysis] = useState<StrategyAnalysisResponse | null>(null);
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [analysisStale, setAnalysisStale] = useState(true);
  const [tab, setTab] = useState<Tab>("dashboard");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [liveModal, setLiveModal] = useState(false);
  const [resetModal, setResetModal] = useState(false);
  const [theme, setTheme] = useState<Theme>(() => getInitialTheme());
  const analysisRequestId = useRef(0);
  const analysisLoadingRef = useRef(false);

  useEffect(() => {
    void refreshCore();
    const events = new EventSource("/api/events");
    let tradesRefreshTimer: number | undefined;
    let tradesRefreshInFlight = false;
    let tradesRefreshQueued = false;
    const scheduleTradesRefresh = () => {
      if (tradesRefreshTimer !== undefined) {
        return;
      }
      tradesRefreshTimer = window.setTimeout(() => {
        tradesRefreshTimer = undefined;
        if (tradesRefreshInFlight) {
          tradesRefreshQueued = true;
          return;
        }
        tradesRefreshInFlight = true;
        void loadTrades().finally(() => {
          tradesRefreshInFlight = false;
          if (tradesRefreshQueued) {
            tradesRefreshQueued = false;
            scheduleTradesRefresh();
          }
        });
      }, 500);
    };
    events.addEventListener("status", (event) => {
      const payload = JSON.parse((event as MessageEvent).data) as { status: UiStatus };
      setStatus(payload.status);
    });
    events.addEventListener("log", () => {
      scheduleTradesRefresh();
    });
    return () => {
      if (tradesRefreshTimer !== undefined) {
        window.clearTimeout(tradesRefreshTimer);
      }
      events.close();
    };
  }, []);

  useEffect(() => {
    if (tab === "analysis" && analysisStale && !analysisLoading) {
      void loadAnalysis();
    }
  }, [tab, analysisStale, analysisLoading]);

  useEffect(() => {
    if (tab !== "analysis" || !status?.running) {
      return undefined;
    }
    const timer = window.setInterval(() => {
      void loadAnalysis();
    }, analysisAutoRefreshMs);
    return () => window.clearInterval(timer);
  }, [tab, status?.running]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    try {
      window.localStorage.setItem(themeStorageKey, theme);
    } catch {
      // Local storage can be unavailable in hardened browser contexts.
    }
  }, [theme]);

  async function refreshCore() {
    setError(null);
    const [nextStatus, nextSettings, nextTrades] = await Promise.all([
      api<UiStatus>("/api/status"),
      api<UiSettings>("/api/settings"),
      api<{ trades: TradeAttempt[] }>("/api/trades?limit=100"),
    ]);
    setStatus(nextStatus);
    setSettings(nextSettings);
    setTrades(nextTrades.trades);
  }

  async function loadTrades() {
    const payload = await api<{ trades: TradeAttempt[] }>("/api/trades?limit=100");
    setTrades(payload.trades);
  }

  async function loadAnalysis() {
    if (analysisLoadingRef.current) {
      return;
    }
    analysisLoadingRef.current = true;
    const requestId = analysisRequestId.current + 1;
    analysisRequestId.current = requestId;
    setAnalysisLoading(true);
    setAnalysisError(null);
    try {
      const nextAnalysis = await api<StrategyAnalysisResponse>("/api/analysis/strategies");
      if (analysisRequestId.current === requestId) {
        setAnalysis(nextAnalysis);
        setAnalysisStale(false);
      }
    } catch (caught) {
      if (analysisRequestId.current === requestId) {
        setAnalysisError(caught instanceof Error ? caught.message : String(caught));
        setAnalysisStale(false);
      }
    } finally {
      analysisLoadingRef.current = false;
      if (analysisRequestId.current === requestId) {
        setAnalysisLoading(false);
      }
    }
  }

  async function startBot(request: StartBotRequest) {
    setBusy(true);
    setError(null);
    try {
      setStatus(await api<UiStatus>("/api/bot/start", { method: "POST", body: JSON.stringify(request) }));
      setLiveModal(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function stopBot() {
    setBusy(true);
    setError(null);
    try {
      setStatus(await api<UiStatus>("/api/bot/stop", { method: "POST" }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function saveSettings(next: UiSettings) {
    await persistSettings(next, false);
  }

  async function applyStrategyFromAnalysis(strategy: StrategyCandidate) {
    await persistSettings(applyStrategyToSettings(settings, strategy), true);
  }

  async function persistSettings(next: UiSettings, rethrow: boolean) {
    setBusy(true);
    setError(null);
    try {
      const saved = await api<UiSettings>("/api/settings", { method: "PATCH", body: JSON.stringify(next) });
      setSettings(saved);
      setAnalysisStale(true);
      await refreshCore();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      if (rethrow) {
        throw caught;
      }
    } finally {
      setBusy(false);
    }
  }

  async function requestOllamaAnalysis(prompt: string): Promise<OllamaTradeAnalysisResponse> {
    setBusy(true);
    setError(null);
    try {
      return await api<OllamaTradeAnalysisResponse>("/api/analysis/ollama", {
        method: "POST",
        body: JSON.stringify({ prompt }),
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      throw caught;
    } finally {
      setBusy(false);
    }
  }

  async function downloadAnalysisSamples(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/analysis/samples/export");
      if (!response.ok) {
        throw new Error(await responseErrorMessage(response));
      }
      const blob = await response.blob();
      const filename = analysisExportFilename(response.headers.get("Content-Disposition"));
      triggerFileDownload(blob, filename);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      throw caught;
    } finally {
      setBusy(false);
    }
  }

  async function importAnalysisSamples(file: File): Promise<AnalysisImportResponse> {
    setBusy(true);
    setError(null);
    try {
      const contents = await file.text();
      const result = await api<AnalysisImportResponse>("/api/analysis/samples/import", {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: contents,
      });
      setAnalysisStale(true);
      return result;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      throw caught;
    } finally {
      setBusy(false);
    }
  }

  async function resetPolybot() {
    setBusy(true);
    setError(null);
    try {
      setStatus(await api<UiStatus>("/api/bot/reset", { method: "POST" }));
      setTrades([]);
      setAnalysis(null);
      setAnalysisStale(true);
      setResetModal(false);
      await refreshCore();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function resetPnl(mode: Mode) {
    setBusy(true);
    setError(null);
    try {
      setStatus(await api<UiStatus>("/api/pnl/reset", { method: "POST", body: JSON.stringify({ mode }) }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <Radio size={24} aria-hidden="true" />
          <div>
            <strong>Polybot</strong>
            <span>Crypto 5m</span>
          </div>
        </div>
        <nav className="tabs" aria-label="Secciones">
          <TabButton active={tab === "dashboard"} icon={<Gauge size={18} />} label="Dashboard" onClick={() => setTab("dashboard")} />
          <TabButton active={tab === "trades"} icon={<Table2 size={18} />} label="Trades" onClick={() => setTab("trades")} />
          <TabButton active={tab === "analysis"} icon={<Brain size={18} />} label="Análisis" onClick={() => setTab("analysis")} />
          <TabButton active={tab === "settings"} icon={<Settings size={18} />} label="Settings" onClick={() => setTab("settings")} />
          <TabButton active={tab === "telegram"} icon={<Bell size={18} />} label="Telegram" onClick={() => setTab("telegram")} />
          <TabButton active={tab === "logs"} icon={<Terminal size={18} />} label="Logs" onClick={() => setTab("logs")} />
        </nav>
      </aside>

      <main className="main">
        <header className="topbar">
          <div>
            <p className="eyebrow">{activeMarketLine(status)}</p>
            <h1>Polybot Crypto Up/Down 5m</h1>
          </div>
          <div className="topbar-actions">
            <ThemeToggle
              theme={theme}
              onToggle={() => setTheme((current) => (current === "dark" ? "light" : "dark"))}
            />
            <ControlBar
              status={status}
              busy={busy}
              onStartSim={() => startBot({ mode: "sim" })}
              onOpenLive={() => setLiveModal(true)}
              onOpenReset={() => setResetModal(true)}
              onStop={stopBot}
              onRefresh={() => refreshCore()}
            />
          </div>
        </header>

        {error && <div className="notice error"><AlertTriangle size={18} />{error}</div>}

        {tab === "dashboard" && <Dashboard status={status} busy={busy} onResetPnl={resetPnl} />}
        {tab === "trades" && <TradesTable trades={trades} settings={settings} />}
        {tab === "analysis" && (
          <AnalysisPanel
            analysis={analysis}
            loading={analysisLoading}
            loadError={analysisError}
            stale={analysisStale}
            settings={settings}
            busy={busy}
            running={Boolean(status?.running)}
            onRefresh={loadAnalysis}
            onAnalyze={requestOllamaAnalysis}
            onApplyStrategy={applyStrategyFromAnalysis}
            onExport={downloadAnalysisSamples}
            onImport={importAnalysisSamples}
          />
        )}
        {tab === "settings" && <SettingsPanel settings={settings} running={Boolean(status?.running)} busy={busy} onSave={saveSettings} />}
        {tab === "telegram" && <TelegramPanel />}
        {tab === "logs" && <LogsPanel logs={status?.logs ?? []} />}
      </main>

      {liveModal && (
        <LiveConfirmModal
          ready={Boolean(status?.liveReadiness.ready)}
          reason={status?.liveReadiness.reason}
          busy={busy}
          onCancel={() => setLiveModal(false)}
          onConfirm={() => startBot({ mode: "live", confirmLive: true })}
        />
      )}

      {resetModal && (
        <ResetConfirmModal
          running={Boolean(status?.running)}
          busy={busy}
          onCancel={() => setResetModal(false)}
          onConfirm={resetPolybot}
        />
      )}
    </div>
  );
}

function ThemeToggle({ theme, onToggle }: { theme: Theme; onToggle: () => void }) {
  const nextTheme = theme === "dark" ? "claro" : "oscuro";
  return (
    <button className="icon-button theme-toggle" title={`Cambiar a tema ${nextTheme}`} aria-label={`Cambiar a tema ${nextTheme}`} onClick={onToggle}>
      {theme === "dark" ? <Sun size={18} /> : <Moon size={18} />}
    </button>
  );
}

export function ControlBar(props: {
  status: UiStatus | null;
  busy: boolean;
  onStartSim: () => void;
  onOpenLive: () => void;
  onOpenReset: () => void;
  onStop: () => void;
  onRefresh: () => void;
}) {
  const running = Boolean(props.status?.running);
  const liveReady = Boolean(props.status?.liveReadiness.ready);
  return (
    <div className="controlbar">
      <button className="icon-button" title="Actualizar" onClick={props.onRefresh} disabled={props.busy}>
        <RefreshCw size={18} />
      </button>
      <button
        className="command reset"
        onClick={props.onOpenReset}
        disabled={props.busy}
        title={running ? "Detener y resetear estado local" : "Resetear estado local"}
      >
        <RotateCcw size={18} /> Reset
      </button>
      {!running ? (
        <>
          <button className="command primary" onClick={props.onStartSim} disabled={props.busy}>
            <Play size={18} /> Sim
          </button>
          <button className="command danger" onClick={props.onOpenLive} disabled={props.busy || !liveReady} title={liveReady ? "Live" : "Live bloqueado"}>
            <ShieldAlert size={18} /> Live
          </button>
        </>
      ) : (
        <button className="command stop" onClick={props.onStop} disabled={props.busy}>
          <Square size={18} /> Detener
        </button>
      )}
    </div>
  );
}

export function Dashboard({
  status,
  busy,
  onResetPnl,
}: {
  status: UiStatus | null;
  busy: boolean;
  onResetPnl: (mode: Mode) => void;
}) {
  const marketSnapshots = getMarketSnapshots(status);
  const [selectedPnlMode, setSelectedPnlMode] = useState<Mode>("sim");
  const selectedPnl = status?.pnlByMode?.[selectedPnlMode];
  const selectedPnlLabel = selectedPnlMode === "sim" ? "Sim" : "Live";
  const riskHalt = status?.riskHalt;
  const health = computeHealth(status);
  const skipReasonCounts = status?.logs ? summarizeLogs(status.logs, 80).skipReasonCounts : {};
  return (
    <>
      <HealthChips status={status} health={health} />
      {riskHalt?.tripped && (
        <div className="risk-banner" role="alert">
          <ShieldAlert size={20} aria-hidden="true" />
          <div className="risk-banner-body">
            <strong>Trading detenido — circuit breaker de riesgo</strong>
            <span>
              {riskHalt.reason === "daily_loss_limit"
                ? `Pérdida diaria ${formatUsd(riskHalt.dailyLossUsd)} alcanzó el límite.`
                : `${riskHalt.consecutiveLosses} pérdidas seguidas alcanzaron el límite.`}{" "}
              El bot sigue observando; reanuda el próximo día UTC.
            </span>
          </div>
        </div>
      )}
      <div className="dashboard-grid">
        <section className="panel hero-panel markets-panel">
          <div className="status-line">
            <span className={`status-dot ${status?.running ? "on" : "off"}`} />
            {status?.running ? `Corriendo ${status.mode?.toUpperCase()}` : "Detenido"}
          </div>
          <div className="market-card-grid">
            {marketSnapshots.map((market) => (
              <MarketCard snapshot={market} key={market.marketSymbol} />
            ))}
          </div>
        </section>

      <section className="panel pnl-panel">
        <div className="section-heading pnl-heading">
          <div className="section-title">
            <DollarSign size={18} />
            <h2>P&L</h2>
          </div>
          <div className="segmented-control pnl-mode-toggle" role="group" aria-label="Modo de P&L">
            <button
              aria-label="Ver P&L sim"
              className={`segment-button ${selectedPnlMode === "sim" ? "active" : ""}`}
              onClick={() => setSelectedPnlMode("sim")}
            >
              Sim
            </button>
            <button
              aria-label="Ver P&L live"
              className={`segment-button ${selectedPnlMode === "live" ? "active" : ""}`}
              onClick={() => setSelectedPnlMode("live")}
            >
              Live
            </button>
          </div>
        </div>
        <PnlModeSummary
          label={selectedPnlLabel}
          summary={selectedPnl}
          busy={busy}
          onReset={() => onResetPnl(selectedPnlMode)}
        />
      </section>

      <section className="panel limits-panel">
        <div className="section-heading">
          <Pause size={18} />
          <h2>Riesgo</h2>
        </div>
        <div className="hero-metrics compact">
          <Metric label="Gasto diario" value={formatUsd(status?.dailySpendUsd)} />
          <Metric label="Limite gasto" value={formatUsd(status?.settings.dailySpendLimitUsd)} />
          <Metric label="Ask cap" value={formatOutcomeSettingRange(status?.settings.maxAskPriceByMarketOutcome, formatPrice)} />
          <Metric
            label="Perdida hoy"
            value={formatUsd(riskHalt?.dailyLossUsd ?? 0)}
            tone={riskHalt?.reason === "daily_loss_limit" ? "negative" : "neutral"}
          />
          <Metric
            label="Limite perdida"
            value={status?.settings.maxDailyLossUsd ? formatUsd(status.settings.maxDailyLossUsd) : "Off"}
          />
          <Metric
            label="Perdidas seguidas"
            value={
              status?.settings.maxConsecutiveLosses
                ? `${riskHalt?.consecutiveLosses ?? 0} / ${status.settings.maxConsecutiveLosses}`
                : `${riskHalt?.consecutiveLosses ?? 0}`
            }
            tone={riskHalt?.reason === "consecutive_losses" ? "negative" : "neutral"}
          />
        </div>
      </section>

      <WhyNotTradingPanel skipReasonCounts={skipReasonCounts} running={Boolean(status?.running)} />
      </div>
    </>
  );
}

const SKIP_REASON_LABELS: Record<string, string> = {
  btc_distance_below_threshold: "Distancia insuficiente",
  no_ask_liquidity_under_cap: "Sin liquidez bajo el cap",
  best_ask_above_cap: "Ask por encima del cap",
  expected_value_gate_failed: "EV no supera el umbral",
  expected_value_history_not_found: "Historia insuficiente (EV)",
  missing_opening_chainlink_tick: "Sin apertura (feed)",
  missing_current_chainlink_tick: "Sin tick actual (feed)",
  stale_chainlink_tick: "Tick viejo (feed)",
  market_already_traded: "Ya operado",
  market_not_accepting_orders: "Mercado cerrado",
  daily_spend_limit_reached: "Limite de gasto",
  risk_circuit_breaker: "Circuit breaker de riesgo",
  outcome_disabled: "Lado desactivado",
  orderbook_quote_failed: "Fallo al pedir orderbook",
};

function humanSkipReason(reason: string): string {
  return SKIP_REASON_LABELS[reason] ?? reason;
}

function WhyNotTradingPanel({
  skipReasonCounts,
  running,
}: {
  skipReasonCounts: Record<string, number>;
  running: boolean;
}) {
  const rows = Object.entries(skipReasonCounts).sort((left, right) => right[1] - left[1]);
  return (
    <section className="panel why-panel">
      <div className="section-heading">
        <AlertTriangle size={18} />
        <h2>Por que no opera</h2>
      </div>
      {rows.length === 0 ? (
        <p className="settings-hint">{running ? "Sin skips recientes." : "El bot esta detenido."}</p>
      ) : (
        <ul className="why-list">
          {rows.map(([reason, count]) => (
            <li key={reason} className="why-row" title={reason}>
              <span className="why-reason">{humanSkipReason(reason)}</span>
              <span className="why-count">{count}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

interface BotHealth {
  feedOk: boolean;
  lastTickAgoSec?: number;
  uptimeSec?: number;
}

function computeHealth(status: UiStatus | null): BotHealth {
  const markets = status?.markets ?? [];
  const tickTimestamps = markets
    .map((market) => market.tick?.timestampMs)
    .filter((value): value is number => typeof value === "number");
  const lastTickMs = tickTimestamps.length > 0 ? Math.max(...tickTimestamps) : undefined;
  const lastTickAgoSec = lastTickMs !== undefined ? Math.max(0, Math.round((Date.now() - lastTickMs) / 1000)) : undefined;
  const feedDegraded =
    markets.some((market) =>
      ["missing_opening_chainlink_tick", "missing_current_chainlink_tick", "stale_chainlink_tick"].includes(
        market.signal.reason,
      ),
    ) || (lastTickAgoSec !== undefined && lastTickAgoSec > 30);
  return {
    feedOk: !feedDegraded && lastTickMs !== undefined,
    lastTickAgoSec,
    uptimeSec: status?.startedAtMs !== undefined ? Math.max(0, Math.round((Date.now() - status.startedAtMs) / 1000)) : undefined,
  };
}

function formatDuration(seconds?: number): string {
  if (seconds === undefined) {
    return "--";
  }
  if (seconds < 60) {
    return `${seconds}s`;
  }
  if (seconds < 3600) {
    return `${Math.floor(seconds / 60)}m`;
  }
  return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

function HealthChips({ status, health }: { status: UiStatus | null; health: BotHealth }) {
  const running = Boolean(status?.running);
  return (
    <div className="health-chips" role="group" aria-label="Salud del bot">
      <span className={`chip ${running ? "chip-on" : "chip-off"}`} title="Estado del bot">
        {running ? <Play size={14} /> : <Square size={14} />}
        {running ? `Corriendo ${status?.mode?.toUpperCase()}` : "Detenido"}
      </span>
      <span className={`chip ${health.feedOk ? "chip-on" : "chip-warn"}`} title="Estado del feed de precios">
        <Radio size={14} />
        {health.feedOk ? "Feed OK" : "Feed degradado"}
      </span>
      <span className="chip chip-neutral" title="Antiguedad del ultimo tick de precio">
        Tick {health.lastTickAgoSec !== undefined ? `hace ${health.lastTickAgoSec}s` : "--"}
      </span>
      <span className="chip chip-neutral" title="Tiempo corriendo">
        Uptime {formatDuration(health.uptimeSec)}
      </span>
      <span
        className={`chip ${status?.settings.aiAutoApplyLive ? "chip-on" : "chip-neutral"}`}
        title="Autoajuste predictivo en tiempo real"
      >
        <Brain size={14} />
        Autoajuste {status?.settings.aiAutoApplyLive ? "on" : "off"}
      </span>
    </div>
  );
}

function MarketCard({ snapshot }: { snapshot: MarketStatusSnapshot }) {
  const upDistance = snapshot.opening && snapshot.tick ? snapshot.tick.value - snapshot.opening.openingPrice : undefined;
  const downDistance = snapshot.opening && snapshot.tick ? snapshot.opening.openingPrice - snapshot.tick.value : undefined;
  const countdown = snapshot.signal.secondsToEnd;
  return (
    <article className="market-card">
      <div className="market-card-header">
        <div>
          <strong>{snapshot.marketSymbol}</strong>
          <span>{snapshot.market?.slug ?? "sin mercado"}</span>
        </div>
        <div className={`signal-badge compact ${snapshot.signal.reason === "signal_ready" ? "ready" : "idle"}`}>
          {reasonLabel(snapshot.signal.reason)}
        </div>
      </div>
      <div className="hero-metrics market-metrics">
        <Metric label="Precio" value={formatMarketUsd(snapshot.tick?.value, snapshot.marketSymbol)} />
        <Metric label="Apertura" value={formatMarketUsd(snapshot.opening?.openingPrice, snapshot.marketSymbol)} />
        <Metric label="Cierre" value={countdown === undefined ? "--" : `${Math.max(0, countdown).toFixed(1)}s`} />
      </div>
      <div className="split-metrics">
        <Metric icon={<TrendingUp size={18} />} label="UP" value={formatMarketDistance(upDistance, snapshot.marketSymbol)} />
        <Metric icon={<TrendingDown size={18} />} label="DOWN" value={formatMarketDistance(downDistance, snapshot.marketSymbol)} />
      </div>
      <div className="quote-rows">
        <QuoteRow side="UP" ask={snapshot.quotes?.UP?.bestAsk} bid={snapshot.quotes?.UP?.bestBid} />
        <QuoteRow side="DOWN" ask={snapshot.quotes?.DOWN?.bestAsk} bid={snapshot.quotes?.DOWN?.bestBid} />
      </div>
    </article>
  );
}

export function AnalysisPanel({
  analysis,
  loading = false,
  loadError = null,
  stale = false,
  settings,
  busy,
  running,
  onRefresh,
  onAnalyze,
  onApplyStrategy,
  onExport,
  onImport,
}: {
  analysis: StrategyAnalysisResponse | null;
  loading?: boolean;
  loadError?: string | null;
  stale?: boolean;
  settings: UiSettings;
  busy: boolean;
  running: boolean;
  onRefresh: () => Promise<void>;
  onAnalyze: (prompt: string) => Promise<OllamaTradeAnalysisResponse>;
  onApplyStrategy: (strategy: StrategyCandidate) => Promise<void>;
  onExport?: () => Promise<void>;
  onImport?: (file: File) => Promise<AnalysisImportResponse>;
}) {
  const [marketFilter, setMarketFilter] = useState<TradeMarketFilter>("ALL");
  const [outcomeFilter, setOutcomeFilter] = useState<OutcomeFilter>("ALL");
  const [qualityFilter, setQualityFilter] = useState<StrategyQualityFilter>("RELIABLE");
  const [sortState, setSortState] = useState<StrategySortState>({ key: "evRoi", direction: "desc" });
  const [prompt, setPrompt] = useState("");
  const [ollamaHistory, setOllamaHistory] = useState<OllamaHistoryEntry[]>(() => loadOllamaHistory());
  const [ollamaError, setOllamaError] = useState<string | null>(null);
  const [selectedStrategy, setSelectedStrategy] = useState<StrategyCandidate | null>(null);
  const [applyMessage, setApplyMessage] = useState<string | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [transferBusy, setTransferBusy] = useState(false);
  const [transferMessage, setTransferMessage] = useState<string | null>(null);
  const [transferError, setTransferError] = useState<string | null>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  const strategies = qualityFilter === "CURRENT" ? analysis?.currentStrategies ?? [] : analysis?.strategies ?? [];
  const bestReliableByOutcome = bestReliableStrategyByOutcome(analysis?.strategies ?? []);
  const filteredStrategies = strategies.filter((strategy) =>
    matchesStrategyFilters(strategy, marketFilter, outcomeFilter, qualityFilter),
  );
  const visibleStrategies = sortStrategies(filteredStrategies, sortState);
  const strategyCardLimit = 9;
  const primaryStrategies = visibleStrategies.slice(0, strategyCardLimit);
  const selectedStrategyKey = selectedStrategy ? strategyKey(selectedStrategy) : undefined;
  const selectedStrategyPreview = selectedStrategy ? strategySettingsPreview(settings, selectedStrategy) : [];

  useEffect(() => {
    saveOllamaHistory(ollamaHistory);
  }, [ollamaHistory]);

  function toggleSort(key: StrategySortKey) {
    setSortState((current) => ({
      key,
      direction: current.key === key && current.direction === "desc" ? "asc" : "desc",
    }));
  }

  async function submitOllama() {
    const trimmed = prompt.trim();
    if (!trimmed) {
      setOllamaError("Prompt requerido.");
      return;
    }
    setOllamaError(null);
    try {
      const result = await onAnalyze(trimmed);
      setOllamaHistory((current) => [
        {
          id: createOllamaHistoryId(result),
          prompt: trimmed,
          result,
        },
        ...current,
      ]);
    } catch (caught) {
      setOllamaError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  function selectStrategy(strategy: StrategyCandidate) {
    setSelectedStrategy(strategy);
    setApplyMessage(null);
    setApplyError(null);
  }

  async function applySelectedStrategy() {
    if (!selectedStrategy) {
      return;
    }
    setApplyMessage(null);
    setApplyError(null);
    try {
      await onApplyStrategy(selectedStrategy);
      setApplyMessage(`Estrategia aplicada: ${strategyApplySummary(selectedStrategy)}.`);
    } catch (caught) {
      setApplyError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  function deleteOllamaEntry(id: string) {
    setOllamaHistory((current) => current.filter((entry) => entry.id !== id));
  }

  async function exportAnalysisData() {
    setTransferMessage(null);
    setTransferError(null);
    setTransferBusy(true);
    try {
      await onExport?.();
      setTransferMessage("Descarga de datos de Analisis iniciada.");
    } catch (caught) {
      setTransferError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setTransferBusy(false);
    }
  }

  function openImportFilePicker() {
    setTransferMessage(null);
    setTransferError(null);
    importInputRef.current?.click();
  }

  async function importAnalysisData(file: File | undefined) {
    if (!file || !onImport) {
      return;
    }
    setTransferMessage(null);
    setTransferError(null);
    setTransferBusy(true);
    try {
      const result = await onImport(file);
      await onRefresh();
      setTransferMessage(formatAnalysisImportResult(result));
    } catch (caught) {
      setTransferError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setTransferBusy(false);
    }
  }

  return (
    <section className="panel analysis-panel">
      <div className="analysis-toolbar">
        <div className="section-heading">
          <Brain size={18} />
          <h2>{"An\u00e1lisis"}</h2>
        </div>
        <div className="analysis-toolbar-actions">
          <button className="command" type="button" onClick={exportAnalysisData} disabled={!onExport || busy || loading || transferBusy}>
            <Download size={18} /> Descargar
          </button>
          <button
            className="command"
            type="button"
            onClick={openImportFilePicker}
            disabled={!onImport || running || busy || loading || transferBusy}
            title={running ? "Deten el bot para importar datos de Analisis." : "Importar datos de Analisis"}
          >
            <Upload size={18} /> Importar
          </button>
          <input
            ref={importInputRef}
            className="file-input-hidden"
            type="file"
            accept=".jsonl,application/x-ndjson,text/plain"
            aria-label="Archivo de Analisis"
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = "";
              void importAnalysisData(file);
            }}
          />
          <button className="command" type="button" onClick={onRefresh} disabled={busy || loading || transferBusy}>
            <RefreshCw size={18} /> Actualizar
          </button>
        </div>
      </div>

      {running && (
        <div className="notice compact-notice">
          <AlertTriangle size={18} />
          Deten el bot para importar datos de Analisis.
        </div>
      )}
      {transferMessage && (
        <div className="notice success compact-notice">
          <CheckCircle2 size={18} />
          {transferMessage}
        </div>
      )}
      {transferError && (
        <div className="notice error compact-notice">
          <AlertTriangle size={18} />
          {transferError}
        </div>
      )}
      {loading && (
        <div className="notice compact-notice">
          <RefreshCw size={18} />
          Calculando estrategias...
        </div>
      )}
      {loadError && (
        <div className="notice error compact-notice">
          <AlertTriangle size={18} />
          {loadError}
        </div>
      )}
      {stale && analysis && !loading && !loadError && (
        <div className="notice compact-notice">
          <AlertTriangle size={18} />
          Analisis pendiente de actualizar.
        </div>
      )}

      <div className="hero-metrics compact analysis-metrics">
        <Metric label="Muestras" value={String(analysis?.summary.sampleCount ?? 0)} />
        <Metric label="Analizadas (grid)" value={String(analysis?.summary.analyzedSampleCount ?? 0)} />
        <Metric label="Ultima muestra" value={formatDateTime(analysis?.summary.lastSampleAtMs)} />
        <Metric label="Confiables" value={String(analysis?.summary.reliableStrategyCount ?? 0)} />
        <Metric label="Mejor ROI EV fiable" value={formatPercent(analysis?.summary.bestReliableEvRoi)} tone={pnlTone(analysis?.summary.bestReliableEvRoi)} />
        <Metric label="Trades fiables" value={String(analysis?.summary.bestReliableTradeCount ?? 0)} />
      </div>

      <div className="analysis-controls">
        <div className="segmented-control" role="group" aria-label="Filtrar estrategias por mercado">
          <button
            className={`segment-button ${marketFilter === "ALL" ? "active" : ""}`}
            type="button"
            onClick={() => setMarketFilter("ALL")}
          >
            Todos
          </button>
          {marketOptions.map((market) => (
            <button
              className={`segment-button ${marketFilter === market.symbol ? "active" : ""}`}
              type="button"
              key={market.symbol}
              onClick={() => setMarketFilter(market.symbol)}
            >
              {market.symbol}
            </button>
          ))}
        </div>
        <div className="segmented-control" role="group" aria-label="Filtrar estrategias por lado">
          <button
            className={`segment-button ${outcomeFilter === "ALL" ? "active" : ""}`}
            type="button"
            onClick={() => setOutcomeFilter("ALL")}
          >
            Ambos
          </button>
          {outcomeOptions.map((outcome) => (
            <button
              className={`segment-button ${outcomeFilter === outcome ? "active" : ""}`}
              type="button"
              key={outcome}
              onClick={() => setOutcomeFilter(outcome)}
            >
              {outcome}
            </button>
          ))}
        </div>
        <div className="segmented-control" role="group" aria-label="Filtrar estrategias por calidad">
          {[
            ["RELIABLE", "Confiables"],
            ["POSITIVE", "EV positivo"],
            ["CURRENT", "Actuales"],
            ["ALL", "Todas"],
          ].map(([value, label]) => (
            <button
              className={`segment-button ${qualityFilter === value ? "active" : ""}`}
              type="button"
              key={value}
              onClick={() => setQualityFilter(value as StrategyQualityFilter)}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="strategy-workspace">
        <div className="strategy-candidate-pane">
          <div className="workspace-heading">
            <div>
              <span>Candidatas</span>
              <strong>{strategyCardCountLabel(primaryStrategies.length, visibleStrategies.length)}</strong>
            </div>
          </div>
          {visibleStrategies.length === 0 ? (
            <div className="empty-state strategy-empty">{emptyStrategyMessage(qualityFilter)}</div>
          ) : (
            <div className="strategy-card-grid">
              {primaryStrategies.map((strategy) => (
                <StrategyMiniCard
                  key={strategyKey(strategy)}
                  strategy={strategy}
                  bestReliable={bestReliableByOutcome.get(strategyOutcomeKey(strategy))}
                  selected={selectedStrategyKey === strategyKey(strategy)}
                  onSelect={selectStrategy}
                />
              ))}
            </div>
          )}
        </div>

        <aside className="strategy-preview-panel" aria-live="polite">
          <div className="workspace-heading">
            <div>
              <span>Preview</span>
              <strong>{selectedStrategy ? strategyApplySummary(selectedStrategy) : "Sin estrategia seleccionada"}</strong>
            </div>
          </div>
          {applyMessage && <div className="notice success compact-notice"><CheckCircle2 size={18} />{applyMessage}</div>}
          {applyError && <div className="notice error compact-notice"><AlertTriangle size={18} />{applyError}</div>}
          {selectedStrategy ? (
            <>
              <div className="hero-metrics compact preview-metrics">
                <Metric label="ROI EV" value={formatPercent(selectedStrategy.metrics.evRoi)} tone={pnlTone(selectedStrategy.metrics.evRoi)} />
                <Metric label="EV live" value={formatSignedUsd(selectedStrategy.metrics.expectedValueUsd)} tone={pnlTone(selectedStrategy.metrics.expectedValueUsd)} />
                <Metric label="Edge" value={formatPercent(selectedStrategy.metrics.edge)} tone={pnlTone(selectedStrategy.metrics.edge)} />
              </div>
              <div className="strategy-preview-list">
                {selectedStrategyPreview.map((item) => (
                  <div className={`strategy-preview-row ${item.changed ? "changed" : ""}`} key={item.label}>
                    <span>{item.label}</span>
                    <strong>{item.current}</strong>
                    <span aria-hidden="true">-&gt;</span>
                    <strong>{item.next}</strong>
                  </div>
                ))}
              </div>
              {running && (
                <div className="notice error compact-notice">
                  <AlertTriangle size={18} />
                  Deten el bot para aplicar cambios de estrategia.
                </div>
              )}
              <button
                className="command primary"
                type="button"
                onClick={applySelectedStrategy}
                disabled={busy || running}
                title={running ? "Deten el bot para aplicar cambios de estrategia" : "Confirmar aplicacion de estrategia"}
              >
                <Save size={18} /> Confirmar aplicacion
              </button>
            </>
          ) : (
            <div className="empty-state strategy-preview-empty">Selecciona una tarjeta para comparar valores actuales y nuevos antes de guardar.</div>
          )}
        </aside>
      </div>

      {visibleStrategies.length > 0 && (
        <details className="strategy-detail-table">
          <summary>Detalle completo</summary>
          <div className="table-scroll strategy-table-scroll">
            <table className="responsive-table strategy-table">
              <thead>
                <tr>
                  <th>Elegir</th>
                  <th>Mercado</th>
                  <th>Lado</th>
                  <th aria-sort={strategySortAria("entryWindowSeconds", sortState)}>
                    <StrategySortHeader label="Ventana" sortKey="entryWindowSeconds" sortState={sortState} onSort={toggleSort} />
                  </th>
                  <th aria-sort={strategySortAria("minDistanceUsd", sortState)}>
                    <StrategySortHeader label="Distancia" sortKey="minDistanceUsd" sortState={sortState} onSort={toggleSort} />
                  </th>
                  <th aria-sort={strategySortAria("maxAskPrice", sortState)}>
                    <StrategySortHeader label="Ask cap" sortKey="maxAskPrice" sortState={sortState} onSort={toggleSort} />
                  </th>
                  <th aria-sort={strategySortAria("averageAsk", sortState)}>
                    <StrategySortHeader label="Ask prom" sortKey="averageAsk" sortState={sortState} onSort={toggleSort} />
                  </th>
                  <th aria-sort={strategySortAria("realWinProbability", sortState)}>
                    <StrategySortHeader label="P real" sortKey="realWinProbability" sortState={sortState} onSort={toggleSort} />
                  </th>
                  <th aria-sort={strategySortAria("adjustedWinProbability", sortState)}>
                    <StrategySortHeader label="P ajustada" sortKey="adjustedWinProbability" sortState={sortState} onSort={toggleSort} />
                  </th>
                  <th aria-sort={strategySortAria("edge", sortState)}>
                    <StrategySortHeader label="Edge" sortKey="edge" sortState={sortState} onSort={toggleSort} />
                  </th>
                  <th aria-sort={strategySortAria("evRoi", sortState)}>
                    <StrategySortHeader label="ROI EV" sortKey="evRoi" sortState={sortState} onSort={toggleSort} />
                  </th>
                  <th aria-sort={strategySortAria("expectedValueUsd", sortState)}>
                    <StrategySortHeader label="EV live" sortKey="expectedValueUsd" sortState={sortState} onSort={toggleSort} />
                  </th>
                  <th>Conf.</th>
                  <th>Delta</th>
                  <th aria-sort={strategySortAria("tradeCount", sortState)}>
                    <StrategySortHeader label="Trades" sortKey="tradeCount" sortState={sortState} onSort={toggleSort} />
                  </th>
                  <th aria-sort={strategySortAria("winRate", sortState)}>
                    <StrategySortHeader label="Win" sortKey="winRate" sortState={sortState} onSort={toggleSort} />
                  </th>
                  <th aria-sort={strategySortAria("quoteCoverage", sortState)}>
                    <StrategySortHeader label="Cobertura" sortKey="quoteCoverage" sortState={sortState} onSort={toggleSort} />
                  </th>
                  <th aria-sort={strategySortAria("maxDrawdown", sortState)}>
                    <StrategySortHeader label="DD" sortKey="maxDrawdown" sortState={sortState} onSort={toggleSort} />
                  </th>
                  <th>Alertas</th>
                </tr>
              </thead>
              <tbody>
                {visibleStrategies.map((strategy) => (
                  <tr className={selectedStrategyKey === strategyKey(strategy) ? "selected-row" : undefined} key={strategyKey(strategy)}>
                    <td data-label="Elegir" className="strategy-action-cell">
                      <button
                        className="command compact-command"
                        type="button"
                        onClick={() => selectStrategy(strategy)}
                        aria-label={`Seleccionar estrategia ${strategy.market} ${strategy.outcome}`}
                      >
                        {selectedStrategyKey === strategyKey(strategy) ? "Elegida" : "Seleccionar"}
                      </button>
                    </td>
                    <td data-label="Mercado">{strategy.market}{strategy.isCurrent ? " actual" : ""}</td>
                    <td data-label="Lado"><span className={`side ${strategy.outcome.toLowerCase()}`}>{strategy.outcome}</span></td>
                    <td data-label="Ventana">{formatEntryWindow(strategy.entryWindowSeconds)}</td>
                    <td data-label="Distancia">{formatMarketDistance(strategy.minDistanceUsd, strategy.market)}</td>
                    <td data-label="Ask cap">{formatPrice(strategy.maxAskPrice)}</td>
                    <td data-label="Ask prom" className="strategy-secondary-cell">{formatPrice(strategy.metrics.averageAsk)}</td>
                    <td data-label="P real" className="strategy-secondary-cell">{formatRatio(strategy.metrics.realWinProbability)}</td>
                    <td data-label="P ajustada" className="strategy-secondary-cell">{formatRatio(strategy.metrics.adjustedWinProbability)}</td>
                    <td data-label="Edge"><span className={`pnl-value ${pnlTone(strategy.metrics.edge)}`}>{formatPercent(strategy.metrics.edge)}</span></td>
                    <td data-label="ROI EV"><span className={`pnl-value ${pnlTone(strategy.metrics.evRoi)}`}>{formatPercent(strategy.metrics.evRoi)}</span></td>
                    <td data-label="EV live"><span className={`pnl-value ${pnlTone(strategy.metrics.expectedValueUsd)}`}>{formatSignedUsd(strategy.metrics.expectedValueUsd)}</span></td>
                    <td data-label="Conf."><ConfidenceBadge confidence={strategy.confidence} /></td>
                    <td data-label="Delta" className="strategy-secondary-cell">{formatDelta(strategy.evDeltaVsCurrent)}</td>
                    <td data-label="Trades">{strategy.metrics.tradeCount}</td>
                    <td data-label="Win" className="strategy-secondary-cell">{formatRatio(strategy.metrics.winRate)}</td>
                    <td data-label="Cobertura" className="strategy-secondary-cell">{formatRatio(strategy.metrics.quoteCoverage)}</td>
                    <td data-label="DD" className="strategy-secondary-cell">{strategy.metrics.maxDrawdown.toFixed(2)}</td>
                    <td data-label="Alertas" className="strategy-alerts-cell">{formatRiskFlags(strategy.riskFlags)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}

      <div className="ollama-panel">
        <div className="quick-prompts" aria-label={"Prompts r\u00e1pidos Ollama"}>
          {ollamaPromptOptions.map((option) => (
            <button className="segment-button" type="button" key={option.label} onClick={() => setPrompt(option.prompt)}>
              {option.label}
            </button>
          ))}
        </div>
        <label className="field">
          <span>Prompt Ollama</span>
          <textarea
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            rows={4}
            placeholder={"Elige un prompt r\u00e1pido o escribe qu\u00e9 quieres revisar de estas estrategias."}
          />
        </label>
        <div className="form-actions">
          <button className="command primary" type="button" onClick={submitOllama} disabled={busy}>
            <CheckCircle2 size={18} /> Analizar con Ollama
          </button>
        </div>
        {ollamaError && <div className="notice error"><AlertTriangle size={18} />{ollamaError}</div>}
        {ollamaHistory.length > 0 && (
          <div className="ollama-history" aria-label="Respuestas guardadas de Ollama">
            {ollamaHistory.map((entry) => (
              <article className="ollama-result" key={entry.id}>
                <div className="ollama-result-header">
                  <div>
                    <strong>{entry.result.model}</strong>
                    <span>{new Date(entry.result.generatedAtMs).toLocaleString()}</span>
                    <span>{entry.result.contextSummary}</span>
                    <span>Prompt: {entry.prompt}</span>
                  </div>
                  <button
                    className="command danger compact-command"
                    type="button"
                    onClick={() => deleteOllamaEntry(entry.id)}
                    aria-label={`Borrar respuesta Ollama ${new Date(entry.result.generatedAtMs).toLocaleString()}`}
                  >
                    <Trash2 size={16} /> Borrar
                  </button>
                </div>
                <p>{entry.result.content}</p>
              </article>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function StrategyMiniCard({
  strategy,
  bestReliable,
  selected,
  onSelect,
}: {
  strategy: StrategyCandidate;
  bestReliable?: StrategyCandidate;
  selected: boolean;
  onSelect: (strategy: StrategyCandidate) => void;
}) {
  const reliableDelta =
    bestReliable?.metrics.evRoi !== undefined && strategy.metrics.evRoi !== undefined
      ? bestReliable.metrics.evRoi - strategy.metrics.evRoi
      : undefined;
  return (
    <article className={`strategy-mini-card ${selected ? "selected" : ""}`}>
      <div className="strategy-mini-heading">
        <strong>{strategy.market} {strategy.outcome}</strong>
        <span>{formatEntryWindow(strategy.entryWindowSeconds)} / {formatMarketDistance(strategy.minDistanceUsd, strategy.market)}</span>
      </div>
      <button
        className="command compact-command"
        type="button"
        onClick={() => onSelect(strategy)}
        aria-label={`Seleccionar estrategia ${strategy.market} ${strategy.outcome}`}
      >
        {selected ? "Elegida" : "Seleccionar"}
      </button>
      <Metric label="Estado" value={entryDecisionLabel(strategy)} tone={strategy.metrics.passesRecommendedEntry ? "positive" : "negative"} />
      <Metric label="P real" value={formatRatio(strategy.metrics.realWinProbability)} />
      <Metric label="P ajustada" value={formatRatio(strategy.metrics.adjustedWinProbability)} />
      <Metric label="Edge" value={formatPercent(strategy.metrics.edge)} tone={pnlTone(strategy.metrics.edge)} />
      <Metric label="EV live" value={formatSignedUsd(strategy.metrics.expectedValueUsd)} tone={pnlTone(strategy.metrics.expectedValueUsd)} />
      <Metric label="Ask prom" value={formatPrice(strategy.metrics.averageAsk)} />
      <Metric label="ROI EV" value={formatPercent(strategy.metrics.evRoi)} tone={pnlTone(strategy.metrics.evRoi)} />
      <Metric label="Trades" value={String(strategy.metrics.tradeCount)} />
      <ConfidenceBadge confidence={strategy.confidence} />
      <small>
        {[
          `Hist. ${formatPercent(strategy.metrics.historicalRoi)}`,
          evDecisionReasonLabel(strategy.metrics.evDecisionReason),
          bestReliable ? `Mejor fiable ${formatPercent(bestReliable.metrics.evRoi)} (${formatDelta(reliableDelta)})` : "Sin fiable",
        ].join(" / ")}
      </small>
    </article>
  );
}

function PnlModeSummary({
  label,
  summary,
  busy,
  onReset,
}: {
  label: string;
  summary?: PnlSummary;
  busy: boolean;
  onReset: () => void;
}) {
  return (
    <div className="pnl-mode-summary">
      <div className="pnl-mode-header">
        <span>{label}</span>
        <div className="pnl-mode-actions">
          <strong className={`pnl-mode-net ${pnlTone(summary?.realizedUsd)}`}>
            {formatSignedUsd(summary?.realizedUsd)}
          </strong>
          <button
            className="icon-button pnl-reset-button"
            title={`Reset P&L ${label}`}
            aria-label={`Reset P&L ${label}`}
            onClick={onReset}
            disabled={busy}
          >
            <RotateCcw size={16} />
          </button>
        </div>
      </div>
      <div className="hero-metrics pnl-metrics">
        <Metric label="Reclamado" value={formatUsd(summary?.payoutUsd)} tone={pnlTone(summary?.payoutUsd)} />
        <Metric label="Invertido" value={formatUsd(summary?.realizedStakeUsd)} />
        <Metric label="Pendiente" value={formatUsd(summary?.pendingStakeUsd)} />
        <Metric label="ROI" value={formatPercent(summary?.roiPct)} tone={pnlTone(summary?.realizedUsd)} />
      </div>
    </div>
  );
}

function ConfidenceBadge({ confidence }: { confidence: StrategyConfidence }) {
  return <span className={`confidence-badge ${confidence}`}>{confidenceLabel(confidence)}</span>;
}

export function TradesTable({ trades, settings }: { trades: TradeAttempt[]; settings?: UiSettings }) {
  const [marketFilter, setMarketFilter] = useState<TradeMarketFilter>("ALL");
  const [pnlFilter, setPnlFilter] = useState<TradePnlFilter>("ALL");
  const [sortState, setSortState] = useState<TradeSortState | undefined>();
  const filteredTrades = trades.filter((trade) => {
    const marketMatches = marketFilter === "ALL" || getTradeMarketSymbol(trade) === marketFilter;
    return marketMatches && matchesTradePnlFilter(trade, pnlFilter);
  });
  const visibleTrades = sortTrades(filteredTrades, sortState, settings);
  const averages = calculateVisibleTradeAverages(filteredTrades, settings);

  function toggleSort(key: TradeSortKey) {
    setSortState((current) => ({
      key,
      direction: current?.key === key && current.direction === "desc" ? "asc" : "desc",
    }));
  }

  if (trades.length === 0) {
    return <section className="panel empty-state">Sin trades registrados</section>;
  }
  return (
    <section className="panel table-panel">
      <div className="table-toolbar">
        <div className="segmented-control" role="group" aria-label="Filtrar trades por mercado">
          <button
            className={`segment-button ${marketFilter === "ALL" ? "active" : ""}`}
            type="button"
            onClick={() => setMarketFilter("ALL")}
          >
            Todos
          </button>
          {marketOptions.map((market) => (
            <button
              className={`segment-button ${marketFilter === market.symbol ? "active" : ""}`}
              type="button"
              key={market.symbol}
              onClick={() => setMarketFilter(market.symbol)}
            >
              {market.symbol}
            </button>
          ))}
        </div>
        <div className="segmented-control" role="group" aria-label="Filtrar trades por P&L">
          <button
            aria-label="P&L todos"
            className={`segment-button ${pnlFilter === "ALL" ? "active" : ""}`}
            type="button"
            onClick={() => setPnlFilter("ALL")}
          >
            Todos
          </button>
          <button
            className={`segment-button ${pnlFilter === "POSITIVE" ? "active" : ""}`}
            type="button"
            onClick={() => setPnlFilter("POSITIVE")}
          >
            Positivo
          </button>
          <button
            className={`segment-button ${pnlFilter === "NEGATIVE" ? "active" : ""}`}
            type="button"
            onClick={() => setPnlFilter("NEGATIVE")}
          >
            Negativo
          </button>
        </div>
      </div>
      {filteredTrades.length === 0 ? (
        <div className="empty-state table-empty">{emptyTradesMessage(marketFilter, pnlFilter)}</div>
      ) : (
        <div className="table-scroll trade-table-scroll">
          <table className="responsive-table trade-table">
            <thead>
              <tr className="average-row">
                <th />
                <th />
                <th>{averageCell(formatEntryWindow(averages.entryWindowSeconds))}</th>
                <th />
                <th />
                <th>{averageCell(formatUsd(averages.stakeUsd))}</th>
                <th>{averageCell(formatPrice(averages.bestAsk))}</th>
                <th>{averageCell(formatAverageDistance(averages.distanceUsd, filteredTrades))}</th>
                <th>{averageCell(formatUsd(averages.payoutUsd))}</th>
                <th>{averageCell(formatSignedUsd(averages.netUsd))}</th>
                <th />
              </tr>
              <tr>
                <th aria-sort={sortAria("createdAtMs", sortState)}>
                  <SortHeader label="Hora" sortKey="createdAtMs" sortState={sortState} onSort={toggleSort} />
                </th>
                <th>Mercado</th>
                <th aria-sort={sortAria("entryWindowSeconds", sortState)}>
                  <SortHeader label="Ventana" sortKey="entryWindowSeconds" sortState={sortState} onSort={toggleSort} />
                </th>
                <th>Modo</th>
                <th>Lado</th>
                <th aria-sort={sortAria("stakeUsd", sortState)}>
                  <SortHeader label="Invertido" sortKey="stakeUsd" sortState={sortState} onSort={toggleSort} />
                </th>
                <th aria-sort={sortAria("bestAsk", sortState)}>
                  <SortHeader label="Ask" sortKey="bestAsk" sortState={sortState} onSort={toggleSort} />
                </th>
                <th aria-sort={sortAria("distanceUsd", sortState)}>
                  <SortHeader label="Distancia" sortKey="distanceUsd" sortState={sortState} onSort={toggleSort} />
                </th>
                <th aria-sort={sortAria("payoutUsd", sortState)}>
                  <SortHeader label="Reclamado" sortKey="payoutUsd" sortState={sortState} onSort={toggleSort} />
                </th>
                <th aria-sort={sortAria("netUsd", sortState)}>
                  <SortHeader label="P&L" sortKey="netUsd" sortState={sortState} onSort={toggleSort} />
                </th>
                <th>Estado</th>
              </tr>
            </thead>
            <tbody>
              {visibleTrades.map((trade) => {
                const pnl = calculateTradePnl(trade);
                const marketSymbol = getTradeMarketSymbol(trade) ?? "BTC";
                return (
                  <tr key={trade.id}>
                    <td data-label="Hora">{new Date(trade.createdAtMs).toLocaleString()}</td>
                    <td data-label="Mercado">{tradeMarketLabel(trade)}</td>
                    <td data-label="Ventana">{formatTradeEntryWindow(trade, settings)}</td>
                    <td data-label="Modo">{trade.mode.toUpperCase()}</td>
                    <td data-label="Lado"><span className={`side ${trade.outcome.toLowerCase()}`}>{trade.outcome}</span></td>
                    <td data-label="Invertido">{formatUsd(pnl.stakeUsd)}</td>
                    <td data-label="Ask">{formatPrice(trade.bestAsk)}</td>
                    <td data-label="Distancia">{formatMarketDistance(trade.distanceUsd, marketSymbol)}</td>
                    <td data-label="Reclamado">{formatTradePayout(pnl)}</td>
                    <td data-label="P&L"><span className={`pnl-value ${pnlTone(pnl.netUsd)}`}>{formatTradePnl(pnl)}</span></td>
                    <td data-label="Estado">{tradeStatusLabel(trade)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export function SettingsPanel({ settings, running, busy, onSave }: {
  settings: UiSettings;
  running: boolean;
  busy: boolean;
  onSave: (settings: UiSettings) => Promise<void>;
}) {
  const [draft, setDraft] = useState(settings);
  const [selectedMarket, setSelectedMarket] = useState<MarketSymbol>("BTC");
  const selectedMarketOption = marketOptions.find((market) => market.symbol === selectedMarket) ?? marketOptions[0];
  const activeLabels = enabledOutcomeLabels(draft.enabledMarketOutcomes);
  useEffect(() => setDraft(settings), [settings]);

  function update(key: keyof UiSettings, value: number | boolean) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  function toggleMarketOutcome(symbol: MarketSymbol, outcome: Outcome, enabled: boolean) {
    setDraft((current) => {
      const enabledMarketOutcomes = {
        ...current.enabledMarketOutcomes,
        [symbol]: {
          ...current.enabledMarketOutcomes[symbol],
          [outcome]: enabled,
        },
      };
      return {
        ...current,
        enabledMarkets: enabledMarketsFromOutcomeSettings(enabledMarketOutcomes),
        enabledMarketOutcomes,
      };
    });
  }

  function updateMarketDistance(symbol: MarketSymbol, outcome: Outcome, value: number) {
    setDraft((current) => {
      const minDistanceUsdByMarketOutcome = {
        ...current.minDistanceUsdByMarketOutcome,
        [symbol]: {
          ...current.minDistanceUsdByMarketOutcome[symbol],
          [outcome]: value,
        },
      };
      const minDistanceUsdByMarket = {
        ...current.minDistanceUsdByMarket,
        [symbol]: minDistanceUsdByMarketOutcome[symbol].UP,
      };
      return {
        ...current,
        minBtcDistanceUsd: minDistanceUsdByMarket.BTC,
        minDistanceUsdByMarket,
        minDistanceUsdByMarketOutcome,
      };
    });
  }

  function updateMarketEntryWindow(symbol: MarketSymbol, outcome: Outcome, value: number) {
    setDraft((current) => {
      const entryWindowSecondsByMarketOutcome = {
        ...current.entryWindowSecondsByMarketOutcome,
        [symbol]: {
          ...current.entryWindowSecondsByMarketOutcome[symbol],
          [outcome]: value,
        },
      };
      const entryWindowSecondsByMarket = {
        ...current.entryWindowSecondsByMarket,
        [symbol]: entryWindowSecondsByMarketOutcome[symbol].UP,
      };
      return {
        ...current,
        entryWindowSeconds: entryWindowSecondsByMarket.BTC,
        entryWindowSecondsByMarket,
        entryWindowSecondsByMarketOutcome,
      };
    });
  }

  function updateMarketSimAmount(symbol: MarketSymbol, outcome: Outcome, value: number) {
    setDraft((current) => {
      const simTradeAmountUsdByMarketOutcome = {
        ...current.simTradeAmountUsdByMarketOutcome,
        [symbol]: {
          ...current.simTradeAmountUsdByMarketOutcome[symbol],
          [outcome]: value,
        },
      };
      return {
        ...current,
        simTradeAmountUsd: simTradeAmountUsdByMarketOutcome.BTC.UP,
        simTradeAmountUsdByMarketOutcome,
      };
    });
  }

  function updateMarketLiveAmount(symbol: MarketSymbol, outcome: Outcome, value: number) {
    setDraft((current) => {
      const liveTradeAmountUsdByMarketOutcome = {
        ...current.liveTradeAmountUsdByMarketOutcome,
        [symbol]: {
          ...current.liveTradeAmountUsdByMarketOutcome[symbol],
          [outcome]: value,
        },
      };
      return {
        ...current,
        liveTradeAmountUsd: liveTradeAmountUsdByMarketOutcome.BTC.UP,
        liveTradeAmountUsdByMarketOutcome,
      };
    });
  }

  function updateMarketAskCap(symbol: MarketSymbol, outcome: Outcome, value: number) {
    setDraft((current) => {
      const maxAskPriceByMarketOutcome = {
        ...current.maxAskPriceByMarketOutcome,
        [symbol]: {
          ...current.maxAskPriceByMarketOutcome[symbol],
          [outcome]: value,
        },
      };
      return {
        ...current,
        maxAskPrice: maxAskPriceByMarketOutcome.BTC.UP,
        maxAskPriceByMarketOutcome,
      };
    });
  }

  function updateAutoAdjust(key: AutoAdjustSettingKey, symbol: MarketSymbol, outcome: Outcome, enabled: boolean) {
    setDraft((current) => ({
      ...current,
      [key]: {
        ...current[key],
        [symbol]: {
          ...current[key][symbol],
          [outcome]: enabled,
        },
      },
    }));
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    await onSave(draft);
  }

  return (
    <form className="panel settings-panel" onSubmit={submit}>
      <div className="settings-summary-grid">
        <Metric label="Lados activos" value={String(activeLabels.length)} />
        <Metric label="Limite diario" value={formatUsd(draft.dailySpendLimitUsd)} />
        <Metric label="Tick stale" value={`${draft.tickStaleMs}ms`} />
        <Metric label="Poll" value={`${draft.pollIntervalMs}ms`} />
      </div>
      <p className="settings-active-line">{activeLabels.length > 0 ? `Activos: ${activeLabels.join(", ")}` : "Sin lados activos."}</p>

      <div className="settings-workspace">
        <div className="segmented-control settings-market-tabs" role="group" aria-label="Mercado de settings">
          {marketOptions.map((market) => (
            <button
              className={`segment-button ${selectedMarket === market.symbol ? "active" : ""}`}
              type="button"
              key={market.symbol}
              onClick={() => setSelectedMarket(market.symbol)}
              aria-label={`Editar ${market.label}`}
            >
              {market.symbol}
            </button>
          ))}
        </div>

        <section className="market-setting-row settings-market-editor">
          <div className="market-setting-header">
            <div>
              <span className="market-code">{selectedMarketOption.symbol}</span>
              <strong>{selectedMarketOption.label}</strong>
            </div>
            <span className="market-active-count">
              {outcomeOptions.filter((outcome) => draft.enabledMarketOutcomes[selectedMarketOption.symbol][outcome]).length} activos
            </span>
          </div>

          <div className="outcome-settings-grid settings-outcome-cards">
            {outcomeOptions.map((outcome) => (
              <div className="outcome-setting-row" key={`${selectedMarketOption.symbol}-${outcome}`}>
                <label className="switch-row outcome-enable">
                  <input
                    type="checkbox"
                    aria-label={`Activar ${selectedMarketOption.label} ${outcome}`}
                    checked={draft.enabledMarketOutcomes[selectedMarketOption.symbol][outcome]}
                    onChange={(event) => toggleMarketOutcome(selectedMarketOption.symbol, outcome, event.target.checked)}
                    disabled={running}
                  />
                  <span className={`side ${outcome.toLowerCase()}`}>{outcome}</span>
                </label>
                <NumberField
                  label={`Distancia ${selectedMarketOption.label} ${outcome}`}
                  value={draft.minDistanceUsdByMarketOutcome[selectedMarketOption.symbol][outcome]}
                  min={selectedMarketOption.min}
                  step={selectedMarketOption.step}
                  onChange={(value) => updateMarketDistance(selectedMarketOption.symbol, outcome, value)}
                />
                <NumberField
                  label={`Ventana ${selectedMarketOption.label} ${outcome}`}
                  value={draft.entryWindowSecondsByMarketOutcome[selectedMarketOption.symbol][outcome]}
                  min={1}
                  step={1}
                  onChange={(value) => updateMarketEntryWindow(selectedMarketOption.symbol, outcome, value)}
                />
                <NumberField
                  label={`Monto sim ${selectedMarketOption.label} ${outcome}`}
                  value={draft.simTradeAmountUsdByMarketOutcome[selectedMarketOption.symbol][outcome]}
                  min={0.1}
                  step={0.1}
                  onChange={(value) => updateMarketSimAmount(selectedMarketOption.symbol, outcome, value)}
                />
                <NumberField
                  label={`Monto live ${selectedMarketOption.label} ${outcome}`}
                  value={draft.liveTradeAmountUsdByMarketOutcome[selectedMarketOption.symbol][outcome]}
                  min={0.1}
                  step={0.1}
                  onChange={(value) => updateMarketLiveAmount(selectedMarketOption.symbol, outcome, value)}
                />
                <NumberField
                  label={`Ask cap ${selectedMarketOption.label} ${outcome}`}
                  value={draft.maxAskPriceByMarketOutcome[selectedMarketOption.symbol][outcome]}
                  min={0.01}
                  max={1}
                  step={0.01}
                  onChange={(value) => updateMarketAskCap(selectedMarketOption.symbol, outcome, value)}
                />
                <label className="switch-row compact-switch">
                  <input
                    type="checkbox"
                    aria-label={`Auto live ${selectedMarketOption.label} ${outcome}`}
                    checked={draft.autoAdjustLiveByMarketOutcome[selectedMarketOption.symbol][outcome]}
                    onChange={(event) =>
                      updateAutoAdjust("autoAdjustLiveByMarketOutcome", selectedMarketOption.symbol, outcome, event.target.checked)}
                    disabled={running}
                  />
                  <span>Auto live</span>
                </label>
                <label className="switch-row compact-switch">
                  <input
                    type="checkbox"
                    aria-label={`Tras perder ${selectedMarketOption.label} ${outcome}`}
                    checked={draft.autoAdjustAfterLossByMarketOutcome[selectedMarketOption.symbol][outcome]}
                    onChange={(event) =>
                      updateAutoAdjust("autoAdjustAfterLossByMarketOutcome", selectedMarketOption.symbol, outcome, event.target.checked)}
                    disabled={running}
                  />
                  <span>Tras perder</span>
                </label>
              </div>
            ))}
          </div>
        </section>
      </div>

      <section className="settings-advanced">
        <div className="section-heading">
          <Settings size={18} />
          <h2>Avanzado</h2>
        </div>
        <div className="settings-grid">
          <NumberField label="Limite diario" value={draft.dailySpendLimitUsd} min={1} step={1} onChange={(value) => update("dailySpendLimitUsd", value)} />
          <NumberField label="Tick stale ms" value={draft.tickStaleMs} min={1000} step={1000} onChange={(value) => update("tickStaleMs", value)} />
          <NumberField label="Poll ms" value={draft.pollIntervalMs} min={250} step={250} onChange={(value) => update("pollIntervalMs", value)} />
        </div>
        <label className="switch-row">
          <input type="checkbox" checked={draft.autoMinLive} onChange={(event) => update("autoMinLive", event.target.checked)} disabled={running} />
          <span>Auto minimo live</span>
        </label>
        <label className="switch-row">
          <input
            type="checkbox"
            checked={draft.aiAutoApplyLive}
            onChange={(event) => update("aiAutoApplyLive", event.target.checked)}
            disabled={running}
          />
          <span>Autoajuste predictivo en tiempo real</span>
        </label>
        <p className="settings-hint">
          Un modelo estadistico local (backtesting walk-forward + estimacion k-NN, sin LLM ni internet) evalua las muestras de
          Analisis mientras el bot corre y aplica automaticamente la mejor ventana y distancia por mercado cuando hay alta
          confianza y dentro de las guardas. Actívalo antes de iniciar el bot.
        </p>
      </section>

      <section className="settings-advanced">
        <div className="section-heading">
          <ShieldAlert size={18} />
          <h2>Límites de riesgo</h2>
        </div>
        <div className="settings-grid">
          <NumberField
            label="Pérdida diaria máx (USD)"
            value={draft.maxDailyLossUsd}
            min={0}
            step={5}
            onChange={(value) => update("maxDailyLossUsd", value)}
          />
          <NumberField
            label="Pérdidas seguidas máx"
            value={draft.maxConsecutiveLosses}
            min={0}
            step={1}
            onChange={(value) => update("maxConsecutiveLosses", value)}
          />
          <NumberField
            label="Techo de ask cap"
            value={draft.maxAskPriceCeiling}
            min={0.5}
            max={0.98}
            step={0.01}
            onChange={(value) => update("maxAskPriceCeiling", value)}
          />
        </div>
        <p className="settings-hint">
          Circuit breaker (0 = desactivado). Si la pérdida realizada del día (UTC) o la racha de pérdidas cruza el
          límite, el bot deja de operar hasta el día siguiente — sigue observando para analítica. Aplica al modo en
          ejecución. Editable con el bot detenido.
        </p>
        <p className="settings-hint">
          <strong>Techo de ask cap</strong>: precio máximo por acción para cualquier trade y para el auto-ajuste. Más
          bajo = mejor relación premio/riesgo (una pérdida se recupera con menos aciertos) pero menos trades. Recomendado
          0.85; la ganancia histórica se concentra por debajo de 0.70 y arriba de 0.85 el edge desaparece.
        </p>
      </section>

      <section className="settings-advanced">
        <div className="section-heading">
          <ShieldAlert size={18} />
          <h2>Gate de EV</h2>
        </div>
        <label className="switch-row">
          <input
            type="checkbox"
            checked={draft.requirePositiveEv}
            onChange={(event) => update("requirePositiveEv", event.target.checked)}
            disabled={running}
          />
          <span>Exigir valor esperado positivo</span>
        </label>
        <div className="settings-grid">
          <NumberField
            label="Margen de seguridad"
            value={draft.evSafetyMargin}
            min={0}
            max={0.99}
            step={0.01}
            onChange={(value) => update("evSafetyMargin", value)}
          />
          <NumberField
            label="Historia mínima (trades)"
            value={draft.evMinHistoryTrades}
            min={0}
            step={1}
            onChange={(value) => update("evMinHistoryTrades", value)}
          />
          <NumberField
            label="ROI esperado mín"
            value={draft.evMinExpectedRoi}
            min={0}
            max={0.99}
            step={0.01}
            onChange={(value) => update("evMinExpectedRoi", value)}
          />
        </div>
        <p className="settings-hint">
          Solo opera setups con ventaja real y EV positivo tras comisiones. <strong>Menor margen = opera más seguido</strong>
          {" "}(recomendado 0.03; 0.08 era demasiado estricto y casi nunca operaba). "Historia mínima" es cuántas muestras
          resueltas necesita el setup antes de confiar en su tasa de acierto. Apagar el gate opera cualquier señal (más
          riesgo). Editable con el bot detenido.
        </p>
      </section>

      <div className="form-actions settings-save-actions">
        <button className="command primary" disabled={running || busy} type="submit">
          <Save size={18} /> Guardar
        </button>
      </div>
    </form>
  );
}

export function TelegramPanel() {
  const [settings, setSettings] = useState<TelegramNotificationSettings | null>(null);
  const [draft, setDraft] = useState<TelegramNotificationPatch>({ enabled: false, chatId: "", publicUrl: "" });
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void loadTelegramSettings();
  }, []);

  async function loadTelegramSettings() {
    setError(null);
    try {
      const next = await api<TelegramNotificationSettings>("/api/notifications/telegram");
      setSettings(next);
      setDraft({
        enabled: next.enabled,
        botToken: "",
        chatId: next.chatId,
        publicUrl: next.publicUrl ?? "",
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  function updateTelegramDraft(key: keyof TelegramNotificationPatch, value: string | boolean) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      const payload = {
        ...draft,
        botToken: typeof draft.botToken === "string" && draft.botToken.trim() ? draft.botToken : undefined,
      };
      const saved = await api<TelegramNotificationSettings>("/api/notifications/telegram", {
        method: "PATCH",
        body: JSON.stringify(payload),
      });
      setSettings(saved);
      setDraft({
        enabled: saved.enabled,
        botToken: "",
        chatId: saved.chatId,
        publicUrl: saved.publicUrl ?? "",
      });
      setMessage("Configuracion guardada.");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function sendTest() {
    setTesting(true);
    setMessage(null);
    setError(null);
    try {
      await api("/api/notifications/telegram/test", { method: "POST" });
      setMessage("Mensaje de prueba enviado.");
      await loadTelegramSettings();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setTesting(false);
    }
  }

  const statusLabel = !settings
    ? "Cargando"
    : !settings.enabled
      ? "Desactivado"
      : settings.configured
        ? "Configurado"
        : "Incompleto";
  const tokenPlaceholder = settings?.hasBotToken ? settings.botTokenMasked ?? "Token guardado" : "123456:ABC...";

  return (
    <form className="panel telegram-panel" onSubmit={submit}>
      <div className="telegram-header">
        <div className="section-heading">
          <Bell size={18} />
          <h2>Telegram</h2>
        </div>
        <span className={`telegram-status ${settings?.configured ? "ready" : "idle"}`}>{statusLabel}</span>
      </div>

      {error && <div className="notice error"><AlertTriangle size={18} />{error}</div>}
      {message && <div className="notice success"><CheckCircle2 size={18} />{message}</div>}

      <label className="switch-row">
        <input
          type="checkbox"
          checked={Boolean(draft.enabled)}
          onChange={(event) => updateTelegramDraft("enabled", event.target.checked)}
        />
        <span>Activar notificaciones Telegram</span>
      </label>

      <div className="settings-grid telegram-grid">
        <label className="field">
          <span>Bot token</span>
          <input
            type="password"
            value={draft.botToken ?? ""}
            placeholder={tokenPlaceholder}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => updateTelegramDraft("botToken", event.target.value)}
          />
        </label>
        <label className="field">
          <span>Chat ID</span>
          <input
            type="text"
            value={draft.chatId ?? ""}
            placeholder="123456789"
            spellCheck={false}
            onChange={(event) => updateTelegramDraft("chatId", event.target.value)}
          />
        </label>
        <label className="field">
          <span>URL publica</span>
          <input
            type="url"
            value={draft.publicUrl ?? ""}
            placeholder="https://polybot.example.com"
            spellCheck={false}
            onChange={(event) => updateTelegramDraft("publicUrl", event.target.value)}
          />
        </label>
      </div>

      {settings?.source === "env" && (
        <p className="telegram-note">Usando valores de .env hasta que guardes una configuracion local.</p>
      )}

      <div className="form-actions telegram-actions">
        <button className="command" type="button" disabled={busy || testing || !settings?.configured} onClick={sendTest}>
          <Send size={18} /> Probar
        </button>
        <button className="command primary" disabled={busy || testing} type="submit">
          <Save size={18} /> Guardar
        </button>
      </div>
    </form>
  );
}

function LogsPanel({ logs }: { logs: LogEntry[] }) {
  return (
    <section className="panel logs-panel">
      {logs.length === 0 ? (
        <div className="empty-state">Sin logs</div>
      ) : (
        logs.map((log) => (
          <div className={`log-row ${log.level}`} key={`${log.at}-${log.message}`}>
            <span>{new Date(log.at).toLocaleTimeString()}</span>
            <strong>{log.level.toUpperCase()}</strong>
            <p>{log.message}</p>
          </div>
        ))
      )}
    </section>
  );
}

function LiveConfirmModal({ ready, reason, busy, onCancel, onConfirm }: {
  ready: boolean;
  reason?: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="live-title">
      <div className="modal">
        <h2 id="live-title">Confirmar live</h2>
        {!ready && <div className="notice error"><AlertTriangle size={18} />{reasonLabel(reason)}</div>}
        <div className="modal-actions">
          <button className="command" onClick={onCancel}>Cancelar</button>
          <button className="command danger" disabled={!ready || busy} onClick={onConfirm}>
            <ShieldAlert size={18} /> Iniciar live
          </button>
        </div>
      </div>
    </div>
  );
}

function ResetConfirmModal({ running, busy, onCancel, onConfirm }: {
  running: boolean;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="reset-title">
      <div className="modal">
        <h2 id="reset-title">Resetear Polybot</h2>
        <p className="modal-copy">
          {running ? "Esto detendra el bot y " : "Esto "}
          borra estado, aperturas, trades y gasto diario local. Conserva settings, .env y credenciales.
        </p>
        <div className="modal-actions">
          <button className="command" onClick={onCancel}>Cancelar</button>
          <button className="command danger" disabled={busy} onClick={onConfirm}>
            <RotateCcw size={18} /> Reset
          </button>
        </div>
      </div>
    </div>
  );
}

function TabButton({ active, icon, label, onClick }: { active: boolean; icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button className={`tab-button ${active ? "active" : ""}`} type="button" aria-current={active ? "page" : undefined} onClick={onClick}>
      {icon}
      <span>{label}</span>
    </button>
  );
}

function Metric({ icon, label, value, tone = "neutral" }: { icon?: React.ReactNode; label: string; value: string; tone?: "positive" | "negative" | "neutral" }) {
  return (
    <div className="metric">
      {icon}
      <span>{label}</span>
      <strong className={tone}>{value}</strong>
    </div>
  );
}

function SortHeader({ label, sortKey, sortState, onSort }: {
  label: string;
  sortKey: TradeSortKey;
  sortState?: TradeSortState;
  onSort: (key: TradeSortKey) => void;
}) {
  const active = sortState?.key === sortKey;
  const Icon = active
    ? sortState.direction === "desc"
      ? ArrowDownNarrowWide
      : ArrowUpNarrowWide
    : ArrowUpDown;
  const nextDirection = active && sortState.direction === "desc" ? "menor a mayor" : "mayor a menor";
  return (
    <button
      className={`sort-header ${active ? "active" : ""}`}
      type="button"
      onClick={() => onSort(sortKey)}
      title={`Ordenar ${label} de ${nextDirection}`}
    >
      <span>{label}</span>
      <Icon size={14} aria-hidden="true" />
    </button>
  );
}

function StrategySortHeader({ label, sortKey, sortState, onSort }: {
  label: string;
  sortKey: StrategySortKey;
  sortState: StrategySortState;
  onSort: (key: StrategySortKey) => void;
}) {
  const active = sortState.key === sortKey;
  const Icon = active
    ? sortState.direction === "desc"
      ? ArrowDownNarrowWide
      : ArrowUpNarrowWide
    : ArrowUpDown;
  const nextDirection = active && sortState.direction === "desc" ? "menor a mayor" : "mayor a menor";
  return (
    <button
      className={`sort-header ${active ? "active" : ""}`}
      type="button"
      onClick={() => onSort(sortKey)}
      title={`Ordenar ${label} de ${nextDirection}`}
    >
      <span>{label}</span>
      <Icon size={14} aria-hidden="true" />
    </button>
  );
}

function QuoteRow({ side, ask, bid }: { side: "UP" | "DOWN"; ask?: number; bid?: number }) {
  return (
    <div className="quote-row">
      <span className={`side ${side.toLowerCase()}`}>{side}</span>
      <span>Ask {formatPrice(ask)}</span>
      <span>Bid {formatPrice(bid)}</span>
    </div>
  );
}

function NumberField({ label, value, min, max, step, onChange }: {
  label: string;
  value: number;
  min: number;
  max?: number;
  step: number;
  onChange: (value: number) => void;
}) {
  const [text, setText] = useState(formatInputValue(value));
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    if (!editing) {
      setText(formatInputValue(value));
    }
  }, [editing, value]);

  function handleChange(nextText: string) {
    setText(nextText);
    const parsed = parseNumberInput(nextText);
    if (parsed !== undefined) {
      onChange(parsed);
    }
  }

  function handleBlur() {
    setEditing(false);
    const parsed = parseNumberInput(text);
    setText(formatInputValue(parsed ?? value));
  }

  return (
    <label className="field">
      <span>{label}</span>
      <input
        type="text"
        inputMode={step % 1 === 0 ? "numeric" : "decimal"}
        value={text}
        data-min={min}
        data-max={max}
        data-step={step}
        spellCheck={false}
        onFocus={() => setEditing(true)}
        onBlur={handleBlur}
        onChange={(event) => handleChange(event.target.value)}
      />
    </label>
  );
}

function parseNumberInput(value: string): number | undefined {
  const normalized = value.trim().replace(",", ".");
  if (normalized === "") {
    return undefined;
  }
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function formatInputValue(value: number | undefined): string {
  return value !== undefined && Number.isFinite(value) ? String(value) : "";
}

function formatAnalysisImportResult(result: AnalysisImportResponse): string {
  const parts = [
    `${result.importedCount} nuevos`,
    `${result.duplicateCount} duplicados`,
    `${result.skippedInvalidCount} invalidos`,
    `${result.totalKnownSamples} totales`,
  ];
  return `Datos importados: ${parts.join(", ")}.`;
}

async function responseErrorMessage(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  if (text) {
    try {
      const payload = JSON.parse(text) as unknown;
      if (payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string") {
        return payload.error;
      }
    } catch {
      return text;
    }
  }
  return text || `HTTP ${response.status}`;
}

function analysisExportFilename(header: string | null): string {
  const match = header?.match(/filename="([^"]+)"/);
  return match?.[1] ?? "polybot-analysis.jsonl";
}

function triggerFileDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error ?? `HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}

function loadOllamaHistory(): OllamaHistoryEntry[] {
  try {
    const raw = window.localStorage.getItem(ollamaHistoryStorageKey);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter(isOllamaHistoryEntry) : [];
  } catch {
    return [];
  }
}

function saveOllamaHistory(entries: OllamaHistoryEntry[]): void {
  try {
    if (entries.length === 0) {
      window.localStorage.removeItem(ollamaHistoryStorageKey);
      return;
    }
    window.localStorage.setItem(ollamaHistoryStorageKey, JSON.stringify(entries));
  } catch {
    // Keeping the in-memory response is still better than interrupting analysis rendering.
  }
}

function createOllamaHistoryId(result: OllamaTradeAnalysisResponse): string {
  return `${result.generatedAtMs}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function isOllamaHistoryEntry(value: unknown): value is OllamaHistoryEntry {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const entry = value as Partial<OllamaHistoryEntry>;
  const result = entry.result as Partial<OllamaTradeAnalysisResponse> | undefined;
  return (
    typeof entry.id === "string" &&
    typeof entry.prompt === "string" &&
    Boolean(result) &&
    typeof result?.generatedAtMs === "number" &&
    typeof result?.model === "string" &&
    typeof result?.content === "string" &&
    typeof result?.contextSummary === "string"
  );
}

function getMarketSnapshots(status: UiStatus | null): MarketStatusSnapshot[] {
  if (status?.markets?.length) {
    return status.markets;
  }
  if (status?.market || status?.tick || status?.opening || status?.quotes) {
    return [
      {
        marketSymbol: status.market?.asset ?? status.tick?.market ?? "BTC",
        market: status.market,
        tick: status.tick,
        opening: status.opening,
        quotes: status.quotes,
        signal: status.signal,
      },
    ];
  }
  return marketOptions.map((market) => ({
    marketSymbol: market.symbol,
    signal: {
      market: market.symbol,
      reason: isAnyOutcomeEnabled(status?.settings.enabledMarketOutcomes, market.symbol) ? "market_not_found" : "disabled",
      inEntryWindow: false,
    },
  }));
}

function activeMarketLine(status: UiStatus | null): string {
  const enabled = enabledOutcomeLabels(status?.settings.enabledMarketOutcomes);
  if (enabled.length === 0) {
    return "sin lados activos";
  }
  return enabled.join(" + ");
}

function enabledMarketsFromOutcomeSettings(settings: UiSettings["enabledMarketOutcomes"]): MarketSymbol[] {
  return marketOptions
    .map((market) => market.symbol)
    .filter((market) => settings[market].UP || settings[market].DOWN);
}

function applyStrategyToSettings(settings: UiSettings, strategy: StrategyCandidate): UiSettings {
  const minDistanceUsdByMarketOutcome = cloneOutcomeNumberSettings(settings.minDistanceUsdByMarketOutcome);
  const entryWindowSecondsByMarketOutcome = cloneOutcomeNumberSettings(settings.entryWindowSecondsByMarketOutcome);
  const maxAskPriceByMarketOutcome = cloneOutcomeNumberSettings(settings.maxAskPriceByMarketOutcome);

  minDistanceUsdByMarketOutcome[strategy.market][strategy.outcome] = strategy.minDistanceUsd;
  entryWindowSecondsByMarketOutcome[strategy.market][strategy.outcome] = strategy.entryWindowSeconds;
  maxAskPriceByMarketOutcome[strategy.market][strategy.outcome] = strategy.maxAskPrice;

  const minDistanceUsdByMarket = {
    ...settings.minDistanceUsdByMarket,
    [strategy.market]: minDistanceUsdByMarketOutcome[strategy.market].UP,
  };
  const entryWindowSecondsByMarket = {
    ...settings.entryWindowSecondsByMarket,
    [strategy.market]: entryWindowSecondsByMarketOutcome[strategy.market].UP,
  };

  return {
    ...settings,
    minBtcDistanceUsd: minDistanceUsdByMarket.BTC,
    minDistanceUsdByMarket,
    minDistanceUsdByMarketOutcome,
    entryWindowSeconds: entryWindowSecondsByMarket.BTC,
    entryWindowSecondsByMarket,
    entryWindowSecondsByMarketOutcome,
    maxAskPrice: maxAskPriceByMarketOutcome.BTC.UP,
    maxAskPriceByMarketOutcome,
  };
}

function strategySettingsPreview(settings: UiSettings, strategy: StrategyCandidate): StrategySettingsPreviewItem[] {
  const currentDistance = settings.minDistanceUsdByMarketOutcome[strategy.market][strategy.outcome];
  const currentWindow = settings.entryWindowSecondsByMarketOutcome[strategy.market][strategy.outcome];
  const currentAskCap = settings.maxAskPriceByMarketOutcome[strategy.market][strategy.outcome];
  return [
    {
      label: "Distancia",
      current: formatMarketDistance(currentDistance, strategy.market),
      next: formatMarketDistance(strategy.minDistanceUsd, strategy.market),
      changed: currentDistance !== strategy.minDistanceUsd,
    },
    {
      label: "Ventana",
      current: formatEntryWindow(currentWindow),
      next: formatEntryWindow(strategy.entryWindowSeconds),
      changed: currentWindow !== strategy.entryWindowSeconds,
    },
    {
      label: "Ask cap",
      current: formatPrice(currentAskCap),
      next: formatPrice(strategy.maxAskPrice),
      changed: currentAskCap !== strategy.maxAskPrice,
    },
  ];
}

function cloneOutcomeNumberSettings<T extends UiSettings["minDistanceUsdByMarketOutcome"]>(settings: T): T {
  return {
    BTC: { ...settings.BTC },
    ETH: { ...settings.ETH },
    DOGE: { ...settings.DOGE },
  } as T;
}

function strategyApplySummary(strategy: StrategyCandidate): string {
  return [
    `${strategy.market} ${strategy.outcome}`,
    formatEntryWindow(strategy.entryWindowSeconds),
    formatMarketDistance(strategy.minDistanceUsd, strategy.market),
    `Ask ${formatPrice(strategy.maxAskPrice)}`,
  ].join(" / ");
}

function strategyCardCountLabel(shown: number, total: number): string {
  return total > shown ? `Mostrando ${shown} de ${total}` : `${total} estrategias visibles`;
}

function enabledOutcomeLabels(settings: UiSettings["enabledMarketOutcomes"] | undefined): string[] {
  if (!settings) {
    return [];
  }
  return marketOptions.flatMap((market) =>
    outcomeOptions
      .filter((outcome) => settings[market.symbol][outcome])
      .map((outcome) => `${market.symbol} ${outcome}`),
  );
}

function isAnyOutcomeEnabled(settings: UiSettings["enabledMarketOutcomes"] | undefined, market: MarketSymbol): boolean {
  return Boolean(settings?.[market]?.UP || settings?.[market]?.DOWN);
}

function tradeMarketLabel(trade: TradeAttempt): string {
  if (trade.asset) {
    return trade.asset;
  }
  const prefix = trade.slug.split("-updown-5m-")[0]?.toUpperCase();
  return prefix || "--";
}

function getTradeMarketSymbol(trade: TradeAttempt): MarketSymbol | undefined {
  if (trade.asset) {
    return trade.asset;
  }
  const label = tradeMarketLabel(trade);
  return marketOptions.find((market) => market.symbol === label)?.symbol;
}

function calculateVisibleTradeAverages(trades: TradeAttempt[], settings?: UiSettings): TradeAverages {
  const pnls = trades.map((trade) => calculateTradePnl(trade));
  return {
    entryWindowSeconds: averageValues(trades.map((trade) => getTradeEntryWindowSeconds(trade, settings))),
    stakeUsd: averageValues(pnls.map((pnl) => pnl.stakeUsd)),
    bestAsk: averageValues(trades.map((trade) => trade.bestAsk)),
    distanceUsd: averageValues(trades.map((trade) => trade.distanceUsd)),
    payoutUsd: averageValues(pnls.map((pnl) => pnl.payoutUsd)),
    netUsd: averageValues(pnls.map((pnl) => pnl.netUsd)),
  };
}

function averageValues(values: Array<number | undefined>): number | undefined {
  const finiteValues = values.filter((value): value is number => value !== undefined && Number.isFinite(value));
  if (finiteValues.length === 0) {
    return undefined;
  }
  return finiteValues.reduce((sum, value) => sum + value, 0) / finiteValues.length;
}

function averageCell(value: string): React.ReactNode {
  if (value === "--") {
    return "";
  }
  return (
    <span className="average-value">
      <span>Prom.</span>
      <strong>{value}</strong>
    </span>
  );
}

function sortTrades(trades: TradeAttempt[], sortState: TradeSortState | undefined, settings?: UiSettings): TradeAttempt[] {
  if (!sortState) {
    return trades;
  }
  return [...trades].sort((left, right) => {
    const leftValue = getTradeSortValue(left, sortState.key, settings);
    const rightValue = getTradeSortValue(right, sortState.key, settings);
    if (leftValue === undefined && rightValue === undefined) {
      return 0;
    }
    if (leftValue === undefined) {
      return 1;
    }
    if (rightValue === undefined) {
      return -1;
    }
    const difference = leftValue - rightValue;
    return sortState.direction === "desc" ? -difference : difference;
  });
}

function sortStrategies(strategies: StrategyCandidate[], sortState: StrategySortState): StrategyCandidate[] {
  return [...strategies].sort((left, right) => {
    const leftValue = getStrategySortValue(left, sortState.key);
    const rightValue = getStrategySortValue(right, sortState.key);
    if (leftValue === undefined && rightValue === undefined) {
      return 0;
    }
    if (leftValue === undefined) {
      return 1;
    }
    if (rightValue === undefined) {
      return -1;
    }
    const difference = leftValue - rightValue;
    return sortState.direction === "desc" ? -difference : difference;
  });
}

function matchesStrategyFilters(
  strategy: StrategyCandidate,
  marketFilter: TradeMarketFilter,
  outcomeFilter: OutcomeFilter,
  qualityFilter: StrategyQualityFilter,
): boolean {
  const marketMatches = marketFilter === "ALL" || strategy.market === marketFilter;
  const outcomeMatches = outcomeFilter === "ALL" || strategy.outcome === outcomeFilter;
  if (!marketMatches || !outcomeMatches) {
    return false;
  }
  if (qualityFilter === "RELIABLE") {
    return isReliableStrategy(strategy);
  }
  if (qualityFilter === "POSITIVE") {
    return (strategy.metrics.evRoi ?? -Infinity) > 0;
  }
  if (qualityFilter === "CURRENT") {
    return strategy.isCurrent;
  }
  return true;
}

function bestReliableStrategyByOutcome(strategies: StrategyCandidate[]): Map<string, StrategyCandidate> {
  const best = new Map<string, StrategyCandidate>();
  for (const strategy of strategies) {
    if (!isReliableStrategy(strategy)) {
      continue;
    }
    const key = strategyOutcomeKey(strategy);
    const current = best.get(key);
    if (!current || (strategy.metrics.evRoi ?? -Infinity) > (current.metrics.evRoi ?? -Infinity)) {
      best.set(key, strategy);
    }
  }
  return best;
}

function isReliableStrategy(strategy: StrategyCandidate): boolean {
  return strategy.confidence === "medium" || strategy.confidence === "high";
}

function getStrategySortValue(strategy: StrategyCandidate, key: StrategySortKey): number | undefined {
  if (key === "entryWindowSeconds" || key === "minDistanceUsd" || key === "maxAskPrice") {
    return strategy[key];
  }
  return strategy.metrics[key];
}

function getTradeSortValue(trade: TradeAttempt, key: TradeSortKey, settings?: UiSettings): number | undefined {
  if (key === "createdAtMs") {
    return trade.createdAtMs;
  }
  if (key === "entryWindowSeconds") {
    return getTradeEntryWindowSeconds(trade, settings);
  }
  if (key === "bestAsk" || key === "distanceUsd") {
    return trade[key];
  }

  const pnl = calculateTradePnl(trade);
  if (key === "stakeUsd") {
    return pnl.stakeUsd;
  }
  if (key === "payoutUsd") {
    return pnl.payoutUsd;
  }
  return pnl.netUsd;
}

function sortAria(key: TradeSortKey, sortState?: TradeSortState): "ascending" | "descending" | "none" {
  if (sortState?.key !== key) {
    return "none";
  }
  return sortState.direction === "asc" ? "ascending" : "descending";
}

function strategySortAria(key: StrategySortKey, sortState: StrategySortState): "ascending" | "descending" | "none" {
  if (sortState.key !== key) {
    return "none";
  }
  return sortState.direction === "asc" ? "ascending" : "descending";
}

function strategyKey(strategy: StrategyCandidate): string {
  return [
    strategy.market,
    strategy.outcome,
    strategy.entryWindowSeconds,
    strategy.minDistanceUsd,
    strategy.maxAskPrice,
    strategy.isCurrent ? "current" : "candidate",
  ].join(":");
}

function strategyOutcomeKey(strategy: Pick<StrategyCandidate, "market" | "outcome">): string {
  return `${strategy.market}:${strategy.outcome}`;
}

function matchesTradePnlFilter(trade: TradeAttempt, filter: TradePnlFilter): boolean {
  if (filter === "ALL") {
    return true;
  }
  const netUsd = calculateTradePnl(trade).netUsd;
  if (netUsd === undefined || !Number.isFinite(netUsd) || netUsd === 0) {
    return false;
  }
  return filter === "POSITIVE" ? netUsd > 0 : netUsd < 0;
}

function emptyTradesMessage(marketFilter: TradeMarketFilter, pnlFilter: TradePnlFilter): string {
  const market = marketFilter === "ALL" ? "todos los mercados" : marketFilter;
  const pnl = pnlFilter === "ALL" ? "cualquier P&L" : pnlFilter === "POSITIVE" ? "P&L positivo" : "P&L negativo";
  return `Sin trades para ${market} y ${pnl}`;
}

function formatUsd(value?: number): string {
  if (value === undefined || !Number.isFinite(value)) {
    return "--";
  }
  return value.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
}

function formatMarketUsd(value: number | undefined, market: MarketSymbol): string {
  if (value === undefined || !Number.isFinite(value)) {
    return "--";
  }
  return value.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: market === "DOGE" ? 6 : 2,
  });
}

function formatSignedUsd(value?: number): string {
  if (value === undefined || !Number.isFinite(value)) {
    return "--";
  }
  const formatted = formatUsd(value);
  return value > 0 ? `+${formatted}` : formatted;
}

function formatDateTime(value?: number): string {
  if (value === undefined || !Number.isFinite(value)) {
    return "--";
  }
  return new Date(value).toLocaleString();
}

function formatPrice(value?: number): string {
  if (value === undefined || !Number.isFinite(value)) {
    return "--";
  }
  return value.toFixed(2);
}

function formatOutcomeSettingRange(
  settings: UiSettings["maxAskPriceByMarketOutcome"] | undefined,
  formatter: (value?: number) => string,
): string {
  if (!settings) {
    return "--";
  }
  const values = marketOptions.flatMap((market) => outcomeOptions.map((outcome) => settings[market.symbol][outcome]));
  const finiteValues = values.filter((value) => Number.isFinite(value));
  if (finiteValues.length === 0) {
    return "--";
  }
  const min = Math.min(...finiteValues);
  const max = Math.max(...finiteValues);
  return min === max ? formatter(min) : `${formatter(min)}-${formatter(max)}`;
}

function formatMarketDistance(value: number | undefined, market: MarketSymbol): string {
  if (value === undefined || !Number.isFinite(value)) {
    return "--";
  }
  return `${value >= 0 ? "+" : ""}${value.toFixed(market === "DOGE" ? 6 : 2)}`;
}

function formatAverageDistance(value: number | undefined, trades: TradeAttempt[]): string {
  if (value === undefined || !Number.isFinite(value)) {
    return "--";
  }
  const allDoge = trades.length > 0 && trades.every((trade) => getTradeMarketSymbol(trade) === "DOGE");
  return `${value >= 0 ? "+" : ""}${value.toFixed(allDoge ? 6 : 2)}`;
}

function formatEntryWindow(value?: number): string {
  if (value === undefined || !Number.isFinite(value)) {
    return "--";
  }
  return `${value}s`;
}

function formatTradeEntryWindow(trade: TradeAttempt, settings?: UiSettings): string {
  return formatEntryWindow(getTradeEntryWindowSeconds(trade, settings));
}

function getTradeEntryWindowSeconds(trade: TradeAttempt, settings?: UiSettings): number | undefined {
  if (trade.entryWindowSeconds !== undefined) {
    return trade.entryWindowSeconds;
  }
  const market = getTradeMarketSymbol(trade);
  if (!market) {
    return undefined;
  }
  return settings?.entryWindowSecondsByMarket[market] ?? settings?.entryWindowSeconds;
}

function formatPercent(value?: number): string {
  if (value === undefined || !Number.isFinite(value)) {
    return "--";
  }
  return `${value > 0 ? "+" : ""}${(value * 100).toFixed(1)}%`;
}

function formatRatio(value?: number): string {
  if (value === undefined || !Number.isFinite(value)) {
    return "--";
  }
  return `${(value * 100).toFixed(1)}%`;
}

function formatDelta(value?: number): string {
  if (value === undefined || !Number.isFinite(value)) {
    return "--";
  }
  return formatPercent(value);
}

function formatRiskFlags(flags: StrategyRiskFlag[]): string {
  if (flags.length === 0) {
    return "OK";
  }
  return flags.map(riskFlagLabel).join(", ");
}

function riskFlagLabel(flag: StrategyRiskFlag): string {
  const labels: Record<StrategyRiskFlag, string> = {
    no_trades: "Sin trades",
    few_trades: "Pocos trades",
    low_quote_coverage: "Baja cobertura",
    negative_ev: "EV negativo",
    insufficient_history: "Historial insuf.",
    unsafe_edge: "Edge < 2%",
    below_min_ev: "EV < 1%",
    avoid_ask: "Ask evitable",
    high_drawdown: "Drawdown alto",
  };
  return labels[flag];
}

function entryDecisionLabel(strategy: StrategyCandidate): string {
  return strategy.metrics.passesRecommendedEntry ? "Entrar\u00eda" : "No entra";
}

function evDecisionReasonLabel(reason: StrategyCandidate["metrics"]["evDecisionReason"]): string {
  if (reason === "passes") {
    return "Regla EV OK";
  }
  if (reason === "insufficient_history") {
    return "Historial insuf.";
  }
  if (reason === "avoid_099") {
    return "Evitar ask 0.99";
  }
  if (reason === "avoid_098") {
    return "Evitar ask 0.98";
  }
  if (reason === "safety_margin") {
    return "Edge < 2%";
  }
  if (reason === "minimum_expected_value") {
    return "EV < 1%";
  }
  return "Sin EV";
}

function confidenceLabel(confidence: StrategyConfidence): string {
  if (confidence === "high") {
    return "Alta";
  }
  if (confidence === "medium") {
    return "Media";
  }
  return "Baja";
}

function emptyStrategyMessage(filter: StrategyQualityFilter): string {
  if (filter === "RELIABLE") {
    return "Sin estrategias confiables todavia. Revisa Todas o acumula mas muestras con EV conservador.";
  }
  if (filter === "POSITIVE") {
    return "Sin estrategias con EV positivo para estos filtros.";
  }
  if (filter === "CURRENT") {
    return "Sin estrategias actuales para estos filtros.";
  }
  return "Sin estrategias con EV calculable.";
}

function formatTradePnl(pnl: TradePnl): string {
  return pnl.status === "resolved" ? formatSignedUsd(pnl.netUsd) : "--";
}

function formatTradePayout(pnl: TradePnl): string {
  return pnl.status === "resolved" ? formatUsd(pnl.payoutUsd) : "--";
}

function tradeStatusLabel(trade: TradeAttempt): string {
  if (trade.resolved) {
    const result = trade.resolved.won ? "Gano" : "Perdio";
    if (trade.mode === "live") {
      return trade.fillSource === "clob_trades" ? `${result} CLOB` : `${result} est.`;
    }
    return result;
  }
  if (trade.mode === "live" && !hasResolvablePosition(trade)) {
    return "Sin fill";
  }
  if (trade.mode === "live") {
    return trade.fillSource === "clob_trades" ? "Confirmado" : "Pendiente est.";
  }
  return trade.status ?? "registrado";
}

function pnlTone(value?: number): "positive" | "negative" | "neutral" {
  if (value === undefined || !Number.isFinite(value) || value === 0) {
    return "neutral";
  }
  return value > 0 ? "positive" : "negative";
}

function getInitialTheme(): Theme {
  try {
    const stored = window.localStorage.getItem(themeStorageKey);
    if (stored === "light" || stored === "dark") {
      return stored;
    }
    return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  } catch {
    return "light";
  }
}

function reasonLabel(reason?: string): string {
  const labels: Record<string, string> = {
    no_market: "Sin mercado",
    no_markets_enabled: "Sin mercados activos",
    disabled: "Desactivado",
    market_not_found: "Mercado no encontrado",
    market_not_accepting_orders: "Mercado cerrado",
    missing_opening_chainlink_tick: "Sin apertura",
    missing_current_chainlink_tick: "Sin tick",
    stale_chainlink_tick: "Tick stale",
    btc_distance_below_threshold: "Sin distancia",
    outcome_disabled: "Lado apagado",
    waiting_entry_window: "Esperando ventana",
    signal_ready: "Lista",
    snapshot_error: "Error snapshot",
    missing_live_configuration: "Faltan credenciales",
  };
  return labels[reason ?? ""] ?? reason ?? "--";
}


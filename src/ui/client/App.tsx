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
  Eye,
  EyeOff,
  Gauge,
  Moon,
  Pause,
  Play,
  Radio,
  Receipt,
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
  TrendingDown,
  TrendingUp,
  Upload,
} from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";

import type { LogEntry } from "../../logger.js";
import { summarizeLogs } from "../../agent/statusSummary.js";
import { calculateTradePnl, type PnlResetAtMsByMode, type PnlSummary, type TradePnl } from "../../pnl.js";
import { hasResolvablePosition } from "../../tradeResolution.js";
import {
  buildEquitySeries,
  calibrationBuckets,
  cumulativeRoi,
  hourOfDayHistogram,
  netDistribution,
  perMarketSide,
  projectionEstimates,
  resolvedTradesForCharts,
  rollingWinRate,
  tradesPerDaySeries,
  validationProgress,
  type LabeledValue,
} from "./chartData.js";
import { BarChart, CalibrationChart, Sparkline } from "./charts.js";
import { formatDateTimeInTimeZone, formatTimeInTimeZone } from "../../timezone.js";
import type {
  AiRecommendation,
  AiRecommendationsResponse,
  AutoApplyThresholds,
  MarketSymbol,
  Mode,
  Outcome,
  RecommendationCandidate,
  RecommendationMetrics,
  TradeAttempt,
} from "../../types.js";
import { summarizeAskBands, type AskBandSummary } from "../../askBands.js";
import type { FiscalMonthSummary } from "../../fiscal.js";
import type {
  AnalysisImportResponse,
  FiscalSummaryResponse,
  MarketStatusSnapshot,
  StartBotRequest,
  TelegramNotificationPatch,
  TelegramNotificationSettings,
  UiSettings,
  UiStatus,
} from "../shared.js";

type Tab = "dashboard" | "trades" | "fiscal" | "analysis" | "settings" | "telegram" | "logs";
type Theme = "light" | "dark";
type TradeMarketFilter = "ALL" | MarketSymbol;
type TradePnlFilter = "ALL" | "POSITIVE" | "NEGATIVE";
type TradeSortKey = "createdAtMs" | "entryWindowSeconds" | "stakeUsd" | "bestAsk" | "distanceUsd" | "payoutUsd" | "netUsd";
type TradeSortDirection = "asc" | "desc";
type OutcomeFilter = "ALL" | Outcome;

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




const themeStorageKey = "polybot-theme";
const pnlModeStorageKey = "polybot-pnl-mode";
const hideAmountsStorageKey = "polybot-hide-amounts";
// What money looks like with the privacy toggle on: fixed-width so the layout never jumps.
const MASKED_AMOUNT = "$ ••••";
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
  riskHaltCooldownHours: 2,
  arbEnabled: false,
  arbMaxUsdPerOpportunity: 25,
  arbMinNetPerSet: 0.02,
  timezone: "auto",
  requirePositiveEv: true,
  evUseSimilarity: false,
  evCalibration: false,
  evSafetyMargin: 0.03,
  evMinHistoryTrades: 15,
  minFillRatio: 0.5,
  evMinExpectedRoi: 0.01,
  tickStaleMs: 10_000,
  pollIntervalMs: 1_000,
  openingCaptureGraceMs: 15_000,
  aiAutoApplyLive: false,
  aiAutoTuneAskCap: false,
};

const marketOptions: Array<{ symbol: MarketSymbol; label: string; step: number; min: number }> = [
  { symbol: "BTC", label: "Bitcoin", step: 1, min: 1 },
  { symbol: "ETH", label: "Ethereum", step: 0.5, min: 0.1 },
  { symbol: "DOGE", label: "Dogecoin", step: 0.0001, min: 0.0001 },
];

const outcomeOptions: Outcome[] = ["UP", "DOWN"];

type OutcomeNumberSettings = UiSettings["maxAskPriceByMarketOutcome"];

function mapOutcomeSettings(settings: OutcomeNumberSettings, fn: (value: number) => number): OutcomeNumberSettings {
  const next = {} as OutcomeNumberSettings;
  for (const { symbol } of marketOptions) {
    next[symbol] = { UP: fn(settings[symbol].UP), DOWN: fn(settings[symbol].DOWN) };
  }
  return next;
}

// The single value shared by every market/outcome, or undefined when they differ (per-side fine-tuning).
function commonOutcomeValue(settings: OutcomeNumberSettings): number | undefined {
  const values = marketOptions.flatMap(({ symbol }) => [settings[symbol].UP, settings[symbol].DOWN]);
  return values.every((value) => value === values[0]) ? values[0] : undefined;
}


export function App() {
  const [status, setStatus] = useState<UiStatus | null>(null);
  const [trades, setTrades] = useState<TradeAttempt[]>([]);
  const [settings, setSettings] = useState<UiSettings>(emptySettings);
  const [recommendations, setRecommendations] = useState<AiRecommendationsResponse | null>(null);
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [analysisError, setAnalysisError] = useState<string | null>(null);
  const [analysisStale, setAnalysisStale] = useState(true);
  const [tab, setTab] = useState<Tab>("dashboard");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [liveModal, setLiveModal] = useState(false);
  const [resetModal, setResetModal] = useState(false);
  const [theme, setTheme] = useState<Theme>(() => getInitialTheme());
  const [hideAmounts, setHideAmounts] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem(hideAmountsStorageKey) === "true";
    } catch {
      return false;
    }
  });
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
      const nextRecommendations = await api<AiRecommendationsResponse>("/api/analysis/recommendations");
      if (analysisRequestId.current === requestId) {
        setRecommendations(nextRecommendations);
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

  async function applyRecommendation(market: MarketSymbol, recommended: RecommendationCandidate) {
    await persistSettings(applyRecommendationToSettings(settings, market, recommended), true);
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
      setRecommendations(null);
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

  async function resetRiskHalt(mode: Mode) {
    setBusy(true);
    setError(null);
    try {
      setStatus(await api<UiStatus>("/api/risk/reset", { method: "POST", body: JSON.stringify({ mode }) }));
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
          <TabButton active={tab === "fiscal"} icon={<Receipt size={18} />} label="Fiscal" onClick={() => setTab("fiscal")} />
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
            <PrivacyToggle
              hidden={hideAmounts}
              onToggle={() =>
                setHideAmounts((current) => {
                  const next = !current;
                  try {
                    window.localStorage.setItem(hideAmountsStorageKey, String(next));
                  } catch {
                    // Storage unavailable (private mode): the toggle still works for the session.
                  }
                  return next;
                })
              }
            />
            <ThemeToggle
              theme={theme}
              onToggle={() => setTheme((current) => (current === "dark" ? "light" : "dark"))}
            />
            <ControlBar
              status={status}
              busy={busy}
              onStartSim={() => startBot({ mode: "sim" })}
              onOpenLive={() => setLiveModal(true)}
              onStop={stopBot}
              onRefresh={() => refreshCore()}
            />
          </div>
        </header>

        {error && <div className="notice error"><AlertTriangle size={18} />{error}</div>}

        {tab === "dashboard" && (
          <Dashboard status={status} trades={trades} busy={busy} hideAmounts={hideAmounts} onResetPnl={resetPnl} onResetRiskHalt={resetRiskHalt} />
        )}
        {tab === "trades" && <TradesTable trades={trades} settings={settings} hideAmounts={hideAmounts} />}
        {tab === "fiscal" && <FiscalPanel />}
        {tab === "analysis" && (
          <>
            <AnalysisChartsSection />
            <AskBandsSection />
            <AnalysisPanel
              recommendations={recommendations}
              loading={analysisLoading}
              loadError={analysisError}
              stale={analysisStale}
              settings={settings}
              busy={busy}
              running={Boolean(status?.running)}
              onRefresh={loadAnalysis}
              onApplyRecommendation={applyRecommendation}
              onExport={downloadAnalysisSamples}
              onImport={importAnalysisSamples}
            />
          </>
        )}
        {tab === "settings" && (
          <SettingsPanel
            settings={settings}
            running={Boolean(status?.running)}
            busy={busy}
            onSave={saveSettings}
            onOpenReset={() => setResetModal(true)}
          />
        )}
        {tab === "telegram" && <TelegramPanel />}
        {tab === "logs" && <LogsPanel logs={status?.logs ?? []} timeZone={status?.settings.timezone} />}
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

function PrivacyToggle({ hidden, onToggle }: { hidden: boolean; onToggle: () => void }) {
  const label = hidden ? "Mostrar montos" : "Ocultar montos";
  return (
    <button className="icon-button privacy-toggle" title={label} aria-label={label} aria-pressed={hidden} onClick={onToggle}>
      {hidden ? <EyeOff size={18} /> : <Eye size={18} />}
    </button>
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
  trades = [],
  busy,
  hideAmounts = false,
  onResetPnl,
  onResetRiskHalt,
}: {
  status: UiStatus | null;
  trades?: TradeAttempt[];
  busy: boolean;
  hideAmounts?: boolean;
  onResetPnl: (mode: Mode) => void;
  onResetRiskHalt: (mode: Mode) => void;
}) {
  const marketSnapshots = getMarketSnapshots(status);
  const [selectedPnlMode, setSelectedPnlMode] = useState<Mode>(() => getStoredPnlMode() ?? "sim");
  // Follow the bot's running mode only while the user has never picked one themselves; an explicit
  // choice (persisted) always wins across reloads.
  useEffect(() => {
    if (getStoredPnlMode() === undefined && status?.mode) {
      setSelectedPnlMode(status.mode);
    }
  }, [status?.mode]);
  function choosePnlMode(mode: Mode) {
    setSelectedPnlMode(mode);
    try {
      window.localStorage.setItem(pnlModeStorageKey, mode);
    } catch {
      // Storage unavailable: selection still applies for the session.
    }
  }
  const money = (formatted: string) => (hideAmounts ? MASKED_AMOUNT : formatted);
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
              {riskHalt.resumeAtMs
                ? `Se re-arma solo a las ${formatTimeInTimeZone(riskHalt.resumeAtMs, status?.settings.timezone)}, o reinícialo ahora sin cambiar el límite.`
                : "Reanuda solo el próximo día calendario, o reinícialo ahora sin cambiar el límite."}
            </span>
          </div>
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => onResetRiskHalt(status?.mode ?? "sim")}
          >
            Reiniciar breaker
          </button>
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
              onClick={() => choosePnlMode("sim")}
            >
              Sim
            </button>
            <button
              aria-label="Ver P&L live"
              className={`segment-button ${selectedPnlMode === "live" ? "active" : ""}`}
              onClick={() => choosePnlMode("live")}
            >
              Live
            </button>
          </div>
        </div>
        <PnlModeSummary
          label={selectedPnlLabel}
          summary={selectedPnl}
          busy={busy}
          hideAmounts={hideAmounts}
          resetAtMs={status?.pnlResetAtMs?.[selectedPnlMode]}
          timeZone={status?.settings.timezone}
          onReset={() => onResetPnl(selectedPnlMode)}
        />
        <PnlCharts trades={trades} mode={selectedPnlMode} resetAtMs={status?.pnlResetAtMs} hideAmounts={hideAmounts} />
      </section>

      <section className="panel limits-panel">
        <div className="section-heading">
          <Pause size={18} />
          <h2>Riesgo</h2>
        </div>
        <div className="hero-metrics compact">
          <Metric label="Gasto diario" value={money(formatUsd(status?.dailySpendUsd))} />
          <Metric label="Limite gasto" value={formatUsd(status?.settings.dailySpendLimitUsd)} />
          <Metric label="Ask cap" value={formatOutcomeSettingRange(status?.settings.maxAskPriceByMarketOutcome, formatPrice)} />
          <Metric
            label="Perdida hoy"
            value={money(formatUsd(riskHalt?.dailyLossUsd ?? 0))}
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
  recommendations,
  loading = false,
  loadError = null,
  stale = false,
  settings,
  busy,
  running,
  onRefresh,
  onApplyRecommendation,
  onExport,
  onImport,
}: {
  recommendations: AiRecommendationsResponse | null;
  loading?: boolean;
  loadError?: string | null;
  stale?: boolean;
  settings: UiSettings;
  busy: boolean;
  running: boolean;
  onRefresh: () => Promise<void>;
  onApplyRecommendation: (market: MarketSymbol, recommended: RecommendationCandidate) => Promise<void>;
  onExport?: () => Promise<void>;
  onImport?: (file: File) => Promise<AnalysisImportResponse>;
}) {
  const [applyMessage, setApplyMessage] = useState<string | null>(null);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [applyingMarket, setApplyingMarket] = useState<MarketSymbol | null>(null);
  const [transferBusy, setTransferBusy] = useState(false);
  const [transferMessage, setTransferMessage] = useState<string | null>(null);
  const [transferError, setTransferError] = useState<string | null>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  const items = recommendations?.recommendations ?? [];
  const thresholds = recommendations?.thresholds;
  const autoApplyOn = Boolean(settings.aiAutoApplyLive);

  async function applyRecommendation(market: MarketSymbol, recommended: RecommendationCandidate) {
    setApplyMessage(null);
    setApplyError(null);
    setApplyingMarket(market);
    try {
      await onApplyRecommendation(market, recommended);
      setApplyMessage(
        `Aplicada la recomendada de ${market}: ventana ${formatEntryWindow(recommended.entryWindowSeconds)}, distancia ${formatMarketDistance(recommended.minDistanceUsd, market)}.`,
      );
    } catch (caught) {
      setApplyError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setApplyingMarket(null);
    }
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
          Calculando recomendaciones del autoajuste...
        </div>
      )}
      {loadError && (
        <div className="notice error compact-notice">
          <AlertTriangle size={18} />
          {loadError}
        </div>
      )}
      {stale && recommendations && !loading && !loadError && (
        <div className="notice compact-notice">
          <AlertTriangle size={18} />
          Recomendaciones pendientes de actualizar.
        </div>
      )}
      {applyMessage && (
        <div className="notice success compact-notice">
          <CheckCircle2 size={18} />
          {applyMessage}
        </div>
      )}
      {applyError && (
        <div className="notice error compact-notice">
          <AlertTriangle size={18} />
          {applyError}
        </div>
      )}

      <div className="recommendation-summary">
        <div className="recommendation-summary-main">
          <span className={`chip ${autoApplyOn ? "chip-on" : "chip-neutral"}`}>
            {autoApplyOn ? "Autoajuste ON" : "Autoajuste OFF"}
          </span>
          {items.length > 0 && (
            <span className="recommendation-counts">
              <strong>{items.filter((r) => r.canAutoApply).length}</strong> se auto-aplican ·{" "}
              <strong>{items.filter((r) => r.canApply && !r.canAutoApply).length}</strong> sugerencias ·{" "}
              <strong>{items.filter((r) => !r.canApply).length}</strong> sin datos
            </span>
          )}
          {recommendations?.totalSamples !== undefined && (
            <span className="recommendation-samples" title="Muestras de análisis almacenadas en total">
              {recommendations.totalSamples.toLocaleString("es-MX")} muestras
            </span>
          )}
          {recommendations && (
            <span className="recommendation-fresh">Actualizado {formatDateTime(recommendations.generatedAtMs, settings.timezone)}</span>
          )}
        </div>
        <p className="recommendation-summary-note">
          La mejor configuración por mercado según el motor del autoajuste (se valida fuera de muestra).{" "}
          {autoApplyOn
            ? "Las marcadas “Se auto-aplica” se aplican solas cada ~60s."
            : "Actívalo en Settings → Autoajuste para que se apliquen solas."}
        </p>
      </div>

      <div className="recommendation-grid">
        {items.length === 0 ? (
          <div className="empty-state">
            {loading ? "Calculando recomendaciones…" : "Aún no hay recomendaciones. Actualiza o espera más muestras."}
          </div>
        ) : (
          [...items]
            .sort((a, b) => RECOMMENDATION_MARKET_ORDER.indexOf(a.market) - RECOMMENDATION_MARKET_ORDER.indexOf(b.market))
            .map((rec) => {
              const best = rec.recommended ?? rec.current;
              const m = best.metrics;
              const badgeLabel = rec.canAutoApply
                ? "Se auto-aplica"
                : rec.canApply
                  ? "Sugerencia (no auto)"
                  : rec.status === "insufficient_data"
                    ? "Datos insuficientes"
                    : "Sin cambio";
              const badgeClass = rec.canAutoApply ? "chip-on" : rec.canApply ? "chip-warn" : "chip-neutral";
              const badgeIcon = rec.canAutoApply ? <CheckCircle2 size={14} /> : rec.canApply ? <AlertTriangle size={14} /> : null;
              const windowChanged = rec.recommended !== undefined && rec.recommended.entryWindowSeconds !== rec.current.entryWindowSeconds;
              const distanceChanged = rec.recommended !== undefined && rec.recommended.minDistanceUsd !== rec.current.minDistanceUsd;
              const reqs = thresholds
                ? [
                    { key: "conf", short: "confianza", label: "Confianza", value: confidenceEs(rec.confidence), threshold: "alta", ok: rec.confidence === "high" },
                    { key: "trades", short: "trades", label: "Trades", value: String(m.tradeCount), threshold: String(thresholds.minAutoTrades), ok: m.tradeCount >= thresholds.minAutoTrades },
                    { key: "cov", short: "cobertura", label: "Cobertura", value: formatRatio(m.quoteCoverage), threshold: formatRatio(thresholds.minQuoteCoverage), ok: m.quoteCoverage >= thresholds.minQuoteCoverage },
                    { key: "over", short: "sobreajuste", label: "Sobreajuste", value: m.overfitRisk.toFixed(2), threshold: `${thresholds.maxOverfitRisk.toFixed(2)} máx`, ok: m.overfitRisk <= thresholds.maxOverfitRisk },
                    { key: "roi", short: "retorno", label: "Retorno", value: formatPercent(m.walkForwardRoi), threshold: ">0", ok: (m.lowerBoundRoi ?? -1) > 0 && (m.walkForwardRoi ?? -1) > 0 },
                    { key: "yield", short: "mejora", label: "Mejora", value: (rec.improvementYield ?? 0).toFixed(4), threshold: thresholds.minYieldImprovement.toString(), ok: (rec.improvementYield ?? -1) >= thresholds.minYieldImprovement },
                  ]
                : [];
              const failing = reqs.filter((req) => !req.ok);
              return (
                <article className="recommendation-card" key={rec.market}>
                  <div className="recommendation-card-head">
                    <h3>{rec.market}</h3>
                    <span className={`chip ${badgeClass}`}>{badgeIcon}{badgeLabel}</span>
                  </div>
                  <div className="recommendation-configs">
                    <div className="recommendation-config">
                      <span className="recommendation-config-label">Actual</span>
                      <strong>{formatEntryWindow(rec.current.entryWindowSeconds)} / {formatMarketDistance(rec.current.minDistanceUsd, rec.market)}</strong>
                    </div>
                    <span className="recommendation-arrow" aria-hidden="true">{"→"}</span>
                    <div className={`recommendation-config ${rec.recommended ? "recommended" : ""}`}>
                      <span className="recommendation-config-label">Recomendada</span>
                      <strong>
                        {rec.recommended ? (
                          <>
                            <span className={windowChanged ? "changed-value" : ""}>{formatEntryWindow(rec.recommended.entryWindowSeconds)}</span>
                            {" / "}
                            <span className={distanceChanged ? "changed-value" : ""}>{formatMarketDistance(rec.recommended.minDistanceUsd, rec.market)}</span>
                          </>
                        ) : (
                          "—"
                        )}
                      </strong>
                    </div>
                  </div>
                  <p className="recommendation-plain">
                    Opera ~{formatRatio(executionRate(m))} de las ventanas · aciertos {winRateText(m)} · retorno validado{" "}
                    <span className={pnlTone(m.walkForwardRoi)}>{formatPercent(m.walkForwardRoi)}</span> · riesgo {riskLevel(m.overfitRisk, thresholds)}
                  </p>
                  {reqs.length > 0 && (
                    failing.length === 0 ? (
                      <p className="requirements-ok"><CheckCircle2 size={15} /> Cumple los requisitos para auto-aplicar.</p>
                    ) : (
                      <p className="requirements-missing"><AlertTriangle size={15} /> Falta: {failing.map((req) => req.short).join(", ")}.</p>
                    )
                  )}
                  {reqs.length > 0 && (
                    <div className="requirement-chips">
                      {reqs.map((req) => (
                        <span className={`req-chip ${req.ok ? "ok" : "fail"}`} key={req.key} title={`${req.label}: ${req.value} (mín/máx ${req.threshold})`}>
                          <span className="req-chip-icon" aria-hidden="true">{req.ok ? "✓" : "✗"}</span>
                          {req.label} {req.value}<span className="req-chip-thr">/{req.threshold}</span>
                        </span>
                      ))}
                    </div>
                  )}
                  {rec.recommended && (
                    <button
                      className="command primary"
                      type="button"
                      onClick={() => rec.recommended && applyRecommendation(rec.market, rec.recommended)}
                      disabled={busy || running || applyingMarket !== null}
                      title={running ? "Detén el bot para aplicar manualmente" : "Aplicar la config recomendada"}
                      aria-label={`Aplicar recomendada ${rec.market}`}
                    >
                      <Save size={18} /> {applyingMarket === rec.market ? "Aplicando…" : "Aplicar recomendada"}
                    </button>
                  )}
                </article>
              );
            })
        )}
      </div>
    </section>
  );
}

function executionRate(m: RecommendationMetrics): number {
  return m.sampleCount > 0 ? m.tradeCount / m.sampleCount : 0;
}

function winRateText(m: RecommendationMetrics): string {
  const decided = m.winCount + m.lossCount;
  if (decided > 0) {
    return `${Math.round((m.winCount / decided) * 100)}% (${m.winCount}/${decided})`;
  }
  if (m.predictedWinProbability !== undefined) {
    return `~${Math.round(m.predictedWinProbability * 100)}%`;
  }
  return "--";
}

function riskLevel(overfit: number, thresholds?: AutoApplyThresholds): string {
  const max = thresholds?.maxOverfitRisk ?? 0.45;
  if (overfit <= 0.2) {
    return "bajo";
  }
  return overfit <= max ? "medio" : "alto";
}

function confidenceEs(confidence: string): string {
  return confidence === "high" ? "alta" : confidence === "medium" ? "media" : "baja";
}

// Fixed card order for the Análisis tab.
const RECOMMENDATION_MARKET_ORDER: MarketSymbol[] = ["BTC", "ETH", "DOGE"];

const TIMEZONE_OPTIONS: { value: string; label: string }[] = [
  { value: "auto", label: "Auto (zona del sistema)" },
  { value: "America/Mexico_City", label: "Ciudad de México" },
  { value: "America/Cancun", label: "Cancún" },
  { value: "America/Tijuana", label: "Tijuana" },
  { value: "UTC", label: "UTC" },
  { value: "America/New_York", label: "Nueva York (ET)" },
  { value: "America/Chicago", label: "Chicago (CT)" },
  { value: "America/Los_Angeles", label: "Los Ángeles (PT)" },
  { value: "Europe/Madrid", label: "Madrid" },
];


function PnlModeSummary({
  label,
  summary,
  busy,
  hideAmounts = false,
  resetAtMs,
  timeZone,
  onReset,
}: {
  label: string;
  summary?: PnlSummary;
  busy: boolean;
  hideAmounts?: boolean;
  resetAtMs?: number;
  timeZone?: string;
  onReset: () => void;
}) {
  const money = (formatted: string) => (hideAmounts ? MASKED_AMOUNT : formatted);
  return (
    <div className="pnl-mode-summary">
      <div className="pnl-mode-header">
        <span>{label}</span>
        <div className="pnl-mode-actions">
          <strong className={`pnl-mode-net ${pnlTone(summary?.realizedUsd)}`}>
            {money(formatSignedUsd(summary?.realizedUsd))}
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
        <Metric label="Win rate" value={formatWinRate(summary)} tone={winRateTone(summary)} />
        <Metric label="ROI" value={formatPercent(summary?.roiPct)} tone={pnlTone(summary?.realizedUsd)} />
        <Metric label="Invertido" value={money(formatUsd(summary?.realizedStakeUsd))} />
        <Metric label="Reclamado" value={money(formatUsd(summary?.payoutUsd))} />
        <Metric label="Pendiente" value={money(formatUsd(summary?.pendingStakeUsd))} />
      </div>
      <p className="pnl-reset-line">
        Reset {label}: {resetAtMs ? formatDateTimeInTimeZone(resetAtMs, timeZone) : "nunca"}
      </p>
    </div>
  );
}

function PnlCharts({
  trades,
  mode,
  resetAtMs,
  hideAmounts,
}: {
  trades: TradeAttempt[];
  mode: Mode;
  resetAtMs?: PnlResetAtMsByMode;
  hideAmounts?: boolean;
}) {
  const series = resolvedTradesForCharts(trades, mode, resetAtMs ?? {});
  if (series.length < 2) {
    return <p className="chart-empty">Se necesitan ≥2 trades resueltos post-reset para las gráficas.</p>;
  }
  const equity = buildEquitySeries(series).map((point) => point.cumulativeUsd);
  const winRate = rollingWinRate(series).map((value) => value * 100);
  const roi = cumulativeRoi(series).map((value) => value * 100);
  const netUsd = equity[equity.length - 1];
  const lastWin = winRate[winRate.length - 1];
  const lastRoi = roi[roi.length - 1];
  const progress = validationProgress(series);
  const band = hideAmounts ? MASKED_AMOUNT : `±${formatUsd(progress.varianceBandUsd)}`;
  return (
    <>
    <p className={`validation-context ${progress.withinBand ? "" : "signal"}`}>
      Validación: <strong>{Math.min(progress.resolvedCount, progress.target)}/{progress.target}</strong> trades
      {" · "}
      {progress.withinBand
        ? `P&L dentro del rango esperado por varianza (${band}) — aún no significativo`
        : `P&L FUERA del rango de varianza (${band}) — esto ya es señal, no ruido`}
    </p>
    <div className="dashboard-charts">
      <div className="chart-card">
        <h3>P&L acumulado</h3>
        <span className={`chart-value ${pnlTone(netUsd)}`}>{hideAmounts ? MASKED_AMOUNT : formatSignedUsd(netUsd)}</span>
        <Sparkline values={equity} title="P&L acumulado post-reset" />
      </div>
      <div className="chart-card">
        <h3>Win rate (móvil 20)</h3>
        <span className="chart-value">{lastWin.toFixed(0)}%</span>
        <Sparkline values={winRate} baseline={50} title="Win rate móvil (línea = 50%)" />
      </div>
      <div className="chart-card">
        <h3>ROI acumulado</h3>
        <span className={`chart-value ${pnlTone(lastRoi)}`}>{lastRoi.toFixed(1)}%</span>
        <Sparkline values={roi} title="ROI acumulado post-reset" />
      </div>
    </div>
    </>
  );
}

function getStoredPnlMode(): Mode | undefined {
  try {
    const stored = window.localStorage.getItem(pnlModeStorageKey);
    return stored === "sim" || stored === "live" ? stored : undefined;
  } catch {
    return undefined;
  }
}

function formatWinRate(summary?: PnlSummary): string {
  const resolved = (summary?.wonCount ?? 0) + (summary?.lostCount ?? 0);
  if (!summary || resolved === 0) {
    return "—";
  }
  return `${summary.wonCount}-${summary.lostCount} · ${Math.round((100 * summary.wonCount) / resolved)}%`;
}

function winRateTone(summary?: PnlSummary): "positive" | "negative" | "neutral" {
  const resolved = (summary?.wonCount ?? 0) + (summary?.lostCount ?? 0);
  if (!summary || resolved === 0) {
    return "neutral";
  }
  return summary.wonCount / resolved >= 0.5 ? "positive" : "negative";
}


export function TradesTable({
  trades,
  settings,
  hideAmounts = false,
}: {
  trades: TradeAttempt[];
  settings?: UiSettings;
  hideAmounts?: boolean;
}) {
  const money = (formatted: string) => (hideAmounts ? MASKED_AMOUNT : formatted);
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
                <th>{averageCell(money(formatUsd(averages.stakeUsd)))}</th>
                <th>{averageCell(formatPrice(averages.bestAsk))}</th>
                <th>{averageCell(formatAverageDistance(averages.distanceUsd, filteredTrades))}</th>
                <th>{averageCell(money(formatUsd(averages.payoutUsd)))}</th>
                <th>{averageCell(money(formatSignedUsd(averages.netUsd)))}</th>
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
                    <td data-label="Hora">{formatDateTimeInTimeZone(trade.createdAtMs, settings?.timezone)}</td>
                    <td data-label="Mercado">{tradeMarketLabel(trade)}</td>
                    <td data-label="Ventana">{formatTradeEntryWindow(trade, settings)}</td>
                    <td data-label="Modo">{trade.mode.toUpperCase()}</td>
                    <td data-label="Lado"><span className={`side ${trade.outcome.toLowerCase()}`}>{trade.outcome}</span></td>
                    <td data-label="Invertido">{money(formatUsd(pnl.stakeUsd))}</td>
                    <td data-label="Ask">{formatPrice(trade.bestAsk)}</td>
                    <td data-label="Distancia">{formatMarketDistance(trade.distanceUsd, marketSymbol)}</td>
                    <td data-label="Reclamado">{money(formatTradePayout(pnl))}</td>
                    <td data-label="P&L"><span className={`pnl-value ${pnlTone(pnl.netUsd)}`}>{money(formatTradePnl(pnl))}</span></td>
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

export function SettingsPanel({ settings, running, busy, onSave, onOpenReset }: {
  settings: UiSettings;
  running: boolean;
  busy: boolean;
  onSave: (settings: UiSettings) => Promise<void>;
  onOpenReset?: () => void;
}) {
  const [draft, setDraft] = useState(settings);
  const [selectedMarket, setSelectedMarket] = useState<MarketSymbol>("BTC");
  const selectedMarketOption = marketOptions.find((market) => market.symbol === selectedMarket) ?? marketOptions[0];
  const activeLabels = enabledOutcomeLabels(draft.enabledMarketOutcomes);
  useEffect(() => setDraft(settings), [settings]);

  const commonAskCap = commonOutcomeValue(draft.maxAskPriceByMarketOutcome);

  function update(key: keyof UiSettings, value: number | boolean | string) {
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

  // Set the same ask cap on all 6 market/outcomes at once (clamped to the ceiling so the global control
  // can't exceed the hard ceiling). Per-side fine-tuning below still works.
  function setAllAskCaps(value: number) {
    setDraft((current) => {
      const capped = Math.min(value, current.maxAskPriceCeiling);
      const maxAskPriceByMarketOutcome = mapOutcomeSettings(current.maxAskPriceByMarketOutcome, () => capped);
      return {
        ...current,
        maxAskPrice: capped,
        maxAskPriceByMarketOutcome,
      };
    });
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
              </div>
            ))}
          </div>
        </section>
      </div>

      <section className="settings-advanced">
        <div className="section-heading">
          <Brain size={18} />
          <h2>Autoajuste</h2>
        </div>
        <label className="switch-row">
          <input
            type="checkbox"
            checked={draft.aiAutoApplyLive}
            onChange={(event) => update("aiAutoApplyLive", event.target.checked)}
            disabled={running}
          />
          <span>Autoajuste predictivo — mejor estrategia por ventana (sim y live)</span>
        </label>
        <p className="settings-hint">
          Único autoajuste del bot. Un modelo estadístico local (backtesting walk-forward + estimación k-NN, sin LLM ni
          internet) evalúa las muestras de Análisis cada ~60s mientras el bot corre y aplica automáticamente la mejor
          ventana y distancia por mercado/lado cuando hay alta confianza y dentro de las guardas. Corre idéntico en sim y
          en live (sin cooldown), así que una prueba en sim predice lo que hará en live. Actívalo antes de iniciar el bot.
        </p>
        <label className="switch-row">
          <input
            type="checkbox"
            checked={draft.aiAutoTuneAskCap}
            onChange={(event) => update("aiAutoTuneAskCap", event.target.checked)}
            disabled={running}
          />
          <span>Auto-tuning del ask cap por bandas realizadas (live)</span>
        </label>
        <p className="settings-hint">
          Deriva el cap por mercado de la tabla de bandas de ask con fills reales: extiende el cap mientras cada banda
          (≥20 trades) supere su break-even por 3pp. Candados: rango 0.45–0.85, cambio máx ±0.05 por aplicación, cooldown
          24h por mercado, y notificación por Telegram en cada cambio.
        </p>
      </section>

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
        <label className="field">
          <span>Zona horaria</span>
          <select value={draft.timezone} onChange={(event) => update("timezone", event.target.value)}>
            {TIMEZONE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <p className="settings-hint">
          Se usa para todo: horas y fechas mostradas, gráficas por hora/día, días fiscales y el corte del día de riesgo
          (límite diario y freno de pérdidas). "Auto" = zona del sistema.
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
            label="Cooldown del freno (horas)"
            value={draft.riskHaltCooldownHours}
            min={0}
            step={0.5}
            onChange={(value) => update("riskHaltCooldownHours", value)}
          />
          <NumberField
            label="Techo de ask cap"
            value={draft.maxAskPriceCeiling}
            min={0.5}
            max={0.98}
            step={0.01}
            onChange={(value) => update("maxAskPriceCeiling", value)}
          />
          <label className="field">
            <span>Ask cap (todos los mercados/lados)</span>
            <input
              type="number"
              min={0.01}
              max={1}
              step={0.01}
              placeholder={commonAskCap === undefined ? "mixto" : undefined}
              value={commonAskCap === undefined ? "" : commonAskCap}
              onChange={(event) => {
                const value = Number(event.target.value);
                if (Number.isFinite(value) && value > 0) {
                  setAllAskCaps(value);
                }
              }}
            />
          </label>
        </div>
        <p className="settings-hint">
          Circuit breaker (0 = desactivado). Si la pérdida realizada del día (según la zona horaria configurada) o la racha de pérdidas cruza el
          límite, el bot deja de operar hasta el día siguiente — sigue observando para analítica. Aplica al modo en
          ejecución. Editable con el bot detenido.
        </p>
        <p className="settings-hint">
          <strong>Techo de ask cap</strong>: precio máximo por acción para cualquier trade y para el auto-ajuste. Más
          bajo = mejor relación premio/riesgo (una pérdida se recupera con menos aciertos) pero menos trades. Recomendado
          0.85; la ganancia histórica se concentra por debajo de 0.70 y arriba de 0.85 el edge desaparece.
          <br />
          <strong>Ask cap (todos)</strong>: fija el ask cap de los 6 mercado/lado a la vez (se limita al Techo). Puedes
          afinar cada lado abajo; si difieren, este campo muestra "mixto".
        </p>
      </section>

      <section className="settings-advanced">
        <div className="section-heading">
          <DollarSign size={18} />
          <h2>Arbitraje de set completo</h2>
        </div>
        <label className="switch-row">
          <input
            type="checkbox"
            checked={draft.arbEnabled}
            onChange={(event) => update("arbEnabled", event.target.checked)}
            disabled={running}
          />
          <span>Ejecutar arbitraje (comprar ambos lados cuando el par cuesta menos de $1 tras comisiones)</span>
        </label>
        <div className="settings-grid">
          <NumberField
            label="Máx USD por oportunidad"
            value={draft.arbMaxUsdPerOpportunity}
            min={1}
            step={5}
            onChange={(value) => update("arbMaxUsdPerOpportunity", value)}
          />
          <NumberField
            label="Ganancia mín por set (USD)"
            value={draft.arbMinNetPerSet}
            min={0}
            max={0.5}
            step={0.005}
            onChange={(value) => update("arbMinNetPerSet", value)}
          />
        </div>
        <p className="settings-hint">
          Ganancia sin riesgo direccional: el par UP+DOWN siempre redime $1. Compra el lado delgado primero y
          registra el par como UN trade (slug "#arb") que paga gane quien gane. Si solo llena una pata, la
          posición direccional se registra y notifica. Respeta el límite de gasto diario y el circuit breaker.
          Las oportunidades por debajo del mínimo solo se observan. Editable con el bot detenido.
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
        <label className="switch-row">
          <input
            type="checkbox"
            checked={draft.evUseSimilarity}
            onChange={(event) => update("evUseSimilarity", event.target.checked)}
            disabled={running}
          />
          <span>Gate por similitud (comparar en vivo con setups parecidos del histórico)</span>
        </label>
        <label className="switch-row">
          <input
            type="checkbox"
            checked={draft.evCalibration}
            onChange={(event) => update("evCalibration", event.target.checked)}
            disabled={running}
          />
          <span>Calibración empírica (corrige la sobreconfianza con los resultados reales del propio bot)</span>
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
          <NumberField
            label="Llenado mínimo (fracción)"
            value={draft.minFillRatio}
            min={0}
            max={1}
            step={0.05}
            onChange={(value) => update("minFillRatio", value)}
          />
        </div>
        <p className="settings-hint">
          Solo opera setups con ventaja real y EV positivo tras comisiones. <strong>Menor margen = opera más seguido</strong>
          {" "}(recomendado 0.03; 0.08 era demasiado estricto y casi nunca operaba). "Historia mínima" es cuántas muestras
          resueltas necesita el setup antes de confiar en su tasa de acierto. "Llenado mínimo" descarta la operación si el
          libro solo puede llenar menos de esa fracción del monto pedido (evita micro-posiciones inútiles por poca
          liquidez; 0.5 = al menos la mitad). Apagar el gate opera cualquier señal (más riesgo). Editable con el bot detenido.
        </p>
      </section>

      <div className="form-actions settings-save-actions">
        <button className="command primary" disabled={running || busy} type="submit">
          <Save size={18} /> Guardar
        </button>
      </div>

      {onOpenReset && (
        <section className="settings-advanced danger-zone">
          <div className="section-heading">
            <AlertTriangle size={18} />
            <h2>Zona de peligro</h2>
          </div>
          <p className="settings-hint">
            Borra el estado local (historial de trades, P&L y gasto diario). Se guarda un respaldo automático en
            data/backups antes de borrar, pero no lo uses a la ligera.
          </p>
          <button className="command reset" type="button" onClick={onOpenReset} disabled={busy}>
            <RotateCcw size={18} /> Resetear estado local
          </button>
        </section>
      )}
    </form>
  );
}

export function AnalysisChartsSection() {
  const [mode, setMode] = useState<Mode>("live");
  const [trades, setTrades] = useState<TradeAttempt[]>([]);
  const [resetAtMs, setResetAtMs] = useState<PnlResetAtMsByMode>({});
  const [timeZone, setTimeZone] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    Promise.all([
      api<{ trades: TradeAttempt[] }>("/api/trades?limit=500"),
      api<UiStatus>("/api/status"),
    ])
      .then(([tradesPayload, status]) => {
        if (!cancelled) {
          setTrades(tradesPayload.trades);
          setResetAtMs(status.pnlResetAtMs ?? {});
          setTimeZone(status.settings?.timezone);
        }
      })
      .catch((caught) => {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : String(caught));
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Directional charts (calibration, ask bands, distribution) exclude arb pairs; equity/per-market include all.
  const directional = resolvedTradesForCharts(trades, mode, resetAtMs, { excludeArb: true });
  const all = resolvedTradesForCharts(trades, mode, resetAtMs);
  const equity = buildEquitySeries(all);
  const hourHistogram = hourOfDayHistogram(all, timeZone);
  const perDay = tradesPerDaySeries(all, timeZone);
  const avgPerDay = perDay.length > 0 ? perDay.reduce((sum, value) => sum + value, 0) / perDay.length : 0;
  const projection = projectionEstimates(all);
  const calibration = calibrationBuckets(directional);
  const distribution = netDistribution(directional);
  const { markets, sides } = perMarketSide(all);
  const askBands = summarizeAskBands(trades, mode, resetAtMs).bands.map(
    (band): LabeledValue => ({
      label: `${band.lo.toFixed(2)}`,
      value: band.netUsd,
      reference: band.winRate,
      count: band.trades,
    }),
  );

  return (
    <section className="panel">
      <div className="section-heading">
        <div className="section-title">
          <Brain size={18} />
          <h2>Gráficas de análisis ({mode})</h2>
        </div>
        <div className="segmented-control" role="group" aria-label="Modo de gráficas de análisis">
          <button className={`segment-button ${mode === "live" ? "active" : ""}`} onClick={() => setMode("live")}>
            Live
          </button>
          <button className={`segment-button ${mode === "sim" ? "active" : ""}`} onClick={() => setMode("sim")}>
            Sim
          </button>
        </div>
      </div>
      {error && <div className="banner error">{error}</div>}
      {all.length < 2 ? (
        <div className="empty-state">Sin trades {mode} resueltos post-reset suficientes.</div>
      ) : (
        <div className="chart-grid">
          <div className="chart-card">
            <h3>Curva de equity (P&L acumulado)</h3>
            <Sparkline values={equity.map((point) => point.cumulativeUsd)} title="P&L acumulado" />
            <p className="settings-hint">
              Max drawdown: {formatSignedUsd(Math.min(...equity.map((point) => point.drawdownUsd)))}
            </p>
          </div>
          <div className="chart-card">
            <h3>Calibración: predicho vs real</h3>
            <CalibrationChart buckets={calibration} />
            <p className="settings-hint">Barra = win% real; marca = probabilidad predicha. Barra corta bajo la marca = sobreconfianza.</p>
          </div>
          <div className="chart-card">
            <h3>Net por banda de ask</h3>
            <BarChart data={askBands} formatValue={(value) => formatSignedUsd(value)} />
            <p className="settings-hint">Marca = win% de la banda. El edge vive donde el net es positivo.</p>
          </div>
          <div className="chart-card">
            <h3>Net por mercado</h3>
            <BarChart data={markets} formatValue={(value) => formatSignedUsd(value)} formatReference={(ref) => `${(100 * ref).toFixed(0)}% win`} />
          </div>
          <div className="chart-card">
            <h3>Net por lado</h3>
            <BarChart data={sides} formatValue={(value) => formatSignedUsd(value)} formatReference={(ref) => `${(100 * ref).toFixed(0)}% win`} />
          </div>
          <div className="chart-card">
            <h3>Distribución de resultados por trade</h3>
            <BarChart data={distribution} formatValue={(value) => String(value)} />
            <p className="settings-hint">Cuántos trades cayeron en cada rango de $ neto (asimetría del payoff).</p>
          </div>
          <div className="chart-card">
            <h3>Frecuencia por hora del día</h3>
            <BarChart
              data={hourHistogram}
              formatValue={(value) => String(value)}
              formatReference={(wins) => `${wins} ganados`}
            />
            <p className="settings-hint">Trades por hora de entrada (zona horaria configurada). Marca = trades ganados en esa hora.</p>
          </div>
          <div className="chart-card">
            <h3>Ritmo de actividad (trades/día)</h3>
            <span className="chart-value">{avgPerDay.toFixed(1)}/día</span>
            <Sparkline values={perDay} title="Trades por día calendario" />
            <p className="settings-hint">Días calendario desde el primer trade post-reset; los huecos cuentan como 0.</p>
          </div>
          <div className="chart-card">
            <h3>Estimaciones (proyección lineal)</h3>
            {projection === undefined ? (
              <p className="chart-empty">Base insuficiente (se requieren ≥5 trades y ≥6h de datos).</p>
            ) : (
              <>
                <p className="settings-hint">
                  Base: {formatSignedUsd(projection.netPerDayUsd)}/día · {projection.tradesPerDay.toFixed(1)} trades/día · ROI{" "}
                  {projection.roiPct.toFixed(1)}% · sobre {projection.spanDays.toFixed(1)} días
                </p>
                <div className="projection-scroll">
                <table className="projection-table">
                  <thead>
                    <tr>
                      <th>Periodo</th>
                      <th>Net</th>
                      <th>Trades</th>
                      <th>Invertido</th>
                    </tr>
                  </thead>
                  <tbody>
                    {projection.periods.map((period) => (
                      <tr key={period.label}>
                        <td>{period.label}</td>
                        <td className={pnlTone(period.netUsd)}>{formatSignedUsd(period.netUsd)}</td>
                        <td>{period.trades}</td>
                        <td>{formatUsd(period.stakeUsd)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                </div>
              </>
            )}
            <p className="settings-hint">Extrapolación lineal del ritmo post-reset; no es garantía.</p>
          </div>
        </div>
      )}
    </section>
  );
}

export function AskBandsSection() {
  const [mode, setMode] = useState<Mode>("live");
  const [summary, setSummary] = useState<AskBandSummary | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    api<AskBandSummary>(`/api/analysis/ask-bands?mode=${mode}`)
      .then((next) => {
        if (!cancelled) {
          setSummary(next);
        }
      })
      .catch((caught) => {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : String(caught));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [mode]);

  return (
    <section className="panel">
      <div className="section-heading">
        <div className="section-title">
          <DollarSign size={18} />
          <h2>Rendimiento por banda de ask ({mode})</h2>
        </div>
        <div className="segmented-control" role="group" aria-label="Modo de bandas de ask">
          <button
            className={`segment-button ${mode === "live" ? "active" : ""}`}
            onClick={() => setMode("live")}
          >
            Live
          </button>
          <button
            className={`segment-button ${mode === "sim" ? "active" : ""}`}
            onClick={() => setMode("sim")}
          >
            Sim
          </button>
        </div>
      </div>
      {error && <div className="banner error">{error}</div>}
      <p className="settings-hint">
        La tabla que decide el <strong>ask cap</strong>: cada banda necesita ganar al menos su "BE%" (el ask
        promedio pagado) para no perder. El edge vive donde <strong>Win% supera BE%</strong>; las bandas
        donde no lo supera son candidatas a quedar fuera del cap. Datos realizados post-reset, con
        resoluciones oficiales — no muestras de observación.
      </p>
      {summary && summary.bands.length > 0 ? (
        <div className="table-scroll">
          <table className="responsive-table">
            <thead>
              <tr>
                <th>Banda</th>
                <th>Trades</th>
                <th>Win%</th>
                <th>BE% (necesario)</th>
                <th>Edge</th>
                <th>Net</th>
              </tr>
            </thead>
            <tbody>
              {summary.bands.map((band) => {
                const edge = (band.winRate ?? 0) - (band.breakEvenRate ?? 0);
                return (
                  <tr key={`${band.lo}`}>
                    <td data-label="Banda">{band.lo.toFixed(2)}–{band.hi.toFixed(2)}</td>
                    <td data-label="Trades">{band.trades}</td>
                    <td data-label="Win%">{formatPercent(band.winRate)}</td>
                    <td data-label="BE% (necesario)">{formatPercent(band.breakEvenRate)}</td>
                    <td data-label="Edge">
                      <span className={edge >= 0 ? "positive" : "negative"}>
                        {edge >= 0 ? "+" : ""}{(100 * edge).toFixed(0)} pp
                      </span>
                    </td>
                    <td data-label="Net">
                      <span className={`pnl-value ${pnlTone(band.netUsd)}`}>{formatSignedUsd(band.netUsd)}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="empty-state">Sin trades {mode} resueltos post-reset.</div>
      )}
    </section>
  );
}

const FISCAL_MONTH_NAMES = [
  "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
  "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre",
];

export function FiscalPanel() {
  const [year, setYear] = useState(new Date().getFullYear());
  const [data, setData] = useState<FiscalSummaryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [tokenDraft, setTokenDraft] = useState("");
  const [rateKeyDraft, setRateKeyDraft] = useState("");
  const [rateValueDraft, setRateValueDraft] = useState("");

  useEffect(() => {
    void loadSummary(year);
  }, [year]);

  async function loadSummary(targetYear: number) {
    setError(null);
    try {
      setData(await api<FiscalSummaryResponse>(`/api/fiscal/summary?year=${targetYear}`));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  async function saveFx(patch: { banxicoToken?: string; manualRates?: Record<string, number | null> }) {
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      setData(await api<FiscalSummaryResponse>("/api/fiscal/fx", {
        method: "POST",
        body: JSON.stringify({ ...patch, year }),
      }));
      setMessage("Configuración de tipo de cambio guardada.");
      setTokenDraft("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  const summary = data?.summary;
  const years = summary?.availableYears?.length ? summary.availableYears : [new Date().getFullYear()];
  const selectableYears = years.includes(year) ? years : [...years, year].sort();
  const coverage = summary && summary.operaciones > 0
    ? `${summary.operacionesConTasa} de ${summary.operaciones} operaciones con tasa`
    : "sin operaciones";
  const manualRateEntries = Object.entries(data?.fx.manualRates ?? {}).sort();

  return (
    <div className="fiscal-panel">
      <section className="panel">
        <div className="section-heading">
          <h2><Receipt size={18} /> Fiscal {year}</h2>
          <div className="section-actions">
            <select aria-label="Año fiscal" value={year} onChange={(event) => setYear(Number(event.target.value))}>
              {selectableYears.map((option) => (
                <option key={option} value={option}>{option}</option>
              ))}
            </select>
            <button
              className="command"
              type="button"
              disabled={!summary || summary.operaciones === 0}
              onClick={() => window.open(`/api/fiscal/export?year=${year}`, "_blank")}
            >
              <Download size={18} /> Exportar CSV
            </button>
          </div>
        </div>
        {error && <div className="banner error">{error}</div>}
        {message && <div className="banner">{message}</div>}
        <div className="hero-metrics">
          <Metric
            label="Ganancia neta (USD)"
            value={formatSignedUsd(summary?.gananciaUsd)}
            tone={pnlTone(summary?.gananciaUsd)}
          />
          <Metric
            label="Ganancia neta (MXN)"
            value={summary?.gananciaMxn !== undefined ? `${summary.gananciaMxn >= 0 ? "+" : "−"}$${Math.abs(summary.gananciaMxn).toFixed(2)} MXN` : "— (faltan tasas)"}
            tone={pnlTone(summary?.gananciaMxn)}
          />
          <Metric label="Comisiones" value={formatUsd(summary?.comisionesUsd)} />
          <Metric label="Operaciones" value={summary ? `${summary.operaciones} (${summary.ganadas}-${summary.perdidas})` : "—"} />
        </div>
        <p className="settings-hint">
          Solo operaciones LIVE resueltas (dinero real); la simulación se excluye siempre. Cobertura de tipo de
          cambio: {coverage}. Los montos salen del mismo cálculo de P&L del dashboard.
        </p>
        {summary && summary.months.length > 0 ? (
          <div className="table-scroll">
            <table className="responsive-table">
              <thead>
                <tr>
                  <th>Mes</th>
                  <th>Operaciones</th>
                  <th>Ganadas</th>
                  <th>Perdidas</th>
                  <th>Invertido USD</th>
                  <th>Comisiones USD</th>
                  <th>Neto USD</th>
                  <th>Neto MXN</th>
                </tr>
              </thead>
              <tbody>
                {summary.months.map((month: FiscalMonthSummary) => (
                  <tr key={month.month}>
                    <td data-label="Mes">{FISCAL_MONTH_NAMES[month.month - 1]}</td>
                    <td data-label="Operaciones">{month.operaciones}</td>
                    <td data-label="Ganadas">{month.ganadas}</td>
                    <td data-label="Perdidas">{month.perdidas}</td>
                    <td data-label="Invertido USD">{formatUsd(month.invertidoUsd)}</td>
                    <td data-label="Comisiones USD">{formatUsd(month.comisionesUsd)}</td>
                    <td data-label="Neto USD"><span className={pnlTone(month.gananciaUsd)}>{formatSignedUsd(month.gananciaUsd)}</span></td>
                    <td data-label="Neto MXN">
                      {month.gananciaMxn !== undefined
                        ? `$${month.gananciaMxn.toFixed(2)}`
                        : `— (${month.operacionesConTasa}/${month.operaciones} con tasa)`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty-state">Sin operaciones live resueltas en {year}.</div>
        )}
      </section>

      <section className="panel">
        <div className="section-heading">
          <h2><DollarSign size={18} /> Tipo de cambio USD/MXN</h2>
        </div>
        <p className="settings-hint">
          Para convertir a MXN por fecha de operación: captura tu <strong>token gratuito de Banxico</strong>
          {" "}(banxico.org.mx → SIE API, serie FIX) para obtención automática, o agrega tasas manuales por día
          ("2026-07-11") o por mes ("2026-07"). Prioridad: manual exacta → manual del mes → Banxico del día →
          día hábil anterior. Sin tasa, la columna MXN queda vacía.
        </p>
        <div className="settings-grid">
          <label className="field">
            <span>Token Banxico {data?.fx.banxicoTokenConfigured ? "(configurado)" : "(no configurado)"}</span>
            <input
              type="password"
              placeholder={data?.fx.banxicoTokenConfigured ? "••••••••" : "Pega tu token"}
              value={tokenDraft}
              onChange={(event) => setTokenDraft(event.target.value)}
            />
          </label>
        </div>
        <div className="form-actions">
          <button className="command" type="button" disabled={busy || !tokenDraft.trim()} onClick={() => void saveFx({ banxicoToken: tokenDraft })}>
            <Save size={18} /> Guardar token
          </button>
          {data?.fx.banxicoTokenConfigured && (
            <button className="command" type="button" disabled={busy} onClick={() => void saveFx({ banxicoToken: "" })}>
              Quitar token
            </button>
          )}
        </div>
        <div className="settings-grid">
          <label className="field">
            <span>Fecha o mes (YYYY-MM-DD / YYYY-MM)</span>
            <input value={rateKeyDraft} placeholder="2026-07" onChange={(event) => setRateKeyDraft(event.target.value)} />
          </label>
          <label className="field">
            <span>Tasa (MXN por USD)</span>
            <input value={rateValueDraft} placeholder="17.05" onChange={(event) => setRateValueDraft(event.target.value)} />
          </label>
        </div>
        <div className="form-actions">
          <button
            className="command"
            type="button"
            disabled={busy || !/^\d{4}-\d{2}(-\d{2})?$/.test(rateKeyDraft.trim()) || !(Number(rateValueDraft) > 0)}
            onClick={() => {
              void saveFx({ manualRates: { [rateKeyDraft.trim()]: Number(rateValueDraft) } });
              setRateKeyDraft("");
              setRateValueDraft("");
            }}
          >
            <Save size={18} /> Agregar tasa manual
          </button>
        </div>
        {manualRateEntries.length > 0 && (
          <div className="table-scroll">
            <table className="responsive-table">
              <thead>
                <tr><th>Periodo</th><th>Tasa</th><th></th></tr>
              </thead>
              <tbody>
                {manualRateEntries.map(([key, value]) => (
                  <tr key={key}>
                    <td data-label="Periodo">{key}</td>
                    <td data-label="Tasa">{value.toFixed(4)}</td>
                    <td data-label="Quitar">
                      <button className="icon-button" type="button" aria-label={`Eliminar tasa ${key}`} disabled={busy} onClick={() => void saveFx({ manualRates: { [key]: null } })}>
                        ✕
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="settings-hint">
          <AlertTriangle size={14} /> Este registro organiza tus operaciones para la declaración; no constituye
          asesoría fiscal. Confirma criterios (tipo de cambio aplicable, régimen, deducciones) con tu contador.
        </p>
      </section>
    </div>
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
        digestEnabled: next.digestEnabled,
        digestIntervalMinutes: next.digestIntervalMinutes,
        dailyReportEnabled: next.dailyReportEnabled,
        dailyReportHour: next.dailyReportHour,
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  function updateTelegramDraft(key: keyof TelegramNotificationPatch, value: string | boolean | number) {
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
        digestEnabled: saved.digestEnabled,
        digestIntervalMinutes: saved.digestIntervalMinutes,
        dailyReportEnabled: saved.dailyReportEnabled,
        dailyReportHour: saved.dailyReportHour,
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

      <label className="switch-row">
        <input
          type="checkbox"
          checked={Boolean(draft.digestEnabled)}
          onChange={(event) => updateTelegramDraft("digestEnabled", event.target.checked)}
        />
        <span>Modo resumen (digest)</span>
      </label>
      {draft.digestEnabled && (
        <label className="field">
          <span>Intervalo del resumen (minutos)</span>
          <input
            type="number"
            min={5}
            step={5}
            value={draft.digestIntervalMinutes ?? 240}
            onChange={(event) => updateTelegramDraft("digestIntervalMinutes", Number(event.target.value))}
          />
        </label>
      )}
      <p className="settings-hint">
        Con el modo resumen, los avisos por trade (ganado/perdido) se agrupan en un solo mensaje cada intervalo —
        informa igual, sin invitarte a reaccionar vela por vela. Las alertas de seguridad (freno de riesgo, errores,
        arbitraje) siguen llegando al instante.
      </p>

      <label className="switch-row">
        <input
          type="checkbox"
          checked={Boolean(draft.dailyReportEnabled)}
          onChange={(event) => updateTelegramDraft("dailyReportEnabled", event.target.checked)}
        />
        <span>Reporte diario</span>
      </label>
      {draft.dailyReportEnabled && (
        <label className="field">
          <span>Hora del reporte (0-23, zona horaria configurada)</span>
          <input
            type="number"
            min={0}
            max={23}
            step={1}
            value={draft.dailyReportHour ?? 21}
            onChange={(event) => updateTelegramDraft("dailyReportHour", Number(event.target.value))}
          />
        </label>
      )}
      <p className="settings-hint">
        Un mensaje al día con P&L de hoy y post-reset, progreso del plan de validación con banda de varianza, estado del
        autoajuste y del freno, cap sugerido por mercado y salud del proceso.
      </p>

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

function LogsPanel({ logs, timeZone }: { logs: LogEntry[]; timeZone?: string }) {
  return (
    <section className="panel logs-panel">
      {logs.length === 0 ? (
        <div className="empty-state">Sin logs</div>
      ) : (
        logs.map((log) => (
          <div className={`log-row ${log.level}`} key={`${log.at}-${log.message}`}>
            <span>{formatTimeInTimeZone(new Date(log.at).getTime(), timeZone)}</span>
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
  // title + aria-label keep the tab usable on small screens, where CSS hides the text label.
  return (
    <button
      className={`tab-button ${active ? "active" : ""}`}
      type="button"
      title={label}
      aria-label={label}
      aria-current={active ? "page" : undefined}
      onClick={onClick}
    >
      {icon}
      <span className="tab-label">{label}</span>
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

// Mirror of the backend applyRecommendationsToSettings: apply the autoajuste's recommended window +
// distance to a market (both sides), so the manual "Aplicar recomendada" matches what the bot does.
function applyRecommendationToSettings(
  settings: UiSettings,
  market: MarketSymbol,
  recommended: RecommendationCandidate,
): UiSettings {
  const minDistanceUsdByMarketOutcome = cloneOutcomeNumberSettings(settings.minDistanceUsdByMarketOutcome);
  const entryWindowSecondsByMarketOutcome = cloneOutcomeNumberSettings(settings.entryWindowSecondsByMarketOutcome);

  minDistanceUsdByMarketOutcome[market] = { UP: recommended.minDistanceUsd, DOWN: recommended.minDistanceUsd };
  entryWindowSecondsByMarketOutcome[market] = {
    UP: recommended.entryWindowSeconds,
    DOWN: recommended.entryWindowSeconds,
  };

  const minDistanceUsdByMarket = { ...settings.minDistanceUsdByMarket, [market]: recommended.minDistanceUsd };
  const entryWindowSecondsByMarket = { ...settings.entryWindowSecondsByMarket, [market]: recommended.entryWindowSeconds };

  return {
    ...settings,
    minBtcDistanceUsd: minDistanceUsdByMarket.BTC,
    minDistanceUsdByMarket,
    minDistanceUsdByMarketOutcome,
    entryWindowSeconds: entryWindowSecondsByMarket.BTC,
    entryWindowSecondsByMarket,
    entryWindowSecondsByMarketOutcome,
  };
}


function cloneOutcomeNumberSettings<T extends UiSettings["minDistanceUsdByMarketOutcome"]>(settings: T): T {
  return {
    BTC: { ...settings.BTC },
    ETH: { ...settings.ETH },
    DOGE: { ...settings.DOGE },
  } as T;
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

function formatDateTime(value?: number, timeZone?: string): string {
  if (value === undefined || !Number.isFinite(value)) {
    return "--";
  }
  return formatDateTimeInTimeZone(value, timeZone);
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


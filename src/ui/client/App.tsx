import {
  AlertTriangle,
  ArrowDownNarrowWide,
  ArrowUpDown,
  ArrowUpNarrowWide,
  Brain,
  CheckCircle2,
  DollarSign,
  Gauge,
  Moon,
  Pause,
  Play,
  Radio,
  RefreshCw,
  RotateCcw,
  Save,
  Settings,
  ShieldAlert,
  Square,
  Sun,
  Table2,
  Terminal,
  TrendingDown,
  TrendingUp,
} from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";

import type { LogEntry } from "../../logger.js";
import { calculateTradePnl, type TradePnl } from "../../pnl.js";
import { hasResolvablePosition } from "../../tradeResolution.js";
import type { AiRecommendation, AiRecommendationsResponse, MarketSymbol, TradeAttempt } from "../../types.js";
import type { MarketStatusSnapshot, StartBotRequest, UiSettings, UiStatus } from "../shared.js";

type Tab = "dashboard" | "trades" | "ai" | "settings" | "logs";
type Theme = "light" | "dark";
type TradeMarketFilter = "ALL" | MarketSymbol;
type TradePnlFilter = "ALL" | "POSITIVE" | "NEGATIVE";
type TradeSortKey = "createdAtMs" | "entryWindowSeconds" | "stakeUsd" | "bestAsk" | "distanceUsd" | "payoutUsd" | "netUsd";
type TradeSortDirection = "asc" | "desc";

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

const emptySettings: UiSettings = {
  minBtcDistanceUsd: 20,
  enabledMarkets: ["BTC"],
  minDistanceUsdByMarket: {
    BTC: 20,
    ETH: 5,
    DOGE: 0.0005,
  },
  entryWindowSeconds: 20,
  entryWindowSecondsByMarket: {
    BTC: 20,
    ETH: 20,
    DOGE: 20,
  },
  simTradeAmountUsd: 1,
  liveTradeAmountUsd: 1,
  autoMinLive: true,
  maxAskPrice: 0.98,
  dailySpendLimitUsd: 50,
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

export function App() {
  const [status, setStatus] = useState<UiStatus | null>(null);
  const [trades, setTrades] = useState<TradeAttempt[]>([]);
  const [settings, setSettings] = useState<UiSettings>(emptySettings);
  const [recommendations, setRecommendations] = useState<AiRecommendationsResponse | null>(null);
  const [tab, setTab] = useState<Tab>("dashboard");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [liveModal, setLiveModal] = useState(false);
  const [resetModal, setResetModal] = useState(false);
  const [theme, setTheme] = useState<Theme>(() => getInitialTheme());

  useEffect(() => {
    void refreshAll();
    const events = new EventSource("/api/events");
    events.addEventListener("status", (event) => {
      const payload = JSON.parse((event as MessageEvent).data) as { status: UiStatus };
      setStatus(payload.status);
    });
    events.addEventListener("log", () => {
      void loadTrades();
    });
    return () => events.close();
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    try {
      window.localStorage.setItem(themeStorageKey, theme);
    } catch {
      // Local storage can be unavailable in hardened browser contexts.
    }
  }, [theme]);

  async function refreshAll() {
    setError(null);
    const [nextStatus, nextSettings, nextRecommendations] = await Promise.all([
      api<UiStatus>("/api/status"),
      api<UiSettings>("/api/settings"),
      api<AiRecommendationsResponse>("/api/recommendations"),
    ]);
    setStatus(nextStatus);
    setSettings(nextSettings);
    setRecommendations(nextRecommendations);
    await loadTrades();
  }

  async function loadTrades() {
    const payload = await api<{ trades: TradeAttempt[] }>("/api/trades?limit=100");
    setTrades(payload.trades);
  }

  async function loadRecommendations() {
    setRecommendations(await api<AiRecommendationsResponse>("/api/recommendations"));
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
    setBusy(true);
    setError(null);
    try {
      const saved = await api<UiSettings>("/api/settings", { method: "PATCH", body: JSON.stringify(next) });
      setSettings(saved);
      await refreshAll();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function applyRecommendation(market: MarketSymbol) {
    setBusy(true);
    setError(null);
    try {
      const payload = await api<{ settings: UiSettings; recommendations: AiRecommendationsResponse }>("/api/recommendations/apply", {
        method: "POST",
        body: JSON.stringify({ markets: [market] }),
      });
      setSettings(payload.settings);
      setRecommendations(payload.recommendations);
      await refreshAll();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function autoApplyRecommendations() {
    setBusy(true);
    setError(null);
    try {
      const payload = await api<{ settings: UiSettings; recommendations: AiRecommendationsResponse }>("/api/recommendations/auto-apply", {
        method: "POST",
        body: JSON.stringify({}),
      });
      setSettings(payload.settings);
      setRecommendations(payload.recommendations);
      await refreshAll();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }

  async function toggleAiAutoApplyLive(enabled: boolean) {
    setBusy(true);
    setError(null);
    try {
      const saved = await api<UiSettings>("/api/settings", {
        method: "PATCH",
        body: JSON.stringify({ aiAutoApplyLive: enabled }),
      });
      setSettings(saved);
      await loadRecommendations();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
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
      setResetModal(false);
      await refreshAll();
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
          <TabButton active={tab === "ai"} icon={<Brain size={18} />} label="IA" onClick={() => setTab("ai")} />
          <TabButton active={tab === "settings"} icon={<Settings size={18} />} label="Settings" onClick={() => setTab("settings")} />
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
              onRefresh={() => refreshAll()}
            />
          </div>
        </header>

        {error && <div className="notice error"><AlertTriangle size={18} />{error}</div>}

        {tab === "dashboard" && <Dashboard status={status} />}
        {tab === "trades" && <TradesTable trades={trades} settings={settings} />}
        {tab === "ai" && (
          <AiPanel
            recommendations={recommendations}
            settings={settings}
            status={status}
            busy={busy}
            onApply={applyRecommendation}
            onRefresh={loadRecommendations}
            onAutoApply={autoApplyRecommendations}
            onToggleAutoApply={toggleAiAutoApplyLive}
          />
        )}
        {tab === "settings" && <SettingsPanel settings={settings} running={Boolean(status?.running)} busy={busy} onSave={saveSettings} />}
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

function Dashboard({ status }: { status: UiStatus | null }) {
  const marketSnapshots = getMarketSnapshots(status);
  return (
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
        <div className="section-heading">
          <DollarSign size={18} />
          <h2>P&L</h2>
        </div>
        <div className="hero-metrics pnl-metrics">
          <Metric label="Neto" value={formatSignedUsd(status?.pnl.realizedUsd)} tone={pnlTone(status?.pnl.realizedUsd)} />
          <Metric label="Reclamado" value={formatUsd(status?.pnl.payoutUsd)} tone={pnlTone(status?.pnl.payoutUsd)} />
          <Metric label="Invertido" value={formatUsd(status?.pnl.realizedStakeUsd)} />
          <Metric label="Pendiente" value={formatUsd(status?.pnl.pendingStakeUsd)} />
          <Metric label="ROI" value={formatPercent(status?.pnl.roiPct)} tone={pnlTone(status?.pnl.realizedUsd)} />
        </div>
      </section>

      <section className="panel limits-panel">
        <div className="section-heading">
          <Pause size={18} />
          <h2>Riesgo</h2>
        </div>
        <div className="hero-metrics compact">
          <Metric label="Gasto diario" value={formatUsd(status?.dailySpendUsd)} />
          <Metric label="Limite" value={formatUsd(status?.settings.dailySpendLimitUsd)} />
          <Metric label="Ask cap" value={formatPrice(status?.settings.maxAskPrice)} />
        </div>
      </section>
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

export function AiPanel({
  recommendations,
  settings,
  status,
  busy,
  onApply,
  onRefresh,
  onAutoApply,
  onToggleAutoApply,
}: {
  recommendations: AiRecommendationsResponse | null;
  settings: UiSettings;
  status: UiStatus | null;
  busy: boolean;
  onApply: (market: MarketSymbol) => Promise<void>;
  onRefresh: () => Promise<void>;
  onAutoApply: () => Promise<void>;
  onToggleAutoApply: (enabled: boolean) => Promise<void>;
}) {
  const running = Boolean(status?.running);
  const runningLive = running && status?.mode === "live";
  const items = recommendations?.recommendations ?? [];
  return (
    <section className="panel ai-panel">
      <div className="ai-toolbar">
        <div className="section-heading">
          <Brain size={18} />
          <h2>IA local</h2>
        </div>
        <div className="ai-actions">
          <label className="switch-row">
            <input
              type="checkbox"
              checked={settings.aiAutoApplyLive}
              onChange={(event) => onToggleAutoApply(event.target.checked)}
              disabled={busy}
            />
            <span>Auto live</span>
          </label>
          <button className="command" type="button" onClick={onRefresh} disabled={busy}>
            <RefreshCw size={18} /> Actualizar
          </button>
          <button className="command primary" type="button" onClick={onAutoApply} disabled={busy || !runningLive}>
            <CheckCircle2 size={18} /> Auto aplicar
          </button>
        </div>
      </div>
      {items.length === 0 ? (
        <div className="empty-state">Sin recomendaciones</div>
      ) : (
        <div className="ai-card-grid">
          {items.map((recommendation) => (
            <AiRecommendationCard
              key={recommendation.market}
              recommendation={recommendation}
              running={running}
              busy={busy}
              onApply={() => onApply(recommendation.market)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function AiRecommendationCard({
  recommendation,
  running,
  busy,
  onApply,
}: {
  recommendation: AiRecommendation;
  running: boolean;
  busy: boolean;
  onApply: () => Promise<void>;
}) {
  const market = recommendation.market;
  const recommended = recommendation.recommended;
  return (
    <article className="ai-card">
      <div className="ai-card-header">
        <div>
          <strong>{market}</strong>
          <span>{aiStatusLabel(recommendation.status)} - {confidenceLabel(recommendation.confidence)}</span>
        </div>
        <span className={`confidence-badge ${recommendation.confidence}`}>{confidenceShortLabel(recommendation.confidence)}</span>
      </div>
      <div className="ai-compare">
        <AiSettingColumn
          label="Actual"
          windowSeconds={recommendation.current.entryWindowSeconds}
          distanceUsd={recommendation.current.minDistanceUsd}
          market={market}
          adjustedRoi={recommendation.current.metrics.adjustedRoi}
        />
        <AiSettingColumn
          label="Sugerida"
          windowSeconds={recommended?.entryWindowSeconds}
          distanceUsd={recommended?.minDistanceUsd}
          market={market}
          adjustedRoi={recommended?.metrics.adjustedRoi}
        />
      </div>
      <div className="hero-metrics compact ai-metrics">
        <Metric label="Muestras" value={String(recommendation.sampleCount)} />
        <Metric label="Trades" value={String((recommended ?? recommendation.current).metrics.tradeCount)} />
        <Metric label="Cobertura" value={formatPercent((recommended ?? recommendation.current).metrics.quoteCoverage)} />
        <Metric label="Edge" value={formatPercent((recommended ?? recommendation.current).metrics.expectedRoi)} />
        <Metric label="Walk" value={formatPercent((recommended ?? recommendation.current).metrics.walkForwardRoi)} />
        <Metric label="Riesgo" value={formatPercent((recommended ?? recommendation.current).metrics.overfitRisk)} />
      </div>
      <p className="ai-reason">{recommendation.reason}</p>
      <div className="form-actions">
        <button className="command primary" type="button" disabled={busy || running || !recommendation.canApply} onClick={onApply}>
          <CheckCircle2 size={18} /> Aplicar
        </button>
      </div>
    </article>
  );
}

function AiSettingColumn({
  label,
  windowSeconds,
  distanceUsd,
  market,
  adjustedRoi,
}: {
  label: string;
  windowSeconds?: number;
  distanceUsd?: number;
  market: MarketSymbol;
  adjustedRoi?: number;
}) {
  return (
    <div className="ai-setting-column">
      <span>{label}</span>
      <strong>{formatEntryWindow(windowSeconds)}</strong>
      <strong>{formatMarketDistance(distanceUsd, market)}</strong>
      <small>{formatPercent(adjustedRoi)}</small>
    </div>
  );
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
        <div className="table-scroll">
          <table>
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
                    <td>{new Date(trade.createdAtMs).toLocaleString()}</td>
                    <td>{tradeMarketLabel(trade)}</td>
                    <td>{formatTradeEntryWindow(trade, settings)}</td>
                    <td>{trade.mode.toUpperCase()}</td>
                    <td><span className={`side ${trade.outcome.toLowerCase()}`}>{trade.outcome}</span></td>
                    <td>{formatUsd(pnl.stakeUsd)}</td>
                    <td>{formatPrice(trade.bestAsk)}</td>
                    <td>{formatMarketDistance(trade.distanceUsd, marketSymbol)}</td>
                    <td>{formatTradePayout(pnl)}</td>
                    <td><span className={`pnl-value ${pnlTone(pnl.netUsd)}`}>{formatTradePnl(pnl)}</span></td>
                    <td>{tradeStatusLabel(trade)}</td>
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
  useEffect(() => setDraft(settings), [settings]);

  function update(key: keyof UiSettings, value: number | boolean) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  function toggleMarket(symbol: MarketSymbol, enabled: boolean) {
    setDraft((current) => {
      const enabledMarkets = enabled
        ? [...current.enabledMarkets, symbol]
        : current.enabledMarkets.filter((market) => market !== symbol);
      return {
        ...current,
        enabledMarkets: marketOptions
          .map((option) => option.symbol)
          .filter((market) => enabledMarkets.includes(market)),
      };
    });
  }

  function updateMarketDistance(symbol: MarketSymbol, value: number) {
    setDraft((current) => {
      const minDistanceUsdByMarket = {
        ...current.minDistanceUsdByMarket,
        [symbol]: value,
      };
      return {
        ...current,
        minBtcDistanceUsd: minDistanceUsdByMarket.BTC,
        minDistanceUsdByMarket,
      };
    });
  }

  function updateMarketEntryWindow(symbol: MarketSymbol, value: number) {
    setDraft((current) => {
      const entryWindowSecondsByMarket = {
        ...current.entryWindowSecondsByMarket,
        [symbol]: value,
      };
      return {
        ...current,
        entryWindowSeconds: entryWindowSecondsByMarket.BTC,
        entryWindowSecondsByMarket,
      };
    });
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    await onSave(draft);
  }

  return (
    <form className="panel settings-panel" onSubmit={submit}>
      <div className="market-settings">
        {marketOptions.map((market) => (
          <div className="market-setting-row" key={market.symbol}>
            <label className="switch-row">
              <input
                type="checkbox"
                checked={draft.enabledMarkets.includes(market.symbol)}
                onChange={(event) => toggleMarket(market.symbol, event.target.checked)}
                disabled={running}
              />
              <span>{market.symbol}</span>
            </label>
            <NumberField
              label={`Distancia ${market.label}`}
              value={draft.minDistanceUsdByMarket[market.symbol]}
              min={market.min}
              step={market.step}
              onChange={(value) => updateMarketDistance(market.symbol, value)}
            />
            <NumberField
              label={`Ventana ${market.label}`}
              value={draft.entryWindowSecondsByMarket[market.symbol]}
              min={1}
              step={1}
              onChange={(value) => updateMarketEntryWindow(market.symbol, value)}
            />
          </div>
        ))}
      </div>
      <div className="settings-grid">
        <NumberField label="Monto sim" value={draft.simTradeAmountUsd} min={0.1} step={0.1} onChange={(value) => update("simTradeAmountUsd", value)} />
        <NumberField label="Monto live" value={draft.liveTradeAmountUsd} min={0.1} step={0.1} onChange={(value) => update("liveTradeAmountUsd", value)} />
        <NumberField label="Ask cap" value={draft.maxAskPrice} min={0.01} max={1} step={0.01} onChange={(value) => update("maxAskPrice", value)} />
        <NumberField label="Limite diario" value={draft.dailySpendLimitUsd} min={1} step={1} onChange={(value) => update("dailySpendLimitUsd", value)} />
        <NumberField label="Tick stale ms" value={draft.tickStaleMs} min={1000} step={1000} onChange={(value) => update("tickStaleMs", value)} />
        <NumberField label="Poll ms" value={draft.pollIntervalMs} min={250} step={250} onChange={(value) => update("pollIntervalMs", value)} />
      </div>
      <label className="switch-row">
        <input type="checkbox" checked={draft.autoMinLive} onChange={(event) => update("autoMinLive", event.target.checked)} disabled={running} />
        <span>Auto minimo live</span>
      </label>
      <div className="form-actions">
        <button className="command primary" disabled={running || busy} type="submit">
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
    <button className={`tab-button ${active ? "active" : ""}`} onClick={onClick}>
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
      reason: status?.settings.enabledMarkets.includes(market.symbol) ? "market_not_found" : "disabled",
      inEntryWindow: false,
    },
  }));
}

function activeMarketLine(status: UiStatus | null): string {
  const enabled = status?.settings.enabledMarkets ?? [];
  if (enabled.length === 0) {
    return "sin mercados activos";
  }
  return enabled.join(" + ");
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

function formatPrice(value?: number): string {
  if (value === undefined || !Number.isFinite(value)) {
    return "--";
  }
  return value.toFixed(2);
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

function aiStatusLabel(status: AiRecommendation["status"]): string {
  return status === "ready" ? "Lista" : "Insuficiente";
}

function confidenceLabel(confidence: AiRecommendation["confidence"]): string {
  if (confidence === "high") {
    return "alta confianza";
  }
  if (confidence === "medium") {
    return "confianza media";
  }
  return "baja confianza";
}

function confidenceShortLabel(confidence: AiRecommendation["confidence"]): string {
  if (confidence === "high") {
    return "Alta";
  }
  if (confidence === "medium") {
    return "Media";
  }
  return "Baja";
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
    waiting_entry_window: "Esperando ventana",
    signal_ready: "Lista",
    snapshot_error: "Error snapshot",
    missing_live_configuration: "Faltan credenciales",
  };
  return labels[reason ?? ""] ?? reason ?? "--";
}

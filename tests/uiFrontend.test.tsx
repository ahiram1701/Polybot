// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AnalysisPanel, App, ControlBar, Dashboard, SettingsPanel, TelegramPanel, TradesTable } from "../src/ui/client/App.js";
import type { UiSettings, UiStatus } from "../src/ui/shared.js";
import type { AiRecommendationsResponse, MarketSymbol, RecommendationMetrics, TradeAttempt } from "../src/types.js";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

describe("UI frontend components", () => {
  it("does not load strategy analysis during the initial dashboard load", async () => {
    class FakeEventSource {
      readonly url: string;
      readonly withCredentials = false;
      readonly CONNECTING = 0;
      readonly OPEN = 1;
      readonly CLOSED = 2;
      readyState = 1;
      onerror: ((this: EventSource, event: Event) => unknown) | null = null;
      onmessage: ((this: EventSource, event: MessageEvent) => unknown) | null = null;
      onopen: ((this: EventSource, event: Event) => unknown) | null = null;

      constructor(url: string | URL) {
        this.url = String(url);
      }

      addEventListener() {}
      removeEventListener() {}
      dispatchEvent() {
        return true;
      }
      close() {}
    }

    vi.stubGlobal("EventSource", FakeEventSource);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/status") {
        return jsonResponse(status({ liveReady: false }));
      }
      if (path === "/api/settings") {
        return jsonResponse(settings());
      }
      if (path === "/api/analysis/recommendations") {
        return jsonResponse(recommendationsResponse());
      }
      if (path === "/api/trades?limit=100") {
        return jsonResponse({ trades: [] });
      }
      return jsonResponse({ error: "not found" }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    expect(screen.getByRole("button", { name: "Telegram" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Dashboard" })).toHaveAttribute("aria-current", "page");
    await waitFor(() => expect(fetchMock.mock.calls.map(([input]) => String(input))).toContain("/api/trades?limit=100"));
    expect(fetchMock.mock.calls.map(([input]) => String(input))).not.toContain("/api/analysis/recommendations");

    expect(screen.getByRole("button", { name: "Análisis" })).toBeInTheDocument();
  });

  it("loads strategy analysis when the Analysis tab opens", async () => {
    class FakeEventSource {
      readonly url: string;
      readonly withCredentials = false;
      readonly CONNECTING = 0;
      readonly OPEN = 1;
      readonly CLOSED = 2;
      readyState = 1;
      onerror: ((this: EventSource, event: Event) => unknown) | null = null;
      onmessage: ((this: EventSource, event: MessageEvent) => unknown) | null = null;
      onopen: ((this: EventSource, event: Event) => unknown) | null = null;

      constructor(url: string | URL) {
        this.url = String(url);
      }

      addEventListener() {}
      removeEventListener() {}
      dispatchEvent() {
        return true;
      }
      close() {}
    }

    vi.stubGlobal("EventSource", FakeEventSource);
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/status") {
        return jsonResponse(status({ liveReady: false }));
      }
      if (path === "/api/settings") {
        return jsonResponse(settings());
      }
      if (path === "/api/trades?limit=100") {
        return jsonResponse({ trades: [] });
      }
      if (path === "/api/analysis/recommendations") {
        return jsonResponse(recommendationsResponse());
      }
      return jsonResponse({ error: "not found" }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /An/i }));

    await waitFor(() => expect(fetchMock.mock.calls.map(([input]) => String(input))).toContain("/api/analysis/recommendations"));
  });

  it("disables live control when live is not ready", () => {
    render(
      <ControlBar
        status={status({ liveReady: false })}
        busy={false}
        onStartSim={vi.fn()}
        onOpenLive={vi.fn()}
        onOpenReset={vi.fn()}
        onStop={vi.fn()}
        onRefresh={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: /live/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /sim/i })).toBeEnabled();
    expect(screen.getByRole("button", { name: /reset/i })).toBeEnabled();
  });

  it("keeps reset available while running", () => {
    render(
      <ControlBar
        status={{ ...status({ liveReady: false }), running: true, mode: "sim" }}
        busy={false}
        onStartSim={vi.fn()}
        onOpenLive={vi.fn()}
        onOpenReset={vi.fn()}
        onStop={vi.fn()}
        onRefresh={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: /reset/i })).toBeEnabled();
  });

  it("switches the dashboard P&L between sim and live", () => {
    const onResetPnl = vi.fn();
    render(
      <Dashboard
        busy={false}
        onResetPnl={onResetPnl}
        onResetRiskHalt={vi.fn()}
        status={{
          ...status({ liveReady: true }),
          pnl: pnlSummary({ realizedUsd: 0.5, payoutUsd: 3, realizedStakeUsd: 2.5 }),
          pnlByMode: {
            sim: pnlSummary({ realizedUsd: 1, payoutUsd: 2, realizedStakeUsd: 1 }),
            live: pnlSummary({ realizedUsd: -0.5, payoutUsd: 1, realizedStakeUsd: 1.5, pendingStakeUsd: 2 }),
          },
        }}
      />,
    );

    expect(screen.getByRole("heading", { name: "P&L" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ver P&L sim" })).toHaveClass("active");
    expect(screen.getByText(/\+.*1\.00/)).toBeInTheDocument();
    expect(screen.queryByText(/\-.*0\.50/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reset P&L Sim" }));
    expect(onResetPnl).toHaveBeenCalledWith("sim");

    fireEvent.click(screen.getByRole("button", { name: "Ver P&L live" }));

    expect(screen.getByRole("button", { name: "Ver P&L live" })).toHaveClass("active");
    expect(screen.getByText(/\-.*0\.50/)).toBeInTheDocument();
    expect(screen.queryByText(/\+.*1\.00/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reset P&L Live" }));
    expect(onResetPnl).toHaveBeenCalledWith("live");
  });

  it("shows the risk circuit breaker banner when tripped", () => {
    render(
      <Dashboard
        busy={false}
        onResetPnl={vi.fn()}
        onResetRiskHalt={vi.fn()}
        status={{
          ...status({ liveReady: true }),
          riskHalt: { tripped: true, reason: "daily_loss_limit", dailyLossUsd: 50, consecutiveLosses: 0 },
        }}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent(/circuit breaker/i);
    expect(screen.getByRole("heading", { name: /Por que no opera/i })).toBeInTheDocument();
  });

  it("hides the risk banner when the circuit breaker is not tripped", () => {
    render(<Dashboard busy={false} onResetPnl={vi.fn()} onResetRiskHalt={vi.fn()} status={status({ liveReady: true })} />);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("renders trade outcomes", () => {
    render(<TradesTable trades={[trade({ resolvedWon: true })]} />);

    expect(screen.getByRole("button", { name: "Todos" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "BTC" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Positivo" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Negativo" })).toBeInTheDocument();
    expect(screen.getByText("UP")).toBeInTheDocument();
    expect(screen.getByText("UP").closest("td")).toHaveAttribute("data-label", "Lado");
    expect(screen.getByText("Gano")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Ventana" })).toBeInTheDocument();
    expect(screen.getAllByText("35s").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByRole("columnheader", { name: "Reclamado" })).toBeInTheDocument();
    expect(screen.getAllByText("$2.00").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/\+.*1\.00/).length).toBeGreaterThanOrEqual(1);
  });

  it("renders averages above numeric trade columns", () => {
    render(
      <TradesTable
        trades={[
          trade({ resolvedWon: true, asset: "BTC" }),
          trade({ resolvedWon: false, asset: "ETH" }),
        ]}
      />,
    );

    const averageRow = screen.getByRole("table").querySelector("thead tr.average-row");
    expect(averageRow).not.toBeNull();
    expect(within(averageRow as HTMLElement).getAllByText("Prom.")).toHaveLength(6);
    expect(within(averageRow as HTMLElement).getByText("35s")).toBeInTheDocument();
    expect(within(averageRow as HTMLElement).getAllByText("$1.00").length).toBeGreaterThanOrEqual(2);
    expect(within(averageRow as HTMLElement).getByText("$0.00")).toBeInTheDocument();
  });

  it("filters trades by market", () => {
    render(
      <TradesTable
        trades={[
          trade({ resolvedWon: true, asset: "BTC" }),
          trade({ resolvedWon: false, asset: "ETH" }),
          trade({ resolvedWon: true, asset: "DOGE" }),
        ]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "ETH" }));

    const rows = getBodyRows();
    expect(rows).toHaveLength(1);
    expect(within(rows[0]).getByText("ETH")).toBeInTheDocument();
    expect(within(rows[0]).getByText("Perdio")).toBeInTheDocument();
  });

  it("filters trades by positive and negative P&L", () => {
    render(
      <TradesTable
        trades={[
          trade({ resolvedWon: true, asset: "BTC" }),
          trade({ resolvedWon: false, asset: "ETH" }),
          trade({ resolvedWon: true, asset: "DOGE" }),
        ]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Negativo" }));

    let rows = getBodyRows();
    expect(rows).toHaveLength(1);
    expect(within(rows[0]).getByText("ETH")).toBeInTheDocument();
    expect(within(rows[0]).getByText(/\-.*1\.00/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Positivo" }));

    rows = getBodyRows();
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText("BTC")).toBeInTheDocument();
    expect(within(rows[1]).getByText("DOGE")).toBeInTheDocument();
  });

  it("sorts visible trades by max and min column values", () => {
    render(
      <TradesTable
        trades={[
          trade({ resolvedWon: true, asset: "BTC", distanceUsd: 5 }),
          trade({ resolvedWon: true, asset: "ETH", distanceUsd: 50 }),
          trade({ resolvedWon: true, asset: "DOGE", distanceUsd: 25 }),
        ]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Distancia" }));

    let rows = getBodyRows();
    expect(within(rows[0]).getByText("ETH")).toBeInTheDocument();
    expect(within(rows[1]).getByText("DOGE")).toBeInTheDocument();
    expect(within(rows[2]).getByText("BTC")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Distancia" }));

    rows = getBodyRows();
    expect(within(rows[0]).getByText("BTC")).toBeInTheDocument();
    expect(within(rows[1]).getByText("DOGE")).toBeInTheDocument();
    expect(within(rows[2]).getByText("ETH")).toBeInTheDocument();
  });

  it("falls back to current market settings when an older trade has no entry window", () => {
    const oldTrade = trade({ resolvedWon: true, asset: "BTC" });
    delete oldTrade.entryWindowSeconds;

    render(<TradesTable trades={[oldTrade]} settings={settings()} />);

    expect(screen.getAllByText("20s").length).toBeGreaterThanOrEqual(1);
  });

  it("locks settings while running", () => {
    render(<SettingsPanel settings={settings()} running={true} busy={false} onSave={vi.fn()} />);

    expect(screen.getByRole("button", { name: /guardar/i })).toBeDisabled();
  });

  it("renders side-specific controls for every market", () => {
    render(<SettingsPanel settings={settings()} running={false} busy={false} onSave={vi.fn()} />);

    expect(screen.getByLabelText("Ventana Bitcoin UP")).toHaveValue("20");
    expect(screen.getByLabelText("Monto sim Bitcoin UP")).toHaveValue("1");
    expect(screen.getByLabelText("Activar Bitcoin UP")).toBeChecked();

    fireEvent.click(screen.getByRole("button", { name: "Editar Ethereum" }));
    expect(screen.getByLabelText("Ventana Ethereum DOWN")).toHaveValue("20");
    expect(screen.getByLabelText("Activar Ethereum UP")).not.toBeChecked();

    fireEvent.click(screen.getByRole("button", { name: "Editar Dogecoin" }));
    expect(screen.getByLabelText("Ask cap Dogecoin DOWN")).toHaveValue("0.98");
  });

  it("exposes the EV gate controls in settings", () => {
    render(<SettingsPanel settings={settings()} running={false} busy={false} onSave={vi.fn()} />);

    expect(screen.getByRole("heading", { name: "Gate de EV" })).toBeInTheDocument();
    expect(screen.getByLabelText("Margen de seguridad")).toHaveValue("0.03");
    expect(screen.getByLabelText("Historia mínima (trades)")).toHaveValue("10");
    expect(screen.getByRole("checkbox", { name: "Exigir valor esperado positivo" })).toBeChecked();
  });

  it("allows free-form number editing in settings", () => {
    render(<SettingsPanel settings={settings()} running={false} busy={false} onSave={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Editar Dogecoin" }));
    const dogeDistance = screen.getByLabelText("Distancia Dogecoin UP");
    fireEvent.focus(dogeDistance);
    fireEvent.change(dogeDistance, { target: { value: "0." } });
    expect(dogeDistance).toHaveValue("0.");

    fireEvent.change(dogeDistance, { target: { value: "0,00025" } });
    expect(dogeDistance).toHaveValue("0,00025");

    fireEvent.blur(dogeDistance);
    expect(dogeDistance).toHaveValue("0.00025");
  });

  it("saves the full settings draft after switching market editors", async () => {
    const onSave = vi.fn(async () => undefined);
    render(<SettingsPanel settings={settings()} running={false} busy={false} onSave={onSave} />);

    fireEvent.click(screen.getByRole("button", { name: "Editar Ethereum" }));
    fireEvent.change(screen.getByLabelText("Ventana Ethereum DOWN"), { target: { value: "45" } });
    fireEvent.click(screen.getByRole("button", { name: "Guardar" }));

    await waitFor(() => expect(onSave).toHaveBeenCalled());
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
      entryWindowSecondsByMarketOutcome: expect.objectContaining({
        BTC: expect.objectContaining({ UP: 20 }),
        ETH: expect.objectContaining({ DOWN: 45 }),
        DOGE: expect.objectContaining({ UP: 20 }),
      }),
    }));
  });

  it("saves Telegram settings and sends a test notification", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/notifications/telegram" && !init?.method) {
        return jsonResponse({
          enabled: false,
          configured: false,
          hasBotToken: false,
          chatId: "",
          source: "none",
        });
      }
      if (path === "/api/notifications/telegram" && init?.method === "PATCH") {
        expect(String(init.body)).toContain("123456:test_token");
        return jsonResponse({
          enabled: true,
          configured: true,
          hasBotToken: true,
          botTokenMasked: "1234...oken",
          chatId: "42",
          publicUrl: "http://polybot.local:8787",
          source: "local",
        });
      }
      if (path === "/api/notifications/telegram/test" && init?.method === "POST") {
        return jsonResponse({ ok: true, sentAtMs: 1 });
      }
      return jsonResponse({ error: "not found" }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<TelegramPanel />);

    await screen.findByText("Desactivado");
    fireEvent.click(screen.getByLabelText("Activar notificaciones Telegram"));
    fireEvent.change(screen.getByLabelText("Bot token"), { target: { value: "123456:test_token" } });
    fireEvent.change(screen.getByLabelText("Chat ID"), { target: { value: "42" } });
    fireEvent.change(screen.getByLabelText("URL publica"), { target: { value: "http://polybot.local:8787" } });
    fireEvent.click(screen.getByRole("button", { name: /guardar/i }));

    expect(await screen.findByText("Configuracion guardada.")).toBeInTheDocument();
    expect(screen.getByLabelText("Bot token")).toHaveValue("");
    expect(screen.queryByDisplayValue("123456:test_token")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /probar/i }));
    expect(await screen.findByText("Mensaje de prueba enviado.")).toBeInTheDocument();
  });

  it("renders the autoajuste recommendation view with decision badges and guard checklist", () => {
    render(
      <AnalysisPanel
        recommendations={recommendationsResponse()}
        settings={settings()}
        busy={false}
        running={false}
        onRefresh={vi.fn(async () => undefined)}
        onApplyRecommendation={vi.fn(async () => undefined)}
      />,
    );

    expect(screen.getByText("Análisis")).toBeInTheDocument();
    // One card per market.
    expect(screen.getByRole("heading", { name: "BTC" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "ETH" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "DOGE" })).toBeInTheDocument();
    // Decision badges reflect canAutoApply / canApply / none.
    expect(screen.getByText("Se auto-aplica")).toBeInTheDocument();
    expect(screen.getByText("Sugerencia (no auto)")).toBeInTheDocument();
    expect(screen.getByText("Datos insuficientes")).toBeInTheDocument();
    // Header summary counts the decisions and shows the total stored samples.
    expect(screen.getByText(/se auto-aplican/)).toBeInTheDocument();
    expect(screen.getByText(/muestras/)).toBeInTheDocument();
    // Plain-language line + requirement chips with value/threshold context.
    expect(screen.getAllByText(/aciertos/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Trades/).length).toBeGreaterThan(0);
    // Failing summary highlights what a market is missing (BTC needs trades).
    expect(screen.getAllByText(/Falta:/).length).toBeGreaterThan(0);
  });

  it("applies a market recommendation", async () => {
    const onApplyRecommendation = vi.fn(async () => undefined);
    render(
      <AnalysisPanel
        recommendations={recommendationsResponse()}
        settings={settings()}
        busy={false}
        running={false}
        onRefresh={vi.fn(async () => undefined)}
        onApplyRecommendation={onApplyRecommendation}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Aplicar recomendada BTC" }));

    await waitFor(() =>
      expect(onApplyRecommendation).toHaveBeenCalledWith(
        "BTC",
        expect.objectContaining({ entryWindowSeconds: 33, minDistanceUsd: 25 }),
      ),
    );
    expect(await screen.findByText(/Aplicada la recomendada de BTC/)).toBeInTheDocument();
  });

  it("blocks manual apply while the bot is running", () => {
    render(
      <AnalysisPanel
        recommendations={recommendationsResponse()}
        settings={settings()}
        busy={false}
        running={true}
        onRefresh={vi.fn(async () => undefined)}
        onApplyRecommendation={vi.fn(async () => undefined)}
      />,
    );

    expect(screen.getByRole("button", { name: "Aplicar recomendada BTC" })).toBeDisabled();
    expect(screen.getByText("Deten el bot para importar datos de Analisis.")).toBeInTheDocument();
  });

  it("exports and imports analysis data from the Analysis panel", async () => {
    const onExport = vi.fn(async () => undefined);
    const onImport = vi.fn(async () => ({
      importedCount: 2,
      duplicateCount: 1,
      skippedInvalidCount: 1,
      totalKnownSamples: 8,
      firstSampleAtMs: Date.UTC(2026, 4, 8, 12),
      lastSampleAtMs: Date.UTC(2026, 4, 8, 13),
    }));
    const onRefresh = vi.fn(async () => undefined);
    render(
      <AnalysisPanel
        recommendations={recommendationsResponse()}
        settings={settings()}
        busy={false}
        running={false}
        onRefresh={onRefresh}
        onApplyRecommendation={vi.fn(async () => undefined)}
        onExport={onExport}
        onImport={onImport}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Descargar" }));
    await waitFor(() => expect(onExport).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("Descarga de datos de Analisis iniciada.")).toBeInTheDocument();

    const file = new File(["{}"], "polybot-analysis.jsonl", { type: "application/x-ndjson" });
    fireEvent.change(screen.getByLabelText("Archivo de Analisis"), { target: { files: [file] } });

    await waitFor(() => expect(onImport).toHaveBeenCalledWith(file));
    await waitFor(() => expect(onRefresh).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("Datos importados: 2 nuevos, 1 duplicados, 1 invalidos, 8 totales.")).toBeInTheDocument();
  });

  it("removes the old EV strategy table and Ollama controls", () => {
    render(
      <AnalysisPanel
        recommendations={recommendationsResponse()}
        settings={settings()}
        busy={false}
        running={false}
        onRefresh={vi.fn(async () => undefined)}
        onApplyRecommendation={vi.fn(async () => undefined)}
      />,
    );

    expect(screen.queryByRole("button", { name: "Analizar con Ollama" })).not.toBeInTheDocument();
    expect(screen.queryByText("Prompt Ollama")).not.toBeInTheDocument();
    expect(screen.queryByText("Detalle completo")).not.toBeInTheDocument();
    expect(screen.queryByText("Preview")).not.toBeInTheDocument();
  });

});

function settings(): UiSettings {
  return {
    minBtcDistanceUsd: 20,
    enabledMarkets: ["BTC"],
    enabledMarketOutcomes: {
      BTC: { UP: true, DOWN: true },
      ETH: { UP: false, DOWN: false },
      DOGE: { UP: false, DOWN: false },
    },
    minDistanceUsdByMarket: { BTC: 20, ETH: 5, DOGE: 0.0005 },
    minDistanceUsdByMarketOutcome: {
      BTC: { UP: 20, DOWN: 20 },
      ETH: { UP: 5, DOWN: 5 },
      DOGE: { UP: 0.0005, DOWN: 0.0005 },
    },
    entryWindowSeconds: 20,
    entryWindowSecondsByMarket: { BTC: 20, ETH: 20, DOGE: 20 },
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
    maxAskPriceCeiling: 0.85,
    maxAskPriceByMarketOutcome: {
      BTC: { UP: 0.98, DOWN: 0.98 },
      ETH: { UP: 0.98, DOWN: 0.98 },
      DOGE: { UP: 0.98, DOWN: 0.98 },
    },
    dailySpendLimitUsd: 50,
    maxDailyLossUsd: 0,
    maxConsecutiveLosses: 0,
    requirePositiveEv: true,
    evUseSimilarity: false,
    evSafetyMargin: 0.03,
    evMinHistoryTrades: 10,
    minFillRatio: 0.5,
    evMinExpectedRoi: 0.01,
    tickStaleMs: 10_000,
    pollIntervalMs: 1_000,
    openingCaptureGraceMs: 15_000,
    aiAutoApplyLive: false,
  };
}

function jsonResponse(body: unknown, statusCode = 200): Response {
  return new Response(JSON.stringify(body), {
    status: statusCode,
    headers: { "Content-Type": "application/json" },
  });
}

function getBodyRows(): HTMLElement[] {
  return Array.from(screen.getByRole("table").querySelectorAll("tbody tr"));
}

function status(args: { liveReady: boolean }): UiStatus {
  return {
    running: false,
    settings: settings(),
    config: {
      ...settings(),
      mode: "sim",
      dataDir: "data",
      hasPrivateKey: args.liveReady,
      hasFunderAddress: args.liveReady,
      hasSignatureType: args.liveReady,
    },
    liveReadiness: {
      ready: args.liveReady,
      hasPrivateKey: args.liveReady,
      hasFunderAddress: args.liveReady,
      hasSignatureType: args.liveReady,
    },
    markets: [],
    signal: { reason: "no_market", inEntryWindow: false },
    dailySpendUsd: 0,
    pnl: {
      realizedUsd: 0,
      realizedStakeUsd: 0,
      payoutUsd: 0,
      pendingStakeUsd: 0,
      totalStakeUsd: 0,
      resolvedCount: 0,
      pendingCount: 0,
      wonCount: 0,
      lostCount: 0,
    },
    pnlByMode: {
      sim: pnlSummary({}),
      live: pnlSummary({}),
    },
    pnlHistoricalByMode: {
      sim: pnlSummary({}),
      live: pnlSummary({}),
    },
    pnlResetAtMs: {},
    logs: [],
  };
}

function pnlSummary(overrides: Partial<UiStatus["pnl"]>): UiStatus["pnl"] {
  return {
    realizedUsd: 0,
    realizedStakeUsd: 0,
    payoutUsd: 0,
    pendingStakeUsd: 0,
    totalStakeUsd: 0,
    resolvedCount: 0,
    pendingCount: 0,
    wonCount: 0,
    lostCount: 0,
    ...overrides,
  };
}

function trade(args: { resolvedWon: boolean; asset?: MarketSymbol; distanceUsd?: number }): TradeAttempt {
  const asset = args.asset ?? "BTC";
  return {
    id: `trade-${asset}`,
    asset,
    slug: `${asset.toLowerCase()}-updown-5m-1`,
    mode: "sim",
    outcome: "UP",
    tokenId: "token",
    amountUsd: 1,
    maxAskPrice: 0.98,
    bestAsk: 0.5,
    estimatedShares: 2,
    openingPrice: 100,
    entryPrice: 125,
    distanceUsd: args.distanceUsd ?? 25,
    entryWindowSeconds: 35,
    windowStartMs: 1,
    endMs: 2,
    createdAtMs: 3,
    resolved: {
      resolvedAtMs: 4,
      finalPrice: 130,
      finalTickTimestampMs: 4,
      winningOutcome: args.resolvedWon ? "UP" : "DOWN",
      won: args.resolvedWon,
    },
  };
}

function recommendationsResponse(): AiRecommendationsResponse {
  const metrics = (over: Partial<RecommendationMetrics> = {}): RecommendationMetrics => ({
    sampleCount: 300,
    signalCount: 250,
    tradeCount: 9,
    winCount: 6,
    lossCount: 3,
    quoteCoverage: 0.04,
    averageRoi: 0.08,
    adjustedRoi: 0.09,
    yieldPerWindow: 0.003,
    expectedRoi: -0.1,
    walkForwardRoi: 0.38,
    lowerBoundRoi: 0.33,
    overfitRisk: 0.36,
    predictedWinProbability: 0.6,
    calibrationError: 0.4,
    maxDrawdown: 1,
    ...over,
  });
  const at = Date.UTC(2026, 4, 8, 12);
  return {
    generatedAtMs: at,
    totalSamples: 20146,
    thresholds: {
      minAutoSamples: 40,
      minAutoTrades: 15,
      minQuoteCoverage: 0.02,
      minYieldImprovement: 0.0008,
      maxOverfitRisk: 0.45,
      maxWindowChangeSeconds: 60,
      maxDistanceChangeRatio: 10,
      autoApplyCooldownMs: 0,
    },
    recommendations: [
      {
        market: "BTC",
        status: "ready",
        confidence: "medium",
        generatedAtMs: at,
        current: { entryWindowSeconds: 52, minDistanceUsd: 21, metrics: metrics({ tradeCount: 22 }) },
        recommended: { entryWindowSeconds: 33, minDistanceUsd: 25, metrics: metrics() },
        improvementAdjustedRoi: 0.5,
        improvementYield: 0.03,
        sampleCount: 300,
        reason: "Mejora predictiva exploratoria validada con walk-forward.",
        canApply: true,
        canAutoApply: false,
      },
      {
        market: "ETH",
        status: "ready",
        confidence: "high",
        generatedAtMs: at,
        current: { entryWindowSeconds: 55, minDistanceUsd: 1, metrics: metrics({ tradeCount: 7 }) },
        recommended: {
          entryWindowSeconds: 55,
          minDistanceUsd: 0.25,
          metrics: metrics({ tradeCount: 50, quoteCoverage: 0.17, overfitRisk: 0.09 }),
        },
        improvementAdjustedRoi: -0.1,
        improvementYield: 0.009,
        sampleCount: 300,
        reason: "Alta confianza: mejora validada fuera de muestra y dentro de guardas.",
        canApply: true,
        canAutoApply: true,
      },
      {
        market: "DOGE",
        status: "insufficient_data",
        confidence: "low",
        generatedAtMs: at,
        current: {
          entryWindowSeconds: 45,
          minDistanceUsd: 0.0001,
          metrics: metrics({ tradeCount: 0, quoteCoverage: 0, overfitRisk: 1, walkForwardRoi: undefined, lowerBoundRoi: undefined, yieldPerWindow: undefined }),
        },
        sampleCount: 8,
        reason: "Sin oportunidades ejecutables con quotes dentro del cap actual.",
        canApply: false,
        canAutoApply: false,
      },
    ],
  };
}

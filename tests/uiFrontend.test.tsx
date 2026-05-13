// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AnalysisPanel, App, ControlBar, SettingsPanel, TelegramPanel, TradesTable } from "../src/ui/client/App.js";
import type { UiSettings, UiStatus } from "../src/ui/shared.js";
import type { MarketSymbol, OllamaTradeAnalysisResponse, StrategyAnalysisResponse, StrategyCandidate, TradeAttempt } from "../src/types.js";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

describe("UI frontend components", () => {
  it("shows the Analysis tab in the app navigation", () => {
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
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === "/api/status") {
        return jsonResponse(status({ liveReady: false }));
      }
      if (path === "/api/settings") {
        return jsonResponse(settings());
      }
      if (path === "/api/analysis/strategies") {
        return jsonResponse(analysisResponse());
      }
      if (path === "/api/trades?limit=100") {
        return jsonResponse({ trades: [] });
      }
      return jsonResponse({ error: "not found" }, 404);
    }));

    render(<App />);
    expect(screen.getByRole("button", { name: "Telegram" })).toBeInTheDocument();

    expect(screen.getByRole("button", { name: "Análisis" })).toBeInTheDocument();
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

  it("renders trade outcomes", () => {
    render(<TradesTable trades={[trade({ resolvedWon: true })]} />);

    expect(screen.getByRole("button", { name: "Todos" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "BTC" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Positivo" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Negativo" })).toBeInTheDocument();
    expect(screen.getByText("UP")).toBeInTheDocument();
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
    expect(screen.getByLabelText("Ventana Ethereum DOWN")).toHaveValue("20");
    expect(screen.getByLabelText("Ask cap Dogecoin DOWN")).toHaveValue("0.98");
    expect(screen.getByLabelText("Monto sim Bitcoin UP")).toHaveValue("1");
    expect(screen.getByLabelText("Activar Bitcoin UP")).toBeChecked();
    expect(screen.getByLabelText("Activar Ethereum UP")).not.toBeChecked();
    expect(screen.getByLabelText("Auto live Bitcoin UP")).not.toBeChecked();
    expect(screen.getByLabelText("Tras perder Bitcoin UP")).not.toBeChecked();
  });

  it("allows free-form number editing in settings", () => {
    render(<SettingsPanel settings={settings()} running={false} busy={false} onSave={vi.fn()} />);

    const dogeDistance = screen.getByLabelText("Distancia Dogecoin UP");
    fireEvent.focus(dogeDistance);
    fireEvent.change(dogeDistance, { target: { value: "0." } });
    expect(dogeDistance).toHaveValue("0.");

    fireEvent.change(dogeDistance, { target: { value: "0,00025" } });
    expect(dogeDistance).toHaveValue("0,00025");

    fireEvent.blur(dogeDistance);
    expect(dogeDistance).toHaveValue("0.00025");
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

  it("renders strategy analysis and requests Ollama analysis", async () => {
    const onAnalyze = vi.fn(async () => ollamaResponse());
    render(
      <AnalysisPanel
        analysis={analysisResponse()}
        busy={false}
        running={false}
        onRefresh={vi.fn(async () => undefined)}
        onAnalyze={onAnalyze}
        onApplyStrategy={vi.fn(async () => undefined)}
      />,
    );

    expect(screen.getByText("Análisis")).toBeInTheDocument();
    expect(screen.getAllByText("Confiables").length).toBeGreaterThan(0);
    expect(screen.getByText("BTC actual")).toBeInTheDocument();
    expect(screen.getAllByText("Media").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Resumen" })).toBeInTheDocument();
    expect(screen.getAllByText(/EV/).length).toBeGreaterThan(0);
    expect(screen.getAllByText("P ajustada").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Entrar\u00eda").length).toBeGreaterThan(0);
    expect(screen.getAllByText("+25.0%").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "Riesgos" }));
    fireEvent.click(screen.getByRole("button", { name: "Analizar con Ollama" }));

    await waitFor(() => expect(onAnalyze).toHaveBeenCalledWith(expect.stringContaining("riesgos")));
    expect(await screen.findByText("Tesis: EV positivo.")).toBeInTheDocument();
  });

  it("selects and applies a strategy from Analysis", async () => {
    const onApplyStrategy = vi.fn(async () => undefined);
    render(
      <AnalysisPanel
        analysis={analysisResponse()}
        busy={false}
        running={false}
        onRefresh={vi.fn(async () => undefined)}
        onAnalyze={vi.fn(async () => ollamaResponse())}
        onApplyStrategy={onApplyStrategy}
      />,
    );

    const applyButton = screen.getByRole("button", { name: "Aplicar estrategia" });
    expect(applyButton).toBeDisabled();

    fireEvent.click(screen.getAllByRole("button", { name: /seleccionar estrategia BTC UP/i })[0]);
    expect(applyButton).toBeEnabled();

    fireEvent.click(applyButton);

    await waitFor(() => expect(onApplyStrategy).toHaveBeenCalledWith(expect.objectContaining({ market: "BTC", outcome: "UP" })));
    expect(await screen.findByText(/Estrategia aplicada/)).toBeInTheDocument();
  });

  it("keeps Ollama responses until the user deletes them", async () => {
    const onAnalyze = vi.fn(async () => ollamaResponse());
    const firstRender = render(
      <AnalysisPanel
        analysis={analysisResponse()}
        busy={false}
        running={false}
        onRefresh={vi.fn(async () => undefined)}
        onAnalyze={onAnalyze}
        onApplyStrategy={vi.fn(async () => undefined)}
      />,
    );

    fireEvent.change(screen.getByLabelText("Prompt Ollama"), { target: { value: "guarda esta respuesta" } });
    fireEvent.click(screen.getByRole("button", { name: "Analizar con Ollama" }));
    expect(await screen.findByText("Tesis: EV positivo.")).toBeInTheDocument();

    firstRender.unmount();
    render(
      <AnalysisPanel
        analysis={analysisResponse()}
        busy={false}
        running={false}
        onRefresh={vi.fn(async () => undefined)}
        onAnalyze={onAnalyze}
        onApplyStrategy={vi.fn(async () => undefined)}
      />,
    );

    expect(screen.getByText("Tesis: EV positivo.")).toBeInTheDocument();
    expect(screen.getByText("Prompt: guarda esta respuesta")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Borrar respuesta Ollama/i }));
    expect(screen.queryByText("Tesis: EV positivo.")).not.toBeInTheDocument();
  });

  it("keeps old AI recommendation controls removed while showing strategy apply", () => {
    render(
      <AnalysisPanel
        analysis={analysisResponse()}
        busy={false}
        running={false}
        onRefresh={vi.fn(async () => undefined)}
        onAnalyze={vi.fn(async () => ollamaResponse())}
        onApplyStrategy={vi.fn(async () => undefined)}
      />,
    );

    expect(screen.queryByText("IA local")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Aplicar estrategia" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Auto aplicar" })).not.toBeInTheDocument();
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
    dailySpendLimitUsd: 50,
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
    logs: [],
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

function analysisResponse(): StrategyAnalysisResponse {
  const strategy: StrategyCandidate = {
    market: "BTC" as const,
    outcome: "UP" as const,
    entryWindowSeconds: 20,
    minDistanceUsd: 10,
    maxAskPrice: 0.8,
    isCurrent: true,
    confidence: "medium",
    riskFlags: [],
    qualityScore: 0.43,
    evDeltaVsCurrent: 0,
    metrics: {
      sampleCount: 5,
      signalCount: 5,
      tradeCount: 5,
      winCount: 3,
      lossCount: 2,
      quoteCoverage: 1,
      winRate: 0.5,
      realWinProbability: 0.5,
      adjustedWinProbability: 0.625,
      averageAsk: 0.5,
      historicalRoi: 0.25,
      evRoi: 0.25,
      expectedRoi: 0.25,
      expectedValueUsd: 0.25,
      minExpectedValueUsd: 0.01,
      winProfitUsd: 1,
      lossUsd: -1,
      breakEvenProbability: 0.5,
      edge: 0.125,
      liveTradeAmountUsd: 1,
      askGuidance: "cheap",
      passesBasicEntry: true,
      passesSafetyMargin: true,
      passesExpectedValue: true,
      passesRecommendedEntry: true,
      evDecisionReason: "passes",
      maxDrawdown: 1,
    },
  };
  return {
    generatedAtMs: Date.UTC(2026, 4, 8, 12),
    strategies: [strategy],
    currentStrategies: [strategy],
    summary: {
      sampleCount: 5,
      strategyCount: 1,
      currentStrategyCount: 1,
      reliableStrategyCount: 1,
      bestEvRoi: 0.25,
      bestTradeCount: 5,
      bestReliableEvRoi: 0.25,
      bestReliableTradeCount: 5,
    },
  };
}

function ollamaResponse(): OllamaTradeAnalysisResponse {
  return {
    generatedAtMs: Date.UTC(2026, 4, 8, 12),
    model: "gpt-oss:120b",
    content: "Tesis: EV positivo.",
    contextSummary: "2 muestras, 1 estrategias rankeadas, 0 trades recientes.",
  };
}

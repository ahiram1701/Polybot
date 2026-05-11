// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AiPanel, ControlBar, SettingsPanel, TradesTable } from "../src/ui/client/App.js";
import type { UiSettings, UiStatus } from "../src/ui/shared.js";
import type { AiRecommendation, AiRecommendationsResponse, MarketSymbol, TradeAttempt } from "../src/types.js";

afterEach(() => cleanup());

describe("UI frontend components", () => {
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

  it("renders entry-window controls for every market", () => {
    render(<SettingsPanel settings={settings()} running={false} busy={false} onSave={vi.fn()} />);

    expect(screen.getByLabelText("Ventana Bitcoin")).toHaveValue("20");
    expect(screen.getByLabelText("Ventana Ethereum")).toHaveValue("20");
    expect(screen.getByLabelText("Ventana Dogecoin")).toHaveValue("20");
  });

  it("allows free-form number editing in settings", () => {
    render(<SettingsPanel settings={settings()} running={false} busy={false} onSave={vi.fn()} />);

    const dogeDistance = screen.getByLabelText("Distancia Dogecoin");
    fireEvent.focus(dogeDistance);
    fireEvent.change(dogeDistance, { target: { value: "0." } });
    expect(dogeDistance).toHaveValue("0.");

    fireEvent.change(dogeDistance, { target: { value: "0,00025" } });
    expect(dogeDistance).toHaveValue("0,00025");

    fireEvent.blur(dogeDistance);
    expect(dogeDistance).toHaveValue("0.00025");
  });

  it("renders AI recommendations and applies a market suggestion", () => {
    const onApply = vi.fn(async () => undefined);
    render(
      <AiPanel
        recommendations={recommendationsResponse([recommendation("BTC")])}
        settings={settings()}
        status={status({ liveReady: false })}
        busy={false}
        onApply={onApply}
        onRefresh={vi.fn(async () => undefined)}
        onAutoApply={vi.fn(async () => undefined)}
        onToggleAutoApply={vi.fn(async () => undefined)}
      />,
    );

    expect(screen.getByText("IA local")).toBeInTheDocument();
    expect(screen.getByText("BTC")).toBeInTheDocument();
    expect(screen.getByText("Alta")).toBeInTheDocument();
    expect(screen.getByText("Edge")).toBeInTheDocument();
    expect(screen.getByText("Walk")).toBeInTheDocument();
    expect(screen.getByText("Riesgo")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Aplicar" }));
    expect(onApply).toHaveBeenCalledWith("BTC");
  });

  it("disables manual AI apply while running", () => {
    render(
      <AiPanel
        recommendations={recommendationsResponse([recommendation("BTC")])}
        settings={settings()}
        status={{ ...status({ liveReady: true }), running: true, mode: "live" }}
        busy={false}
        onApply={vi.fn(async () => undefined)}
        onRefresh={vi.fn(async () => undefined)}
        onAutoApply={vi.fn(async () => undefined)}
        onToggleAutoApply={vi.fn(async () => undefined)}
      />,
    );

    expect(screen.getByRole("button", { name: "Aplicar" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Auto aplicar" })).toBeEnabled();
  });
});

function settings(): UiSettings {
  return {
    minBtcDistanceUsd: 20,
    enabledMarkets: ["BTC"],
    minDistanceUsdByMarket: { BTC: 20, ETH: 5, DOGE: 0.0005 },
    entryWindowSeconds: 20,
    entryWindowSecondsByMarket: { BTC: 20, ETH: 20, DOGE: 20 },
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

function recommendationsResponse(recommendations: AiRecommendation[]): AiRecommendationsResponse {
  return {
    generatedAtMs: Date.UTC(2026, 4, 8, 12),
    recommendations,
  };
}

function recommendation(market: MarketSymbol): AiRecommendation {
  return {
    market,
    status: "ready",
    confidence: "high",
    generatedAtMs: Date.UTC(2026, 4, 8, 12),
    current: {
      entryWindowSeconds: 20,
      minDistanceUsd: 20,
      metrics: {
        sampleCount: 20,
        signalCount: 20,
        tradeCount: 20,
        winCount: 10,
        lossCount: 10,
        quoteCoverage: 1,
        averageRoi: 0,
        adjustedRoi: 0,
        expectedRoi: 0,
        walkForwardRoi: 0,
        lowerBoundRoi: 0,
        overfitRisk: 0.2,
        predictedWinProbability: 0.5,
        calibrationError: 0.1,
        maxDrawdown: 1,
      },
    },
    recommended: {
      entryWindowSeconds: 30,
      minDistanceUsd: 15,
      metrics: {
        sampleCount: 20,
        signalCount: 20,
        tradeCount: 20,
        winCount: 15,
        lossCount: 5,
        quoteCoverage: 1,
        averageRoi: 0.2,
        adjustedRoi: 0.12,
        expectedRoi: 0.16,
        walkForwardRoi: 0.14,
        lowerBoundRoi: 0.1,
        overfitRisk: 0.2,
        predictedWinProbability: 0.62,
        calibrationError: 0.08,
        maxDrawdown: 1,
      },
    },
    improvementAdjustedRoi: 0.12,
    sampleCount: 20,
    reason: "Alta confianza",
    canApply: true,
    canAutoApply: true,
  };
}

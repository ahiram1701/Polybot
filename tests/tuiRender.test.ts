import { beforeAll, describe, expect, it } from "vitest";

import type { CompactStatus, CompactTrade } from "../src/agent/statusSummary.js";
import type { UiSettings } from "../src/ui/shared.js";
import { applyNumber, applyToggle, buildSettingsFields } from "../src/tui/settingsModel.js";
import {
  renderDashboard,
  renderSettings,
  renderStatusLine,
  renderTabBar,
  renderTrades,
  type ViewModel,
} from "../src/tui/render.js";
import { setColorEnabled, stripAnsi } from "../src/tui/theme.js";

// Assert on plain text: color off so substrings aren't split by escape codes.
beforeAll(() => setColorEnabled(false));

function numMap(v: number) {
  return { BTC: { UP: v, DOWN: v }, ETH: { UP: v, DOWN: v }, DOGE: { UP: v, DOWN: v } };
}
function boolMap(v: boolean) {
  return { BTC: { UP: v, DOWN: v }, ETH: { UP: v, DOWN: v }, DOGE: { UP: v, DOWN: v } };
}

// Only the fields the pure Settings model actually reads/writes — enough for these unit tests.
function testSettings(): UiSettings {
  return {
    requirePositiveEv: true,
    evUseSimilarity: false,
    evCalibration: false,
    autoMinLive: true,
    arbEnabled: false,
    aiAutoApplyLive: true,
    aiAutoTuneAskCap: false,
    dailySpendLimitUsd: 250,
    maxAskPriceCeiling: 0.85,
    maxAskPrice: 0.6,
    liveTradeAmountUsd: 5,
    simTradeAmountUsd: 5,
    enabledMarkets: ["BTC", "ETH", "DOGE"],
    enabledMarketOutcomes: boolMap(true),
    minAskPriceByMarketOutcome: numMap(0.3),
    maxAskPriceByMarketOutcome: numMap(0.6),
    liveTradeAmountUsdByMarketOutcome: numMap(5),
    simTradeAmountUsdByMarketOutcome: numMap(5),
  } as unknown as UiSettings;
}

function statusFixture(overrides: Partial<CompactStatus> = {}): CompactStatus {
  return {
    running: true,
    mode: "sim",
    startedAtMs: 1000,
    uptimeSeconds: 125,
    liveReady: false,
    dailySpendUsd: 10,
    dailySpendLimitUsd: 250,
    markets: [
      {
        marketSymbol: "ETH",
        reason: "waiting_entry_window",
        inEntryWindow: true,
        secondsToEnd: 90,
        outcome: "UP",
        distanceUsd: 1.06,
        tickValue: 3000,
      },
    ],
    pnlByMode: {
      sim: { realizedUsd: -11.37, roiPct: -0.4, resolvedCount: 6, wonCount: 2, lostCount: 4, pendingCount: 0 },
      live: { realizedUsd: -23.67, roiPct: -0.1, resolvedCount: 51, wonCount: 23, lostCount: 28, pendingCount: 0 },
    },
    pnlHistoricalByMode: {
      sim: { realizedUsd: 0, resolvedCount: 0, wonCount: 0, lostCount: 0, pendingCount: 0 },
      live: { realizedUsd: 0, resolvedCount: 0, wonCount: 0, lostCount: 0, pendingCount: 0 },
    },
    pnlResetAtMs: {},
    recentActivity: {
      sampleSize: 60,
      skipReasonCounts: { btc_distance_below_threshold: 12, no_ask_liquidity_under_cap: 5 },
      otherMessageCounts: {},
    },
    ...overrides,
  };
}

function tradeFixture(overrides: Partial<CompactTrade> = {}): CompactTrade {
  return {
    id: "t1",
    market: "ETH",
    mode: "sim",
    outcome: "UP",
    amountUsd: 5,
    bestAsk: 0.52,
    createdAtMs: new Date(2026, 6, 21, 14, 30).getTime(),
    resolved: { won: true, winningOutcome: "UP" },
    netUsd: 4.6,
    ...overrides,
  };
}

function baseVm(overrides: Partial<ViewModel> = {}): ViewModel {
  return {
    width: 100,
    height: 30,
    tab: "dashboard",
    nowMs: new Date(2026, 6, 21, 17, 0).getTime(),
    connected: true,
    tradesScroll: 0,
    analysisLoading: false,
    settingsSelected: 0,
    settingsScroll: 0,
    ...overrides,
  };
}

/** Salto de linea, para no repetir el literal en cada assert. */
const NL = "\n";

describe("TUI render", () => {
  it("renders the dashboard with running mode, P&L, win rate, markets and skip reasons", () => {
    const text = stripAnsi(renderDashboard(baseVm({ status: statusFixture() })).join("\n"));
    expect(text).toContain("corriendo SIM");
    expect(text).toContain("-$11.37");
    expect(text).toContain("win 33.3%");
    expect(text).toContain("ETH");
    // Traducido, no el codigo crudo: la TUI comparte el mapa de etiquetas con la UI web.
    expect(text).toContain("Distancia insuficiente");
    expect(text).not.toContain("btc_distance_below_threshold");
    expect(text).toContain("$10.00 / $250.00");
  });

  /**
   * Capital y salud del bucle vivian solo en la UI web. Son justo las dos cosas que explican "por que
   * no opera" cuando ningun motivo de skip lo explica: un saldo que no se puede leer, o un bucle que
   * falla y llega tarde a las entradas.
   */
  it("muestra el capital y de donde sale", () => {
    const conSaldo = stripAnsi(
      renderDashboard(
        baseVm({ status: statusFixture({ bankroll: { usd: 17.8, source: "onchain" } }) }),
      ).join(NL),
    );
    expect(conSaldo).toContain("$17.80");
    expect(conSaldo).toContain("on-chain");

    // "declarado" avisa de que la lectura on-chain fallo y se esta dimensionando a mano.
    const declarado = stripAnsi(
      renderDashboard(
        baseVm({ status: statusFixture({ bankroll: { usd: 17, source: "declared" } }) }),
      ).join(NL),
    );
    expect(declarado).toContain("declarado");
  });

  it("muestra el porcentaje de iteraciones fallidas del bucle", () => {
    const text = stripAnsi(
      renderDashboard(
        baseVm({ status: statusFixture({ loopHealth: { iterations: 600, failed: 42, failedPct: 7 } }) }),
      ).join(NL),
    );
    expect(text).toContain("7.0% fallidas");
    expect(text).toContain("42/600");
  });

  it("no inventa una fila de bucle cuando todavia no hay iteraciones", () => {
    const text = stripAnsi(
      renderDashboard(
        baseVm({ status: statusFixture({ loopHealth: { iterations: 0, failed: 0, failedPct: 0 } }) }),
      ).join(NL),
    );
    expect(text).not.toContain("fallidas");
  });

  it("shows the risk halt banner when tripped", () => {
    const status = statusFixture({
      riskHalt: { tripped: true, reason: "daily_loss_limit", dailyLossUsd: 30, consecutiveLosses: 3 },
    });
    const text = stripAnsi(renderDashboard(baseVm({ status })).join("\n"));
    expect(text).toContain("FRENO");
    expect(text).toContain("daily_loss_limit");
  });

  it("renders a resolved trade row with result and net", () => {
    const text = stripAnsi(renderTrades(baseVm({ trades: [tradeFixture()] })).join("\n"));
    expect(text).toContain("WON");
    expect(text).toContain("ETH");
    expect(text).toContain("+$4.60");
  });

  it("locks settings editing while the bot runs and shows group headers", () => {
    const fields = buildSettingsFields(testSettings());
    const text = stripAnsi(
      renderSettings(baseVm({ status: statusFixture({ running: true }), settingsFields: fields, settingsSelected: 1 })).join("\n"),
    );
    expect(text).toContain("detén el bot para editar");
    expect(text).toContain("Estrategia");
    expect(text).toContain("Mercados");
  });

  it("renders the LIVE confirmation prompt with the exact phrase", () => {
    const line = stripAnsi(
      renderStatusLine(baseVm({ prompt: { title: "Escribe «ARRANCAR LIVE» para operar con DINERO REAL:", buffer: "ARR" } })),
    );
    expect(line).toContain("ARRANCAR LIVE");
    expect(line).toContain("ARR");
  });

  it("highlights the active tab in the tab bar", () => {
    expect(stripAnsi(renderTabBar(baseVm({ tab: "trades" })))).toContain("Trades");
    expect(stripAnsi(renderTabBar(baseVm({ tab: "settings" })))).toContain("Settings");
  });
});

describe("TUI settings model", () => {
  it("builds fields with headers, toggles and per-market amounts", () => {
    const fields = buildSettingsFields(testSettings());
    expect(fields.some((f) => f.kind === "header" && f.label === "Estrategia")).toBe(true);
    expect(fields.find((f) => f.id === "arbEnabled")?.value).toBe("OFF");
    expect(fields.find((f) => f.id === "amount:ETH:UP")?.value).toBe("$5.00");
    expect(fields.find((f) => f.id === "enabled:BTC:UP")?.value).toBe("ON");
  });

  it("toggles a top-level flag on a fresh clone", () => {
    const before = testSettings();
    const after = applyToggle(before, "arbEnabled");
    expect(after.arbEnabled).toBe(true);
    expect(before.arbEnabled).toBe(false); // original untouched
  });

  it("toggling a market outcome keeps enabledMarkets consistent", () => {
    const after = applyToggle(testSettings(), "enabled:ETH:UP");
    expect(after.enabledMarketOutcomes.ETH.UP).toBe(false);
    // ETH still enabled because DOWN remains on.
    expect(after.enabledMarkets).toContain("ETH");
    const both = applyToggle(after, "enabled:ETH:DOWN");
    expect(both.enabledMarkets).not.toContain("ETH");
  });

  it("clamps the global ask cap to the ceiling and the floor to each cap", () => {
    const cap = applyNumber(testSettings(), "askCapAll", 0.95);
    expect(cap.maxAskPriceByMarketOutcome.BTC.UP).toBe(0.85); // clamped to ceiling
    const floor = applyNumber(testSettings(), "askFloorAll", 0.99);
    expect(floor.minAskPriceByMarketOutcome.BTC.UP).toBe(0.6); // clamped to the side's cap
  });

  it("keeps sim and live amounts identical when editing a market amount", () => {
    const after = applyNumber(testSettings(), "amount:ETH:UP", 7);
    expect(after.liveTradeAmountUsdByMarketOutcome.ETH.UP).toBe(7);
    expect(after.simTradeAmountUsdByMarketOutcome.ETH.UP).toBe(7);
  });
});

/**
 * El auto-aplicado solo es tolerable si se ve. Sin este panel, "que aplique solo" seria exactamente
 * "entrar sin que nadie lo vea".
 */
describe("TUI: decisiones del autoajuste", () => {
  const programa = (overrides: Record<string, unknown> = {}) => ({
    market: "ETH",
    lo: 0.85,
    hi: 0.9,
    createdAtMs: 0,
    expectedNetPerTradeUsd: 0.294,
    outOfSampleTrades: 73,
    reason: "gana en ambas mitades",
    status: "probing",
    ...overrides,
  });

  it("muestra la banda, lo que promete y su estado", () => {
    const text = stripAnsi(
      renderDashboard(baseVm({ status: statusFixture({ bandPrograms: [programa()] as never }) })).join(NL),
    );
    expect(text).toContain("0.85-0.90");
    expect(text).toContain("sondeando");
    expect(text).toContain("$0.29");
  });

  it("cuando hay veredicto enseña lo REALIZADO junto a lo prometido", () => {
    // Es la comparacion que importa: no "¿gana?" sino "¿entrega lo que dijo?".
    const text = stripAnsi(
      renderDashboard(
        baseVm({
          status: statusFixture({
            bandPrograms: [programa({ status: "rejected", realizedNetPerTradeUsd: 0.03 })] as never,
          }),
        }),
      ).join(NL),
    );
    expect(text).toContain("descartada");
    expect(text).toContain("real $0.03/op");
  });

  it("sin programas no pinta el panel", () => {
    const text = stripAnsi(renderDashboard(baseVm({ status: statusFixture() })).join(NL));
    expect(text).not.toContain("bandas en prueba");
  });
});

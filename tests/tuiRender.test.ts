import { beforeAll, describe, expect, it } from "vitest";

import type { CompactStatus, CompactTrade } from "../src/agent/statusSummary.js";
import type { UiSettings } from "../src/ui/shared.js";
import { applyNumber, applyToggle, buildSettingsFields, isModeId, TUI_RISK_KEYS } from "../src/tui/settingsModel.js";
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
    arbMode: "heredado",
    directionalMode: "heredado",
    maxDailyLossUsd: 15,
    maxConsecutiveLosses: 6,
    riskHaltCooldownHours: 1,
    minBankrollForDirectionalUsd: 50,
    liveBankrollUsd: 17,
    liveMaxSlippage: 0.02,
    arbMaxUsdPerOpportunity: 17,
    arbMinNetPerSet: 0.01,
    arbNakedLegHaltStreak: 1,
    requirePositiveEv: true,
    evUseSimilarity: false,
    evCalibration: false,
    autoMinLive: true,
    arbEnabled: false,
    aiAutoApplyLive: true,
    aiAutoTuneAskCap: false,
    dailySpendLimitUsd: 250,
    maxAskPriceCeiling: 0.85,
    favoriteStrategyEnabled: true,
    favoriteMinAsk: 0.76,
    favoriteMaxAsk: 0.85,
    favoriteMaxAskSum: 1.15,
    favoriteAllowLive: false,
    favoriteMaxSizeEnabled: false,
    favoriteMaxSizeAsk: 0.98,
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

/**
 * El maker no escribe trades, asi que su actividad no sale por el P&L ni por la pestaña de
 * operaciones. Sin este panel, dinero real en el libro y un maker parado se ven exactamente igual —
 * que es como los $41,41 del 2026-08-19 estuvieron 40 minutos a la vista de nadie.
 */
describe("renderDashboard: panel del maker", () => {
  it("enseña el dinero separado por lo que significa y los mercados que cotiza", () => {
    const out = stripAnsi(
      renderDashboard({
        tab: "dashboard",
        width: 100,
        status: statusFixture({
          makerSummary: {
            colocadas: 2,
            canceladas: 2,
            comprometidoUsd: 19.8,
            vivoUsd: 19.8,
            paresUsd: 0,
            gastadoUsd: 0,
            mercados: [
              { slug: "lowest-temperature-in-seoul-2026", esperadoUsdDia: 105.08 },
              { slug: "(+22 sin financiar)", motivo: "capital_dedicado_a_otro_mercado" },
            ],
          },
        }),
      } as ViewModel).join("\n"),
    );

    expect(out).toContain("Maker (recompensas)");
    expect(out).toContain("en el libro");
    expect(out).toContain("$19.80");
    expect(out).toContain("lowest-temperature-in-seoul-2026");
    // El motivo traducido: es la respuesta a "por que no gana mas".
    expect(out).toContain("Sin capital (va a otro mercado)");
  });

  it("hace visible un llenado, que es una posicion direccional abierta", () => {
    // Lo que hay que ver ANTES de que se convierta en perdida. Un maker de recompensas no quiere
    // tener direccion; si `gastadoUsd` deja de ser cero, algo va mal y tiene que saltar a la vista.
    const out = stripAnsi(
      renderDashboard({
        tab: "dashboard",
        width: 100,
        status: statusFixture({
          makerSummary: {
            colocadas: 1,
            canceladas: 0,
            comprometidoUsd: 10,
            vivoUsd: 10,
            gastadoUsd: 41.41,
            llenadas: 650,
            mercados: [],
          },
        }),
      } as ViewModel).join("\n"),
    );

    expect(out).toContain("$41.41");
    expect(out).toContain("650 participaciones llenadas");
  });

  it("no pinta el panel cuando el maker no ha corrido", () => {
    const out = stripAnsi(
      renderDashboard({ tab: "dashboard", width: 100, status: statusFixture() } as ViewModel).join("\n"),
    );
    expect(out).not.toContain("Maker (recompensas)");
  });
});

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
    // "Mercados" ya no cabe en la primera pantalla desde que hay un grupo mas, asi que se comprueba
    // donde vive de verdad —la lista de campos— y ademas que se ve al desplazarse hasta el.
    const mercados = fields.findIndex((f) => f.label.startsWith("Mercados"));
    expect(mercados).toBeGreaterThan(0);
    const desplazado = stripAnsi(
      renderSettings(
        baseVm({ status: statusFixture({ running: true }), settingsFields: fields, settingsScroll: mercados }),
      ).join(NL),
    );
    expect(desplazado).toContain("Mercados");
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

  it("el modo de cada estrategia cicla por los tres valores y avisa del dinero real", () => {
    const base = testSettings();
    expect(buildSettingsFields(base).find((f) => f.id === "arbMode")?.value).toBe("heredado");

    const aSim = applyToggle(base, "arbMode");
    expect(aSim.arbMode).toBe("sim");
    const aLive = applyToggle(aSim, "arbMode");
    expect(aLive.arbMode).toBe("live");
    // La TUI no tiene donde esconder el aviso, asi que va en el propio valor de la fila.
    expect(buildSettingsFields(aLive).find((f) => f.id === "arbMode")?.value).toContain("DINERO REAL");
    // Y vuelve al principio, sin quedarse atascado en live.
    expect(applyToggle(aLive, "arbMode").arbMode).toBe("heredado");
    // El direccional no se mueve: son independientes.
    expect(aLive.directionalMode).toBe("heredado");
  });

  it("la cabecera separa las dos estrategias cuando sus modos difieren", () => {
    const status = statusFixture({ effectiveModes: { arb: "live", directional: "sim", maker: "sim" } });
    const text = stripAnsi(renderDashboard(baseVm({ status })).join(NL));
    // Una sola insignia diria "SIM" con el arbitraje moviendo dinero real.
    expect(text).toContain("arb LIVE");
    expect(text).toContain("dir SIM");
  });

  it("ninguna etiqueta se pasa de la columna, o desalinea la fila entera", () => {
    // `renderSettings` hace padEnd(label, 30). Tres etiquetas llevaban tiempo pasandose y rompian la
    // alineacion en silencio; ahora el detalle largo vive en la ayuda, que antes no tenia donde ir.
    const largas = buildSettingsFields(testSettings())
      .filter((f) => f.kind !== "header" && f.label.length > 30)
      .map((f) => `${f.id} (${f.label.length})`);
    expect(largas).toEqual([]);
  });

  it("cada interruptor se explica, no solo los limites de riesgo", () => {
    const fields = buildSettingsFields(testSettings());
    const interruptores = fields.filter((f) => f.kind === "toggle" && !f.id.startsWith("enabled:"));
    expect(interruptores.length).toBeGreaterThan(10);
    // Los modos llevan el aviso dentro del valor ("LIVE DINERO REAL"), no necesitan ayuda aparte.
    const sinAyuda = interruptores.filter((f) => !f.help && !isModeId(f.id)).map((f) => f.id);
    expect(sinAyuda).toEqual([]);
  });

  it("todo ajuste que acota dinero tiene fila en la TUI", () => {
    // La TUI vivio siendo un subconjunto de la web: 25 ajustes solo estaban alli, incluido el
    // cortacircuitos entero. Este test convierte "acota dinero" en una lista y exige la fila.
    const ids = new Set(buildSettingsFields(testSettings()).map((f) => f.id));
    const sinFila = TUI_RISK_KEYS.filter((key) => !ids.has(key));
    expect(sinFila).toEqual([]);
    expect(TUI_RISK_KEYS).toContain("maxDailyLossUsd");
    expect(TUI_RISK_KEYS).toContain("arbNakedLegHaltStreak");
  });

  it("cada limite de riesgo se explica: la TUI no tiene tooltips", () => {
    const fields = buildSettingsFields(testSettings());
    const sinAyuda = TUI_RISK_KEYS.filter((key) => !fields.find((f) => f.id === key)?.help);
    expect(sinAyuda).toEqual([]);
  });

  it("la ayuda se pinta solo para la fila seleccionada", () => {
    const fields = buildSettingsFields(testSettings());
    const idx = fields.findIndex((f) => f.id === "maxDailyLossUsd");
    const vm = baseVm({ settingsFields: fields, settingsSelected: idx, settingsScroll: idx });
    // Sin espacios ni saltos: la ayuda se envuelve en dos lineas y el corte cae donde quepa, asi que
    // afirmar la frase literal ataria el test a la anchura del terminal.
    // Fuera espacios Y bordes: la ayuda se envuelve en dos lineas y el marco mete un "|" entre ellas.
    const plano = stripAnsi(renderSettings(vm).join(NL)).replace(/[\s│]+/g, "");
    expect(plano).toContain("Nofrenaelarbitraje");
    // Y NO se pinta la de otra fila, o serian 9 bloques de ayuda a la vez.
    expect(plano).not.toContain("Rearmaalreiniciarelbot");
  });

  it("los limites de riesgo se acotan al rango del esquema antes de mandarlos", () => {
    const base = testSettings();
    // El esquema exige entero entre 1 y 10. Sin recorte, el PUT falla despues con un error opaco.
    expect(applyNumber(base, "arbNakedLegHaltStreak", 0).arbNakedLegHaltStreak).toBe(1);
    expect(applyNumber(base, "arbNakedLegHaltStreak", 99).arbNakedLegHaltStreak).toBe(10);
    expect(applyNumber(base, "arbNakedLegHaltStreak", 2.7).arbNakedLegHaltStreak).toBe(3);
    // Y el limite diario exige POSITIVO, no solo no-negativo.
    expect(applyNumber(base, "dailySpendLimitUsd", 0).dailySpendLimitUsd).toBeGreaterThan(0);
  });

  it("solo los modos ciclan a live; el resto de interruptores no", () => {
    expect(isModeId("arbMode")).toBe(true);
    expect(isModeId("directionalMode")).toBe(true);
    expect(isModeId("arbEnabled")).toBe(false);
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

describe("TUI: precios del libro y ajustes del favorito", () => {
  it("la caja de mercados enseña el ask y el medio, que es de lo que vive el favorito", () => {
    // Hasta ahora la TUI no pintaba NINGUN precio de libro: no habia forma de ver "el favorito cotiza
    // a 0,81" desde la terminal, que es justo el numero del que depende esa estrategia.
    const vm = baseVm({
      status: statusFixture({
        markets: [
          {
            marketSymbol: "BTC",
            reason: "favorite_below_band",
            inEntryWindow: true,
            secondsToEnd: 200,
            twapValue: 80500.25,
            upAsk: 0.812,
            downAsk: 0.201,
            upMid: 0.805,
            downMid: 0.195,
          },
        ],
      }),
    });

    const texto = stripAnsi(renderDashboard(vm).join("\n"));

    expect(texto).toContain("0.812");
    // El medio va al lado del ask porque es el numero que enseña la web de Polymarket, y difieren.
    expect(texto).toContain("0.805");
    expect(texto).toContain("twap 80500.25");
  });

  it("un mercado sin libro no inventa precios", () => {
    const vm = baseVm({
      status: statusFixture({
        markets: [
          {
            marketSymbol: "BTC",
            reason: "favorite_missing_quote",
            inEntryWindow: true,
            secondsToEnd: 200,
          },
        ],
      }),
    });

    const texto = stripAnsi(renderDashboard(vm).join("\n"));

    expect(texto).toContain("—");
    expect(texto).not.toContain("0.000");
  });

  it("la estrategia favorito tiene su propio grupo de ajustes", () => {
    const ids = buildSettingsFields(testSettings()).map((f) => f.id);

    expect(ids).toContain("favoriteStrategyEnabled");
    expect(ids).toContain("favoriteMinAsk");
    expect(ids).toContain("favoriteMaxAsk");
    expect(ids).toContain("favoriteMaxAskSum");
    // El cierre de dinero real va DESPUES de la banda: se lee en el orden en que se decide.
    expect(ids.indexOf("favoriteAllowLive")).toBeGreaterThan(ids.indexOf("favoriteMaxAskSum"));
  });
});

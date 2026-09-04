import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { StateStore } from "../src/stateStore.js";
import type { TradeAttempt } from "../src/types.js";

const temps: string[] = [];

afterEach(async () => {
  await Promise.all(temps.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("StateStore trade mode separation", () => {
  it("keeps sim and live trades for the same slug as separate records", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "polybot-state-"));
    temps.push(dataDir);
    const store = new StateStore(dataDir);
    await store.load();

    const slug = "btc-updown-5m-same-window";
    await store.recordTradeAttempt(trade({ slug, mode: "sim", id: "sim-trade" }));
    await store.recordTradeAttempt(trade({ slug, mode: "live", id: "live-trade" }));

    const reloaded = new StateStore(dataDir);
    await reloaded.load();

    expect(reloaded.listTrades()).toHaveLength(2);
    expect(reloaded.hasTraded(slug, "sim")).toBe(true);
    expect(reloaded.hasTraded(slug, "live")).toBe(true);
    expect(reloaded.getTradedMarket(slug, "sim")?.id).toBe("sim-trade");
    expect(reloaded.getTradedMarket(slug, "live")?.id).toBe("live-trade");

    await reloaded.recordTradeResolution(slug, {
      resolvedAtMs: 4,
      finalPrice: 90,
      finalTickTimestampMs: 4,
      winningOutcome: "DOWN",
      won: false,
    }, "live");

    expect(reloaded.getTradedMarket(slug, "sim")?.resolved).toBeUndefined();
    expect(reloaded.getTradedMarket(slug, "live")?.resolved?.won).toBe(false);

    await reloaded.resetPnl("sim", 10);
    expect(reloaded.getPnlResetAtMs().sim).toBe(10);
    expect(reloaded.listTrades()).toHaveLength(2);

    const resetReloaded = new StateStore(dataDir);
    await resetReloaded.load();
    expect(resetReloaded.getPnlResetAtMs().sim).toBe(10);
    expect(resetReloaded.listTrades()).toHaveLength(2);
  });

  it("applies an official-resolution correction: flips the winner and persists the verification", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "polybot-state-"));
    temps.push(dataDir);
    const store = new StateStore(dataDir);
    await store.load();

    const slug = "eth-updown-5m-photo-finish";
    await store.recordTradeAttempt(trade({ slug, mode: "live", id: "live-pf", outcome: "DOWN" }));
    await store.recordTradeResolution(slug, {
      resolvedAtMs: 4,
      finalPrice: 1806.103,
      finalTickTimestampMs: 4,
      winningOutcome: "UP",
      won: false,
    }, "live");

    await store.recordTradeOfficialResolution(slug, "live", {
      winningOutcome: "DOWN",
      verifiedAtMs: 9,
      corrected: true,
    });

    const reloaded = new StateStore(dataDir);
    await reloaded.load();
    const corrected = reloaded.getTradedMarket(slug, "live");
    expect(corrected?.resolved?.winningOutcome).toBe("DOWN");
    expect(corrected?.resolved?.won).toBe(true); // the DOWN position officially won
    expect(corrected?.officialResolution).toMatchObject({ winningOutcome: "DOWN", corrected: true });
  });

  it("recovers a P&L reset from the durable trades log when state.json is clobbered", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "polybot-state-"));
    temps.push(dataDir);
    const store = new StateStore(dataDir);
    await store.load();
    await store.recordTradeAttempt(trade({ slug: "btc-updown-5m-reset", mode: "sim", id: "sim-reset" }));
    await store.resetPnl("sim", 12345);

    // Simulate the clobber bug: state.json rewritten with an empty pnlResetAtMs.
    const statePath = join(dataDir, "state.json");
    const clobbered = JSON.parse(await readFile(statePath, "utf8"));
    clobbered.pnlResetAtMs = {};
    await writeFile(statePath, `${JSON.stringify(clobbered)}\n`);

    const reloaded = new StateStore(dataDir);
    await reloaded.load();
    expect(reloaded.getPnlResetAtMs().sim).toBe(12345);
  });

  it("prunes openings older than the retention window when saving a new one", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "polybot-state-"));
    temps.push(dataDir);
    const store = new StateStore(dataDir);
    await store.load();

    const nowMs = 10_000_000_000;
    const hourMs = 60 * 60 * 1000;
    await store.saveOpening(opening("eth-updown-5m-old", nowMs - 2 * hourMs));
    await store.saveOpening(opening("btc-updown-5m-new", nowMs));

    expect(store.getOpening("eth-updown-5m-old")).toBeUndefined();
    expect(store.getOpening("btc-updown-5m-new")).toBeDefined();

    const reloaded = new StateStore(dataDir);
    await reloaded.load();
    expect(reloaded.getOpening("eth-updown-5m-old")).toBeUndefined();
    expect(reloaded.getOpening("btc-updown-5m-new")).toBeDefined();
  });

  it("does not drop openings another instance persisted after this one loaded", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "polybot-state-"));
    temps.push(dataDir);
    const nowMs = 10_000_000_000;

    // Instance A loads, then instance B (loaded from the same empty state) records ETH/DOGE openings.
    const a = new StateStore(dataDir);
    await a.load();
    const b = new StateStore(dataDir);
    await b.load();
    await b.saveOpening(opening("eth-updown-5m-w1", nowMs));
    await b.saveOpening(opening("doge-updown-5m-w1", nowMs));

    // Stale instance A now writes its own opening. Without reconciliation it would clobber B's.
    await a.saveOpening(opening("btc-updown-5m-w1", nowMs));

    const reloaded = new StateStore(dataDir);
    await reloaded.load();
    expect(reloaded.getOpening("btc-updown-5m-w1")).toBeDefined();
    expect(reloaded.getOpening("eth-updown-5m-w1")).toBeDefined();
    expect(reloaded.getOpening("doge-updown-5m-w1")).toBeDefined();
  });
});

function opening(slug: string, windowStartMs: number) {
  return {
    asset: "BTC" as const,
    slug,
    windowStartMs,
    openingPrice: 100,
    openingTickTimestampMs: windowStartMs,
    capturedAtMs: windowStartMs,
  };
}

describe("el gasto diario se cuenta por modo", () => {
  it("el papel no consume el presupuesto del dinero real", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "polybot-spend-"));
    temps.push(dataDir);
    const store = new StateStore(dataDir);
    await store.load();

    // Importa desde que cada estrategia elige su modo: con el direccional en sim y el arbitraje en
    // live, un contador comun dejaria que unas operaciones ficticias frenaran las de verdad.
    // El fixture nace en 1970; el contador es por dia, asi que hay que fecharlas hoy.
    const nowMs = Date.now();
    await store.recordTradeAttempt({
      ...trade({ slug: "a", mode: "sim", id: "1" }),
      amountUsd: 40,
      createdAtMs: nowMs,
    });
    await store.recordTradeAttempt({
      ...trade({ slug: "b", mode: "live", id: "2" }),
      amountUsd: 7,
      createdAtMs: nowMs,
    });

    expect(store.getDailySpend(nowMs, undefined, "sim")).toBe(40);
    expect(store.getDailySpend(nowMs, undefined, "live")).toBe(7);
    // Sin modo sigue siendo el total, que es lo que muestran las pantallas.
    expect(store.getDailySpend(nowMs)).toBe(47);
  });
});

function trade(args: {
  slug: string;
  mode: TradeAttempt["mode"];
  id: string;
  outcome?: TradeAttempt["outcome"];
  entryKind?: TradeAttempt["entryKind"];
}): TradeAttempt {
  return {
    id: args.id,
    slug: args.slug,
    mode: args.mode,
    entryKind: args.entryKind,
    outcome: args.outcome ?? "UP",
    tokenId: "token",
    amountUsd: 1,
    maxAskPrice: 0.98,
    bestAsk: 0.5,
    estimatedShares: 2,
    openingPrice: 100,
    entryPrice: 125,
    distanceUsd: 25,
    windowStartMs: 1,
    endMs: 2,
    createdAtMs: 3,
  };
}

describe("StateStore: los dos tramos del favorito en la misma ventana", () => {
  // Antes de esto, `tradedMarkets[modo:slug] = trade` era una ASIGNACION: la segunda entrada de una
  // ventana borraba la primera sin dejar rastro. Y eso no era solo perder una fila del historial —
  // `openStakeUsd` lee de aqui para saber cuanto capital esta atado, asi que una fila perdida hacia
  // que el tramo de conviccion volviera a apostar dinero ya comprometido.
  it("banda y conviccion conviven, y ninguna borra a la otra", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "polybot-state-"));
    temps.push(dataDir);
    const store = new StateStore(dataDir);
    await store.load();

    const slug = "btc-updown-5m-dos-tramos";
    await store.recordTradeAttempt(trade({ slug, mode: "sim", id: "banda-1", entryKind: "banda" }));
    await store.recordTradeAttempt(trade({ slug, mode: "sim", id: "conviccion-1", entryKind: "conviccion" }));

    const reloaded = new StateStore(dataDir);
    await reloaded.load();

    expect(reloaded.listTrades()).toHaveLength(2);
    expect(reloaded.hasTraded(slug, "sim", "banda")).toBe(true);
    expect(reloaded.hasTraded(slug, "sim", "conviccion")).toBe(true);
    expect(reloaded.getTradedMarket(slug, "sim", "banda")?.id).toBe("banda-1");
    expect(reloaded.getTradedMarket(slug, "sim", "conviccion")?.id).toBe("conviccion-1");
  });

  it("resolver una NO toca la otra", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "polybot-state-"));
    temps.push(dataDir);
    const store = new StateStore(dataDir);
    await store.load();

    const slug = "btc-updown-5m-resolucion";
    await store.recordTradeAttempt(trade({ slug, mode: "sim", id: "banda-1", entryKind: "banda" }));
    await store.recordTradeAttempt(trade({ slug, mode: "sim", id: "conviccion-1", entryKind: "conviccion" }));

    // Por id. Buscando por slug caeria siempre en la primera y la otra se quedaria pendiente para
    // siempre — que es como el capital atado se volvia invisible.
    await store.recordTradeResolution(slug, {
      resolvedAtMs: 4,
      finalPrice: 90,
      finalTickTimestampMs: 4,
      winningOutcome: "DOWN",
      won: false,
    }, "sim", "conviccion-1");

    expect(store.getTradedMarket(slug, "sim", "conviccion")?.resolved?.won).toBe(false);
    expect(store.getTradedMarket(slug, "sim", "banda")?.resolved).toBeUndefined();
  });

  it("una fila antigua SIN entryKind se sigue encontrando y resolviendo", async () => {
    // Compatibilidad: las filas ya guardadas en state.json no tienen el campo, y su clave no cambia.
    const dataDir = await mkdtemp(join(tmpdir(), "polybot-state-"));
    temps.push(dataDir);
    const store = new StateStore(dataDir);
    await store.load();

    const slug = "btc-updown-5m-legacy";
    await store.recordTradeAttempt(trade({ slug, mode: "sim", id: "vieja" }));

    const reloaded = new StateStore(dataDir);
    await reloaded.load();

    expect(reloaded.hasTraded(slug, "sim")).toBe(true);
    // Ausente cuenta como banda: es el tramo que existia cuando se guardo.
    expect(reloaded.hasTraded(slug, "sim", "banda")).toBe(true);
    expect(reloaded.hasTraded(slug, "sim", "conviccion")).toBe(false);

    await reloaded.recordTradeResolution(slug, {
      resolvedAtMs: 4,
      finalPrice: 90,
      finalTickTimestampMs: 4,
      winningOutcome: "UP",
      won: true,
    }, "sim");
    expect(reloaded.getTradedMarket(slug, "sim")?.resolved?.won).toBe(true);
  });
});

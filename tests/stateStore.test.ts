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

function trade(args: { slug: string; mode: TradeAttempt["mode"]; id: string }): TradeAttempt {
  return {
    id: args.id,
    slug: args.slug,
    mode: args.mode,
    outcome: "UP",
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

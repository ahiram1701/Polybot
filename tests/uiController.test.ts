import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";

import { BotController, ControllerError, type RunnerLike } from "../src/ui/controller.js";
import { calculatePnlSummaryByMode } from "../src/pnl.js";
import { StateStore } from "../src/stateStore.js";
import type { UiStatus } from "../src/ui/shared.js";
import type { BotConfig, Mode, TradeAttempt } from "../src/types.js";

class FakeRunner implements RunnerLike {
  stopped = false;
  async start(): Promise<void> {
    return new Promise(() => undefined);
  }
  stop(): void {
    this.stopped = true;
  }
}

// Mirrors the real bot: holds its own long-lived StateStore instance and routes resetPnl to it.
class StateAwareFakeRunner extends FakeRunner {
  readonly resetCalls: Mode[] = [];
  constructor(private readonly state: StateStore) {
    super();
  }
  async resetPnl(mode: Mode): Promise<void> {
    this.resetCalls.push(mode);
    await this.state.resetPnl(mode);
  }
}

const temps: string[] = [];

afterEach(async () => {
  await Promise.all(temps.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("BotController", () => {
  it("starts and stops a simulation runner", async () => {
    const runner = new FakeRunner();
    const createdConfigs: BotConfig[] = [];
    const controller = new BotController(await baseConfig(), {
      startPriceFeed: false,
      snapshotProvider: fixedSnapshot,
      runnerFactory: (config) => {
        createdConfigs.push(config);
        return runner;
      },
    });

    const running = await controller.start("sim");
    expect(running.running).toBe(true);
    expect(createdConfigs[0].mode).toBe("sim");

    const stopped = await controller.stop();
    expect(stopped.running).toBe(false);
    expect(runner.stopped).toBe(true);
    controller.dispose();
  });

  it("prevents two runners from starting at once", async () => {
    const controller = new BotController(await baseConfig(), {
      startPriceFeed: false,
      snapshotProvider: fixedSnapshot,
      runnerFactory: () => new FakeRunner(),
    });

    await controller.start("sim");
    await expect(controller.start("sim")).rejects.toMatchObject({ statusCode: 409 });
    controller.dispose();
  });

  it("blocks live mode without confirmation", async () => {
    const controller = new BotController(await baseConfig({ withSecrets: true }), {
      env: { POLYMARKET_SIGNATURE_TYPE: "0" },
      startPriceFeed: false,
      snapshotProvider: fixedSnapshot,
      runnerFactory: () => new FakeRunner(),
    });

    await expect(controller.start("live", false)).rejects.toBeInstanceOf(ControllerError);
    controller.dispose();
  });

  it("blocks live mode without configured secrets", async () => {
    const controller = new BotController(await baseConfig(), {
      env: {},
      startPriceFeed: false,
      snapshotProvider: fixedSnapshot,
      runnerFactory: () => new FakeRunner(),
    });

    await expect(controller.start("live", true)).rejects.toThrow(/requires private key/i);
    controller.dispose();
  });

  it("keeps the P&L reset applied while the bot is running", async () => {
    const config = await baseConfig();
    // The running bot's own state instance (loaded once, then mutated in memory like the real runner).
    const botState = new StateStore(config.dataDir);
    await botState.load();
    const slug = "btc-updown-5m-1";
    await botState.recordTradeAttempt(simTrade(slug));
    await botState.recordTradeResolution(
      slug,
      { resolvedAtMs: 10, finalPrice: 130, finalTickTimestampMs: 9, winningOutcome: "UP", won: true },
      "sim",
    );

    // Sanity: the resolved sim trade counts before any reset.
    const before = new StateStore(config.dataDir);
    await before.load();
    expect(calculatePnlSummaryByMode(before.listTrades(), before.getPnlResetAtMs()).sim.resolvedCount).toBe(1);

    const runner = new StateAwareFakeRunner(botState);
    const controller = new BotController(config, {
      startPriceFeed: false,
      snapshotProvider: fixedSnapshot,
      runnerFactory: () => runner,
    });
    await controller.start("sim");
    await controller.resetPnl("sim");

    // Simulate the bot persisting its state again AFTER the reset. With a separate state instance
    // (the old bug) this save would clobber the reset; routing through the runner's own state keeps it.
    await botState.saveOpening({
      slug,
      windowStartMs: 1,
      openingPrice: 100,
      openingTickTimestampMs: 1,
      capturedAtMs: 2,
    });

    expect(runner.resetCalls).toEqual(["sim"]);
    const after = new StateStore(config.dataDir);
    await after.load();
    expect(after.getPnlResetAtMs().sim).toBeGreaterThan(0);
    expect(calculatePnlSummaryByMode(after.listTrades(), after.getPnlResetAtMs()).sim.resolvedCount).toBe(0);
    controller.dispose();
  });
});

function simTrade(slug: string): TradeAttempt {
  return {
    id: `${slug}-trade`,
    slug,
    mode: "sim",
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

async function baseConfig(options: { withSecrets?: boolean } = {}): Promise<BotConfig> {
  const dataDir = await mkdtemp(join(tmpdir(), "polybot-ui-"));
  temps.push(dataDir);
  return {
    mode: "sim",
    confirmLive: false,
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
    dataDir,
    gammaHost: "https://gamma-api.polymarket.com",
    clobHost: "https://clob.polymarket.com",
    rtdsUrl: "wss://ws-live-data.polymarket.com",
    polygonRpcUrl: "https://polygon-rpc.com",
    signatureType: 0,
    privateKey: options.withSecrets ? (`0x${"1".repeat(64)}` as `0x${string}`) : undefined,
    funderAddress: options.withSecrets ? (`0x${"2".repeat(40)}` as `0x${string}`) : undefined,
  };
}

async function fixedSnapshot(): Promise<Partial<UiStatus>> {
  return {
    markets: [],
    dailySpendUsd: 0,
    signal: { reason: "no_market", inEntryWindow: false },
  };
}

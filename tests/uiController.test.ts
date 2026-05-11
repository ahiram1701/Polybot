import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";

import { BotController, ControllerError, type RunnerLike } from "../src/ui/controller.js";
import type { UiStatus } from "../src/ui/shared.js";
import type { BotConfig } from "../src/types.js";

class FakeRunner implements RunnerLike {
  stopped = false;
  async start(): Promise<void> {
    return new Promise(() => undefined);
  }
  stop(): void {
    this.stopped = true;
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
});

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

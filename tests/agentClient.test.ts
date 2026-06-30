import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import { PolybotApiError, PolybotClient } from "../src/agent/client.js";
import type { BotConfig } from "../src/types.js";
import { BotController, type RunnerLike } from "../src/ui/controller.js";
import { createUiApp } from "../src/ui/server.js";

class FakeRunner implements RunnerLike {
  async start(): Promise<void> {
    return new Promise(() => undefined);
  }
  stop(): void {}
}

const temps: string[] = [];
const servers: Server[] = [];
const controllers: BotController[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))));
  controllers.splice(0).forEach((controller) => controller.dispose());
  await Promise.all(temps.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function startClient(): Promise<PolybotClient> {
  const dataDir = await mkdtemp(join(tmpdir(), "polybot-agent-"));
  temps.push(dataDir);
  const controller = new BotController(await baseConfig(dataDir), {
    startPriceFeed: false,
    snapshotProvider: async () => ({ markets: [], dailySpendUsd: 0, signal: { reason: "no_market", inEntryWindow: false } }),
    runnerFactory: () => new FakeRunner(),
  });
  controllers.push(controller);
  const app = createUiApp(controller);
  const server = app.listen(0);
  servers.push(server);
  await new Promise<void>((done) => server.once("listening", () => done()));
  const port = (server.address() as AddressInfo).port;
  return new PolybotClient({ baseUrl: `http://127.0.0.1:${port}` });
}

describe("PolybotClient (agent interface)", () => {
  it("reads status, updates settings, and reports running state", async () => {
    const client = await startClient();

    await expect(client.getStatus()).resolves.toMatchObject({ running: false });

    const updated = await client.updateSettings({ minBtcDistanceUsd: 25 });
    expect(updated.minBtcDistanceUsd).toBe(25);

    const started = await client.startBot("sim");
    expect(started.running).toBe(true);

    const stopped = await client.stopBot();
    expect(stopped.running).toBe(false);
  });

  it("surfaces the 409 guard when patching settings while running", async () => {
    const client = await startClient();
    await client.startBot("sim");

    await expect(client.updateSettings({ minBtcDistanceUsd: 30 })).rejects.toMatchObject({
      name: "PolybotApiError",
      status: 409,
    });

    await client.stopBot();
  });

  it("returns recommendations payload", async () => {
    const client = await startClient();
    const recommendations = await client.getRecommendations();
    expect(Array.isArray(recommendations.recommendations)).toBe(true);
  });

  it("gives a clear connection error when the server is down", async () => {
    const client = new PolybotClient({ baseUrl: "http://127.0.0.1:1" });
    await expect(client.getStatus()).rejects.toBeInstanceOf(PolybotApiError);
    await expect(client.getStatus()).rejects.toThrow(/No se pudo conectar/);
  });
});

async function baseConfig(dataDir: string): Promise<BotConfig> {
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
  };
}

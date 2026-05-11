import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { RecommendationEngine } from "../src/recommendationEngine.js";
import type { AiRecommendation, AiRecommendationsResponse, MarketInfo, MarketSymbol } from "../src/types.js";
import type { BotConfig } from "../src/types.js";
import { BotController, type RunnerLike } from "../src/ui/controller.js";
import { createUiApp } from "../src/ui/server.js";
import type { UiStatus } from "../src/ui/shared.js";

class FakeRunner implements RunnerLike {
  async start(): Promise<void> {
    return new Promise(() => undefined);
  }
  stop(): void {}
}

const temps: string[] = [];

afterEach(async () => {
  await Promise.all(temps.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("UI API", () => {
  it("returns sanitized status", async () => {
    const controller = new BotController(await baseConfig(true), {
      env: { POLYMARKET_SIGNATURE_TYPE: "0" },
      startPriceFeed: false,
      snapshotProvider: fixedSnapshot,
      runnerFactory: () => new FakeRunner(),
    });
    const app = createUiApp(controller);

    const response = await request(app).get("/api/status").expect(200);
    expect(response.body.config.hasPrivateKey).toBe(true);
    expect(JSON.stringify(response.body)).not.toContain("1111111111");
    controller.dispose();
  });

  it("starts and stops the bot", async () => {
    const controller = new BotController(await baseConfig(false), {
      startPriceFeed: false,
      snapshotProvider: fixedSnapshot,
      runnerFactory: () => new FakeRunner(),
    });
    const app = createUiApp(controller);

    await request(app).post("/api/bot/start").send({ mode: "sim" }).expect(200).expect((response) => {
      expect(response.body.running).toBe(true);
    });
    await request(app).post("/api/bot/stop").expect(200).expect((response) => {
      expect(response.body.running).toBe(false);
    });
    controller.dispose();
  });

  it("patches settings only while stopped", async () => {
    const controller = new BotController(await baseConfig(false), {
      startPriceFeed: false,
      snapshotProvider: fixedSnapshot,
      runnerFactory: () => new FakeRunner(),
    });
    const app = createUiApp(controller);

    await request(app).patch("/api/settings").send({ minBtcDistanceUsd: 25 }).expect(200).expect((response) => {
      expect(response.body.minBtcDistanceUsd).toBe(25);
    });

    await request(app).post("/api/bot/start").send({ mode: "sim" }).expect(200);
    await request(app).patch("/api/settings").send({ minBtcDistanceUsd: 30 }).expect(409);
    controller.dispose();
  });

  it("patches enabled markets from the UI", async () => {
    const controller = new BotController(await baseConfig(false), {
      startPriceFeed: false,
      snapshotProvider: fixedSnapshot,
      runnerFactory: () => new FakeRunner(),
    });
    const app = createUiApp(controller);

    await request(app)
      .patch("/api/settings")
      .send({
        enabledMarkets: ["BTC", "DOGE", "ETH"],
        minDistanceUsdByMarket: { BTC: 20, DOGE: 0.0004, ETH: 4 },
        entryWindowSecondsByMarket: { BTC: 20, DOGE: 12, ETH: 35 },
      })
      .expect(200)
      .expect((response) => {
        expect(response.body.enabledMarkets).toEqual(["BTC", "DOGE", "ETH"]);
        expect(response.body.minDistanceUsdByMarket.DOGE).toBe(0.0004);
        expect(response.body.entryWindowSecondsByMarket).toEqual({ BTC: 20, DOGE: 12, ETH: 35 });
      });
    controller.dispose();
  });

  it("allows disabling every market", async () => {
    const controller = new BotController(await baseConfig(false), {
      startPriceFeed: false,
      snapshotProvider: fixedSnapshot,
      runnerFactory: () => new FakeRunner(),
    });
    const app = createUiApp(controller);

    await request(app).patch("/api/settings").send({ enabledMarkets: [] }).expect(200).expect((response) => {
      expect(response.body.enabledMarkets).toEqual([]);
    });
    controller.dispose();
  });

  it("returns and applies AI recommendations while stopped", async () => {
    const recommendationEngine = fakeRecommendationEngine(recommendationsResponse([recommendation({ market: "BTC" })]));
    const controller = new BotController(await baseConfig(false), {
      recommendationEngine,
      startPriceFeed: false,
      snapshotProvider: fixedSnapshot,
      runnerFactory: () => new FakeRunner(),
    });
    const app = createUiApp(controller);

    await request(app).get("/api/recommendations").expect(200).expect((response) => {
      expect(response.body.recommendations[0].market).toBe("BTC");
    });

    await request(app)
      .post("/api/recommendations/apply")
      .send({ markets: ["BTC"] })
      .expect(200)
      .expect((response) => {
        expect(response.body.settings.minDistanceUsdByMarket.BTC).toBe(15);
        expect(response.body.settings.entryWindowSecondsByMarket.BTC).toBe(30);
      });
    controller.dispose();
  });

  it("rejects AI auto-apply without high-confidence recommendations", async () => {
    const recommendationEngine = fakeRecommendationEngine(
      recommendationsResponse([recommendation({ market: "BTC", canApply: true, canAutoApply: false })]),
    );
    const controller = new BotController(await baseConfig(false), {
      recommendationEngine,
      startPriceFeed: false,
      snapshotProvider: fixedSnapshot,
      runnerFactory: () => new FakeRunner(),
    });
    const app = createUiApp(controller);

    await request(app).post("/api/recommendations/auto-apply").send({ markets: ["BTC"] }).expect(409);
    controller.dispose();
  });

  it("auto-applies high-confidence AI recommendations to a running live runner", async () => {
    const updateStrategySettings = vi.fn<
      (settings: Pick<BotConfig, "minDistanceUsdByMarket" | "entryWindowSeconds" | "entryWindowSecondsByMarket">) => void
    >();
    const runner: RunnerLike = {
      start: async () => new Promise(() => undefined),
      stop: () => undefined,
      updateStrategySettings,
    };
    const recommendationEngine = fakeRecommendationEngine(recommendationsResponse([recommendation({ market: "BTC" })]));
    const controller = new BotController(await baseConfig(true), {
      env: { POLYMARKET_SIGNATURE_TYPE: "0" },
      recommendationEngine,
      startPriceFeed: false,
      snapshotProvider: fixedSnapshot,
      watcher: { getCurrentMarket: async () => null },
      runnerFactory: () => runner,
    });
    const app = createUiApp(controller);

    await request(app).post("/api/bot/start").send({ mode: "live", confirmLive: true }).expect(200);
    await request(app)
      .post("/api/recommendations/auto-apply")
      .send({ markets: ["BTC"] })
      .expect(200)
      .expect((response) => {
        expect(response.body.settings.minDistanceUsdByMarket.BTC).toBe(15);
        expect(response.body.settings.entryWindowSecondsByMarket.BTC).toBe(30);
      });
    expect(updateStrategySettings).toHaveBeenCalledWith(
      expect.objectContaining({
        minDistanceUsdByMarket: expect.objectContaining({ BTC: 15 }),
        entryWindowSecondsByMarket: expect.objectContaining({ BTC: 30 }),
      }),
    );
    controller.dispose();
  });

  it("rejects AI auto-apply during the protected final market window", async () => {
    const runner: RunnerLike = {
      start: async () => new Promise(() => undefined),
      stop: () => undefined,
      updateStrategySettings: () => undefined,
    };
    const recommendationEngine = fakeRecommendationEngine(recommendationsResponse([recommendation({ market: "BTC" })]));
    const controller = new BotController(await baseConfig(true), {
      env: { POLYMARKET_SIGNATURE_TYPE: "0" },
      recommendationEngine,
      startPriceFeed: false,
      snapshotProvider: fixedSnapshot,
      watcher: { getCurrentMarket: async () => marketInfo("BTC", Date.now() + 30_000) },
      runnerFactory: () => runner,
    });
    const app = createUiApp(controller);

    await request(app).post("/api/bot/start").send({ mode: "live", confirmLive: true }).expect(200);
    await request(app).post("/api/recommendations/auto-apply").send({ markets: ["BTC"] }).expect(409);
    controller.dispose();
  });

  it("allows toggling AI auto-apply while running", async () => {
    const controller = new BotController(await baseConfig(false), {
      startPriceFeed: false,
      snapshotProvider: fixedSnapshot,
      runnerFactory: () => new FakeRunner(),
    });
    const app = createUiApp(controller);

    await request(app).post("/api/bot/start").send({ mode: "sim" }).expect(200);
    await request(app).patch("/api/settings").send({ aiAutoApplyLive: true }).expect(200).expect((response) => {
      expect(response.body.aiAutoApplyLive).toBe(true);
    });
    controller.dispose();
  });

  it("resets state while stopped or running", async () => {
    const controller = new BotController(await baseConfig(false), {
      startPriceFeed: false,
      snapshotProvider: fixedSnapshot,
      runnerFactory: () => new FakeRunner(),
    });
    const app = createUiApp(controller);

    await request(app).post("/api/bot/reset").expect(200).expect((response) => {
      expect(response.body.running).toBe(false);
    });

    await request(app).post("/api/bot/start").send({ mode: "sim" }).expect(200);
    await request(app).post("/api/bot/reset").expect(200).expect((response) => {
      expect(response.body.running).toBe(false);
    });
    controller.dispose();
  });
});

async function baseConfig(withSecrets: boolean): Promise<BotConfig> {
  const dataDir = await mkdtemp(join(tmpdir(), "polybot-api-"));
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
    privateKey: withSecrets ? (`0x${"1".repeat(64)}` as `0x${string}`) : undefined,
    funderAddress: withSecrets ? (`0x${"2".repeat(40)}` as `0x${string}`) : undefined,
  };
}

async function fixedSnapshot(): Promise<Partial<UiStatus>> {
  return {
    markets: [],
    dailySpendUsd: 0,
    signal: { reason: "no_market", inEntryWindow: false },
  };
}

function fakeRecommendationEngine(response: AiRecommendationsResponse): RecommendationEngine {
  return {
    recommend: async () => response,
  } as unknown as RecommendationEngine;
}

function recommendationsResponse(recommendations: AiRecommendation[]): AiRecommendationsResponse {
  return {
    generatedAtMs: Date.UTC(2026, 4, 8, 12),
    recommendations,
  };
}

function marketInfo(asset: MarketSymbol, endMs: number): MarketInfo {
  const windowStartMs = endMs - 300_000;
  return {
    asset,
    slug: `${asset.toLowerCase()}-updown-5m-${Math.floor(windowStartMs / 1000)}`,
    title: `${asset} Up or Down`,
    conditionId: "condition",
    windowStartMs,
    endMs,
    eventStartTimeMs: windowStartMs,
    acceptingOrders: true,
    active: true,
    closed: false,
    tickSize: "0.01",
    negRisk: false,
    orderMinSize: 1,
    outcomes: {
      UP: { outcome: "UP", label: "Up", tokenId: "up" },
      DOWN: { outcome: "DOWN", label: "Down", tokenId: "down" },
    },
  };
}

function recommendation(args: {
  market: "BTC" | "ETH" | "DOGE";
  canApply?: boolean;
  canAutoApply?: boolean;
}): AiRecommendation {
  return {
    market: args.market,
    status: "ready",
    confidence: args.canAutoApply === false ? "medium" : "high",
    generatedAtMs: Date.UTC(2026, 4, 8, 12),
    current: {
      entryWindowSeconds: 20,
      minDistanceUsd: args.market === "DOGE" ? 0.0005 : args.market === "ETH" ? 5 : 20,
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
      minDistanceUsd: args.market === "DOGE" ? 0.0004 : args.market === "ETH" ? 4 : 15,
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
    canApply: args.canApply ?? true,
    canAutoApply: args.canAutoApply ?? true,
  };
}

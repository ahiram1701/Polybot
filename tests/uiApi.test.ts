import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { StrategyAnalysisEngine } from "../src/strategyAnalysisEngine.js";
import { StateStore } from "../src/stateStore.js";
import type { BotConfig, StrategyAnalysisResponse, StrategyCandidate, TradeAttempt } from "../src/types.js";
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
        expect(response.body.enabledMarkets).toEqual(["BTC", "ETH", "DOGE"]);
        expect(response.body.enabledMarketOutcomes.DOGE.UP).toBe(true);
        expect(response.body.enabledMarketOutcomes.DOGE.DOWN).toBe(true);
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
      expect(response.body.enabledMarketOutcomes.BTC.UP).toBe(false);
      expect(response.body.enabledMarketOutcomes.BTC.DOWN).toBe(false);
    });
    controller.dispose();
  });

  it("patches enabled market sides from the UI", async () => {
    const controller = new BotController(await baseConfig(false), {
      startPriceFeed: false,
      snapshotProvider: fixedSnapshot,
      runnerFactory: () => new FakeRunner(),
    });
    const app = createUiApp(controller);

    await request(app)
      .patch("/api/settings")
      .send({
        enabledMarketOutcomes: {
          BTC: { UP: true, DOWN: false },
          ETH: { UP: false, DOWN: true },
          DOGE: { UP: false, DOWN: false },
        },
      })
      .expect(200)
      .expect((response) => {
        expect(response.body.enabledMarkets).toEqual(["BTC", "ETH"]);
        expect(response.body.enabledMarketOutcomes.BTC.UP).toBe(true);
        expect(response.body.enabledMarketOutcomes.BTC.DOWN).toBe(false);
        expect(response.body.enabledMarketOutcomes.ETH.DOWN).toBe(true);
      });
    controller.dispose();
  });

  it("patches auto-adjust toggles per market side", async () => {
    const controller = new BotController(await baseConfig(false), {
      startPriceFeed: false,
      snapshotProvider: fixedSnapshot,
      runnerFactory: () => new FakeRunner(),
    });
    const app = createUiApp(controller);

    await request(app)
      .patch("/api/settings")
      .send({
        autoAdjustLiveByMarketOutcome: {
          BTC: { UP: true, DOWN: false },
          ETH: { UP: false, DOWN: false },
          DOGE: { UP: false, DOWN: false },
        },
        autoAdjustAfterLossByMarketOutcome: {
          BTC: { UP: false, DOWN: true },
          ETH: { UP: false, DOWN: false },
          DOGE: { UP: false, DOWN: false },
        },
      })
      .expect(200)
      .expect((response) => {
        expect(response.body.autoAdjustLiveByMarketOutcome.BTC.UP).toBe(true);
        expect(response.body.autoAdjustLiveByMarketOutcome.BTC.DOWN).toBe(false);
        expect(response.body.autoAdjustAfterLossByMarketOutcome.BTC.DOWN).toBe(true);
      });
    controller.dispose();
  });

  it("returns strategy analysis", async () => {
    const controller = new BotController(await baseConfig(false), {
      strategyAnalysisEngine: fakeStrategyAnalysisEngine(analysisResponse()),
      startPriceFeed: false,
      snapshotProvider: fixedSnapshot,
      runnerFactory: () => new FakeRunner(),
    });
    const app = createUiApp(controller);

    await request(app).get("/api/analysis/strategies").expect(200).expect((response) => {
      expect(response.body.summary.sampleCount).toBe(5);
      expect(response.body.strategies[0].market).toBe("BTC");
      expect(response.body.currentStrategies[0].isCurrent).toBe(true);
    });
    controller.dispose();
  });

  it("reuses unchanged state summaries for recent trades and status", async () => {
    const listTrades = vi.fn(() => [
      apiTrade({ id: "older", createdAtMs: 1 }),
      apiTrade({ id: "newer", createdAtMs: 2 }),
    ]);
    const state = {
      load: vi.fn(async () => undefined),
      getLoadedSignature: vi.fn(() => "state:1"),
      listTrades,
      getPnlResetAtMs: vi.fn(() => ({})),
      getDailySpend: vi.fn(() => 2),
      getOpening: vi.fn(() => undefined),
    } as unknown as StateStore;
    const controller = new BotController(await baseConfig(false, { enabledMarkets: [] }), {
      stateFactory: () => state,
      startPriceFeed: false,
      runnerFactory: () => new FakeRunner(),
    });

    await expect(controller.getTrades(1)).resolves.toEqual([expect.objectContaining({ id: "newer" })]);
    await expect(controller.getTrades(1)).resolves.toEqual([expect.objectContaining({ id: "newer" })]);
    await controller.getStatus();
    await controller.getStatus();

    expect(listTrades).toHaveBeenCalledTimes(1);
    controller.dispose();
  });

  it("rejects empty Ollama prompts", async () => {
    const controller = new BotController(await baseConfig(false, { ollamaApiKey: "ollama-key" }), {
      strategyAnalysisEngine: fakeStrategyAnalysisEngine(analysisResponse()),
      startPriceFeed: false,
      snapshotProvider: fixedSnapshot,
      runnerFactory: () => new FakeRunner(),
    });
    const app = createUiApp(controller);

    await request(app).post("/api/analysis/ollama").send({ prompt: " " }).expect(400);
    controller.dispose();
  });

  it("manages Telegram notification settings without exposing the token", async () => {
    const fetchMock = vi.fn(async () => new Response("{}")) as unknown as typeof fetch;
    const controller = new BotController(await baseConfig(false), {
      fetch: fetchMock,
      startPriceFeed: false,
      snapshotProvider: fixedSnapshot,
      runnerFactory: () => new FakeRunner(),
    });
    const app = createUiApp(controller);

    await request(app)
      .patch("/api/notifications/telegram")
      .send({
        enabled: true,
        botToken: "123456:test_token",
        chatId: "42",
        publicUrl: "http://polybot.local:8787",
      })
      .expect(200)
      .expect((response) => {
        expect(response.body.configured).toBe(true);
        expect(response.body.hasBotToken).toBe(true);
        expect(response.body.botTokenMasked).not.toContain("test_token");
        expect(JSON.stringify(response.body)).not.toContain("123456:test_token");
      });

    await request(app)
      .patch("/api/notifications/telegram")
      .send({ enabled: true, chatId: "43" })
      .expect(200)
      .expect((response) => {
        expect(response.body.configured).toBe(true);
        expect(response.body.chatId).toBe("43");
      });

    await request(app).post("/api/notifications/telegram/test").expect(200);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.telegram.org/bot123456:test_token/sendMessage",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining("\"chat_id\":\"43\""),
      }),
    );
    controller.dispose();
  });

  it("uses .env Telegram values as fallback before local settings exist", async () => {
    const controller = new BotController(
      await baseConfig(false, {
        telegramBotToken: "123456:env_token",
        telegramChatId: "99",
        publicUrl: "http://env-polybot.local",
      }),
      {
        startPriceFeed: false,
        snapshotProvider: fixedSnapshot,
        runnerFactory: () => new FakeRunner(),
      },
    );
    const app = createUiApp(controller);

    await request(app)
      .get("/api/notifications/telegram")
      .expect(200)
      .expect((response) => {
        expect(response.body.source).toBe("env");
        expect(response.body.configured).toBe(true);
        expect(response.body.chatId).toBe("99");
        expect(JSON.stringify(response.body)).not.toContain("env_token");
      });
    controller.dispose();
  });

  it("rejects Ollama analysis without an API key", async () => {
    const controller = new BotController(await baseConfig(false), {
      strategyAnalysisEngine: fakeStrategyAnalysisEngine(analysisResponse()),
      startPriceFeed: false,
      snapshotProvider: fixedSnapshot,
      runnerFactory: () => new FakeRunner(),
    });
    const app = createUiApp(controller);

    await request(app).post("/api/analysis/ollama").send({ prompt: "resume riesgos" }).expect(409);
    controller.dispose();
  });

  it("requests Ollama analysis with strategy context", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = String(init?.body);
      expect(body).toContain("resume riesgos");
      expect(body).toContain("topStrategies");
      expect(body).toContain("confidence");
      expect(body).toContain("riskFlags");
      expect(body).not.toContain("1111111111");
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer ollama-key");
      return new Response(JSON.stringify({ message: { content: "Tesis: EV positivo." } }), { status: 200 });
    }) as unknown as typeof fetch;
    const controller = new BotController(await baseConfig(true, { ollamaApiKey: "ollama-key" }), {
      env: { POLYMARKET_SIGNATURE_TYPE: "0" },
      strategyAnalysisEngine: fakeStrategyAnalysisEngine(analysisResponse()),
      fetch: fetchMock,
      startPriceFeed: false,
      snapshotProvider: fixedSnapshot,
      runnerFactory: () => new FakeRunner(),
    });
    const app = createUiApp(controller);

    await request(app)
      .post("/api/analysis/ollama")
      .send({ prompt: "resume riesgos" })
      .expect(200)
      .expect((response) => {
        expect(response.body.model).toBe("gpt-oss:120b");
        expect(response.body.content).toContain("EV positivo");
        expect(response.body.contextSummary).toContain("estrategias");
      });
    expect(fetchMock).toHaveBeenCalledWith("https://ollama.com/api/chat", expect.any(Object));
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

  it("resets dashboard P&L for one mode without clearing trades", async () => {
    const config = await baseConfig(false);
    const seedState = new StateStore(config.dataDir);
    await seedState.load();
    await seedState.recordTradeAttempt(apiTrade());
    const controller = new BotController(config, {
      startPriceFeed: false,
      snapshotProvider: fixedSnapshot,
      runnerFactory: () => new FakeRunner(),
    });
    const app = createUiApp(controller);

    await request(app).post("/api/pnl/reset").send({ mode: "sim" }).expect(200);

    const state = new StateStore(config.dataDir);
    await state.load();
    expect(state.getPnlResetAtMs().sim).toEqual(expect.any(Number));
    expect(state.listTrades()).toHaveLength(1);
    controller.dispose();
  });
});

async function baseConfig(withSecrets: boolean, overrides: Partial<BotConfig> = {}): Promise<BotConfig> {
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
    ollamaHost: "https://ollama.com",
    ollamaModel: "gpt-oss:120b",
    signatureType: 0,
    privateKey: withSecrets ? (`0x${"1".repeat(64)}` as `0x${string}`) : undefined,
    funderAddress: withSecrets ? (`0x${"2".repeat(40)}` as `0x${string}`) : undefined,
    ...overrides,
  };
}

async function fixedSnapshot(): Promise<Partial<UiStatus>> {
  return {
    markets: [],
    dailySpendUsd: 0,
    signal: { reason: "no_market", inEntryWindow: false },
  };
}

function fakeStrategyAnalysisEngine(response: StrategyAnalysisResponse): StrategyAnalysisEngine {
  return {
    analyze: async () => response,
  } as unknown as StrategyAnalysisEngine;
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
      averageAsk: 0.5,
      evRoi: 0.25,
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

function apiTrade(overrides: Partial<TradeAttempt> = {}): TradeAttempt {
  return {
    id: "api-trade",
    asset: "BTC",
    slug: "btc-updown-5m-api",
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
    entryWindowSeconds: 20,
    windowStartMs: 1,
    endMs: 2,
    createdAtMs: 3,
    ...overrides,
  };
}

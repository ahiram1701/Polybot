import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";

import { importAnalyticsSamples, readAnalyticsSamples } from "../src/analyticsRecorder.js";
import type { StrategyAnalysisEngine } from "../src/strategyAnalysisEngine.js";
import { StateStore } from "../src/stateStore.js";
import type {
  AiRecommendation,
  AiRecommendationsResponse,
  AnalyticsSample,
  BotConfig,
  StrategyAnalysisResponse,
  StrategyCandidate,
  TradeAttempt,
} from "../src/types.js";
import type { RecommendationEngine } from "../src/recommendationEngine.js";
import { BotController, type RunnerLike } from "../src/ui/controller.js";
import { createUiApp } from "../src/ui/server.js";
import type { UiStatus } from "../src/ui/shared.js";

class FakeRunner implements RunnerLike {
  async start(): Promise<void> {
    return new Promise(() => undefined);
  }
  stop(): void {}
}

type StrategySettingsUpdate = Parameters<NonNullable<RunnerLike["updateStrategySettings"]>>[0];

class RecordingRunner extends FakeRunner {
  readonly updates: StrategySettingsUpdate[] = [];
  updateStrategySettings(settings: StrategySettingsUpdate): void {
    this.updates.push(settings);
  }
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

  it("patches the risk circuit breaker limits from the UI", async () => {
    const controller = new BotController(await baseConfig(false), {
      startPriceFeed: false,
      snapshotProvider: fixedSnapshot,
      runnerFactory: () => new FakeRunner(),
    });
    const app = createUiApp(controller);

    await request(app)
      .patch("/api/settings")
      .send({ maxDailyLossUsd: 40, maxConsecutiveLosses: 3, maxAskPriceCeiling: 0.8 })
      .expect(200)
      .expect((response) => {
        expect(response.body.maxDailyLossUsd).toBe(40);
        expect(response.body.maxConsecutiveLosses).toBe(3);
        expect(response.body.maxAskPriceCeiling).toBe(0.8);
      });

    const settings = await controller.getSettings();
    expect(settings.maxDailyLossUsd).toBe(40);
    expect(settings.maxConsecutiveLosses).toBe(3);
    expect(settings.maxAskPriceCeiling).toBe(0.8);

    const status = await controller.getStatus();
    expect(status.config.maxAskPriceCeiling).toBe(0.8);
    controller.dispose();
  });

  it("does not clobber unspecified settings when patching a single field", async () => {
    const controller = new BotController(await baseConfig(false), {
      startPriceFeed: false,
      snapshotProvider: fixedSnapshot,
      runnerFactory: () => new FakeRunner(),
    });
    const app = createUiApp(controller);

    // Establish non-default values on fields that carry a Zod `.default()`.
    await request(app)
      .patch("/api/settings")
      .send({ maxConsecutiveLosses: 7, maxAskPriceCeiling: 0.7, evSafetyMargin: 0.05 })
      .expect(200);

    // Patch a DIFFERENT, unrelated field. The defaulted fields must survive untouched
    // (Zod's `.partial()` still injects `.default()` values — the route must ignore them).
    await request(app).patch("/api/settings").send({ minBtcDistanceUsd: 25 }).expect(200);

    const settings = await controller.getSettings();
    expect(settings.minBtcDistanceUsd).toBe(25);
    expect(settings.maxConsecutiveLosses).toBe(7);
    expect(settings.maxAskPriceCeiling).toBe(0.7);
    expect(settings.evSafetyMargin).toBe(0.05);
    controller.dispose();
  });

  it("patches the EV gate from the UI and applies it to the runtime config", async () => {
    const controller = new BotController(await baseConfig(false), {
      startPriceFeed: false,
      snapshotProvider: fixedSnapshot,
      runnerFactory: () => new FakeRunner(),
    });
    const app = createUiApp(controller);

    await request(app)
      .patch("/api/settings")
      .send({ requirePositiveEv: false, evSafetyMargin: 0.02, evMinHistoryTrades: 8, evMinExpectedRoi: 0.005 })
      .expect(200)
      .expect((response) => {
        expect(response.body.requirePositiveEv).toBe(false);
        expect(response.body.evSafetyMargin).toBe(0.02);
        expect(response.body.evMinHistoryTrades).toBe(8);
        expect(response.body.evMinExpectedRoi).toBe(0.005);
      });

    const settings = await controller.getSettings();
    expect(settings.requirePositiveEv).toBe(false);
    expect(settings.evSafetyMargin).toBe(0.02);
    expect(settings.evMinHistoryTrades).toBe(8);

    const status = await controller.getStatus();
    expect(status.config.evSafetyMargin).toBe(0.02);
    expect(status.config.evMinHistoryTrades).toBe(8);
    expect(status.config.requirePositiveEv).toBe(false);
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

  it("patches the predictive auto-adjust toggle", async () => {
    const controller = new BotController(await baseConfig(false), {
      startPriceFeed: false,
      snapshotProvider: fixedSnapshot,
      runnerFactory: () => new FakeRunner(),
    });
    const app = createUiApp(controller);

    await request(app)
      .patch("/api/settings")
      .send({ aiAutoApplyLive: true })
      .expect(200)
      .expect((response) => {
        expect(response.body.aiAutoApplyLive).toBe(true);
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

  it("returns AI recommendations", async () => {
    const controller = new BotController(await baseConfig(false), {
      recommendationEngine: fakeRecommendationEngine(recommendationsResponse()),
      startPriceFeed: false,
      snapshotProvider: fixedSnapshot,
      runnerFactory: () => new FakeRunner(),
    });
    const app = createUiApp(controller);

    await request(app).get("/api/analysis/recommendations").expect(200).expect((response) => {
      expect(response.body.recommendations).toHaveLength(1);
      expect(response.body.recommendations[0].market).toBe("BTC");
      expect(response.body.recommendations[0].canAutoApply).toBe(true);
    });
    controller.dispose();
  });

  it("auto-applies AI recommendations into the running bot when enabled", async () => {
    const config = await baseConfig(false);
    const recordingRunner = new RecordingRunner();
    const controller = new BotController(config, {
      recommendationEngine: fakeRecommendationEngine(recommendationsResponse()),
      startPriceFeed: false,
      snapshotProvider: fixedSnapshot,
      runnerFactory: () => recordingRunner,
    });

    await controller.patchSettings({ aiAutoApplyLive: true });
    await controller.start("sim");

    const applied = await controller.runAiAutoApplyTick();
    expect(applied.map((recommendation) => recommendation.market)).toEqual(["BTC"]);
    expect(recordingRunner.updates).toHaveLength(1);
    const [update] = recordingRunner.updates;
    expect(update?.entryWindowSecondsByMarketOutcome?.BTC).toEqual({ UP: 18, DOWN: 18 });
    expect(update?.minDistanceUsdByMarketOutcome?.BTC).toEqual({ UP: 22, DOWN: 22 });

    const settings = await controller.getSettings();
    expect(settings.entryWindowSecondsByMarket.BTC).toBe(18);
    expect(settings.minDistanceUsdByMarket.BTC).toBe(22);
    expect(settings.aiLastAppliedAtMs).toEqual(expect.any(Number));
    controller.dispose();
  });

  it("skips AI auto-apply when the toggle is off", async () => {
    const controller = new BotController(await baseConfig(false), {
      recommendationEngine: fakeRecommendationEngine(recommendationsResponse()),
      startPriceFeed: false,
      snapshotProvider: fixedSnapshot,
      runnerFactory: () => new RecordingRunner(),
    });

    await controller.start("sim");
    await expect(controller.runAiAutoApplyTick()).resolves.toEqual([]);
    controller.dispose();
  });

  it("downloads analysis samples as jsonl", async () => {
    const config = await baseConfig(false);
    const sample = apiAnalyticsSample("BTC", Date.UTC(2026, 4, 8, 12, 0, 0));
    await importAnalyticsSamples(join(config.dataDir, "analytics.jsonl"), JSON.stringify(sample));
    const controller = new BotController(config, {
      startPriceFeed: false,
      snapshotProvider: fixedSnapshot,
      runnerFactory: () => new FakeRunner(),
    });
    const app = createUiApp(controller);

    const response = await request(app)
      .get("/api/analysis/samples/export")
      .expect(200)
      .expect("Content-Type", /application\/x-ndjson/)
      .expect("Content-Disposition", /attachment; filename="polybot-analysis-\d{8}-\d{6}\.jsonl"/);

    expect(response.text).toContain('"type":"analytics_sample"');
    expect(response.text).toContain(sample.slug);
    controller.dispose();
  });

  it("imports analysis samples while stopped", async () => {
    const config = await baseConfig(false);
    const sample = apiAnalyticsSample("ETH", Date.UTC(2026, 4, 8, 12, 5, 0));
    const controller = new BotController(config, {
      startPriceFeed: false,
      snapshotProvider: fixedSnapshot,
      runnerFactory: () => new FakeRunner(),
    });
    const app = createUiApp(controller);

    await request(app)
      .post("/api/analysis/samples/import")
      .set("Content-Type", "text/plain")
      .send(JSON.stringify(sample))
      .expect(200)
      .expect((response) => {
        expect(response.body.importedCount).toBe(1);
        expect(response.body.duplicateCount).toBe(0);
        expect(response.body.skippedInvalidCount).toBe(0);
        expect(response.body.totalKnownSamples).toBe(1);
        expect(response.body).not.toHaveProperty("validSampleCount");
      });

    await expect(readAnalyticsSamples(join(config.dataDir, "analytics.jsonl"))).resolves.toHaveLength(1);
    controller.dispose();
  });

  it("rejects analysis import while the bot is running", async () => {
    const controller = new BotController(await baseConfig(false), {
      startPriceFeed: false,
      snapshotProvider: fixedSnapshot,
      runnerFactory: () => new FakeRunner(),
    });
    const app = createUiApp(controller);

    await request(app).post("/api/bot/start").send({ mode: "sim" }).expect(200);
    await request(app)
      .post("/api/analysis/samples/import")
      .set("Content-Type", "text/plain")
      .send(JSON.stringify(apiAnalyticsSample("BTC", Date.UTC(2026, 4, 8, 12, 0, 0))))
      .expect(409);
    controller.dispose();
  });

  it("rejects analysis import without valid samples", async () => {
    const controller = new BotController(await baseConfig(false), {
      startPriceFeed: false,
      snapshotProvider: fixedSnapshot,
      runnerFactory: () => new FakeRunner(),
    });
    const app = createUiApp(controller);

    await request(app)
      .post("/api/analysis/samples/import")
      .set("Content-Type", "text/plain")
      .send("not-json\n")
      .expect(400);
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

  it("re-arms the risk circuit breaker via /api/risk/reset without clearing trades", async () => {
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

    await request(app).post("/api/risk/reset").send({ mode: "sim" }).expect(200);

    const state = new StateStore(config.dataDir);
    await state.load();
    expect(state.getRiskHaltResetAtMs().sim).toEqual(expect.any(Number));
    expect(state.listTrades()).toHaveLength(1);
    controller.dispose();
  });

  it("serves the fiscal summary, applies manual FX rates, and exports the CSV", async () => {
    const config = await baseConfig(false);
    const resolvedAtMs = Date.UTC(2026, 6, 10, 18, 0, 0);
    const seedState = new StateStore(config.dataDir);
    await seedState.load();
    await seedState.recordTradeAttempt(
      apiTrade({
        id: "live-fiscal",
        mode: "live",
        amountUsd: 7,
        bestAsk: 0.7,
        estimatedShares: 10,
        fillDetected: true,
        filledAmountUsd: 7,
        filledShares: 10,
        feeUsd: 0.1,
        createdAtMs: resolvedAtMs - 60_000,
        resolved: {
          resolvedAtMs,
          finalPrice: 130,
          finalTickTimestampMs: resolvedAtMs,
          winningOutcome: "UP",
          won: true,
        },
      }),
    );
    // A sim trade in the same year must never leak into the fiscal report.
    await seedState.recordTradeAttempt(
      apiTrade({
        id: "sim-fiscal",
        createdAtMs: resolvedAtMs,
        resolved: { resolvedAtMs, finalPrice: 130, finalTickTimestampMs: resolvedAtMs, winningOutcome: "UP", won: true },
      }),
    );
    const controller = new BotController(config, {
      startPriceFeed: false,
      snapshotProvider: fixedSnapshot,
      runnerFactory: () => new FakeRunner(),
    });
    const app = createUiApp(controller);

    const summary = await request(app).get("/api/fiscal/summary?year=2026").expect(200);
    expect(summary.body.summary.operaciones).toBe(1);
    expect(summary.body.summary.gananciaUsd).toBeCloseTo(2.9); // 10 shares - ($7 + $0.10 fee)
    expect(summary.body.summary.gananciaMxn).toBeUndefined();
    expect(summary.body.fx.banxicoTokenConfigured).toBe(false);

    const withRate = await request(app)
      .post("/api/fiscal/fx")
      .send({ manualRates: { "2026-07": 17 }, year: 2026 })
      .expect(200);
    expect(withRate.body.summary.gananciaMxn).toBeCloseTo(49.3); // 2.9 USD * 17

    const csv = await request(app).get("/api/fiscal/export?year=2026").expect(200);
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(csv.headers["content-disposition"]).toContain("attachment");
    expect(csv.text).toContain("live-fiscal");
    expect(csv.text).not.toContain("sim-fiscal");
    expect(csv.text).toContain("17.0000,49.30");
    controller.dispose();
  });
});

describe("MCP over HTTP (/mcp)", () => {
  const MCP_ACCEPT = "application/json, text/event-stream";

  it("completes the initialize handshake and lists the polybot tools", async () => {
    const controller = new BotController(await baseConfig(false), {
      startPriceFeed: false,
      snapshotProvider: fixedSnapshot,
      runnerFactory: () => new FakeRunner(),
    });
    const app = createUiApp(controller);

    const init = await request(app)
      .post("/mcp")
      .set("Accept", MCP_ACCEPT)
      .send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "test-cowork", version: "1.0.0" },
        },
      })
      .expect(200);

    expect(init.body.result.serverInfo.name).toBe("polybot");
    const sessionId = init.headers["mcp-session-id"];
    expect(sessionId).toBeTruthy();

    await request(app)
      .post("/mcp")
      .set("Accept", MCP_ACCEPT)
      .set("mcp-session-id", sessionId)
      .send({ jsonrpc: "2.0", method: "notifications/initialized" })
      .expect(202);

    const tools = await request(app)
      .post("/mcp")
      .set("Accept", MCP_ACCEPT)
      .set("mcp-session-id", sessionId)
      .send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })
      .expect(200);

    const names = (tools.body.result.tools as Array<{ name: string }>).map((t) => t.name);
    expect(names).toContain("polybot_get_status");
    expect(names).toContain("polybot_start_bot");
    expect(names).toContain("polybot_update_settings");
    controller.dispose();
  });

  it("rejects a non-initialize request without a session", async () => {
    const controller = new BotController(await baseConfig(false), {
      startPriceFeed: false,
      snapshotProvider: fixedSnapshot,
      runnerFactory: () => new FakeRunner(),
    });
    const app = createUiApp(controller);

    await request(app)
      .post("/mcp")
      .set("Accept", MCP_ACCEPT)
      .send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} })
      .expect(400);
    controller.dispose();
  });

  it("hides write/control tools when POLYBOT_MCP_ALLOW_WRITE=false", async () => {
    const prev = process.env.POLYBOT_MCP_ALLOW_WRITE;
    process.env.POLYBOT_MCP_ALLOW_WRITE = "false";
    try {
      const controller = new BotController(await baseConfig(false), {
        startPriceFeed: false,
        snapshotProvider: fixedSnapshot,
        runnerFactory: () => new FakeRunner(),
      });
      const app = createUiApp(controller);

      const init = await request(app)
        .post("/mcp")
        .set("Accept", MCP_ACCEPT)
        .send({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } },
        })
        .expect(200);
      const sessionId = init.headers["mcp-session-id"];
      await request(app)
        .post("/mcp")
        .set("Accept", MCP_ACCEPT)
        .set("mcp-session-id", sessionId)
        .send({ jsonrpc: "2.0", method: "notifications/initialized" });

      const tools = await request(app)
        .post("/mcp")
        .set("Accept", MCP_ACCEPT)
        .set("mcp-session-id", sessionId)
        .send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })
        .expect(200);
      const names = (tools.body.result.tools as Array<{ name: string }>).map((t) => t.name);
      expect(names).toContain("polybot_get_status");
      expect(names).not.toContain("polybot_start_bot");
      expect(names).not.toContain("polybot_update_settings");
      controller.dispose();
    } finally {
      if (prev === undefined) {
        delete process.env.POLYBOT_MCP_ALLOW_WRITE;
      } else {
        process.env.POLYBOT_MCP_ALLOW_WRITE = prev;
      }
    }
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

function fakeRecommendationEngine(response: AiRecommendationsResponse): Pick<RecommendationEngine, "recommend"> {
  return {
    recommend: async () => response,
  };
}

function recommendationsResponse(): AiRecommendationsResponse {
  const metrics = {
    sampleCount: 60,
    signalCount: 40,
    tradeCount: 35,
    winCount: 22,
    lossCount: 13,
    quoteCoverage: 0.9,
    averageRoi: 0.12,
    adjustedRoi: 0.1,
    expectedRoi: 0.08,
    walkForwardRoi: 0.07,
    lowerBoundRoi: 0.05,
    overfitRisk: 0.2,
    predictedWinProbability: 0.6,
    calibrationError: 0.1,
    maxDrawdown: 1.5,
  };
  const recommendation: AiRecommendation = {
    market: "BTC",
    status: "ready",
    confidence: "high",
    generatedAtMs: Date.UTC(2026, 4, 8, 12, 0, 0),
    current: { entryWindowSeconds: 20, minDistanceUsd: 20, metrics },
    recommended: { entryWindowSeconds: 18, minDistanceUsd: 22, metrics },
    improvementAdjustedRoi: 0.05,
    sampleCount: 60,
    reason: "Alta confianza.",
    canApply: true,
    canAutoApply: true,
  };
  return {
    generatedAtMs: Date.UTC(2026, 4, 8, 12, 0, 0),
    recommendations: [recommendation],
  };
}

function apiAnalyticsSample(market: AnalyticsSample["market"], windowStartMs: number): AnalyticsSample {
  const prefix = market.toLowerCase();
  return {
    version: 1,
    market,
    slug: `${prefix}-updown-5m-${Math.floor(windowStartMs / 1000)}`,
    windowStartMs,
    endMs: windowStartMs + 300_000,
    openingPrice: 100,
    openingTickTimestampMs: windowStartMs,
    ticks: [
      {
        timestampMs: windowStartMs + 270_000,
        secondsToEnd: 30,
        price: 112,
        distanceUsd: 12,
      },
    ],
    quotes: [
      {
        timestampMs: windowStartMs + 270_000,
        secondsToEnd: 30,
        upBestAsk: 0.52,
        upBestBid: 0.51,
        downBestAsk: 0.49,
        downBestBid: 0.48,
      },
    ],
    finalPrice: 112,
    finalTickTimestampMs: windowStartMs + 300_000,
    winningOutcome: "UP",
    resolvedAtMs: windowStartMs + 301_000,
  };
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
      analyzedSampleCount: 5,
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

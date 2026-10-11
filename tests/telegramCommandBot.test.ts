import { describe, expect, it, vi } from "vitest";

import type { EffectiveTelegramNotificationConfig } from "../src/notifier.js";
import { EMPTY_PNL_SUMMARY } from "../src/pnl.js";
import {
  LIVE_CONFIRMATION_TTL_MS,
  liveStrategies,
  TelegramCommandBot,
  type CommandBotController,
  type TelegramUpdate,
} from "../src/telegram/commandBot.js";
import type { UiSettings, UiStatus } from "../src/ui/shared.js";

const CHAT = "42";

function makeConfig(overrides: Partial<EffectiveTelegramNotificationConfig> = {}): EffectiveTelegramNotificationConfig {
  return {
    enabled: true,
    botToken: "123456789:test-token-abcdefghijklm",
    chatId: CHAT,
    source: "local",
    digestEnabled: false,
    digestIntervalMinutes: 240,
    dailyReportEnabled: false,
    dailyReportHour: 21,
    commandsEnabled: true,
    liveControlEnabled: true,
    ...overrides,
  };
}

function makeSettings(overrides: Partial<UiSettings> = {}): UiSettings {
  return {
    enabledMarkets: ["BTC"],
    arbMode: "heredado",
    directionalMode: "heredado",
    makerMode: "heredado",
    arbEnabled: true,
    makerEnabled: false,
    favoriteStrategyEnabled: true,
    explorationEnabled: false,
    requirePositiveEv: false,
    simTradeAmountUsd: 5,
    liveTradeAmountUsd: 2,
    maxAskPrice: 0.9,
    minBtcDistanceUsd: 15,
    dailySpendLimitUsd: 50,
    maxDailyLossUsd: 10,
    maxConsecutiveLosses: 4,
    dailyProfitTargetUsd: 20,
    timezone: "America/Mexico_City",
    ...overrides,
  } as UiSettings;
}

function makeStatus(overrides: Partial<UiStatus> = {}): UiStatus {
  return {
    running: false,
    effectiveModes: { arb: "sim", directional: "sim", maker: "sim" },
    settings: makeSettings(),
    liveReadiness: { ready: true, hasPrivateKey: true, hasFunderAddress: true, hasSignatureType: true },
    pnlByMode: { sim: EMPTY_PNL_SUMMARY, live: EMPTY_PNL_SUMMARY },
    pnlHistoricalByMode: { sim: EMPTY_PNL_SUMMARY, live: EMPTY_PNL_SUMMARY },
    ...overrides,
  } as UiStatus;
}

function setup(options: { config?: Partial<EffectiveTelegramNotificationConfig>; settings?: Partial<UiSettings> } = {}) {
  let nowMs = 1_784_200_000_000;
  const config = makeConfig(options.config);
  const sent: { method: string; body: Record<string, unknown> }[] = [];
  let updates: TelegramUpdate[] = [];
  const fetchFn = vi.fn(async (url: unknown, init?: RequestInit) => {
    const method = String(url).split("/").at(-1)!;
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    sent.push({ method, body });
    const result = method === "getUpdates" ? updates : true;
    return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
  }) as unknown as typeof fetch;
  const controller: CommandBotController = {
    getStatus: vi.fn(async () => makeStatus()),
    getTrades: vi.fn(async () => []),
    getSettings: vi.fn(async () => makeSettings(options.settings)),
    start: vi.fn(async () => makeStatus({ running: true })),
    stop: vi.fn(async () => makeStatus()),
  };
  const bot = new TelegramCommandBot({ loadEffective: async () => config }, controller, {
    fetchFn,
    now: () => nowMs,
    confirmationCode: () => "1234",
  });
  let nextId = 1;
  const message = (text: string, chatId: string | number = CHAT): TelegramUpdate => ({
    update_id: nextId++,
    message: { message_id: nextId, chat: { id: chatId }, text },
  });
  const callback = (data: string): TelegramUpdate => ({
    update_id: nextId++,
    callback_query: { id: `cb${nextId}`, data, message: { message_id: nextId, chat: { id: CHAT } } },
  });
  const replies = () => sent.filter((call) => call.method === "sendMessage").map((call) => String(call.body.text));
  const lastButtons = () =>
    (sent.filter((call) => call.method === "sendMessage").at(-1)?.body.reply_markup as {
      inline_keyboard: { callback_data: string }[][];
    })?.inline_keyboard[0].map((button) => button.callback_data);
  return {
    bot,
    controller,
    config,
    sent,
    replies,
    lastButtons,
    message,
    callback,
    setUpdates: (next: TelegramUpdate[]) => (updates = next),
    advance: (ms: number) => (nowMs += ms),
    handle: (update: TelegramUpdate) => bot.handleUpdate(update, config),
  };
}

describe("telegram command bot", () => {
  it("ignores messages from any chat other than the configured one", async () => {
    const t = setup();
    await t.handle(t.message("/estado", 999));
    expect(t.replies()).toHaveLength(0);
    expect(t.controller.getStatus).not.toHaveBeenCalled();
  });

  it("drops the backlog on first poll so old commands never run after a restart", async () => {
    const t = setup();
    t.setUpdates([t.message("/arrancar sim")]);
    await t.bot.pollOnce(0);

    const getUpdates = t.sent.filter((call) => call.method === "getUpdates");
    expect(getUpdates[0].body.offset).toBe(-1);
    // Second call continues after the discarded update instead of re-reading it.
    expect(getUpdates[1].body.offset).toBe(2);
    expect(t.sent.some((call) => call.method === "setMyCommands")).toBe(true);
  });

  it("does not poll at all when commands are disabled", async () => {
    const t = setup({ config: { commandsEnabled: false } });
    expect(await t.bot.pollOnce(0)).toBe(false);
    expect(t.sent).toHaveLength(0);
  });

  it("treats Telegram's /start greeting as help, never as a bot start", async () => {
    const t = setup();
    await t.handle(t.message("/start"));
    expect(t.controller.start).not.toHaveBeenCalled();
    expect(t.replies()[0]).toContain("/arrancar sim");
  });

  it("formats /estado with only the strategies that are switched on", async () => {
    const t = setup();
    vi.mocked(t.controller.getStatus).mockResolvedValue(
      makeStatus({
        effectiveModes: { arb: "live", directional: "sim", maker: "live" },
        settings: makeSettings({ arbEnabled: true, makerEnabled: false }),
      }),
    );
    await t.handle(t.message("/estado@PolybotBot"));
    expect(t.replies()[0]).toContain("Estrategias: favorito 🧪 SIM · arbitraje 🔴 LIVE");
    expect(t.replies()[0]).toContain("Apagadas: maker");
    expect(t.replies()[0]).not.toContain("maker 🔴");
  });

  it("starts a pure sim run straight away", async () => {
    const t = setup();
    await t.handle(t.message("/arrancar sim"));
    expect(t.controller.start).toHaveBeenCalledWith("sim");
  });

  it("refuses a live start when live control is disabled", async () => {
    const t = setup({ config: { liveControlEnabled: false } });
    await t.handle(t.message("/arrancar live"));
    expect(t.controller.start).not.toHaveBeenCalled();
    expect(t.replies()[0]).toContain("dinero real");
  });

  it("requires the double confirmation for a sim start that has a strategy in live", async () => {
    const t = setup({ settings: { arbMode: "live" } });
    await t.handle(t.message("/arrancar sim"));
    expect(t.controller.start).not.toHaveBeenCalled();
    expect(t.lastButtons()?.[0]).toMatch(/^live:/);
  });

  it("starts live only after the button and the right code", async () => {
    const t = setup();
    await t.handle(t.message("/arrancar live"));
    const nonceData = t.lastButtons()![0];
    await t.handle(t.callback(nonceData));
    expect(t.replies().at(-1)).toContain("CONFIRMO LIVE 1234");
    expect(t.controller.start).not.toHaveBeenCalled();

    await t.handle(t.message("confirmo live 1234"));
    expect(t.controller.start).toHaveBeenCalledWith("live", true);
  });

  it("burns the pending start on a wrong code", async () => {
    const t = setup();
    await t.handle(t.message("/arrancar live"));
    await t.handle(t.callback(t.lastButtons()![0]));
    await t.handle(t.message("CONFIRMO LIVE 9999"));
    await t.handle(t.message("CONFIRMO LIVE 1234"));
    expect(t.controller.start).not.toHaveBeenCalled();
  });

  it("rejects an expired code", async () => {
    const t = setup();
    await t.handle(t.message("/arrancar live"));
    await t.handle(t.callback(t.lastButtons()![0]));
    t.advance(LIVE_CONFIRMATION_TTL_MS + 1);
    await t.handle(t.message("CONFIRMO LIVE 1234"));
    expect(t.controller.start).not.toHaveBeenCalled();
    expect(t.replies().at(-1)).toContain("caduco");
  });

  it("rejects a stale button from an earlier request", async () => {
    const t = setup();
    await t.handle(t.message("/arrancar live"));
    const stale = t.lastButtons()![0];
    await t.handle(t.callback("cancelar"));
    await t.handle(t.callback(stale));
    expect(t.replies().at(-1)).toContain("ya no es valida");
  });

  it("stops the bot from the confirmation button", async () => {
    const t = setup();
    vi.mocked(t.controller.getStatus).mockResolvedValue(makeStatus({ running: true }));
    await t.handle(t.message("/detener"));
    expect(t.controller.stop).not.toHaveBeenCalled();
    await t.handle(t.callback("detener"));
    expect(t.controller.stop).toHaveBeenCalled();
  });
});

describe("liveStrategies", () => {
  const base = {
    arbMode: "heredado",
    directionalMode: "sim",
    makerMode: "heredado",
    arbEnabled: true,
    makerEnabled: true,
    favoriteStrategyEnabled: true,
    explorationEnabled: false,
    requirePositiveEv: false,
  } as const;

  it("mirrors the runner inheritance: heredado follows the start mode, maker falls back to sim", () => {
    expect(liveStrategies(base, "live")).toEqual(["arbitraje"]);
    expect(liveStrategies(base, "sim")).toEqual([]);
    expect(liveStrategies({ ...base, makerMode: "live" }, "sim")).toEqual(["maker"]);
  });

  it("ignores strategies that are switched off, whatever their mode says", () => {
    expect(liveStrategies({ ...base, makerMode: "live", makerEnabled: false }, "sim")).toEqual([]);
    expect(liveStrategies({ ...base, arbEnabled: false }, "live")).toEqual([]);
  });

  it("names exploration only when the EV gate that runs it is on", () => {
    const live = { ...base, directionalMode: "live", explorationEnabled: true } as const;
    expect(liveStrategies(live, "sim")).toEqual(["favorito"]);
    expect(liveStrategies({ ...live, requirePositiveEv: true }, "sim")).toEqual(["favorito + exploracion"]);
  });
});

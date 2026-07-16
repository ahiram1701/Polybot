import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DynamicTelegramNotifier, TelegramNotificationStore } from "../src/notifier.js";

describe("telegram digest mode", () => {
  let dataDir: string;
  let sent: { text: string }[];
  let nowMs: number;
  let store: TelegramNotificationStore;
  let notifier: DynamicTelegramNotifier;

  const fetchStub = (async (_url: unknown, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)) as { text: string });
    return new Response("{}", { status: 200 });
  }) as typeof fetch;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "polybot-digest-"));
    sent = [];
    nowMs = 1_784_200_000_000;
    store = new TelegramNotificationStore(dataDir, {});
    await store.save({ enabled: true, botToken: "123456789:test-token-abcdefghijklm", chatId: "42" });
    notifier = new DynamicTelegramNotifier(store, fetchStub, { now: () => nowMs, digestTimer: false });
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it("sends per-trade pings immediately when digest is off", async () => {
    await notifier.notify({ category: "trade", title: "Trade ganado", body: "x" });
    expect(sent).toHaveLength(1);
  });

  it("buffers trade pings and flushes one summary after the interval", async () => {
    await store.save({ digestEnabled: true, digestIntervalMinutes: 60 });

    await notifier.notify({ category: "trade", title: "Trade ganado", body: "Modo: live." });
    nowMs += 10 * 60_000;
    await notifier.notify({ category: "trade", title: "Trade perdido", body: "Modo: live." });
    expect(sent).toHaveLength(0); // nothing yet: interval not elapsed

    nowMs += 55 * 60_000; // past the hour
    await notifier.flushDigestIfDue();
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain("Resumen de trades (1W/1L)");
    expect(sent[0].text).toContain("Trade ganado");
    expect(sent[0].text).toContain("Trade perdido");

    // Buffer drained: nothing further to send.
    await notifier.flushDigestIfDue();
    expect(sent).toHaveLength(1);
  });

  it("keeps safety notifications immediate even with digest on", async () => {
    await store.save({ digestEnabled: true, digestIntervalMinutes: 60 });
    await notifier.notify({ title: "Circuit breaker de riesgo activado", level: "warn" });
    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain("Circuit breaker");
  });
});

import { describe, expect, it, vi } from "vitest";

import { createNotifier, formatTelegramMessage, NoopNotifier, TelegramNotifier } from "../src/notifier.js";

describe("notifier", () => {
  it("uses a no-op notifier when Telegram credentials are missing", async () => {
    const notifier = createNotifier({});

    expect(notifier).toBeInstanceOf(NoopNotifier);
    await expect(notifier.notify({ title: "UI lista" })).resolves.toBeUndefined();
  });

  it("sends Telegram notifications with the configured public URL", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => new Response("{}"));
    const notifier = new TelegramNotifier({
      botToken: "123456:test_token",
      chatId: "42",
      publicUrl: "http://polybot.tailnet.ts.net:8787",
      fetchFn,
      now: () => 1_000,
    });

    await notifier.notify({ key: "ui-ready", title: "UI lista", body: "Live apagado." });

    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0];
    expect(String(url)).toContain("https://api.telegram.org/bot123456:test_token/sendMessage");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      chat_id: "42",
      text: "Polybot INFO: UI lista\nLive apagado.\nUI: http://polybot.tailnet.ts.net:8787",
    });
  });

  it("deduplicates repeated Telegram notifications inside the rate window", async () => {
    let nowMs = 1_000;
    const fetchFn = vi.fn<typeof fetch>(async () => new Response("{}"));
    const notifier = new TelegramNotifier({
      botToken: "123456:test_token",
      chatId: "42",
      fetchFn,
      now: () => nowMs,
      defaultMinIntervalMs: 60_000,
    });

    await notifier.notify({ key: "same", title: "Error" });
    nowMs += 1_000;
    await notifier.notify({ key: "same", title: "Error" });
    nowMs += 61_000;
    await notifier.notify({ key: "same", title: "Error" });

    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("redacts private keys and Telegram-like tokens in message text", () => {
    const text = formatTelegramMessage({
      title: `key 0x${"1".repeat(64)}`,
      body: "token 123456:abcdefghijklmnopqrstuvwxyz",
    });

    expect(text).not.toContain("1111111111");
    expect(text).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(text).toContain("redacted");
  });
});

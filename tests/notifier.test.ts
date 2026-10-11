import { describe, expect, it, vi } from "vitest";

import {
  buildTelegramPayload,
  createNotifier,
  formatTelegramMessage,
  NoopNotifier,
  TelegramNotifier,
} from "../src/notifier.js";

describe("notifier", () => {
  it("uses a no-op notifier when Telegram credentials are missing", async () => {
    const notifier = createNotifier({});

    expect(notifier).toBeInstanceOf(NoopNotifier);
    await expect(notifier.notify({ title: "UI lista" })).resolves.toBeUndefined();
  });

  it("sends HTML Telegram notifications with a UI button for the public URL", async () => {
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
      parse_mode: "HTML",
      text: "🟢 <b>UI lista</b>\nLive apagado.",
      reply_markup: { inline_keyboard: [[{ text: "🖥 Abrir UI", url: "http://polybot.tailnet.ts.net:8787" }]] },
    });
  });

  it("falls back to plain text when Telegram rejects the formatted message", async () => {
    const fetchFn = vi.fn<typeof fetch>(async (_url, init) =>
      JSON.parse(String(init?.body)).parse_mode
        ? new Response(JSON.stringify({ ok: false, description: "Bad Request: wrong HTTP URL" }), { status: 400 })
        : new Response("{}"),
    );
    const notifier = new TelegramNotifier({
      botToken: "123456:test_token",
      chatId: "42",
      publicUrl: "http://127.0.0.1:8787",
      fetchFn,
      now: () => 1_000,
    });

    await notifier.notify({ title: "Trade ganado", body: "P&L <+$1>", mode: "live" });

    expect(fetchFn).toHaveBeenCalledTimes(2);
    const retry = JSON.parse(String(fetchFn.mock.calls[1][1]?.body));
    expect(retry.parse_mode).toBeUndefined();
    expect(retry.reply_markup).toBeUndefined();
    expect(retry.text).toBe("✅ Trade ganado  🔴 LIVE\nP&L <+$1>\nUI: http://127.0.0.1:8787");
  });

  it("escapes HTML, tags the mode and adds the status button only when asked", () => {
    const payload = buildTelegramPayload(
      { title: "Trade perdido", body: "ask <0.90 & bid>0.80", mode: "sim" },
      { chatId: "42", statusButton: true },
    );

    expect(payload.text).toBe("❌ <b>Trade perdido</b>  🧪 SIM\nask &lt;0.90 &amp; bid&gt;0.80");
    expect(payload.reply_markup).toEqual({ inline_keyboard: [[{ text: "📊 Estado", callback_data: "estado" }]] });
    expect(buildTelegramPayload({ title: "x" }, { chatId: "42" }).reply_markup).toBeUndefined();
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

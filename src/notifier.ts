import { logger } from "./logger.js";
import type { BotConfig } from "./types.js";

export type NotificationLevel = "info" | "warn" | "error";

export interface NotificationMessage {
  title: string;
  body?: string;
  level?: NotificationLevel;
  key?: string;
  nowMs?: number;
  minIntervalMs?: number;
}

export interface Notifier {
  notify(message: NotificationMessage): Promise<void>;
}

export class NoopNotifier implements Notifier {
  async notify(): Promise<void> {
    return undefined;
  }
}

export interface TelegramNotifierOptions {
  botToken: string;
  chatId: string;
  publicUrl?: string;
  fetchFn?: typeof fetch;
  now?: () => number;
  defaultMinIntervalMs?: number;
}

export class TelegramNotifier implements Notifier {
  private readonly lastSentByKey = new Map<string, number>();
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly defaultMinIntervalMs: number;

  constructor(private readonly options: TelegramNotifierOptions) {
    this.fetchFn = options.fetchFn ?? fetch;
    this.now = options.now ?? Date.now;
    this.defaultMinIntervalMs = options.defaultMinIntervalMs ?? 60_000;
  }

  async notify(message: NotificationMessage): Promise<void> {
    const nowMs = message.nowMs ?? this.now();
    const key = message.key ?? `${message.level ?? "info"}:${message.title}:${message.body ?? ""}`;
    const minIntervalMs = message.minIntervalMs ?? this.defaultMinIntervalMs;
    const lastSentAtMs = this.lastSentByKey.get(key);
    if (lastSentAtMs !== undefined && nowMs - lastSentAtMs < minIntervalMs) {
      return;
    }
    this.lastSentByKey.set(key, nowMs);

    try {
      const response = await this.fetchFn(
        `https://api.telegram.org/bot${this.options.botToken}/sendMessage`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            chat_id: this.options.chatId,
            text: formatTelegramMessage(message, this.options.publicUrl),
            disable_web_page_preview: false,
          }),
        },
      );
      if (!response.ok) {
        logger.warn("Telegram notification failed.", { status: response.status });
      }
    } catch (error) {
      logger.warn("Telegram notification failed.", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

export function createNotifier(config: Pick<BotConfig, "telegramBotToken" | "telegramChatId" | "publicUrl">): Notifier {
  if (!config.telegramBotToken || !config.telegramChatId) {
    return new NoopNotifier();
  }
  return new TelegramNotifier({
    botToken: config.telegramBotToken,
    chatId: config.telegramChatId,
    publicUrl: config.publicUrl,
  });
}

export function formatTelegramMessage(message: NotificationMessage, publicUrl?: string): string {
  const level = message.level ?? "info";
  const lines = [`Polybot ${level.toUpperCase()}: ${redactSecrets(message.title)}`];
  if (message.body) {
    lines.push(redactSecrets(message.body));
  }
  if (publicUrl) {
    lines.push(`UI: ${publicUrl}`);
  }
  return lines.join("\n");
}

function redactSecrets(value: string): string {
  return value
    .replace(/0x[0-9a-fA-F]{64}/g, "0x[redacted-private-key]")
    .replace(/bot[0-9]+:[A-Za-z0-9_-]+/g, "bot[redacted-token]")
    .replace(/\b\d{6,}:[A-Za-z0-9_-]{20,}/g, "[redacted-token]")
    .replace(/[A-Za-z0-9_-]{20,}:[A-Za-z0-9_-]{20,}/g, "[redacted-token]");
}

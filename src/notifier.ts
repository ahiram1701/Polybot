import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { dirname, join } from "node:path";

import { writeFileAtomic } from "./atomicWrite.js";
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
  // "trade" = per-trade ping (won/lost) that digest mode batches into a periodic summary. Safety and
  // system messages (risk halt, errors, arb legs) stay immediate and never carry this category.
  category?: "trade" | "system";
  // Modo del dinero en juego. Se pinta como etiqueta (🔴 LIVE / 🧪 SIM) para que en el movil se vea de
  // un vistazo si el aviso habla de dinero real.
  mode?: "sim" | "live";
  // P&L neto del trade, si aplica. El digest lo suma para decir cuanto se gano en el periodo.
  netUsd?: number;
}

export interface Notifier {
  notify(message: NotificationMessage): Promise<void>;
}

export interface TelegramNotificationSettings {
  enabled: boolean;
  configured: boolean;
  hasBotToken: boolean;
  botTokenMasked?: string;
  chatId: string;
  publicUrl?: string;
  source: "env" | "local" | "none";
  // Digest mode: batch per-trade pings into one summary every N minutes (anti slot-machine).
  digestEnabled: boolean;
  digestIntervalMinutes: number;
  // Daily self-report at the configured hour (timezone-aware; sent by the controller).
  dailyReportEnabled: boolean;
  dailyReportHour: number;
  // Comandos entrantes (/estado, /arrancar...). Solo se atienden desde `chatId`.
  commandsEnabled: boolean;
  // Permite arrancar en live desde el chat (con doble confirmacion). Apagado por defecto.
  liveControlEnabled: boolean;
}

export interface TelegramNotificationPatch {
  enabled?: boolean;
  botToken?: string;
  chatId?: string;
  publicUrl?: string;
  digestEnabled?: boolean;
  digestIntervalMinutes?: number;
  dailyReportEnabled?: boolean;
  dailyReportHour?: number;
  commandsEnabled?: boolean;
  liveControlEnabled?: boolean;
}

interface TelegramNotificationFile {
  enabled: boolean;
  encryptedBotToken?: string;
  chatId?: string;
  publicUrl?: string;
  digestEnabled?: boolean;
  digestIntervalMinutes?: number;
  dailyReportEnabled?: boolean;
  dailyReportHour?: number;
  commandsEnabled?: boolean;
  liveControlEnabled?: boolean;
}

export interface EffectiveTelegramNotificationConfig {
  enabled: boolean;
  botToken?: string;
  chatId?: string;
  publicUrl?: string;
  source: "env" | "local" | "none";
  digestEnabled: boolean;
  digestIntervalMinutes: number;
  dailyReportEnabled: boolean;
  dailyReportHour: number;
  commandsEnabled: boolean;
  liveControlEnabled: boolean;
}

export const DEFAULT_DIGEST_INTERVAL_MINUTES = 240;
export const DEFAULT_DAILY_REPORT_HOUR = 21;

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
  // Boton "📊 Estado" en cada aviso. Solo tiene sentido si hay quien atienda el callback (comandos on).
  statusButton?: boolean;
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

    const payload = buildTelegramPayload(message, {
      chatId: this.options.chatId,
      publicUrl: this.options.publicUrl,
      statusButton: this.options.statusButton,
    });
    try {
      let response = await this.post(payload);
      // Telegram rechaza con 400 un HTML mal formado o un boton con una URL que no acepta (p. ej.
      // http://127.0.0.1). Mejor el aviso en texto plano que quedarse sin aviso.
      if (response.status === 400) {
        logger.warn("Telegram rechazo el aviso con formato; se reenvia en texto plano.", {
          description: await readTelegramDescription(response),
        });
        response = await this.post({
          chat_id: this.options.chatId,
          text: formatTelegramPlainText(message, this.options.publicUrl),
        });
      }
      if (!response.ok) {
        logger.warn("Telegram notification failed.", { status: response.status });
      }
    } catch (error) {
      logger.warn("Telegram notification failed.", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private post(payload: Record<string, unknown>): Promise<Response> {
    return this.fetchFn(`https://api.telegram.org/bot${this.options.botToken}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  }
}

export class DynamicTelegramNotifier implements Notifier {
  private notifier?: TelegramNotifier;
  private notifierKey?: string;
  private readonly now: () => number;
  private readonly digestBuffer: {
    atMs: number;
    title: string;
    body?: string;
    mode?: "sim" | "live";
    netUsd?: number;
  }[] = [];
  private lastDigestFlushMs: number;

  constructor(
    private readonly store: TelegramNotificationStore,
    private readonly fetchFn?: typeof fetch,
    options: { now?: () => number; digestTimer?: boolean } = {},
  ) {
    this.now = options.now ?? Date.now;
    this.lastDigestFlushMs = this.now();
    if (options.digestTimer !== false) {
      setInterval(() => void this.flushDigestIfDue(), 60_000).unref();
    }
  }

  async notify(message: NotificationMessage): Promise<void> {
    const config = await this.store.loadEffective();
    if (!config.enabled || !config.botToken || !config.chatId) {
      return;
    }
    if (config.digestEnabled && message.category === "trade") {
      this.digestBuffer.push({
        atMs: message.nowMs ?? this.now(),
        title: message.title,
        body: message.body,
        mode: message.mode,
        netUsd: message.netUsd,
      });
      await this.flushDigestIfDue();
      return;
    }
    await this.sendWith(config, message);
  }

  /** Sends the pending digest when the configured interval elapsed. Public for tests. */
  async flushDigestIfDue(): Promise<void> {
    if (this.digestBuffer.length === 0) {
      return;
    }
    const config = await this.store.loadEffective();
    const intervalMs = Math.max(1, config.digestIntervalMinutes) * 60_000;
    if (this.now() - this.lastDigestFlushMs < intervalMs) {
      return;
    }
    if (!config.enabled || !config.botToken || !config.chatId) {
      return;
    }
    const entries = this.digestBuffer.splice(0);
    this.lastDigestFlushMs = this.now();
    // Un arbitraje liquidado SIEMPRE gana (redime $1 por set gane quien gane), asi que cuenta como
    // ganado. Antes caia en "otros" y el resumen subreportaba los aciertos frente al P&L real.
    const wins = entries.filter(
      (entry) => entry.title === "Trade ganado" || entry.title === "Arbitraje liquidado",
    ).length;
    const losses = entries.filter((entry) => entry.title === "Trade perdido").length;
    const other = entries.length - wins - losses;
    const lines = entries.slice(-10).map((entry) => {
      const time = new Date(entry.atMs).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
      const net = entry.netUsd === undefined ? "" : ` ${formatSignedUsdShort(entry.netUsd)}`;
      return `${time} ${titleEmoji(entry.title, "info")} ${entry.title}${net}${entry.body ? ` — ${entry.body.split("\n")[0]}` : ""}`;
    });
    const nets = entries.filter((entry) => entry.netUsd !== undefined);
    const netLine =
      nets.length > 0
        ? `Neto del periodo: ${formatSignedUsdShort(nets.reduce((sum, entry) => sum + (entry.netUsd ?? 0), 0))}`
        : undefined;
    // Un digest mezcla modos solo si se cambio de modo a mitad de periodo; la etiqueta solo se pone si
    // todos coinciden, para no afirmar "SIM" sobre un resumen que incluye dinero real.
    const modes = new Set(entries.map((entry) => entry.mode));
    await this.sendWith(config, {
      key: `telegram-digest:${this.lastDigestFlushMs}`,
      minIntervalMs: 0,
      mode: modes.size === 1 ? entries[0].mode : undefined,
      title: `Resumen de trades (${wins}W/${losses}L${other > 0 ? ` +${other}` : ""})`,
      body:
        [netLine, ...lines].filter(Boolean).join("\n") +
        (entries.length > 10 ? `\n(+${entries.length - 10} anteriores)` : ""),
    });
  }

  private async sendWith(config: EffectiveTelegramNotificationConfig, message: NotificationMessage): Promise<void> {
    const key = `${config.botToken}:${config.chatId}:${config.publicUrl ?? ""}:${config.commandsEnabled}`;
    if (this.notifierKey !== key) {
      this.notifierKey = key;
      this.notifier = new TelegramNotifier({
        botToken: config.botToken!,
        chatId: config.chatId!,
        publicUrl: config.publicUrl,
        fetchFn: this.fetchFn,
        now: this.now,
        statusButton: config.commandsEnabled,
      });
    }
    await this.notifier?.notify(message);
  }
}

export class TelegramNotificationStore {
  constructor(
    private readonly dataDir: string,
    private readonly fallbackConfig: Pick<BotConfig, "telegramBotToken" | "telegramChatId" | "publicUrl"> = {},
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  get settingsPath(): string {
    return join(this.dataDir, "telegram-notifications.json");
  }

  get keyPath(): string {
    return join(this.dataDir, "telegram-secret.key");
  }

  async loadSanitized(): Promise<TelegramNotificationSettings> {
    return sanitizeEffectiveConfig(await this.loadEffective());
  }

  async loadEffective(): Promise<EffectiveTelegramNotificationConfig> {
    const local = await this.readLocalFile();
    if (local) {
      const botToken = local.encryptedBotToken ? await this.decrypt(local.encryptedBotToken) : undefined;
      return {
        enabled: local.enabled,
        botToken,
        chatId: local.chatId,
        publicUrl: local.publicUrl,
        source: "local",
        digestEnabled: local.digestEnabled ?? false,
        digestIntervalMinutes: local.digestIntervalMinutes ?? DEFAULT_DIGEST_INTERVAL_MINUTES,
        dailyReportEnabled: local.dailyReportEnabled ?? false,
        dailyReportHour: local.dailyReportHour ?? DEFAULT_DAILY_REPORT_HOUR,
        commandsEnabled: local.commandsEnabled ?? true,
        liveControlEnabled: local.liveControlEnabled ?? false,
      };
    }

    const botToken = this.fallbackConfig.telegramBotToken;
    const chatId = this.fallbackConfig.telegramChatId;
    if (!botToken && !chatId && !this.fallbackConfig.publicUrl) {
      return {
        enabled: false,
        source: "none",
        digestEnabled: false,
        digestIntervalMinutes: DEFAULT_DIGEST_INTERVAL_MINUTES,
        dailyReportEnabled: false,
        dailyReportHour: DEFAULT_DAILY_REPORT_HOUR,
        commandsEnabled: false,
        liveControlEnabled: false,
      };
    }
    return {
      enabled: Boolean(botToken && chatId),
      botToken,
      chatId,
      publicUrl: this.fallbackConfig.publicUrl,
      source: botToken || chatId ? "env" : "none",
      digestEnabled: false,
      digestIntervalMinutes: DEFAULT_DIGEST_INTERVAL_MINUTES,
      dailyReportEnabled: false,
      dailyReportHour: DEFAULT_DAILY_REPORT_HOUR,
      commandsEnabled: true,
      liveControlEnabled: false,
    };
  }

  async save(patch: TelegramNotificationPatch): Promise<TelegramNotificationSettings> {
    const current = await this.loadEffective();
    const next: EffectiveTelegramNotificationConfig = {
      enabled: patch.enabled ?? current.enabled,
      botToken: normalizeOptionalSecret(patch.botToken) ?? current.botToken,
      chatId: normalizeOptionalText(patch.chatId) ?? current.chatId,
      publicUrl: normalizeOptionalText(patch.publicUrl),
      source: "local",
      digestEnabled: patch.digestEnabled ?? current.digestEnabled,
      digestIntervalMinutes:
        typeof patch.digestIntervalMinutes === "number" && patch.digestIntervalMinutes >= 5
          ? Math.round(patch.digestIntervalMinutes)
          : current.digestIntervalMinutes,
      dailyReportEnabled: patch.dailyReportEnabled ?? current.dailyReportEnabled,
      dailyReportHour:
        typeof patch.dailyReportHour === "number" && patch.dailyReportHour >= 0 && patch.dailyReportHour <= 23
          ? Math.round(patch.dailyReportHour)
          : current.dailyReportHour,
      commandsEnabled: patch.commandsEnabled ?? current.commandsEnabled,
      liveControlEnabled: patch.liveControlEnabled ?? current.liveControlEnabled,
    };
    if (patch.publicUrl === undefined) {
      next.publicUrl = current.publicUrl;
    }

    const file: TelegramNotificationFile = {
      enabled: next.enabled,
      encryptedBotToken: next.botToken ? await this.encrypt(next.botToken) : undefined,
      chatId: next.chatId,
      publicUrl: next.publicUrl,
      digestEnabled: next.digestEnabled,
      digestIntervalMinutes: next.digestIntervalMinutes,
      dailyReportEnabled: next.dailyReportEnabled,
      dailyReportHour: next.dailyReportHour,
      commandsEnabled: next.commandsEnabled,
      liveControlEnabled: next.liveControlEnabled,
    };
    await writeFileAtomic(this.settingsPath, `${JSON.stringify(file, null, 2)}\n`);
    return sanitizeEffectiveConfig(next);
  }

  private async readLocalFile(): Promise<TelegramNotificationFile | undefined> {
    try {
      const parsed = JSON.parse(await readFile(this.settingsPath, "utf8")) as Partial<TelegramNotificationFile>;
      return {
        enabled: Boolean(parsed.enabled),
        encryptedBotToken: typeof parsed.encryptedBotToken === "string" ? parsed.encryptedBotToken : undefined,
        chatId: typeof parsed.chatId === "string" ? parsed.chatId : undefined,
        publicUrl: typeof parsed.publicUrl === "string" ? parsed.publicUrl : undefined,
        digestEnabled: typeof parsed.digestEnabled === "boolean" ? parsed.digestEnabled : undefined,
        digestIntervalMinutes:
          typeof parsed.digestIntervalMinutes === "number" ? parsed.digestIntervalMinutes : undefined,
        dailyReportEnabled: typeof parsed.dailyReportEnabled === "boolean" ? parsed.dailyReportEnabled : undefined,
        dailyReportHour: typeof parsed.dailyReportHour === "number" ? parsed.dailyReportHour : undefined,
        commandsEnabled: typeof parsed.commandsEnabled === "boolean" ? parsed.commandsEnabled : undefined,
        liveControlEnabled: typeof parsed.liveControlEnabled === "boolean" ? parsed.liveControlEnabled : undefined,
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return undefined;
      }
      throw error;
    }
  }

  private async encrypt(value: string): Promise<string> {
    const key = await this.loadKey();
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return ["v1", iv.toString("base64"), tag.toString("base64"), encrypted.toString("base64")].join(":");
  }

  private async decrypt(value: string): Promise<string | undefined> {
    const [version, ivBase64, tagBase64, encryptedBase64] = value.split(":");
    if (version !== "v1" || !ivBase64 || !tagBase64 || !encryptedBase64) {
      return undefined;
    }
    const key = await this.loadKey();
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivBase64, "base64"));
    decipher.setAuthTag(Buffer.from(tagBase64, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(encryptedBase64, "base64")),
      decipher.final(),
    ]).toString("utf8");
  }

  private async loadKey(): Promise<Buffer> {
    const configuredKey = normalizeOptionalText(this.env.POLYBOT_SECRET_KEY);
    if (configuredKey) {
      return keyFromString(configuredKey);
    }
    try {
      return Buffer.from((await readFile(this.keyPath, "utf8")).trim(), "base64");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      const key = randomBytes(32);
      await mkdir(dirname(this.keyPath), { recursive: true });
      await writeFile(this.keyPath, `${key.toString("base64")}\n`, "utf8");
      return key;
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

export function createDynamicNotifier(
  config: Pick<BotConfig, "dataDir" | "telegramBotToken" | "telegramChatId" | "publicUrl">,
  options: { fetchFn?: typeof fetch; env?: NodeJS.ProcessEnv } = {},
): Notifier {
  return new DynamicTelegramNotifier(
    new TelegramNotificationStore(config.dataDir, config, options.env),
    options.fetchFn,
  );
}

/** Callback de los botones "📊 Estado" de los avisos; lo atiende el bot de comandos. */
export const TELEGRAM_STATUS_CALLBACK = "estado";

/** Cuerpo de `sendMessage`: HTML con emoji, etiqueta de modo y botones inline. */
export function buildTelegramPayload(
  message: NotificationMessage,
  options: { chatId: string; publicUrl?: string; statusButton?: boolean },
): Record<string, unknown> {
  const buttons: { text: string; callback_data?: string; url?: string }[] = [];
  if (options.statusButton) {
    buttons.push({ text: "📊 Estado", callback_data: TELEGRAM_STATUS_CALLBACK });
  }
  if (options.publicUrl) {
    buttons.push({ text: "🖥 Abrir UI", url: options.publicUrl });
  }
  return {
    chat_id: options.chatId,
    text: formatTelegramMessage(message),
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...(buttons.length > 0 ? { reply_markup: { inline_keyboard: [buttons] } } : {}),
  };
}

export function formatTelegramMessage(message: NotificationMessage): string {
  const level = message.level ?? "info";
  const head = `${titleEmoji(message.title, level)} <b>${escapeTelegramHtml(redactSecrets(message.title))}</b>`;
  const lines = [message.mode ? `${head}  ${modeBadge(message.mode)}` : head];
  if (message.body) {
    lines.push(escapeTelegramHtml(redactSecrets(message.body)));
  }
  return lines.join("\n");
}

/** Respaldo sin formato para cuando Telegram rechaza el HTML o los botones. */
export function formatTelegramPlainText(message: NotificationMessage, publicUrl?: string): string {
  const level = message.level ?? "info";
  const head = `${titleEmoji(message.title, level)} ${redactSecrets(message.title)}`;
  const lines = [message.mode ? `${head}  ${modeBadge(message.mode)}` : head];
  if (message.body) {
    lines.push(redactSecrets(message.body));
  }
  if (publicUrl) {
    lines.push(`UI: ${publicUrl}`);
  }
  return lines.join("\n");
}

export function escapeTelegramHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function modeBadge(mode: "sim" | "live"): string {
  return mode === "live" ? "🔴 LIVE" : "🧪 SIM";
}

// Por titulo exacto los avisos que mas llegan; el resto, por nivel.
const TITLE_EMOJI: Record<string, string> = {
  "Trade ganado": "✅",
  "Trade perdido": "❌",
  "Arbitraje ejecutado": "⚖️",
  "Arbitraje liquidado": "⚖️",
  "Arbitraje incompleto": "⚠️",
  "Circuit breaker de riesgo activado": "🛑",
  "Objetivo del dia cumplido": "🎯",
  "Bot iniciado": "▶️",
  "Bot detenido": "⏹",
  "UI lista": "🟢",
};

function titleEmoji(title: string, level: NotificationLevel): string {
  if (TITLE_EMOJI[title]) {
    return TITLE_EMOJI[title];
  }
  if (title.startsWith("Salida:")) {
    return "🚪";
  }
  if (title.startsWith("Resumen de trades")) {
    return "🧾";
  }
  return level === "error" ? "🔥" : level === "warn" ? "⚠️" : "ℹ️";
}

export function formatSignedUsdShort(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  return `${rounded >= 0 ? "+" : "-"}$${Math.abs(rounded).toFixed(2)}`;
}

async function readTelegramDescription(response: Response): Promise<string | undefined> {
  try {
    const parsed = (await response.json()) as { description?: unknown };
    return typeof parsed.description === "string" ? parsed.description : undefined;
  } catch {
    return undefined;
  }
}

function redactSecrets(value: string): string {
  return value
    .replace(/0x[0-9a-fA-F]{64}/g, "0x[redacted-private-key]")
    .replace(/bot[0-9]+:[A-Za-z0-9_-]+/g, "bot[redacted-token]")
    .replace(/\b\d{6,}:[A-Za-z0-9_-]{20,}/g, "[redacted-token]")
    .replace(/[A-Za-z0-9_-]{20,}:[A-Za-z0-9_-]{20,}/g, "[redacted-token]");
}

function sanitizeEffectiveConfig(config: EffectiveTelegramNotificationConfig): TelegramNotificationSettings {
  return {
    enabled: config.enabled,
    configured: Boolean(config.enabled && config.botToken && config.chatId),
    hasBotToken: Boolean(config.botToken),
    botTokenMasked: config.botToken ? maskToken(config.botToken) : undefined,
    chatId: config.chatId ?? "",
    publicUrl: config.publicUrl,
    source: config.source,
    digestEnabled: config.digestEnabled,
    digestIntervalMinutes: config.digestIntervalMinutes,
    dailyReportEnabled: config.dailyReportEnabled,
    dailyReportHour: config.dailyReportHour,
    commandsEnabled: config.commandsEnabled,
    liveControlEnabled: config.liveControlEnabled,
  };
}

function maskToken(value: string): string {
  if (value.length <= 10) {
    return "********";
  }
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function normalizeOptionalText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeOptionalSecret(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed === "********" || trimmed.includes("...")) {
    return undefined;
  }
  return trimmed;
}

function keyFromString(value: string): Buffer {
  if (/^[0-9a-fA-F]{64}$/.test(value)) {
    return Buffer.from(value, "hex");
  }
  const base64 = Buffer.from(value, "base64");
  if (base64.length === 32) {
    return base64;
  }
  return createHash("sha256").update(value).digest();
}

import { randomInt } from "node:crypto";

import { logger } from "../logger.js";
import {
  escapeTelegramHtml,
  formatSignedUsdShort,
  modeBadge,
  TELEGRAM_STATUS_CALLBACK,
  type EffectiveTelegramNotificationConfig,
  type TelegramNotificationStore,
} from "../notifier.js";
import { calculateTradePnl } from "../pnl.js";
import type { Mode, TradeAttempt } from "../types.js";
import { MODE_KEYS, type UiSettings, type UiStatus } from "../ui/shared.js";

/**
 * Comandos de Polybot por Telegram.
 *
 * Long polling (`getUpdates`) y no webhook: el servidor escucha en 127.0.0.1 y Telegram no puede
 * llamarlo. Aqui es el bot quien pregunta, sin abrir puertos.
 *
 * Solo se atiende el `chatId` configurado; el resto se ignora sin responder. Arrancar con dinero real
 * exige `liveControlEnabled` + boton + codigo de 4 digitos, y caduca a los 60 s.
 */

export interface CommandBotController {
  getStatus(): Promise<UiStatus>;
  getTrades(limit?: number): Promise<TradeAttempt[]>;
  getSettings(): Promise<UiSettings>;
  start(mode: Mode, confirmLive?: boolean): Promise<UiStatus>;
  stop(): Promise<UiStatus>;
}

export interface TelegramCommandBotOptions {
  fetchFn?: typeof fetch;
  now?: () => number;
  /** Codigo de confirmacion live. Inyectable para tests. */
  confirmationCode?: () => string;
  pollTimeoutSeconds?: number;
}

interface TelegramChat {
  id: number | string;
}

interface TelegramMessage {
  message_id: number;
  chat: TelegramChat;
  text?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: { id: string; data?: string; message?: TelegramMessage };
}

interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
}

interface PendingLiveStart {
  nonce: string;
  /** Modo de arranque: "sim" cuando un arranque sim lleva alguna estrategia en live. */
  mode: Mode;
  stage: "button" | "code";
  code?: string;
  expiresAtMs: number;
}

export const LIVE_CONFIRMATION_TTL_MS = 60_000;
const IDLE_RECHECK_MS = 30_000;
const MAX_BACKOFF_MS = 60_000;
const DEFAULT_TRADES = 5;
const MAX_TRADES = 20;

const COMMAND_MENU = [
  { command: "estado", description: "Estado del bot y modos efectivos" },
  { command: "pnl", description: "P&L sim y live desde el ultimo reset" },
  { command: "trades", description: "Ultimos trades (/trades 10)" },
  { command: "ajustes", description: "Resumen de ajustes clave" },
  { command: "arrancar", description: "Arrancar: /arrancar sim o /arrancar live" },
  { command: "detener", description: "Detener el bot" },
  { command: "ayuda", description: "Lista de comandos" },
];

export class TelegramCommandBot {
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly confirmationCode: () => string;
  private readonly pollTimeoutSeconds: number;
  private running = false;
  private abort = new AbortController();
  private wake?: () => void;
  private offset?: number;
  /** Token con el que se inicializo el polling; si cambia, se vuelve a descartar el backlog. */
  private activeToken?: string;
  private pending?: PendingLiveStart;
  private loop?: Promise<void>;

  constructor(
    private readonly store: Pick<TelegramNotificationStore, "loadEffective">,
    private readonly controller: CommandBotController,
    options: TelegramCommandBotOptions = {},
  ) {
    this.fetchFn = options.fetchFn ?? fetch;
    this.now = options.now ?? Date.now;
    this.confirmationCode = options.confirmationCode ?? (() => String(randomInt(0, 10_000)).padStart(4, "0"));
    this.pollTimeoutSeconds = options.pollTimeoutSeconds ?? 25;
  }

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.abort = new AbortController();
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.abort.abort();
    this.wake?.();
    await this.loop?.catch(() => undefined);
  }

  private async run(): Promise<void> {
    let backoffMs = 5_000;
    while (this.running) {
      try {
        const polled = await this.pollOnce();
        backoffMs = 5_000;
        if (!polled) {
          await this.sleep(IDLE_RECHECK_MS);
        }
      } catch (error) {
        if (!this.running) {
          return;
        }
        logger.warn("Telegram: fallo al leer comandos; se reintenta.", {
          error: error instanceof Error ? error.message : String(error),
          retryInMs: backoffMs,
        });
        await this.sleep(backoffMs);
        backoffMs = Math.min(MAX_BACKOFF_MS, backoffMs * 2);
      }
    }
  }

  /**
   * Una ronda de `getUpdates`. Devuelve `false` si los comandos estan apagados o sin configurar.
   * Publico para tests.
   */
  async pollOnce(timeoutSeconds = this.pollTimeoutSeconds): Promise<boolean> {
    const config = await this.store.loadEffective();
    if (!config.enabled || !config.commandsEnabled || !config.botToken || !config.chatId) {
      this.activeToken = undefined;
      return false;
    }
    if (this.activeToken !== config.botToken) {
      await this.initialize(config.botToken);
    }

    const updates = await this.call<TelegramUpdate[]>(
      config.botToken,
      "getUpdates",
      {
        offset: this.offset,
        timeout: timeoutSeconds,
        allowed_updates: ["message", "callback_query"],
      },
      (timeoutSeconds + 10) * 1_000,
    );
    for (const update of updates ?? []) {
      this.offset = update.update_id + 1;
      try {
        await this.handleUpdate(update, config);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn("Telegram: el comando fallo.", { error: message });
        // Al chat tambien: un comando que no contesta nada parece que no llego.
        if (isAuthorized(update, config.chatId)) {
          await this.send(config, `🔥 Error: ${escapeTelegramHtml(message.slice(0, 500))}`).catch(() => undefined);
        }
      }
    }
    return true;
  }

  /**
   * Descarta lo que se escribio mientras el proceso estaba caido: un `/arrancar` de hace horas no debe
   * ejecutarse solo porque el watchdog reinicio Polybot.
   */
  private async initialize(token: string): Promise<void> {
    const backlog = await this.call<TelegramUpdate[]>(token, "getUpdates", { offset: -1, timeout: 0 });
    const last = backlog?.at(-1);
    this.offset = last ? last.update_id + 1 : undefined;
    this.activeToken = token;
    this.pending = undefined;
    try {
      await this.call(token, "setMyCommands", { commands: COMMAND_MENU });
    } catch (error) {
      // El menu es comodidad: sin el, los comandos escritos a mano funcionan igual.
      logger.warn("Telegram: no se pudo registrar el menu de comandos.", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    logger.info("Telegram: comandos activos.");
  }

  /** Publico para tests. */
  async handleUpdate(update: TelegramUpdate, config: EffectiveTelegramNotificationConfig): Promise<void> {
    if (!isAuthorized(update, config.chatId)) {
      const chat = updateChat(update);
      logger.warn("Telegram: mensaje de un chat no autorizado ignorado.", { chatId: chat ? String(chat.id) : undefined });
      return;
    }
    const reply = (text: string, buttons?: InlineButton[][]) => this.send(config, text, buttons);

    if (update.callback_query) {
      await this.call(config.botToken!, "answerCallbackQuery", { callback_query_id: update.callback_query.id }).catch(
        () => undefined,
      );
      await this.handleCallback(update.callback_query.data ?? "", config, reply);
      return;
    }

    const text = update.message?.text?.trim() ?? "";
    const confirmation = /^CONFIRMO\s+LIVE\s+(\d{4})$/i.exec(text);
    if (confirmation) {
      await this.confirmLiveCode(confirmation[1], reply);
      return;
    }
    if (!text.startsWith("/")) {
      await reply("No entiendo mensajes libres. Escribe /ayuda para ver los comandos.");
      return;
    }

    const [rawCommand, ...args] = text.split(/\s+/);
    // "/estado@PolybotBot" en grupos: el sufijo es el nombre del bot.
    const command = rawCommand.slice(1).split("@")[0].toLowerCase();
    switch (command) {
      case "start": // Lo manda Telegram al abrir el chat por primera vez: es un saludo, NO un arranque.
      case "ayuda":
      case "help":
        await reply(helpText(config.liveControlEnabled));
        return;
      case "estado":
      case "status":
        await reply(formatStatus(await this.controller.getStatus(), this.now()));
        return;
      case "pnl":
        await reply(formatPnl(await this.controller.getStatus()));
        return;
      case "trades": {
        const requested = Number.parseInt(args[0] ?? "", 10);
        const limit = Number.isFinite(requested) ? Math.min(MAX_TRADES, Math.max(1, requested)) : DEFAULT_TRADES;
        const [trades, settings] = await Promise.all([this.controller.getTrades(limit), this.controller.getSettings()]);
        await reply(formatTrades(trades, settings.timezone));
        return;
      }
      case "ajustes":
        await reply(formatSettings(await this.controller.getSettings()));
        return;
      case "arrancar":
        await this.requestStart(args[0]?.toLowerCase(), config, reply);
        return;
      case "detener":
      case "stop": {
        const status = await this.controller.getStatus();
        if (!status.running) {
          await reply("⏹ El bot ya esta detenido.");
          return;
        }
        await reply(`¿Detener el bot? ${anyLive(status) ? modeBadge("live") : modeBadge("sim")}`, [
          [
            { text: "⏹ Detener", callback_data: "detener" },
            { text: "Cancelar", callback_data: "cancelar" },
          ],
        ]);
        return;
      }
      default:
        await reply(`Comando desconocido: /${escapeTelegramHtml(command)}. Escribe /ayuda.`);
    }
  }

  private async requestStart(
    requested: string | undefined,
    config: EffectiveTelegramNotificationConfig,
    reply: Reply,
  ): Promise<void> {
    if (requested !== "sim" && requested !== "live") {
      await reply("Indica el modo: /arrancar sim o /arrancar live");
      return;
    }
    const mode: Mode = requested;
    const status = await this.controller.getStatus();
    if (status.running) {
      await reply("El bot ya esta corriendo. Usa /detener primero.");
      return;
    }
    const settings = await this.controller.getSettings();
    const live = liveStrategies(settings, mode);
    if (live.length === 0) {
      const next = await this.controller.start(mode);
      await reply(`▶️ Bot arrancado.\n\n${formatStatus(next, this.now())}`);
      return;
    }

    if (!config.liveControlEnabled) {
      await reply(
        [
          `🔒 Este arranque mueve <b>dinero real</b> (${live.join(", ")} en live) y el control live por Telegram esta apagado.`,
          "Activalo en la UI → Telegram → «Permitir arrancar en LIVE desde Telegram», o arranca desde la PC.",
        ].join("\n"),
      );
      return;
    }
    if (!status.liveReadiness.ready) {
      await reply(`🔒 Live no esta listo: ${escapeTelegramHtml(status.liveReadiness.reason ?? "faltan credenciales en .env")}.`);
      return;
    }

    const nonce = String(randomInt(0, 1_000_000_000));
    this.pending = { nonce, mode, stage: "button", expiresAtMs: this.now() + LIVE_CONFIRMATION_TTL_MS };
    const bankroll = status.bankroll ? `$${status.bankroll.usd.toFixed(2)} (${status.bankroll.source})` : "desconocido";
    await reply(
      [
        `⚠️ <b>Arranque con DINERO REAL</b>  ${modeBadge("live")}`,
        `Estrategias en live: <b>${live.join(", ")}</b>`,
        `Perdida maxima diaria: ${usdOrOff(settings.maxDailyLossUsd)} · Gasto diario max: ${usdOrOff(settings.dailySpendLimitUsd)}`,
        `Stake live: $${settings.liveTradeAmountUsd} · Bankroll: ${escapeTelegramHtml(bankroll)}`,
        "",
        "Pulsa el boton en los proximos 60 s para continuar.",
      ].join("\n"),
      [
        [
          { text: "🔴 Confirmar LIVE", callback_data: `live:${nonce}` },
          { text: "Cancelar", callback_data: "cancelar" },
        ],
      ],
    );
  }

  private async handleCallback(data: string, config: EffectiveTelegramNotificationConfig, reply: Reply): Promise<void> {
    if (data === TELEGRAM_STATUS_CALLBACK) {
      await reply(formatStatus(await this.controller.getStatus(), this.now()));
      return;
    }
    if (data === "detener") {
      // Parar nunca arriesga dinero: no hace falta nonce ni que el aviso sea reciente.
      const status = await this.controller.stop();
      await reply(`⏹ Bot detenido.\n\n${formatStatus(status, this.now())}`);
      return;
    }
    if (data === "cancelar") {
      this.pending = undefined;
      await reply("Cancelado.");
      return;
    }
    if (data.startsWith("live:")) {
      const pending = this.pending;
      if (!config.liveControlEnabled || !pending || pending.stage !== "button" || data !== `live:${pending.nonce}`) {
        await reply("Esa confirmacion ya no es valida. Empieza de nuevo con /arrancar live.");
        return;
      }
      if (this.now() > pending.expiresAtMs) {
        this.pending = undefined;
        await reply("⌛ La confirmacion caduco. Empieza de nuevo con /arrancar live.");
        return;
      }
      pending.stage = "code";
      pending.code = this.confirmationCode();
      pending.expiresAtMs = this.now() + LIVE_CONFIRMATION_TTL_MS;
      await reply(`Para arrancar en live escribe exactamente:\n<code>CONFIRMO LIVE ${pending.code}</code>\n(caduca en 60 s)`);
      return;
    }
    await reply("Boton desconocido.");
  }

  private async confirmLiveCode(code: string, reply: Reply): Promise<void> {
    const pending = this.pending;
    // Un solo intento: cualquier codigo, bueno o malo, consume el pendiente.
    this.pending = undefined;
    if (!pending || pending.stage !== "code") {
      await reply("No hay ningun arranque live pendiente. Usa /arrancar live.");
      return;
    }
    if (this.now() > pending.expiresAtMs) {
      await reply("⌛ El codigo caduco. Empieza de nuevo con /arrancar live.");
      return;
    }
    if (code !== pending.code) {
      await reply("❌ Codigo incorrecto. Empieza de nuevo con /arrancar live.");
      return;
    }
    // Se revalida justo antes de arrancar: el ajuste pudo cambiar en la UI durante el minuto de espera.
    const config = await this.store.loadEffective();
    if (!config.liveControlEnabled) {
      await reply("🔒 El control live por Telegram se desactivo mientras confirmabas.");
      return;
    }
    try {
      const status = await this.controller.start(pending.mode, pending.mode === "live");
      await reply(`🔴 <b>Bot arrancado con dinero real.</b>\n\n${formatStatus(status, this.now())}`);
    } catch (error) {
      await reply(`🔥 No se pudo arrancar: ${escapeTelegramHtml(error instanceof Error ? error.message : String(error))}`);
    }
  }

  private async send(config: EffectiveTelegramNotificationConfig, text: string, buttons?: InlineButton[][]): Promise<void> {
    await this.call(config.botToken!, "sendMessage", {
      chat_id: config.chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      ...(buttons ? { reply_markup: { inline_keyboard: buttons } } : {}),
    });
  }

  private async call<T = unknown>(
    token: string,
    method: string,
    body: Record<string, unknown>,
    timeoutMs = 15_000,
  ): Promise<T | undefined> {
    const response = await this.fetchFn(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(timeoutMs)]),
    });
    const parsed = (await response.json().catch(() => ({}))) as TelegramApiResponse<T>;
    if (!response.ok || !parsed.ok) {
      // 409 = otro proceso hace polling con el mismo token, o hay un webhook puesto.
      throw new Error(`Telegram ${method} fallo (${response.status}): ${parsed.description ?? "sin detalle"}`);
    }
    return parsed.result;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref?.();
      this.wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }
}

type InlineButton = { text: string; callback_data: string };
type Reply = (text: string, buttons?: InlineButton[][]) => Promise<void>;

type StrategySettings = Pick<
  UiSettings,
  | (typeof MODE_KEYS)[number]
  | "arbEnabled"
  | "makerEnabled"
  | "favoriteStrategyEnabled"
  | "explorationEnabled"
  | "requirePositiveEv"
>;

export interface StrategyView {
  /** Clave de `effectiveModes`. */
  key: "arb" | "directional" | "maker";
  label: string;
  active: boolean;
}

/**
 * Que estrategias estan ENCENDIDAS y como se llaman para quien lee el movil.
 *
 * `effectiveModes` dice en que modo operaria cada estrategia, no si esta encendida: con arbitraje y
 * maker apagados seguia listando "arb SIM · maker SIM", y eso se leyo como tres estrategias corriendo.
 * El direccional siempre esta encendido (es el motor base); se nombra por su variante.
 */
export function describeStrategies(settings: StrategySettings): StrategyView[] {
  // La exploracion vive dentro del filtro de EV: con `requirePositiveEv` apagado no corre nunca.
  const exploring = settings.explorationEnabled === true && settings.requirePositiveEv === true;
  const directional = settings.favoriteStrategyEnabled === true ? "favorito" : "direccional";
  return [
    { key: "directional", label: exploring ? `${directional} + exploracion` : directional, active: true },
    { key: "arb", label: "arbitraje", active: settings.arbEnabled === true },
    { key: "maker", label: "maker", active: settings.makerEnabled === true },
  ];
}

const MODE_KEY_BY_STRATEGY: Record<StrategyView["key"], (typeof MODE_KEYS)[number]> = {
  arb: "arbMode",
  directional: "directionalMode",
  maker: "makerMode",
};

/**
 * Estrategias ENCENDIDAS que operarian en live con este arranque. Replica la herencia del runner:
 * `heredado` toma el modo del arranque, salvo el maker, que cae a sim. Una estrategia apagada no mueve
 * dinero aunque su modo diga live, asi que no pide confirmacion.
 */
export function liveStrategies(settings: StrategySettings, mode: Mode): string[] {
  return describeStrategies(settings)
    .filter((strategy) => {
      if (!strategy.active) {
        return false;
      }
      const value = settings[MODE_KEY_BY_STRATEGY[strategy.key]];
      const resolved = value === "heredado" ? (strategy.key === "maker" ? "sim" : mode) : value;
      return resolved === "live";
    })
    .map((strategy) => strategy.label);
}

function updateChat(update: TelegramUpdate): TelegramChat | undefined {
  return update.message?.chat ?? update.callback_query?.message?.chat;
}

function isAuthorized(update: TelegramUpdate, chatId: string | undefined): boolean {
  const chat = updateChat(update);
  return Boolean(chat && chatId && String(chat.id) === chatId);
}

function anyLive(status: UiStatus): boolean {
  return describeStrategies(status.settings).some(
    (strategy) => strategy.active && status.effectiveModes[strategy.key] === "live",
  );
}

function helpText(liveControlEnabled: boolean): string {
  return [
    "<b>Polybot</b> — comandos",
    "/estado — estado y estrategias encendidas",
    "/pnl — P&amp;L sim y live",
    "/trades [n] — ultimos trades",
    "/ajustes — ajustes clave",
    "/arrancar sim · /arrancar live",
    "/detener — detener el bot",
    "",
    liveControlEnabled
      ? "🔓 Arranque live permitido (boton + codigo)."
      : "🔒 Arranque live desde Telegram desactivado.",
  ].join("\n");
}

export function formatStatus(status: UiStatus, nowMs: number): string {
  const lines = ["<b>📊 Estado</b>"];
  if (status.running) {
    const uptime = status.startedAtMs ? ` desde hace ${formatDuration(nowMs - status.startedAtMs)}` : "";
    lines.push(`▶️ Corriendo${uptime} (arranque: ${status.mode ?? "?"})`);
  } else {
    lines.push("⏹ Detenido");
  }
  const strategies = describeStrategies(status.settings);
  lines.push(
    `Estrategias: ${strategies
      .filter((strategy) => strategy.active)
      .map((strategy) => `${strategy.label} ${modeBadge(status.effectiveModes[strategy.key])}`)
      .join(" · ")}`,
  );
  const off = strategies.filter((strategy) => !strategy.active).map((strategy) => strategy.label);
  if (off.length > 0) {
    lines.push(`Apagadas: ${off.join(", ")}`);
  }
  const halt = status.riskHalt;
  if (halt?.tripped) {
    const until = halt.resumeAtMs ? ` hasta ${new Date(halt.resumeAtMs).toISOString().slice(11, 16)} UTC` : "";
    lines.push(`🛑 Freno activo: ${RISK_REASON[halt.reason ?? ""] ?? halt.reason}${until}`);
  }
  if (halt) {
    lines.push(`Hoy: ${formatSignedUsdShort(halt.dailyNetUsd)} · perdidas seguidas: ${halt.consecutiveLosses}`);
  }
  if (status.bankroll) {
    lines.push(`Bankroll: $${status.bankroll.usd.toFixed(2)} (${status.bankroll.source})`);
  }
  if (status.loopHealth && status.loopHealth.iterations > 0) {
    lines.push(`Loop: ${status.loopHealth.failedPct.toFixed(1)}% fallos en ${status.loopHealth.iterations} iteraciones`);
  }
  if (status.lastError) {
    lines.push(`🔥 Ultimo error: ${escapeTelegramHtml(status.lastError.slice(0, 300))}`);
  }
  return lines.join("\n");
}

export function formatPnl(status: UiStatus): string {
  const lines = ["<b>💰 P&amp;L desde el ultimo reset</b>"];
  for (const mode of ["live", "sim"] as const) {
    const pnl = status.pnlByMode[mode];
    const resolved = pnl.wonCount + pnl.lostCount;
    const winRate = resolved > 0 ? ` · ${Math.round((100 * pnl.wonCount) / resolved)}% win` : "";
    const roi = pnl.roiPct !== undefined ? ` (${(pnl.roiPct * 100).toFixed(1)}%)` : "";
    lines.push(
      `${modeBadge(mode)}: <b>${formatSignedUsdShort(pnl.realizedUsd)}</b>${roi} · ${pnl.wonCount}-${pnl.lostCount}${winRate}` +
        (pnl.pendingCount > 0 ? ` · ${pnl.pendingCount} abiertos ($${pnl.pendingStakeUsd.toFixed(2)})` : ""),
    );
  }
  const historical = status.pnlHistoricalByMode.live;
  lines.push(`Historico live: ${formatSignedUsdShort(historical.realizedUsd)} en ${historical.resolvedCount} trades`);
  return lines.join("\n");
}

export function formatTrades(trades: TradeAttempt[], timeZone: string): string {
  if (trades.length === 0) {
    return "Sin trades todavia.";
  }
  const lines = [`<b>🧾 Ultimos ${trades.length} trades</b>`];
  for (const trade of trades) {
    const time = safeTime(trade.createdAtMs, timeZone);
    const asset = trade.asset ?? trade.slug.split("-")[0]?.toUpperCase() ?? "?";
    let result = "⏳ abierto";
    let icon = "⏳";
    if (trade.resolved) {
      const net = calculateTradePnl(trade).netUsd ?? 0;
      icon = net > 0 ? "✅" : net < 0 ? "❌" : "➖";
      result = formatSignedUsdShort(net);
    }
    lines.push(
      `${icon} ${time} ${escapeTelegramHtml(asset)} ${trade.outcome} $${trade.amountUsd.toFixed(2)} → ${result} ${trade.mode === "live" ? "🔴" : "🧪"}`,
    );
  }
  return lines.join("\n");
}

export function formatSettings(settings: UiSettings): string {
  const mode = (value: string) => (value === "heredado" ? "heredado" : value.toUpperCase());
  return [
    "<b>⚙️ Ajustes clave</b>",
    `Mercados: ${settings.enabledMarkets.join(", ") || "ninguno"}`,
    `Estrategias: ${describeStrategies(settings)
      .map((strategy) =>
        strategy.active ? `${strategy.label} ${mode(settings[MODE_KEY_BY_STRATEGY[strategy.key]])}` : `${strategy.label} off`,
      )
      .join(" · ")}`,
    `Stake: sim $${settings.simTradeAmountUsd} · live $${settings.liveTradeAmountUsd}`,
    `Ask max: ${settings.maxAskPrice} · Distancia min: $${settings.minBtcDistanceUsd}`,
    `Gasto diario max: ${usdOrOff(settings.dailySpendLimitUsd)} · Perdida diaria max: ${usdOrOff(settings.maxDailyLossUsd)}`,
    `Perdidas seguidas max: ${settings.maxConsecutiveLosses > 0 ? settings.maxConsecutiveLosses : "sin limite"} · Objetivo diario: ${usdOrOff(settings.dailyProfitTargetUsd)}`,
    "",
    "Para cambiarlos usa la UI (el bot debe estar detenido).",
  ].join("\n");
}

const RISK_REASON: Record<string, string> = {
  daily_loss_limit: "perdida diaria maxima",
  consecutive_losses: "perdidas seguidas",
  daily_profit_target: "objetivo del dia cumplido",
};

/** En los limites de riesgo, 0 significa apagado (la guardia solo actua con `> 0`), no "cero tolerancia". */
function usdOrOff(value: number): string {
  return value > 0 ? `$${value}` : "sin limite";
}

function formatDuration(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  const hours = Math.floor(minutes / 60);
  return hours > 0 ? `${hours}h ${minutes % 60}m` : `${minutes}m`;
}

function safeTime(atMs: number, timeZone: string): string {
  try {
    return new Date(atMs).toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit", timeZone });
  } catch {
    return new Date(atMs).toISOString().slice(11, 16);
  }
}

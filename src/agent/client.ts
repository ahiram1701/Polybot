import type {
  AiRecommendationsResponse,
  MarketSymbol,
  Mode,
  OllamaTradeAnalysisResponse,
  Outcome,
  StrategyAnalysisResponse,
  StrategyMetrics,
  TradeAttempt,
} from "../types.js";
import type {
  AnalysisImportResponse,
  TelegramNotificationPatch,
  TelegramNotificationSettings,
  TelegramNotificationTestResponse,
  UiSettings,
  UiStatus,
} from "../ui/shared.js";

export const DEFAULT_POLYBOT_API_URL = "http://127.0.0.1:8787";

export class PolybotApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "PolybotApiError";
  }
}

export interface PolybotClientOptions {
  baseUrl?: string;
  fetchFn?: typeof fetch;
}

export interface AnalysisExportResult {
  filename: string;
  contents: string;
}

export interface SetupEvParams {
  market: MarketSymbol;
  outcome: Outcome;
  entryWindowSeconds: number;
  minDistanceUsd: number;
  maxAskPrice: number;
  capitalUsd?: number;
}

export type SetupEvResult = StrategyMetrics & { market: MarketSymbol; outcome: Outcome };

type HttpMethod = "GET" | "POST" | "PATCH";

/**
 * Thin typed client over the local Polybot HTTP API. Shared by the MCP server
 * and the CLI so neither instantiates its own BotController (a second controller
 * could run a second trading loop). The Polybot UI/API server must be running.
 */
export class PolybotClient {
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;

  constructor(options: PolybotClientOptions = {}) {
    const base = options.baseUrl ?? process.env.POLYBOT_API_URL ?? DEFAULT_POLYBOT_API_URL;
    this.baseUrl = base.replace(/\/$/, "");
    this.fetchFn = options.fetchFn ?? fetch;
  }

  get apiUrl(): string {
    return this.baseUrl;
  }

  getStatus(): Promise<UiStatus> {
    return this.requestJson("GET", "/api/status");
  }

  listTrades(limit = 100): Promise<{ trades: TradeAttempt[] }> {
    return this.requestJson("GET", `/api/trades?limit=${encodeURIComponent(limit)}`);
  }

  getSettings(): Promise<UiSettings> {
    return this.requestJson("GET", "/api/settings");
  }

  updateSettings(patch: Partial<UiSettings>): Promise<UiSettings> {
    return this.requestJson("PATCH", "/api/settings", patch);
  }

  getStrategyAnalysis(): Promise<StrategyAnalysisResponse> {
    return this.requestJson("GET", "/api/analysis/strategies");
  }

  getRecommendations(): Promise<AiRecommendationsResponse> {
    return this.requestJson("GET", "/api/analysis/recommendations");
  }

  estimateSetup(params: SetupEvParams): Promise<SetupEvResult> {
    const query = new URLSearchParams({
      market: params.market,
      outcome: params.outcome,
      entryWindowSeconds: String(params.entryWindowSeconds),
      minDistanceUsd: String(params.minDistanceUsd),
      maxAskPrice: String(params.maxAskPrice),
    });
    if (params.capitalUsd !== undefined) {
      query.set("capitalUsd", String(params.capitalUsd));
    }
    return this.requestJson("GET", `/api/analysis/setup-ev?${query.toString()}`);
  }

  async exportSamples(): Promise<AnalysisExportResult> {
    const response = await this.send("GET", "/api/analysis/samples/export");
    const text = await response.text();
    if (!response.ok) {
      throw this.toError(response.status, text);
    }
    const disposition = response.headers.get("content-disposition") ?? "";
    const match = /filename="?([^"]+)"?/.exec(disposition);
    return { filename: match?.[1] ?? "polybot-analysis.jsonl", contents: text };
  }

  importSamples(contents: string): Promise<AnalysisImportResponse> {
    return this.requestJson("POST", "/api/analysis/samples/import", contents, "text/plain");
  }

  getTelegram(): Promise<TelegramNotificationSettings> {
    return this.requestJson("GET", "/api/notifications/telegram");
  }

  updateTelegram(patch: TelegramNotificationPatch): Promise<TelegramNotificationSettings> {
    return this.requestJson("PATCH", "/api/notifications/telegram", patch);
  }

  testTelegram(): Promise<TelegramNotificationTestResponse> {
    return this.requestJson("POST", "/api/notifications/telegram/test");
  }

  analyzeOllama(prompt: string): Promise<OllamaTradeAnalysisResponse> {
    return this.requestJson("POST", "/api/analysis/ollama", { prompt });
  }

  startBot(mode: Mode, confirmLive = false): Promise<UiStatus> {
    return this.requestJson("POST", "/api/bot/start", { mode, confirmLive });
  }

  stopBot(): Promise<UiStatus> {
    return this.requestJson("POST", "/api/bot/stop");
  }

  resetState(): Promise<UiStatus> {
    return this.requestJson("POST", "/api/bot/reset");
  }

  resetPnl(mode: Mode): Promise<UiStatus> {
    return this.requestJson("POST", "/api/pnl/reset", { mode });
  }

  private async requestJson<T>(
    method: HttpMethod,
    path: string,
    body?: unknown,
    contentType = "application/json",
  ): Promise<T> {
    const response = await this.send(method, path, body, contentType);
    const text = await response.text();
    const data = text ? safeJsonParse(text) : undefined;
    if (!response.ok) {
      const message =
        isRecord(data) && typeof data.error === "string" ? data.error : `Polybot respondio HTTP ${response.status}.`;
      throw new PolybotApiError(message, response.status, isRecord(data) ? data.issues ?? data : text);
    }
    return data as T;
  }

  private async send(method: HttpMethod, path: string, body?: unknown, contentType = "application/json"): Promise<Response> {
    const url = `${this.baseUrl}${path}`;
    const init: RequestInit = { method };
    if (body !== undefined) {
      init.headers = { "Content-Type": contentType };
      init.body = contentType === "application/json" ? JSON.stringify(body) : String(body);
    }
    try {
      return await this.fetchFn(url, init);
    } catch (error) {
      throw new PolybotApiError(
        `No se pudo conectar con Polybot en ${this.baseUrl}. Inicia el servidor (INICIAR-POLYBOT.cmd o "npm run ui") e intenta de nuevo.`,
        undefined,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private toError(status: number, text: string): PolybotApiError {
    const data = text ? safeJsonParse(text) : undefined;
    const message =
      isRecord(data) && typeof data.error === "string" ? data.error : `Polybot respondio HTTP ${status}.`;
    return new PolybotApiError(message, status, isRecord(data) ? data : text);
  }
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

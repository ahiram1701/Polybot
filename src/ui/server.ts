import express, { type Express, type Request, type Response } from "express";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { z } from "zod";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";

import { PolybotClient } from "../agent/client.js";
import { createPolybotMcpServer } from "../mcp/server.js";
import { ControllerError, type BotController } from "./controller.js";
import { patchSettingsSchema } from "./settings.js";
import type { StartBotRequest, UiEvent, UiSettings } from "./shared.js";

const ANALYSIS_IMPORT_LIMIT = "512mb";

/**
 * Umbral de "el feed esta muerto". Holgado a proposito: entrega ~1 tick/s, asi que dos minutos sin
 * nada no es un hipo de red — y reiniciar por un hipo cuesta el estado en memoria.
 */
const MAX_FEED_STALENESS_MS = 120_000;

/**
 * Bloqueo del bucle a partir del cual el proceso se considera enfermo.
 *
 * Holgado: una pausa de recoleccion de basura de medio segundo es normal, pero diez segundos
 * significa que el bot no ha visto el mercado en diez segundos, y un arbitraje dura menos que eso.
 */
const MAX_LOOP_BLOCK_MS = 10_000;

const startRequestSchema = z.object({
  mode: z.enum(["sim", "live"]),
  confirmLive: z.boolean().optional(),
});
const pnlResetRequestSchema = z.object({
  mode: z.enum(["sim", "live"]),
});
const ollamaAnalysisRequestSchema = z.object({
  prompt: z.string().trim().min(1),
});
const setupEvQuerySchema = z.object({
  market: z.enum(["BTC", "ETH", "DOGE"]),
  outcome: z.enum(["UP", "DOWN"]),
  entryWindowSeconds: z.coerce.number().positive(),
  minDistanceUsd: z.coerce.number().positive(),
  maxAskPrice: z.coerce.number().gt(0).lte(1),
  capitalUsd: z.coerce.number().positive().optional(),
});
const telegramNotificationsPatchSchema = z.object({
  enabled: z.boolean().optional(),
  botToken: z.string().optional(),
  chatId: z.string().optional(),
  publicUrl: z.union([z.string().url(), z.literal("")]).optional(),
  // Faltaban aqui, asi que la UI podia mandarlos pero el endpoint los descartaba en silencio.
  digestEnabled: z.boolean().optional(),
  digestIntervalMinutes: z.coerce.number().int().min(5).optional(),
  dailyReportEnabled: z.boolean().optional(),
  dailyReportHour: z.coerce.number().int().min(0).max(23).optional(),
});
const fiscalYearQuerySchema = z.object({
  year: z.coerce.number().int().min(2020).max(2100).optional(),
});
const fiscalFxPatchSchema = z.object({
  banxicoToken: z.string().optional(),
  manualRates: z.record(z.string(), z.union([z.number().positive(), z.null()])).optional(),
  year: z.coerce.number().int().min(2020).max(2100).optional(),
});

export interface UiAppOptions {
  staticClient?: boolean;
}

export function createUiApp(controller: BotController, options: UiAppOptions = {}): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json());

  /**
   * Sonda de vida. Responde SIN tocar la red: solo dice si el proceso esta vivo y atendiendo.
   *
   * `/api/status` no vale para esto: cotiza mercados en vivo (gamma + 2 getQuote por mercado), asi
   * que cuando la red va lenta tarda mas de 5s. El watchdog lo interpretaba como "UI caida" y mataba
   * un bot perfectamente sano — 4 reinicios en 2 horas, cada uno perdiendo el estado en memoria y
   * volviendo a leer las 20.000 muestras en frio.
   *
   * Una sonda de vida debe comprobar que el proceso responde, no que las APIs de terceros van rapidas.
   */
  /**
   * Salud REAL, no "el proceso contesta".
   *
   * Este endpoint lo sondea el watchdog externo (`scripts/watchdog.ps1`), que reinicia el proceso
   * cuando falla. El 2026-08-08 el feed se quedo congelado SIETE HORAS tras un corte de red y el
   * watchdog no movio un dedo, porque aqui solo se comprobaba que el servidor respondia: un bot
   * completamente ciego devolvia 200. Reiniciar era justo la cura, y la unica razon de que no
   * ocurriera es que la salud mentia.
   *
   * Un bot que no ve el mercado no esta sano aunque conteste.
   */
  app.get("/api/health", (_req, res) => {
    const feedStalenessMs = controller.feedStalenessMs?.();
    // Un bucle congelado deja al bot igual de ciego que un feed mudo, pero no se notaba: las
    // iteraciones bloqueadas acaban BIEN, solo tarde, asi que no contaban como fallidas y la salud
    // las daba por sanas. Medido: 7,85 segundos de bloqueo por cada arranque.
    const loopBlockedMs = controller.loopBlockedMs?.();
    // `undefined` = aun no ha llegado ningun tick. No se marca enfermo: recien arrancado es lo normal,
    // y reiniciar un proceso que acaba de arrancar solo encadena reinicios.
    const feedOk = feedStalenessMs === undefined || feedStalenessMs <= MAX_FEED_STALENESS_MS;
    const loopOk = loopBlockedMs === undefined || loopBlockedMs <= MAX_LOOP_BLOCK_MS;
    const feedOkYLoopOk = feedOk && loopOk;
    res.status(feedOkYLoopOk ? 200 : 503).json({
      ok: feedOkYLoopOk,
      loopBlockedMs,
      uptimeSeconds: Math.round(process.uptime()),
      rssMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      feedStalenessMs,
      ...(feedOk ? {} : { reason: "price_feed_stale" }),
      ...(loopOk ? {} : { reason: "event_loop_blocked" }),
    });
  });

  app.get("/api/status", asyncHandler(async (_req, res) => {
    res.json(await controller.getStatus());
  }));

  app.get("/api/trades", asyncHandler(async (req, res) => {
    const limit = Math.max(1, Math.min(500, Number(req.query.limit ?? 100)));
    res.json({ trades: await controller.getTrades(limit) });
  }));

  app.get("/api/settings", asyncHandler(async (_req, res) => {
    res.json(await controller.getSettings());
  }));

  app.get("/api/analysis/strategies", asyncHandler(async (_req, res) => {
    res.json(await controller.getStrategyAnalysis());
  }));

  app.get("/api/analysis/recommendations", asyncHandler(async (_req, res) => {
    res.json(await controller.getAiRecommendations());
  }));

  app.get("/api/analysis/setup-ev", asyncHandler(async (req, res) => {
    res.json(await controller.estimateSetupEv(setupEvQuerySchema.parse(req.query)));
  }));

  app.get("/api/analysis/arb-opportunities", asyncHandler(async (_req, res) => {
    res.json(await controller.getArbOpportunities());
  }));

  app.get("/api/analysis/ask-bands", asyncHandler(async (req, res) => {
    const mode = req.query.mode === "sim" ? "sim" : "live";
    res.json(await controller.getAskBandSummary(mode));
  }));

  app.get("/api/analysis/samples/export", asyncHandler(async (_req, res) => {
    const exported = await controller.exportAnalysisSamples();
    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${exported.filename}"`);
    res.send(exported.contents);
  }));

  app.post(
    "/api/analysis/samples/import",
    express.text({ type: ["text/plain", "application/x-ndjson", "application/jsonl"], limit: ANALYSIS_IMPORT_LIMIT }),
    asyncHandler(async (req, res) => {
      res.json(await controller.importAnalysisSamples(typeof req.body === "string" ? req.body : ""));
    }),
  );

  app.get("/api/fiscal/summary", asyncHandler(async (req, res) => {
    const { year } = fiscalYearQuerySchema.parse(req.query);
    res.json(await controller.getFiscalSummary(year));
  }));

  app.get("/api/fiscal/export", asyncHandler(async (req, res) => {
    const { year } = fiscalYearQuerySchema.parse(req.query);
    const exported = await controller.exportFiscalCsv(year);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${exported.filename}"`);
    res.send(exported.contents);
  }));

  app.post("/api/fiscal/fx", asyncHandler(async (req, res) => {
    res.json(await controller.updateFiscalFxConfig(fiscalFxPatchSchema.parse(req.body ?? {})));
  }));

  app.get("/api/notifications/telegram", asyncHandler(async (_req, res) => {
    res.json(await controller.getTelegramNotifications());
  }));

  app.patch("/api/notifications/telegram", asyncHandler(async (req, res) => {
    const patch = telegramNotificationsPatchSchema.parse(req.body ?? {});
    res.json(await controller.patchTelegramNotifications(patch));
  }));

  app.post("/api/notifications/telegram/test", asyncHandler(async (_req, res) => {
    res.json(await controller.testTelegramNotifications());
  }));

  app.post("/api/analysis/ollama", asyncHandler(async (req, res) => {
    const body = ollamaAnalysisRequestSchema.parse(req.body ?? {});
    res.json(await controller.analyzeTradesWithOllama(body.prompt));
  }));

  app.patch("/api/settings", asyncHandler(async (req, res) => {
    const parsed = patchSettingsSchema.parse(req.body);
    // Zod applies `.default()` even under `.partial()`, so `parsed` contains every defaulted field
    // (maxConsecutiveLosses, evSafetyMargin, ...) even when the client didn't send it — which would
    // silently clobber those settings back to their defaults. Keep only the keys actually sent.
    const sentKeys = new Set(Object.keys(req.body && typeof req.body === "object" ? req.body : {}));
    const patch = Object.fromEntries(
      Object.entries(parsed).filter(([key]) => sentKeys.has(key)),
    ) as Partial<UiSettings>;
    res.json(await controller.patchSettings(patch));
  }));

  app.post("/api/bot/start", asyncHandler(async (req, res) => {
    const body = startRequestSchema.parse(req.body) satisfies StartBotRequest;
    res.json(await controller.start(body.mode, Boolean(body.confirmLive)));
  }));

  app.post("/api/bot/stop", asyncHandler(async (_req, res) => {
    res.json(await controller.stop());
  }));

  app.post("/api/bot/reset", asyncHandler(async (_req, res) => {
    res.json(await controller.reset());
  }));

  app.post("/api/pnl/reset", asyncHandler(async (req, res) => {
    const body = pnlResetRequestSchema.parse(req.body ?? {});
    res.json(await controller.resetPnl(body.mode));
  }));

  app.post("/api/risk/reset", asyncHandler(async (req, res) => {
    const body = pnlResetRequestSchema.parse(req.body ?? {});
    res.json(await controller.resetRiskHalt(body.mode));
  }));

  app.get("/api/events", (req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });
    res.write("\n");

    const send = (event: UiEvent) => {
      res.write(`event: ${event.type}\n`);
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    const unsubscribe = controller.onEvent(send);
    let statusInFlight = false;
    const statusTimer = setInterval(() => {
      if (statusInFlight) {
        return;
      }
      statusInFlight = true;
      controller.getStatus()
        .then((status) => send({ type: "status", status }))
        .catch((error) => send({
          type: "log",
          log: {
            at: new Date().toISOString(),
            level: "warn",
            message: "UI status refresh failed.",
            meta: { error: error instanceof Error ? error.message : String(error) },
          },
        }))
        .finally(() => {
          statusInFlight = false;
        });
    }, 1_000);

    req.on("close", () => {
      clearInterval(statusTimer);
      unsubscribe();
    });
  });

  // Streamable HTTP MCP endpoint (stateful, per-session): lets MCP clients that register a URL
  // connector (e.g. Claude Cowork/Desktop) control Polybot via the same tools as the stdio server.
  // Reachable wherever the UI is served (localhost by default; also over Tailscale if POLYBOT_UI_HOST
  // is opened up). Clients call POST /mcp with `initialize`, get an Mcp-Session-Id, then reuse it.
  const mcpAllowWrite = (process.env.POLYBOT_MCP_ALLOW_WRITE ?? "true").toLowerCase() !== "false";
  const mcpAllowLive = (process.env.POLYBOT_MCP_ALLOW_LIVE ?? "true").toLowerCase() !== "false";
  const mcpTransports = new Map<string, StreamableHTTPServerTransport>();

  app.post("/mcp", asyncHandler(async (req, res) => {
    const sessionId = req.header("mcp-session-id");
    const existing = sessionId ? mcpTransports.get(sessionId) : undefined;
    if (existing) {
      await existing.handleRequest(req, res, req.body);
      return;
    }
    if (!isInitializeRequest(req.body)) {
      res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "No session. Send an 'initialize' request first (Streamable HTTP)." },
        id: null,
      });
      return;
    }
    // New session: loopback client into this same server so the MCP tools reuse the HTTP control plane.
    const selfUrl = `http://${req.headers.host ?? "127.0.0.1:8787"}`;
    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableJsonResponse: true,
      onsessioninitialized: (id) => {
        mcpTransports.set(id, transport);
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) {
        mcpTransports.delete(transport.sessionId);
      }
    };
    const mcpServer = createPolybotMcpServer(new PolybotClient({ baseUrl: selfUrl }), {
      allowWrite: mcpAllowWrite,
      allowLive: mcpAllowLive,
    });
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res, req.body);
  }));

  // GET (server->client SSE stream) and DELETE (end session) reuse the session's transport.
  const mcpSessionRequest = asyncHandler(async (req: Request, res: Response) => {
    const sessionId = req.header("mcp-session-id");
    const transport = sessionId ? mcpTransports.get(sessionId) : undefined;
    if (!transport) {
      res.status(400).json({ error: "Unknown or missing Mcp-Session-Id." });
      return;
    }
    await transport.handleRequest(req, res);
  });
  app.get("/mcp", mcpSessionRequest);
  app.delete("/mcp", mcpSessionRequest);

  if (options.staticClient) {
    const clientDir = resolve(process.cwd(), "dist/client");
    app.use(express.static(clientDir));
    app.get("*splat", (_req, res) => res.sendFile(join(clientDir, "index.html")));
  }

  app.use((error: unknown, _req: Request, res: Response, _next: unknown) => {
    if (error instanceof ControllerError) {
      res.status(error.statusCode).json({ error: error.message });
      return;
    }
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: "Invalid request.", issues: error.issues });
      return;
    }
    if (isEntityTooLargeError(error)) {
      res.status(413).json({ error: `Analysis import file is too large. Maximum size is ${ANALYSIS_IMPORT_LIMIT}.` });
      return;
    }
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  });

  return app;
}

function isEntityTooLargeError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  return (
    "type" in error &&
    (error as { type?: unknown }).type === "entity.too.large"
  );
}

function asyncHandler(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: (error?: unknown) => void) => {
    handler(req, res).catch(next);
  };
}

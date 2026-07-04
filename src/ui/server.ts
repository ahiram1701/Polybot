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
});

export interface UiAppOptions {
  staticClient?: boolean;
}

export function createUiApp(controller: BotController, options: UiAppOptions = {}): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json());

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

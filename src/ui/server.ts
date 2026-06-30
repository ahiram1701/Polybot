import express, { type Express, type Request, type Response } from "express";
import { join, resolve } from "node:path";
import { z } from "zod";

import { ControllerError, type BotController } from "./controller.js";
import { patchSettingsSchema } from "./settings.js";
import type { StartBotRequest, UiEvent } from "./shared.js";

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
    const patch = patchSettingsSchema.parse(req.body);
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

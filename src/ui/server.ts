import express, { type Express, type Request, type Response } from "express";
import { join, resolve } from "node:path";
import { z } from "zod";

import { SUPPORTED_MARKETS } from "../markets.js";
import { ControllerError, type BotController } from "./controller.js";
import { patchSettingsSchema } from "./settings.js";
import type { StartBotRequest, UiEvent } from "./shared.js";

const startRequestSchema = z.object({
  mode: z.enum(["sim", "live"]),
  confirmLive: z.boolean().optional(),
});
const recommendationRequestSchema = z.object({
  markets: z.array(z.enum(SUPPORTED_MARKETS)).optional(),
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

  app.get("/api/recommendations", asyncHandler(async (_req, res) => {
    res.json(await controller.getRecommendations());
  }));

  app.post("/api/recommendations/apply", asyncHandler(async (req, res) => {
    const body = recommendationRequestSchema.parse(req.body ?? {});
    res.json(await controller.applyRecommendations(body.markets));
  }));

  app.post("/api/recommendations/auto-apply", asyncHandler(async (req, res) => {
    const body = recommendationRequestSchema.parse(req.body ?? {});
    res.json(await controller.autoApplyRecommendations(body.markets));
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
    const statusTimer = setInterval(async () => {
      send({ type: "status", status: await controller.getStatus() });
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
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  });

  return app;
}

function asyncHandler(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: (error?: unknown) => void) => {
    handler(req, res).catch(next);
  };
}

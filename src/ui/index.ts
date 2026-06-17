import { loadConfig } from "../config.js";
import { logger } from "../logger.js";
import { createDynamicNotifier } from "../notifier.js";
import { BotController } from "./controller.js";
import { createUiApp } from "./server.js";

const HOST = process.env.POLYBOT_UI_HOST ?? "127.0.0.1";
const PORT = Number(process.env.POLYBOT_UI_PORT ?? 8788);

async function main(): Promise<void> {
  const staticClient = process.argv.includes("--static");
  const autoStartMode = getAutoStartMode(process.argv);
  const { config } = loadConfig(["--mode", "sim"]);
  const notifier = createDynamicNotifier(config);
  const controller = new BotController(config);
  const app = createUiApp(controller, { staticClient });

  if (!staticClient) {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  }

  const server = app.listen(PORT, HOST, () => {
    const url = config.publicUrl ?? `http://${HOST}:${PORT}`;
    logger.info("Polybot UI listening.", { url, host: HOST, port: PORT, staticClient });
    void notifier.notify({
      key: "ui-ready",
      title: "UI lista",
      body: `Polybot esta escuchando en ${url}. Live queda apagado hasta que lo inicies manualmente.`,
    });
    if (autoStartMode === "sim") {
      controller.start("sim").catch((error) => {
        logger.error("Auto-start failed.", {
          error: error instanceof Error ? error.message : String(error),
        });
        void notifier.notify({
          key: "ui-autostart-error",
          level: "error",
          title: "Autoarranque fallido",
          body: error instanceof Error ? error.message : String(error),
        });
      });
    }
  });

  const shutdown = () => {
    controller.dispose();
    server.close();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

function getAutoStartMode(argv: string[]): "sim" | undefined {
  return argv.includes("--auto-start=sim") || argv.includes("--autostart=sim") ? "sim" : undefined;
}

main().catch((error) => {
  logger.error("UI server crashed.", {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
});

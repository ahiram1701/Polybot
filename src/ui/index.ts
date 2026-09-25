import { loadConfig } from "../config.js";
import { installHttpKeepAlive } from "../httpAgent.js";
import { installNoisyConsoleAggregator } from "../noisyConsole.js";
import { logger } from "../logger.js";
import { iniciarLatido } from "../latido.js";
import { createDynamicNotifier } from "../notifier.js";
import { BotController } from "./controller.js";
import { createUiApp } from "./server.js";

const HOST = process.env.POLYBOT_UI_HOST ?? "127.0.0.1";
const PORT = Number(process.env.POLYBOT_UI_PORT ?? 8787);

// Antes de cualquier peticion: reutilizar conexiones evita reabrir (y reresolver) en cada llamada.
installHttpKeepAlive();
// Antes de que nada pueda empezar a gritar: el SDK del CLOB llego a escribir 250.000 lineas en 30
// minutos durante un corte de red, y eso llena disco y come CPU justo cuando peor esta el proceso.
installNoisyConsoleAggregator();

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

  // 2026-07-15: el proceso murió con 6.4GB (OOM del sistema, evento 2004). Una línea de memoria cada
  // 5 min en el log permite ver la pendiente de crecimiento y cazar al retenedor si vuelve a pasar.
  const memoryLogTimer = setInterval(() => {
    const usage = process.memoryUsage();
    const mb = (bytes: number) => Math.round(bytes / 1_048_576);
    logger.info("Uso de memoria del proceso.", {
      rssMb: mb(usage.rss),
      heapUsedMb: mb(usage.heapUsed),
      heapTotalMb: mb(usage.heapTotal),
      externalMb: mb(usage.external),
    });
  }, 5 * 60_000);
  memoryLogTimer.unref();

  // El latido: una marca de tiempo en un fichero que el vigilante de Windows puede leer sin tocar la
  // red ni invocar `wsl.exe`. Ver `src/latido.ts` para las dos averias que lo hicieron necesario.
  iniciarLatido({ path: process.env.POLYBOT_HEARTBEAT_PATH });

  const server = app.listen(PORT, HOST, async () => {
    const url = config.publicUrl ?? `http://${HOST}:${PORT}`;
    logger.info("Polybot UI listening.", { url, host: HOST, port: PORT, staticClient });
    void notifier.notify({
      key: "ui-ready",
      title: "UI lista",
      body: `Polybot esta escuchando en ${url}. Live queda apagado hasta que lo inicies manualmente.`,
    });
    // El flag de linea de comandos O el ajuste persistido. Solo "sim" por diseño: live siempre lo
    // arranca el usuario, asi que un reinicio automatico nunca puede acabar moviendo dinero real.
    const autoStartFromSettings = (await controller.getSettings()).autoStartSimOnBoot === true;
    if (autoStartMode === "sim" || autoStartFromSettings) {
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

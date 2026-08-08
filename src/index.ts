import { BotRunner } from "./botRunner.js";
import { loadConfig, usage } from "./config.js";
import { installHttpKeepAlive } from "./httpAgent.js";
import { installNoisyConsoleAggregator } from "./noisyConsole.js";
import { logger } from "./logger.js";

// Antes de cualquier peticion: reutilizar conexiones evita reabrir (y reresolver) en cada llamada.
installHttpKeepAlive();
// Antes de que nada pueda empezar a gritar: el SDK del CLOB llego a escribir 250.000 lineas en 30
// minutos durante un corte de red, y eso llena disco y come CPU justo cuando peor esta el proceso.
installNoisyConsoleAggregator();

async function main(): Promise<void> {
  const { config, cli } = loadConfig();
  if (cli.help) {
    console.log(usage());
    return;
  }

  const runner = BotRunner.create(config);
  process.once("SIGINT", () => {
    logger.info("SIGINT received; stopping bot.");
    runner.stop();
  });
  process.once("SIGTERM", () => {
    logger.info("SIGTERM received; stopping bot.");
    runner.stop();
  });

  await runner.start({ once: cli.once });
}

main().catch((error) => {
  logger.error("Bot crashed.", {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
});

import { BotRunner } from "./botRunner.js";
import { loadConfig, usage } from "./config.js";
import { installHttpKeepAlive } from "./httpAgent.js";
import { logger } from "./logger.js";

// Antes de cualquier peticion: reutilizar conexiones evita reabrir (y reresolver) en cada llamada.
installHttpKeepAlive();

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

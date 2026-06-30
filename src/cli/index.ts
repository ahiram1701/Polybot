#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { PolybotApiError, PolybotClient } from "../agent/client.js";
import type { UiSettings } from "../ui/shared.js";

interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(args: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const eq = key.indexOf("=");
    if (eq >= 0) {
      flags[key.slice(0, eq)] = key.slice(eq + 1);
      continue;
    }
    const next = args[index + 1];
    if (next === undefined || next.startsWith("--")) {
      flags[key] = true;
    } else {
      flags[key] = next;
      index += 1;
    }
  }
  return { positionals, flags };
}

function emit(data: unknown, pretty: boolean): void {
  process.stdout.write(`${JSON.stringify(data, null, pretty ? 2 : 0)}\n`);
}

function strFlag(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numFlag(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") {
    throw new Error("Falta --json '{...}'.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("--json debe ser JSON valido.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("--json debe ser un objeto JSON.");
  }
  return parsed as Record<string, unknown>;
}

function requireMode(value: unknown): "sim" | "live" {
  if (value === "sim" || value === "live") {
    return value;
  }
  throw new Error("Requiere --mode sim|live.");
}

const HELP = `Polybot CLI — controla Polybot via la API local (JSON por stdout).

Requiere el servidor corriendo (INICIAR-POLYBOT.cmd o "npm run ui").
Base URL: $POLYBOT_API_URL o http://127.0.0.1:8787 (override con --url).

Comandos:
  status                              Estado completo (running, markets, pnl, signal...)
  trades [--limit N]                  Trades recientes (default 100, max 500)
  settings get                        Settings actuales
  settings set --json '{...}'         Aplica settings (el bot debe estar detenido)
  analysis strategies                 EV historico por estrategia
  analysis recommend                  Recomendaciones del modelo predictivo
  analysis export [--out <file>]      Exporta muestras .jsonl a un archivo
  analysis import --in <file>         Importa muestras .jsonl
  start --mode sim|live [--confirm-live]   Arranca el bot (live mueve dinero real)
  stop                                Detiene el bot
  reset                               Limpia estado/trades (conserva settings)
  pnl-reset --mode sim|live           Resetea P&L de un modo
  telegram get | telegram test        Config de Telegram / envia prueba
  ollama --prompt "..."               Analisis LLM (requiere OLLAMA_API_KEY)

Flags globales: --pretty (JSON indentado), --url <baseUrl>, --help
Los errores se imprimen como {"error":...} por stderr con exit code 1.`;

async function run(): Promise<void> {
  const { positionals, flags } = parseArgs(process.argv.slice(2));
  const pretty = Boolean(flags.pretty);
  const [command, sub] = positionals;

  if (!command || command === "help" || flags.help) {
    process.stdout.write(`${HELP}\n`);
    return;
  }

  const client = new PolybotClient({ baseUrl: strFlag(flags.url) });

  switch (command) {
    case "status":
      return emit(await client.getStatus(), pretty);
    case "trades":
      return emit(await client.listTrades(numFlag(flags.limit, 100)), pretty);
    case "settings": {
      if (sub === "get") {
        return emit(await client.getSettings(), pretty);
      }
      if (sub === "set") {
        const patch = parseJsonObject(flags.json) as Partial<UiSettings>;
        return emit(await client.updateSettings(patch), pretty);
      }
      throw new Error("Uso: settings get | settings set --json '{...}'");
    }
    case "analysis": {
      if (sub === "strategies") {
        return emit(await client.getStrategyAnalysis(), pretty);
      }
      if (sub === "recommend" || sub === "recommendations") {
        return emit(await client.getRecommendations(), pretty);
      }
      if (sub === "export") {
        const result = await client.exportSamples();
        const target = resolve(strFlag(flags.out) ?? result.filename);
        await writeFile(target, result.contents, "utf8");
        return emit({ filename: result.filename, savedTo: target, bytes: Buffer.byteLength(result.contents) }, pretty);
      }
      if (sub === "import") {
        const inFile = strFlag(flags.in);
        if (!inFile) {
          throw new Error("analysis import requiere --in <archivo>.");
        }
        const contents = await readFile(resolve(inFile), "utf8");
        return emit(await client.importSamples(contents), pretty);
      }
      throw new Error("Uso: analysis strategies | recommend | export [--out <file>] | import --in <file>");
    }
    case "start":
      return emit(await client.startBot(requireMode(flags.mode), Boolean(flags["confirm-live"])), pretty);
    case "stop":
      return emit(await client.stopBot(), pretty);
    case "reset":
      return emit(await client.resetState(), pretty);
    case "pnl-reset":
      return emit(await client.resetPnl(requireMode(flags.mode)), pretty);
    case "telegram": {
      if (sub === "get") {
        return emit(await client.getTelegram(), pretty);
      }
      if (sub === "test") {
        return emit(await client.testTelegram(), pretty);
      }
      throw new Error("Uso: telegram get | telegram test");
    }
    case "ollama": {
      const prompt = strFlag(flags.prompt);
      if (!prompt) {
        throw new Error('ollama requiere --prompt "...".');
      }
      return emit(await client.analyzeOllama(prompt), pretty);
    }
    default:
      throw new Error(`Comando desconocido: ${command}. Usa "help".`);
  }
}

run().catch((error) => {
  const payload =
    error instanceof PolybotApiError
      ? { error: error.message, status: error.status, details: error.details }
      : { error: error instanceof Error ? error.message : String(error) };
  process.stderr.write(`${JSON.stringify(payload)}\n`);
  process.exitCode = 1;
});

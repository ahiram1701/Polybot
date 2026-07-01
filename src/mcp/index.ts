import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { PolybotApiError, PolybotClient } from "../agent/client.js";
import { summarizeStatus } from "../agent/statusSummary.js";
import type { UiSettings } from "../ui/shared.js";

const ALLOW_WRITE = (process.env.POLYBOT_MCP_ALLOW_WRITE ?? "true").toLowerCase() !== "false";
const ALLOW_LIVE = (process.env.POLYBOT_MCP_ALLOW_LIVE ?? "true").toLowerCase() !== "false";

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

function ok(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function fail(error: unknown): ToolResult {
  const payload =
    error instanceof PolybotApiError
      ? { error: error.message, status: error.status, details: error.details }
      : { error: error instanceof Error ? error.message : String(error) };
  return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], isError: true };
}

async function guard(run: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return ok(await run());
  } catch (error) {
    return fail(error);
  }
}

const client = new PolybotClient();
const server = new McpServer({ name: "polybot", version: "0.1.0" });

// ---- Read-only tools (always available) ----

server.registerTool(
  "polybot_get_status",
  {
    description:
      "Estado COMPACTO de Polybot para agentes (read-only): running/modo, senal por mercado, P&L por modo, gasto diario " +
      "y un resumen de razones de skip recientes (por que no opera). Pasa verbose:true para el status crudo completo (~150KB).",
    inputSchema: {
      verbose: z.boolean().optional().describe("true = status crudo completo (grande). Por defecto compacto."),
    },
  },
  async ({ verbose }) =>
    guard(async () => {
      const status = await client.getStatus();
      return verbose ? status : summarizeStatus(status);
    }),
);

server.registerTool(
  "polybot_get_logs",
  {
    description:
      "Logs recientes del bot (mas nuevos primero), opcionalmente filtrados por nivel o meta.reason. Read-only. " +
      "El status compacto ya trae un resumen de skips; usa esto solo si necesitas el detalle crudo.",
    inputSchema: {
      limit: z.number().int().positive().max(300).optional(),
      level: z.string().optional().describe("Filtra por nivel (info/warn/error)."),
      reason: z.string().optional().describe("Filtra por meta.reason (p. ej. no_ask_liquidity_under_cap)."),
    },
  },
  async ({ limit, level, reason }) =>
    guard(async () => {
      const status = await client.getStatus();
      let logs = status.logs ?? [];
      if (level) {
        logs = logs.filter((entry) => entry.level === level);
      }
      if (reason) {
        logs = logs.filter(
          (entry) =>
            entry.meta !== null &&
            typeof entry.meta === "object" &&
            (entry.meta as { reason?: unknown }).reason === reason,
        );
      }
      return { logs: logs.slice(0, limit ?? 40) };
    }),
);

server.registerTool(
  "polybot_estimate_setup",
  {
    description:
      "EV historico AGREGADO de un setup (mercado/lado/ventana/distancia/cap): winCount, tradeCount, winRate, evRoi, edge. " +
      "Read-only, no opera. Util para que el agente razone o tunee la estrategia. Distancia en USD, ventana en segundos.",
    inputSchema: {
      market: z.enum(["BTC", "ETH", "DOGE"]),
      outcome: z.enum(["UP", "DOWN"]),
      entryWindowSeconds: z.number().positive(),
      minDistanceUsd: z.number().positive(),
      maxAskPrice: z.number().gt(0).lte(1),
      capitalUsd: z.number().positive().optional().describe("Capital por trade (default 10)."),
    },
  },
  async (params) => guard(() => client.estimateSetup(params)),
);

server.registerTool(
  "polybot_list_trades",
  {
    description: "Lista los trades recientes (sim y live) mas nuevos primero.",
    inputSchema: { limit: z.number().int().positive().max(500).optional() },
  },
  async ({ limit }) => guard(() => client.listTrades(limit ?? 100)),
);

server.registerTool(
  "polybot_get_settings",
  { description: "Settings actuales del bot (distancias, ventanas, montos, mercados habilitados, autoajuste, etc.)." },
  async () => guard(() => client.getSettings()),
);

server.registerTool(
  "polybot_get_strategy_analysis",
  { description: "EV historico por estrategia (mercado/lado/ventana/distancia) calculado sobre las muestras de Analisis." },
  async () => guard(() => client.getStrategyAnalysis()),
);

server.registerTool(
  "polybot_get_recommendations",
  { description: "Recomendaciones del modelo predictivo (walk-forward + k-NN) por mercado, con confianza y si son auto-aplicables." },
  async () => guard(() => client.getRecommendations()),
);

server.registerTool(
  "polybot_get_telegram",
  { description: "Configuracion actual de notificaciones de Telegram (sin exponer el token)." },
  async () => guard(() => client.getTelegram()),
);

server.registerTool(
  "polybot_export_analysis_samples",
  {
    description: "Exporta las muestras de Analisis (.jsonl) a un archivo en disco y devuelve la ruta y el tamano (no vuelca el contenido).",
    inputSchema: { path: z.string().optional().describe("Ruta de salida; por defecto el nombre sugerido en el directorio actual.") },
  },
  async ({ path }) =>
    guard(async () => {
      const result = await client.exportSamples();
      const target = resolve(path ?? result.filename);
      await writeFile(target, result.contents, "utf8");
      return { filename: result.filename, savedTo: target, bytes: Buffer.byteLength(result.contents) };
    }),
);

// ---- Write / control tools (gated by POLYBOT_MCP_ALLOW_WRITE) ----

if (ALLOW_WRITE) {
  server.registerTool(
    "polybot_update_settings",
    {
      description:
        "Aplica un patch de settings. IMPORTANTE: el bot debe estar DETENIDO (si esta corriendo responde 409). Pasa solo las claves a cambiar.",
      inputSchema: { settings: z.record(z.string(), z.any()).describe("Objeto parcial de settings, p. ej. {\"minBtcDistanceUsd\": 15}.") },
    },
    async ({ settings }) => guard(() => client.updateSettings(settings as Partial<UiSettings>)),
  );

  server.registerTool(
    "polybot_import_analysis_samples",
    {
      description: "Importa muestras de Analisis (.jsonl) desde un archivo. El bot debe estar detenido.",
      inputSchema: { path: z.string().describe("Ruta del archivo .jsonl a importar.") },
    },
    async ({ path }) =>
      guard(async () => {
        const contents = await readFile(resolve(path), "utf8");
        return client.importSamples(contents);
      }),
  );

  server.registerTool(
    "polybot_update_telegram",
    {
      description: "Actualiza la configuracion de Telegram (enabled, botToken, chatId, publicUrl).",
      inputSchema: {
        enabled: z.boolean().optional(),
        botToken: z.string().optional(),
        chatId: z.string().optional(),
        publicUrl: z.string().optional(),
      },
    },
    async (patch) => guard(() => client.updateTelegram(patch)),
  );

  server.registerTool(
    "polybot_test_telegram",
    { description: "Envia un mensaje de prueba por Telegram (requiere Telegram configurado y habilitado)." },
    async () => guard(() => client.testTelegram()),
  );

  server.registerTool(
    "polybot_analyze_with_ollama",
    {
      description: "Pide un analisis LLM a Ollama Cloud sobre el contexto agregado (requiere OLLAMA_API_KEY). Solo devuelve texto, no cambia nada.",
      inputSchema: { prompt: z.string().min(1) },
    },
    async ({ prompt }) => guard(() => client.analyzeOllama(prompt)),
  );

  server.registerTool(
    "polybot_start_bot",
    {
      description:
        "Arranca el bot. mode='sim' es seguro (paper). mode='live' MUEVE DINERO REAL y requiere confirmLive=true mas llaves configuradas en .env.",
      inputSchema: {
        mode: z.enum(["sim", "live"]),
        confirmLive: z.boolean().optional().describe("Obligatorio true para mode='live'."),
      },
    },
    async ({ mode, confirmLive }) => {
      if (mode === "live" && !ALLOW_LIVE) {
        return fail(new Error("Modo live deshabilitado para MCP (POLYBOT_MCP_ALLOW_LIVE=false)."));
      }
      if (mode === "live" && !confirmLive) {
        return fail(new Error("Modo live requiere confirmLive=true (mueve dinero real)."));
      }
      return guard(() => client.startBot(mode, Boolean(confirmLive)));
    },
  );

  server.registerTool(
    "polybot_stop_bot",
    { description: "Detiene el bot." },
    async () => guard(() => client.stopBot()),
  );

  server.registerTool(
    "polybot_reset_state",
    { description: "Limpia estado y trades (conserva settings y .env). Detiene el bot si corre." },
    async () => guard(() => client.resetState()),
  );

  server.registerTool(
    "polybot_reset_pnl",
    {
      description: "Resetea el P&L mostrado de un modo sin borrar trades.",
      inputSchema: { mode: z.enum(["sim", "live"]) },
    },
    async ({ mode }) => guard(() => client.resetPnl(mode)),
  );
}

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Nota: no escribir en stdout; stdout es el canal del protocolo MCP.
  process.stderr.write(
    `Polybot MCP listo. API=${client.apiUrl} write=${ALLOW_WRITE} live=${ALLOW_LIVE}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`Polybot MCP fallo al iniciar: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

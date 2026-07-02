# Operar Polybot desde un agente IA

Polybot es un bot de trading de Polymarket (mercados cripto Up/Down 5m). Este documento explica cómo un agente IA lo controla de forma segura. Hay tres vías equivalentes sobre el **mismo plano de control** (la API HTTP local): **MCP**, **CLI** y **HTTP directo**.

## ⚠️ Seguridad primero

- **`mode: "live"` mueve dinero real.** Requiere `confirmLive: true` y llaves en `.env` (`POLYMARKET_PRIVATE_KEY`, `POLYMARKET_SIGNATURE_TYPE`, `POLYMARKET_FUNDER_ADDRESS`). `mode: "sim"` es paper-trading, seguro.
- **Un solo runner.** No levantes un segundo proceso que tradee; controla siempre el servidor en marcha. MCP y CLI son clientes de ese servidor (no arrancan su propio bot).
- **Detén el bot antes de cambiar settings o importar muestras.** Con el bot corriendo, `PATCH /api/settings` y el import responden `409`.
- Acceso **local** (`127.0.0.1`), sin autenticación. No lo expongas a redes no confiables.

## Prerrequisito: el servidor debe estar corriendo

Arranca Polybot (doble clic en `INICIAR-POLYBOT.cmd`, o `npm run ui`, o `npm start`). Por defecto escucha en `http://127.0.0.1:8787`. Override con `POLYBOT_API_URL`.

Comprobación: `curl http://127.0.0.1:8787/api/status` → `200`.

## Vía 1 — MCP (recomendado para Claude y agentes nativos)

Hay **dos transportes** que exponen exactamente las mismas tools `polybot_`:

- **stdio** (comando local): `npm run mcp` (o `node dist/src/mcp/index.js` tras `npm run build`). Para clientes que registran un MCP por *comando* (Claude Desktop/Code con `.mcp.json`).
- **HTTP (Streamable) en `/mcp`**: ya montado dentro del servidor de Polybot. Cuando Polybot corre, el endpoint MCP vive en `http://127.0.0.1:8787/mcp` (misma URL que la UI/API). Para clientes que registran un MCP por *URL* (ej. **Claude Cowork** como connector). No arranca un proceso aparte; usa el servidor ya en marcha.

### Claude Cowork (connector por URL)

Con Polybot corriendo en la misma PC, registra un connector MCP apuntando a `http://127.0.0.1:8787/mcp` (Streamable HTTP, con sesión `Mcp-Session-Id`). Si abres Polybot a la red (`POLYBOT_UI_HOST=0.0.0.0`, p. ej. vía Tailscale), el endpoint queda accesible desde otro dispositivo en esa misma URL/host — **ojo: sin autenticación**, expón solo en redes de confianza.

**Automático:** al iniciar Polybot con `INICIAR-POLYBOT.cmd` / `ABRIR-POLYBOT.cmd`, se crea `.mcp.json` solo (desde `.mcp.json.example`) si no existe. Tu cliente MCP (Claude Code/Desktop) lo carga desde la raíz del proyecto. (Manual: copiar `.mcp.json.example` → `.mcp.json`.)

Config para un cliente MCP (ej. Claude Desktop / Claude Code):

```json
{
  "mcpServers": {
    "polybot": {
      "command": "npx",
      "args": ["tsx", "src/mcp/index.ts"],
      "cwd": "C:/DEV/Github/Polybot",
      "env": { "POLYBOT_API_URL": "http://127.0.0.1:8787" }
    }
  }
}
```

Tools expuestas (prefijo `polybot_`): `get_status`, `list_trades`, `get_settings`, `get_strategy_analysis`, `get_recommendations`, `get_telegram`, `export_analysis_samples`, `update_settings`, `import_analysis_samples`, `update_telegram`, `test_telegram`, `analyze_with_ollama`, `start_bot`, `stop_bot`, `reset_state`, `reset_pnl`.

Restricciones opcionales por entorno:
- `POLYBOT_MCP_ALLOW_WRITE=false` → solo herramientas de lectura.
- `POLYBOT_MCP_ALLOW_LIVE=false` → bloquea `start_bot` con `mode:"live"`.

## Vía 2 — CLI (salida JSON)

`npm run cli -- <comando>` (o `node dist/src/cli/index.js <comando>`). Devuelve JSON por stdout; errores como `{"error":...}` por stderr con exit code ≠ 0.

```bash
npm run cli -- status
npm run cli -- trades --limit 20
npm run cli -- settings get
npm run cli -- settings set --json '{"minBtcDistanceUsd": 15}'
npm run cli -- analysis recommend
npm run cli -- analysis export --out ./muestras.jsonl
npm run cli -- start --mode sim
npm run cli -- start --mode live --confirm-live
npm run cli -- stop
```

`npm run cli -- help` lista todo. Flags globales: `--pretty`, `--url <baseUrl>`.

**Comando global:** tras `npm run build` y `npm link`, la CLI queda disponible como `polybot` (ej. `polybot status`, `polybot start --mode sim`, `polybot analysis recommend`).

## Vía 3 — HTTP directo

Spec completo: [`docs/openapi.yaml`](docs/openapi.yaml).

```bash
curl http://127.0.0.1:8787/api/status
curl -X PATCH http://127.0.0.1:8787/api/settings -H 'Content-Type: application/json' -d '{"minBtcDistanceUsd":15}'
curl -X POST http://127.0.0.1:8787/api/bot/start -H 'Content-Type: application/json' -d '{"mode":"sim"}'
```

## Endpoints (referencia rápida)

| Método | Ruta | Propósito | Notas |
|---|---|---|---|
| GET | `/api/status` | Estado completo (running, mercados, signal, P&L) | — |
| GET | `/api/trades?limit=N` | Trades recientes | `limit` 1–500 |
| GET | `/api/settings` | Settings actuales | — |
| PATCH | `/api/settings` | Aplica patch de settings | **409** si el bot corre |
| GET | `/api/analysis/strategies` | EV histórico por estrategia | — |
| GET | `/api/analysis/recommendations` | Recomendaciones del modelo predictivo | — |
| GET | `/api/analysis/samples/export` | Exporta `.jsonl` | devuelve NDJSON |
| POST | `/api/analysis/samples/import` | Importa `.jsonl` (text/plain) | **409** si el bot corre; máx 512MB |
| GET/PATCH | `/api/notifications/telegram` | Config Telegram | token nunca se devuelve |
| POST | `/api/notifications/telegram/test` | Mensaje de prueba | — |
| POST | `/api/analysis/ollama` | Análisis LLM (Ollama Cloud) | requiere `OLLAMA_API_KEY`; solo texto |
| POST | `/api/bot/start` | Arranca bot `{mode, confirmLive}` | live = dinero real |
| POST | `/api/bot/stop` | Detiene bot | — |
| POST | `/api/bot/reset` | Limpia estado/trades | conserva settings |
| POST | `/api/pnl/reset` | Resetea P&L `{mode}` | — |
| GET | `/api/events` | Stream SSE (status + logs) | text/event-stream |
| POST/GET/DELETE | `/mcp` | Endpoint MCP (Streamable HTTP) para connectors por URL | sesión `Mcp-Session-Id`; mismas tools `polybot_` |

## Flujo recomendado para un agente

1. **Observar**: `get_status`, `list_trades`, `get_strategy_analysis`, `get_recommendations`.
2. **Analizar**: razona sobre EV/recomendaciones; opcional `analyze_with_ollama` para una segunda opinión en texto.
3. **Ajustar en sim**: `stop_bot` → `update_settings` → `start_bot(sim)`; verifica con `get_status`.
4. **Live (opcional, con cuidado)**: solo tras validar en sim, `start_bot(live, confirmLive=true)`.

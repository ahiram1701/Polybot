import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { PolybotClient } from "../agent/client.js";
import { createPolybotMcpServer } from "./server.js";

const ALLOW_WRITE = (process.env.POLYBOT_MCP_ALLOW_WRITE ?? "true").toLowerCase() !== "false";
const ALLOW_LIVE = (process.env.POLYBOT_MCP_ALLOW_LIVE ?? "true").toLowerCase() !== "false";

const client = new PolybotClient();
const server = createPolybotMcpServer(client, { allowWrite: ALLOW_WRITE, allowLive: ALLOW_LIVE });

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Nota: no escribir en stdout; stdout es el canal del protocolo MCP.
  process.stderr.write(
    `Polybot MCP listo (stdio). API=${client.apiUrl} write=${ALLOW_WRITE} live=${ALLOW_LIVE}\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`Polybot MCP fallo al iniciar: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

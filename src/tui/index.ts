// Entry point for the Polybot terminal UI. Normally it opens a full-screen interactive dashboard
// (raw mode, alternate screen); with `--once` it prints a single rendered snapshot and exits, which
// is both the headless-verification path and a handy "give me a glance" command. It never starts the
// server itself — the launcher (.cmd) does that — it only connects as a client.

import { PolybotClient } from "../agent/client.js";
import { summarizeStatus, summarizeStrategyAnalysis, summarizeTrade } from "../agent/statusSummary.js";
import { buildSettingsFields } from "./settingsModel.js";
import { renderBody, renderTabBar, renderTitleBar, TABS } from "./render.js";
import type { AnalysisData, Tab, ViewModel } from "./render.js";
import { startTui } from "./runtime.js";
import { setColorEnabled } from "./theme.js";

interface Cli {
  url?: string;
  once: boolean;
  tab: Tab;
  color?: boolean;
}

function parseArgs(argv: string[]): Cli {
  const cli: Cli = { once: false, tab: "dashboard" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--once") {
      cli.once = true;
    } else if (arg === "--no-color") {
      cli.color = false;
    } else if (arg === "--color") {
      cli.color = true;
    } else if (arg === "--url") {
      cli.url = argv[(i += 1)];
    } else if (arg.startsWith("--url=")) {
      cli.url = arg.slice("--url=".length);
    } else if (arg === "--tab") {
      cli.tab = normalizeTab(argv[(i += 1)]);
    } else if (arg.startsWith("--tab=")) {
      cli.tab = normalizeTab(arg.slice("--tab=".length));
    }
  }
  return cli;
}

function normalizeTab(value: string | undefined): Tab {
  const match = TABS.find((t) => t.id === value);
  return match ? match.id : "dashboard";
}

async function renderOnce(client: PolybotClient, tab: Tab): Promise<void> {
  const width = Math.min(process.stdout.columns || 100, 120);
  const height = process.stdout.rows || 40;

  let status: ViewModel["status"];
  let statusError: string | undefined;
  try {
    status = summarizeStatus(await client.getStatus());
  } catch (error) {
    statusError = error instanceof Error ? error.message : String(error);
  }

  let trades: ViewModel["trades"];
  let analysis: AnalysisData | undefined;
  let settingsFields: ViewModel["settingsFields"];
  // El dashboard los necesita igual que la pestaña de operaciones: sin ellos no puede repartir el P&L
  // por estrategia y la caja desaparece sin decir por qué.
  if (tab === "trades" || tab === "dashboard") {
    const { trades: raw } = await client.listTrades(tab === "trades" ? 50 : 200);
    trades = raw.map(summarizeTrade).sort((a, b) => b.createdAtMs - a.createdAtMs);
  } else if (tab === "analysis") {
    const summary = summarizeStrategyAnalysis(await client.getStrategyAnalysis());
    analysis = { topStrategies: summary.topStrategies, currentStrategies: summary.currentStrategies };
  } else if (tab === "settings") {
    settingsFields = buildSettingsFields(await client.getSettings());
  }

  const vm: ViewModel = {
    width,
    height,
    tab,
    nowMs: Date.now(),
    connected: status !== undefined,
    status,
    statusError,
    trades,
    tradesScroll: 0,
    analysis,
    analysisLoading: false,
    settingsFields,
    settingsSelected: 0,
    settingsScroll: 0,
    bodyScroll: 0,
    lastUpdateMs: status ? Date.now() : undefined,
  };

  const lines = [renderTitleBar(vm), renderTabBar(vm), "", ...renderBody(vm)];
  process.stdout.write(`${lines.join("\n")}\n`);
}

async function main(): Promise<void> {
  const cli = parseArgs(process.argv.slice(2));
  const client = new PolybotClient({ baseUrl: cli.url });

  const colorDefault = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
  setColorEnabled(cli.color ?? (cli.once ? colorDefault : true));

  if (cli.once) {
    await renderOnce(client, cli.tab);
    return;
  }

  // Raw-mode capability is the real test — some launch chains (npm shims, wrappers) leave `isTTY`
  // undefined even though keypresses work, and setRawMode is present exactly when they do.
  if (typeof process.stdin.setRawMode !== "function") {
    process.stdout.write(
      "La TUI necesita una terminal interactiva (no detecté teclado).\n" +
        'Ábrela con doble clic en TUI-POLYBOT.cmd (Windows nativo) o, bajo Docker, con\n' +
        '"docker compose exec polybot node dist/src/tui/index.js".\n' +
        'Para un vistazo puntual sin terminal interactiva: "npm run tui -- --once".\n',
    );
    process.exitCode = 1;
    return;
  }

  startTui(client);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

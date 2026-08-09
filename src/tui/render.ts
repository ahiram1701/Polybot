// Pure rendering for the terminal UI. Every function here maps a view-model to an array of styled
// lines with no I/O — the same discipline as chartData/statusSummary, so the layout is unit-testable
// by asserting on the returned strings. The runtime owns all side effects (polling, keypresses, the
// screen buffer); it just feeds a ViewModel in and prints what comes out.

import { splitCompactPnlByKind, VALIDATION_TARGET_TRADES } from "../agent/statusSummary.js";
import type { CompactStatus, CompactStrategy, CompactTrade } from "../agent/statusSummary.js";
import { humanSkipReason } from "../ui/shared.js";
import {
  bold,
  boxed,
  colorSignedUsd,
  cyan,
  dim,
  fmtInt,
  fmtPct,
  fmtUsd,
  gray,
  green,
  highlight,
  padEnd,
  padStart,
  red,
  truncate,
  yellow,
} from "./theme.js";
import type { SettingsField } from "./settingsModel.js";

export type Tab = "dashboard" | "trades" | "analysis" | "settings";

export const TABS: { id: Tab; label: string }[] = [
  { id: "dashboard", label: "Dashboard" },
  { id: "trades", label: "Trades" },
  { id: "analysis", label: "Análisis" },
  { id: "settings", label: "Settings" },
];

export interface Message {
  text: string;
  kind: "info" | "error" | "success";
}

export interface PromptState {
  title: string;
  hint?: string;
  buffer: string;
}

export interface AnalysisData {
  topStrategies: CompactStrategy[];
  currentStrategies: CompactStrategy[];
}

export interface ViewModel {
  width: number;
  height: number;
  tab: Tab;
  nowMs: number;
  connected: boolean;
  status?: CompactStatus;
  statusError?: string;
  trades?: CompactTrade[];
  tradesError?: string;
  tradesScroll: number;
  analysis?: AnalysisData;
  analysisLoading: boolean;
  analysisError?: string;
  settingsFields?: SettingsField[];
  settingsSelected: number;
  settingsScroll: number;
  message?: Message;
  prompt?: PromptState;
}

function labelValue(label: string, value: string, labelWidth = 16): string {
  return `${dim(padEnd(`${label}:`, labelWidth))} ${value}`;
}

function hhmm(ms: number): string {
  const d = new Date(ms);
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

function winRatePct(won: number, resolved: number): number | undefined {
  return resolved > 0 ? (won / resolved) * 100 : undefined;
}

// ---- title + tab bar ---------------------------------------------------------------------------

export function renderTitleBar(vm: ViewModel): string {
  const brand = bold(cyan(" POLYBOT "));
  const conn = vm.connected ? green("● conectado") : red("● sin conexión");
  const clock = dim(hhmm(vm.nowMs));
  const left = `${brand} ${conn}`;
  const right = clock;
  const gap = Math.max(1, vm.width - visibleLen(left) - visibleLen(right));
  return `${left}${" ".repeat(gap)}${right}`;
}

export function renderTabBar(vm: ViewModel): string {
  const cells = TABS.map((tab) => {
    const text = ` ${tab.label} `;
    return tab.id === vm.tab ? highlight(text) : dim(text);
  });
  return cells.join(gray("│"));
}

// visibleLen kept local to avoid importing theme's internal; re-uses the same stripping rule.
function visibleLen(text: string): number {
  return text.replace(/\x1b\[[0-9;]*m/g, "").length;
}

// ---- dashboard ---------------------------------------------------------------------------------

function runningBadge(status: CompactStatus): string {
  if (!status.running) {
    return gray("○ detenido");
  }
  const mode = status.mode === "live" ? red(bold("LIVE")) : green(bold("SIM"));
  return `${green("●")} corriendo ${mode}`;
}

function pnlLines(title: string, pnl: CompactStatus["pnlByMode"]["sim"], active: boolean): string[] {
  const head = active ? bold(cyan(title)) : bold(title);
  const win = winRatePct(pnl.wonCount, pnl.resolvedCount);
  return [
    `${padEnd(head, 22)} ${colorSignedUsd(pnl.realizedUsd)}   ROI ${fmtPct(pnl.roiPct)}`,
    dim(
      `  win ${fmtPct(win)}  ·  ${pnl.wonCount}G/${pnl.lostCount}P de ${pnl.resolvedCount}  ·  ${pnl.pendingCount} pend.`,
    ),
  ];
}

export function renderDashboard(vm: ViewModel): string[] {
  const width = vm.width;
  if (!vm.status) {
    return boxed("Estado", [vm.statusError ? red(vm.statusError) : dim("cargando…")], width);
  }
  const s = vm.status;
  const out: string[] = [];

  // Estado + freno
  const stateLines: string[] = [];
  stateLines.push(labelValue("Bot", runningBadge(s)));
  if (s.uptimeSeconds !== undefined) {
    stateLines.push(labelValue("Uptime", `${Math.floor(s.uptimeSeconds / 60)}m ${s.uptimeSeconds % 60}s`));
  }
  const spend = `${fmtUsd(s.dailySpendUsd)}${s.dailySpendLimitUsd !== undefined ? ` / ${fmtUsd(s.dailySpendLimitUsd)}` : ""}`;
  stateLines.push(labelValue("Gasto hoy", spend));
  stateLines.push(labelValue("Live listo", s.liveReady ? green("sí") : gray("no")));
  if (s.bankroll) {
    // De donde sale el capital importa tanto como el numero: "declarado" significa que la lectura
    // on-chain fallo y el bot esta dimensionando con un valor escrito a mano.
    const fuente =
      s.bankroll.source === "onchain"
        ? green("on-chain")
        : s.bankroll.source === "declared"
          ? yellow("declarado")
          : red("desconocido");
    stateLines.push(labelValue("Capital", `${fmtUsd(s.bankroll.usd)} ${dim("(")}${fuente}${dim(")")}`));
  }
  if (s.loopHealth && s.loopHealth.iterations > 0) {
    const pct = s.loopHealth.failedPct;
    const texto = `${pct.toFixed(1)}% fallidas ${dim(`(${s.loopHealth.failed}/${s.loopHealth.iterations})`)}`;
    // Un bucle que falla llega tarde a las entradas, y eso no aparece en ningun motivo de skip.
    stateLines.push(labelValue("Loop", pct >= 5 ? red(texto) : pct > 0 ? yellow(texto) : green(texto)));
  }
  if (s.riskHalt?.tripped) {
    const resume = s.riskHalt.resumeAtMs ? ` — re-arma ${hhmm(s.riskHalt.resumeAtMs)}` : "";
    stateLines.push(
      red(
        bold(
          `FRENO: ${s.riskHalt.reason ?? "riesgo"} · pérdida ${fmtUsd(s.riskHalt.dailyLossUsd)} · ${s.riskHalt.consecutiveLosses} seguidas${resume}`,
        ),
      ),
    );
  } else {
    stateLines.push(green("sin freno de riesgo"));
  }
  if (s.lastError) {
    stateLines.push(red(`error: ${truncate(s.lastError, width - 10)}`));
  }
  out.push(...boxed("Estado", stateLines, width));

  // P&L (post-reset)
  const pnlBody = [
    ...pnlLines("SIM", s.pnlByMode.sim, s.mode === "sim" && s.running),
    ...pnlLines("LIVE", s.pnlByMode.live, s.mode === "live" && s.running),
  ];
  // Desglose arbitraje vs direccional: con la estrategia arb-first, saber CUAL de los dos genera el
  // dinero es el numero que importa. El total mezclado lo esconde.
  if (vm.trades?.length) {
    const modo = s.mode ?? "sim";
    const split = splitCompactPnlByKind(vm.trades, modo, s.pnlResetAtMs);
    if (split.arb.count > 0 || split.dir.count > 0) {
      const fila = (etiqueta: string, parte: { netUsd: number; count: number }): string => {
        const neto = parte.netUsd >= 0 ? green(fmtUsd(parte.netUsd)) : red(fmtUsd(parte.netUsd));
        return `${bold(padEnd(etiqueta, 5))} ${padStart(neto, 18)}  ${dim(`${parte.count} ops`)}`;
      };
      pnlBody.push(dim("— por estrategia —"), fila("ARB", split.arb), fila("DIR", split.dir));
      // El go/no-go se juzga sobre el ARBITRAJE, que es lo unico que corre en live mientras el
      // capital siga por debajo del minimo del direccional. Mezclarlos daba un numero que no
      // describe ninguna de las dos.
      const meta = Math.min(split.arb.count, VALIDATION_TARGET_TRADES);
      pnlBody.push(
        `${dim("validación arb")} ${bold(String(meta))}${dim("/" + VALIDATION_TARGET_TRADES)} ${dim("operaciones")}`,
      );
    }
  }
  out.push(...boxed("P&L (post-reset)", pnlBody, width));

  // Mercados
  const marketLines = s.markets.length
    ? s.markets.map((m) => {
        const inWin = m.inEntryWindow ? green("● en ventana") : gray("○ fuera");
        const secs = m.secondsToEnd !== undefined ? `${padStart(fmtInt(m.secondsToEnd), 3)}s` : "  —";
        const side = m.outcome ? padEnd(m.outcome, 4) : "    ";
        const dist = m.distanceUsd !== undefined ? padStart(fmtUsd(m.distanceUsd), 8) : padStart("—", 8);
        return `${bold(padEnd(m.marketSymbol, 5))} ${inWin}  ${secs}  ${side} ${dist}  ${dim(truncate(humanSkipReason(m.reason), width - 40))}`;
      })
    : [dim("sin mercados observados")];
  out.push(...boxed("Mercados", marketLines, width));

  // Decisiones del autoajuste. Se pintan aunque se apliquen solas: eso es lo que separa "autonomo"
  // de "opaco".
  if (s.bandPrograms?.length) {
    const filas = s.bandPrograms.slice(-4).map((p) => {
      const estado =
        p.status === "probing"
          ? yellow("sondeando")
          : p.status === "confirmed"
            ? green("confirmada")
            : red("descartada");
      const real =
        p.realizedNetPerTradeUsd !== undefined
          ? ` real ${fmtUsd(p.realizedNetPerTradeUsd)}/op`
          : dim(" sin veredicto");
      return `${bold(padEnd(p.market, 5))} ${p.lo.toFixed(2)}-${p.hi.toFixed(2)} ${estado} ${dim("promete")} ${fmtUsd(p.expectedNetPerTradeUsd)}/op${real}`;
    });
    out.push(...boxed("Autoajuste: bandas en prueba", filas, width));
  }

  // Por qué no opera
  const skips = Object.entries(s.recentActivity.skipReasonCounts).sort((a, b) => b[1] - a[1]);
  const skipLines = skips.length
    ? skips.slice(0, 6).map(([reason, count]) => `${padStart(String(count), 4)} × ${humanSkipReason(reason)}`)
    : [dim("sin skips recientes")];
  out.push(...boxed(`Por qué no opera (muestra ${s.recentActivity.sampleSize})`, skipLines, width));

  return out;
}

// ---- trades ------------------------------------------------------------------------------------

function tradeRow(t: CompactTrade, width: number): string {
  const time = dim(hhmm(t.createdAtMs));
  const market = padEnd(t.market ?? "—", 5);
  const side = padEnd(t.outcome, 4);
  const ask = padStart(t.bestAsk !== undefined ? t.bestAsk.toFixed(2) : "—", 5);
  const amount = padStart(fmtUsd(t.amountUsd), 7);
  let result: string;
  if (!t.resolved) {
    result = yellow(padEnd("pend.", 6));
  } else if (t.kind === "arb") {
    // El set completo cobra $1 por set gane quien gane: nunca es LOST.
    result = cyan(padEnd("ARB", 6));
  } else {
    result = t.resolved.won ? green(padEnd("WON", 6)) : red(padEnd("LOST", 6));
  }
  const net = padStart(colorSignedUsd(t.netUsd), 8);
  const mode = t.mode === "live" ? red("L") : gray("S");
  return `${time} ${mode} ${bold(market)} ${side} ${ask} ${amount}  ${result} ${net}`;
}

export function renderTrades(vm: ViewModel): string[] {
  const width = vm.width;
  if (vm.tradesError) {
    return boxed("Trades", [red(vm.tradesError)], width);
  }
  if (!vm.trades) {
    return boxed("Trades", [dim("cargando…")], width);
  }
  if (vm.trades.length === 0) {
    return boxed("Trades", [dim("sin trades todavía")], width);
  }
  const header = dim(`${padEnd("hora", 5)}   ${padEnd("mkt", 5)} ${padEnd("lado", 4)} ${padStart("ask", 5)} ${padStart("monto", 7)}  ${padEnd("res", 6)} ${padStart("net", 8)}`);
  const rows = Math.max(3, vm.height - 10);
  const visible = vm.trades.slice(vm.tradesScroll, vm.tradesScroll + rows);
  const lines = [header, ...visible.map((t) => tradeRow(t, width))];
  const more = vm.trades.length > vm.tradesScroll + rows || vm.tradesScroll > 0;
  if (more) {
    lines.push(dim(`— ${vm.tradesScroll + 1}‑${Math.min(vm.tradesScroll + rows, vm.trades.length)} de ${vm.trades.length} (↑/↓ desplaza) —`));
  }
  return boxed(`Trades (${vm.trades.length})`, lines, width);
}

// ---- analysis ----------------------------------------------------------------------------------

function strategyRow(c: CompactStrategy): string {
  const cur = c.isCurrent ? cyan("●") : " ";
  const head = padEnd(`${cur} ${c.market} ${c.outcome}`, 12);
  const win = padStart(fmtPct(c.winRate === undefined ? undefined : c.winRate * 100), 7);
  const ev = padStart(c.evRoi === undefined ? "—" : `${(c.evRoi * 100).toFixed(1)}%`, 7);
  const n = padStart(`${c.tradeCount}t`, 5);
  const window = padStart(`${c.entryWindowSeconds}s`, 4);
  const cap = padStart(c.maxAskPrice.toFixed(2), 5);
  const conf = dim(c.confidence);
  return `${head} win${win} ev${ev} ${n} ${dim("win")}${window} ${dim("cap")}${cap}  ${conf}`;
}

export function renderAnalysis(vm: ViewModel): string[] {
  const width = vm.width;
  if (vm.analysisError) {
    return boxed("Análisis", [red(vm.analysisError)], width);
  }
  if (vm.analysisLoading || !vm.analysis) {
    return boxed("Análisis", [dim(vm.analysisLoading ? "cargando…" : "pulsa [g] para cargar")], width);
  }
  const out: string[] = [];
  const current = vm.analysis.currentStrategies.length
    ? vm.analysis.currentStrategies.map(strategyRow)
    : [dim("sin estrategias actuales")];
  out.push(...boxed("Estrategia actual por mercado", current, width));
  const top = vm.analysis.topStrategies.length
    ? vm.analysis.topStrategies.slice(0, Math.max(3, vm.height - 14)).map(strategyRow)
    : [dim("sin ranking")];
  out.push(...boxed("Mejores estrategias (ranking)", top, width));
  return out;
}

// ---- settings ----------------------------------------------------------------------------------

export function renderSettings(vm: ViewModel): string[] {
  const width = vm.width;
  const fields = vm.settingsFields;
  if (!fields) {
    return boxed("Settings", [dim("cargando…")], width);
  }
  const running = vm.status?.running ?? false;
  const lines: string[] = [];
  if (running) {
    lines.push(yellow("detén el bot para editar (los cambios se rechazan mientras corre)"));
  } else {
    lines.push(dim("↑/↓ mueve · Enter alterna/edita"));
  }
  const rows = Math.max(4, vm.height - 11);
  const visible = fields.slice(vm.settingsScroll, vm.settingsScroll + rows);
  visible.forEach((field, index) => {
    const absolute = vm.settingsScroll + index;
    if (field.kind === "header") {
      lines.push(bold(cyan(field.label)));
      return;
    }
    const selected = absolute === vm.settingsSelected;
    const marker = selected ? cyan("›") : " ";
    const label = padEnd(field.label, 30);
    const value = field.value ?? "";
    const rowText = `${marker} ${label} ${value}`;
    lines.push(selected ? highlight(` ${label} ${value} `) : rowText);
  });
  return boxed("Settings", lines, width);
}

// ---- action bar + status/prompt ----------------------------------------------------------------

export function renderActionBar(vm: ViewModel): string {
  const key = (k: string, label: string, enabled = true): string => {
    const chip = `${bold(`[${k}]`)}${label}`;
    return enabled ? chip : dim(`[${k}]${label}`);
  };
  const parts: string[] = [key("←/→", " tabs"), key("g", " refrescar"), key("q", " salir")];
  const running = vm.status?.running ?? false;
  if (vm.tab === "dashboard") {
    parts.push(gray("│"));
    parts.push(key("I", " sim", !running));
    parts.push(key("S", " detener", running));
    parts.push(key("L", " LIVE", !running));
    parts.push(key("B", " freno"));
    parts.push(key("P", " resetP&L"));
    parts.push(key("X", " resetEstado", !running));
  } else if (vm.tab === "trades") {
    parts.push(gray("│"));
    parts.push(key("↑/↓", " desplazar"));
  } else if (vm.tab === "settings") {
    parts.push(gray("│"));
    parts.push(key("↑/↓", " mover"));
    parts.push(key("Enter", " editar", !running));
  }
  return parts.join(" ");
}

export function renderStatusLine(vm: ViewModel): string {
  if (vm.prompt) {
    const hint = vm.prompt.hint ? dim(`  (${vm.prompt.hint})`) : "";
    return `${yellow(bold(vm.prompt.title))} ${vm.prompt.buffer}${inverse(" ")}${hint}`;
  }
  if (vm.message) {
    const paint = vm.message.kind === "error" ? red : vm.message.kind === "success" ? green : dim;
    return paint(vm.message.text);
  }
  return dim(" ");
}

// inverse cursor block for the prompt (kept local; theme.inverse also exists but we want a space cell).
function inverse(text: string): string {
  return `\x1b[7m${text}\x1b[27m`;
}

// ---- full screen composition -------------------------------------------------------------------

export function renderBody(vm: ViewModel): string[] {
  switch (vm.tab) {
    case "dashboard":
      return renderDashboard(vm);
    case "trades":
      return renderTrades(vm);
    case "analysis":
      return renderAnalysis(vm);
    case "settings":
      return renderSettings(vm);
    default:
      return [];
  }
}

/** Compose the whole screen and pad/truncate to exactly `height` lines so the alt-screen repaint
 * leaves no stale rows behind. */
export function renderScreen(vm: ViewModel): string[] {
  const lines: string[] = [];
  lines.push(renderTitleBar(vm));
  lines.push(renderTabBar(vm));
  lines.push("");
  lines.push(...renderBody(vm));

  const height = vm.height;
  // Reserve the last two rows for the action bar and the status/prompt line.
  const bodyMax = Math.max(0, height - 2);
  while (lines.length < bodyMax) {
    lines.push("");
  }
  const trimmed = lines.slice(0, bodyMax);
  trimmed.push(renderActionBar(vm));
  trimmed.push(renderStatusLine(vm));
  return trimmed;
}

// Interactive runtime for the terminal UI: owns the alternate-screen buffer, raw keypresses, the
// polling loop and every side-effecting action. It talks to the running server through PolybotClient
// (the server stays the single source of truth) and reuses the same summarize* projections the MCP
// server uses. Rendering is delegated wholesale to the pure functions in render.ts.
//
// Safety: starting LIVE trading is only ever reachable by the *user* typing an exact confirmation
// phrase here — mirroring the web's confirmLive lock. Nothing in this file starts live on its own.

import readline from "node:readline";

import { PolybotClient, PolybotApiError } from "../agent/client.js";
import { summarizeStatus, summarizeStrategyAnalysis, summarizeTrade } from "../agent/statusSummary.js";
import type { UiSettings } from "../ui/shared.js";
import { entraEnLive, LIVE_PHRASE } from "../ui/shared.js";
import { applyNumber, applyToggle, buildSettingsFields, isModeId } from "./settingsModel.js";
import type { SettingsField } from "./settingsModel.js";
import type { AnalysisData, Message, Tab, ViewModel } from "./render.js";
import { renderScreen, TABS } from "./render.js";

const RESET_STATE_PHRASE = "RESET";
const POLL_MS = 2000;
const MAX_WIDTH = 120;

interface PendingPrompt {
  title: string;
  hint?: string;
  buffer: string;
  validate?: (value: string) => string | undefined;
  onSubmit: (value: string) => void | Promise<void>;
}

interface RuntimeState {
  tab: Tab;
  connected: boolean;
  status?: ReturnType<typeof summarizeStatus>;
  statusError?: string;
  trades?: ReturnType<typeof summarizeTrade>[];
  tradesError?: string;
  tradesScroll: number;
  analysis?: AnalysisData;
  analysisLoading: boolean;
  analysisError?: string;
  settings?: UiSettings;
  settingsFields?: SettingsField[];
  settingsSelected: number;
  settingsScroll: number;
  message?: Message;
  prompt?: PendingPrompt;
}

function errMsg(error: unknown): string {
  if (error instanceof PolybotApiError) {
    return error.details ? `${error.message} (${error.status})` : error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

export function startTui(client: PolybotClient): void {
  const state: RuntimeState = {
    tab: "dashboard",
    connected: false,
    tradesScroll: 0,
    analysisLoading: false,
    settingsSelected: 0,
    settingsScroll: 0,
  };

  const out = process.stdout;
  let pollTimer: NodeJS.Timeout | undefined;
  let torndown = false;

  function width(): number {
    return Math.min(out.columns || 100, MAX_WIDTH);
  }
  function height(): number {
    return Math.max(12, out.rows || 30);
  }

  function toViewModel(): ViewModel {
    return {
      width: width(),
      height: height(),
      tab: state.tab,
      nowMs: Date.now(),
      connected: state.connected,
      status: state.status,
      statusError: state.statusError,
      trades: state.trades,
      tradesError: state.tradesError,
      tradesScroll: state.tradesScroll,
      analysis: state.analysis,
      analysisLoading: state.analysisLoading,
      analysisError: state.analysisError,
      settingsFields: state.settingsFields,
      settingsSelected: state.settingsSelected,
      settingsScroll: state.settingsScroll,
      message: state.message,
      prompt: state.prompt
        ? { title: state.prompt.title, hint: state.prompt.hint, buffer: state.prompt.buffer }
        : undefined,
    };
  }

  function render(): void {
    if (torndown) {
      return;
    }
    const lines = renderScreen(toViewModel());
    // Home the cursor and repaint each row, clearing to end-of-line so shorter rows don't leave
    // debris. The frame is already exactly `height` rows, so there's nothing below to wipe.
    out.write(`\x1b[H${lines.map((line) => `${line}\x1b[K`).join("\n")}`);
  }

  // ---- data refresh --------------------------------------------------------

  async function refreshStatus(): Promise<void> {
    try {
      const status = await client.getStatus();
      state.status = summarizeStatus(status);
      state.connected = true;
      state.statusError = undefined;
    } catch (error) {
      state.connected = false;
      state.statusError = `sin conexión al servidor (${errMsg(error)})`;
    }
    render();
  }

  async function refreshTrades(): Promise<void> {
    try {
      const { trades } = await client.listTrades(200);
      state.trades = trades.map(summarizeTrade).sort((a, b) => b.createdAtMs - a.createdAtMs);
      state.tradesError = undefined;
    } catch (error) {
      state.tradesError = errMsg(error);
    }
    render();
  }

  async function refreshAnalysis(): Promise<void> {
    state.analysisLoading = true;
    render();
    try {
      const summary = summarizeStrategyAnalysis(await client.getStrategyAnalysis());
      state.analysis = { topStrategies: summary.topStrategies, currentStrategies: summary.currentStrategies };
      state.analysisError = undefined;
    } catch (error) {
      state.analysisError = errMsg(error);
    }
    state.analysisLoading = false;
    render();
  }

  async function refreshSettings(): Promise<void> {
    try {
      state.settings = await client.getSettings();
      state.settingsFields = buildSettingsFields(state.settings);
      ensureSelectable(0);
    } catch (error) {
      state.message = { text: errMsg(error), kind: "error" };
    }
    render();
  }

  // ---- settings navigation -------------------------------------------------

  function ensureSelectable(direction: number): void {
    const fields = state.settingsFields;
    if (!fields || fields.length === 0) {
      return;
    }
    let index = Math.max(0, Math.min(state.settingsSelected, fields.length - 1));
    const step = direction === 0 ? 1 : direction;
    let guard = 0;
    while (fields[index] && !fields[index].editable && guard < fields.length) {
      index = (index + step + fields.length) % fields.length;
      guard += 1;
    }
    state.settingsSelected = index;
    const rows = Math.max(4, height() - 11);
    if (index < state.settingsScroll) {
      state.settingsScroll = index;
    } else if (index >= state.settingsScroll + rows) {
      state.settingsScroll = index - rows + 1;
    }
  }

  function moveSelection(delta: number): void {
    const fields = state.settingsFields;
    if (!fields) {
      return;
    }
    let index = state.settingsSelected;
    let guard = 0;
    do {
      index = (index + delta + fields.length) % fields.length;
      guard += 1;
    } while (fields[index] && !fields[index].editable && guard < fields.length);
    state.settingsSelected = index;
    ensureSelectable(delta >= 0 ? 1 : -1);
    render();
  }

  // ---- prompt handling -----------------------------------------------------

  function openPrompt(prompt: Omit<PendingPrompt, "buffer">): void {
    state.prompt = { ...prompt, buffer: "" };
    render();
  }

  function closePrompt(): void {
    state.prompt = undefined;
  }

  async function submitPrompt(): Promise<void> {
    const prompt = state.prompt;
    if (!prompt) {
      return;
    }
    const value = prompt.buffer.trim();
    const error = prompt.validate?.(value);
    if (error) {
      state.message = { text: error, kind: "error" };
      closePrompt();
      render();
      return;
    }
    closePrompt();
    render();
    await prompt.onSubmit(value);
  }

  // ---- actions -------------------------------------------------------------

  function setMessage(text: string, kind: Message["kind"]): void {
    state.message = { text, kind };
    render();
  }

  async function guarded(run: () => Promise<void>): Promise<void> {
    try {
      await run();
    } catch (error) {
      setMessage(errMsg(error), "error");
    }
  }

  async function startSim(): Promise<void> {
    if (state.status?.running) {
      setMessage("el bot ya está corriendo", "info");
      return;
    }
    await guarded(async () => {
      state.status = summarizeStatus(await client.startBot("sim", false));
      setMessage("simulación iniciada", "success");
    });
  }

  async function stopBot(): Promise<void> {
    await guarded(async () => {
      state.status = summarizeStatus(await client.stopBot());
      setMessage("bot detenido", "success");
    });
  }

  function askStartLive(): void {
    if (state.status?.running) {
      setMessage("detén el bot antes de cambiar de modo", "info");
      return;
    }
    // The assistant never reaches this branch — only a human typing the exact phrase does.
    openPrompt({
      title: `Escribe «${LIVE_PHRASE}» para operar con DINERO REAL:`,
      hint: "cualquier otra cosa cancela",
      onSubmit: async (value) => {
        if (value !== LIVE_PHRASE) {
          setMessage("live cancelado", "info");
          return;
        }
        await guarded(async () => {
          state.status = summarizeStatus(await client.startBot("live", true));
          setMessage("LIVE iniciado — operando con dinero real", "success");
        });
      },
    });
  }

  function askResetPnl(): void {
    openPrompt({
      title: "Reset P&L — escribe sim o live:",
      validate: (value) => (value === "sim" || value === "live" ? undefined : "escribe sim o live"),
      onSubmit: async (value) => {
        await guarded(async () => {
          state.status = summarizeStatus(await client.resetPnl(value as "sim" | "live"));
          setMessage(`P&L de ${value} reseteado`, "success");
        });
      },
    });
  }

  function askResetState(): void {
    if (state.status?.running) {
      setMessage("detén el bot antes de resetear el estado", "info");
      return;
    }
    openPrompt({
      title: `Escribe «${RESET_STATE_PHRASE}» para borrar estado y trades:`,
      hint: "se archiva un backup antes",
      onSubmit: async (value) => {
        if (value !== RESET_STATE_PHRASE) {
          setMessage("reset cancelado", "info");
          return;
        }
        await guarded(async () => {
          state.status = summarizeStatus(await client.resetState());
          state.trades = undefined;
          setMessage("estado reseteado", "success");
        });
      },
    });
  }

  async function resetBreaker(): Promise<void> {
    await guarded(async () => {
      await client.resetRiskHalt("sim");
      state.status = summarizeStatus(await client.resetRiskHalt("live"));
      setMessage("circuit breaker re-armado (sim y live)", "success");
    });
  }

  async function saveSettings(next: UiSettings, note: string): Promise<void> {
    await guarded(async () => {
      state.settings = await client.updateSettings(next);
      state.settingsFields = buildSettingsFields(state.settings);
      setMessage(note, "success");
    });
  }

  function editSelectedSetting(): void {
    const fields = state.settingsFields;
    const settings = state.settings;
    if (!fields || !settings) {
      return;
    }
    if (state.status?.running) {
      setMessage("detén el bot para editar settings", "info");
      return;
    }
    const field = fields[state.settingsSelected];
    if (!field || !field.editable) {
      return;
    }
    if (field.kind === "toggle") {
      const next = applyToggle(settings, field.id);
      // Entrar en LIVE pide teclear la frase. No contradice la decision de "sin confirmar al arrancar":
      // aquello era el ARRANQUE, esto es el gesto de edicion. Los modos ciclan con la misma tecla que
      // los interruptores, asi que sin esto un Enter de mas empieza a mover dinero real. Salir de live
      // y el resto del ciclo siguen a una tecla: solo se pone friccion al lado que cuesta dinero.
      // Sin `isModeId` delante: `entraEnLive` ya sabe que claves encienden dinero real, y desde que
      // cubre tambien los cierres booleanos (`favoriteAllowLive`) exigir que fuera un modo dejaba al
      // favorito encendiendose en live con un solo Enter.
      if (entraEnLive(settings, next, field.id)) {
        openPrompt({
          title: `${field.label} → LIVE. Escribe «${LIVE_PHRASE}» para operar con DINERO REAL:`,
          hint: "cualquier otra cosa cancela",
          onSubmit: async (value) => {
            if (value !== LIVE_PHRASE) {
              setMessage("cambio a live cancelado", "info");
              return;
            }
            await saveSettings(next, `${field.label}: LIVE — dinero real`);
          },
        });
        return;
      }
      void saveSettings(next, `${field.label}: alternado`);
      return;
    }
    if (field.kind === "number") {
      openPrompt({
        title: `${field.label} = `,
        hint: `actual: ${field.value ?? "—"}`,
        validate: (value) => (Number.isFinite(Number(value)) && value !== "" ? undefined : "escribe un número"),
        onSubmit: async (value) => {
          await saveSettings(applyNumber(settings, field.id, Number(value)), `${field.label} actualizado`);
        },
      });
    }
  }

  // ---- tab switching -------------------------------------------------------

  function setTab(tab: Tab): void {
    state.tab = tab;
    state.message = undefined;
    if (tab === "trades" && !state.trades) {
      void refreshTrades();
    } else if (tab === "analysis" && !state.analysis) {
      void refreshAnalysis();
    } else if (tab === "settings" && !state.settingsFields) {
      void refreshSettings();
    }
    render();
  }

  function cycleTab(delta: number): void {
    const index = TABS.findIndex((t) => t.id === state.tab);
    const nextIndex = (index + delta + TABS.length) % TABS.length;
    setTab(TABS[nextIndex].id);
  }

  function refreshCurrentTab(): void {
    void refreshStatus();
    if (state.tab === "trades") {
      void refreshTrades();
    } else if (state.tab === "analysis") {
      void refreshAnalysis();
    } else if (state.tab === "settings") {
      void refreshSettings();
    }
  }

  // ---- keypress dispatch ---------------------------------------------------

  function onKey(str: string | undefined, key: readline.Key): void {
    // Ctrl+C always quits, even mid-prompt.
    if (key.ctrl && key.name === "c") {
      teardown();
      process.exit(0);
    }

    if (state.prompt) {
      if (key.name === "escape") {
        closePrompt();
        setMessage("cancelado", "info");
        return;
      }
      if (key.name === "return" || key.name === "enter") {
        void submitPrompt();
        return;
      }
      if (key.name === "backspace") {
        state.prompt.buffer = state.prompt.buffer.slice(0, -1);
        render();
        return;
      }
      if (str && !key.ctrl && !key.meta && str.length === 1 && str >= " ") {
        state.prompt.buffer += str;
        render();
      }
      return;
    }

    switch (key.name) {
      case "q":
        teardown();
        process.exit(0);
        return;
      case "left":
        cycleTab(-1);
        return;
      case "right":
      case "tab":
        cycleTab(1);
        return;
      case "g":
        refreshCurrentTab();
        return;
      case "up":
        if (state.tab === "settings") {
          moveSelection(-1);
        } else if (state.tab === "trades") {
          state.tradesScroll = Math.max(0, state.tradesScroll - 1);
          render();
        }
        return;
      case "down":
        if (state.tab === "settings") {
          moveSelection(1);
        } else if (state.tab === "trades") {
          state.tradesScroll += 1;
          render();
        }
        return;
      default:
        break;
    }

    // Number keys jump straight to a tab.
    if (str && str >= "1" && str <= String(TABS.length)) {
      setTab(TABS[Number(str) - 1].id);
      return;
    }

    if (state.tab === "settings" && (key.name === "return" || key.name === "enter")) {
      editSelectedSetting();
      return;
    }

    if (state.tab === "dashboard") {
      switch (str) {
        case "I":
        case "i":
          void startSim();
          return;
        case "S":
        case "s":
          void stopBot();
          return;
        case "L":
          askStartLive();
          return;
        case "B":
        case "b":
          void resetBreaker();
          return;
        case "P":
        case "p":
          askResetPnl();
          return;
        case "X":
        case "x":
          askResetState();
          return;
        default:
          break;
      }
    }
  }

  // ---- lifecycle -----------------------------------------------------------

  function teardown(): void {
    if (torndown) {
      return;
    }
    torndown = true;
    if (pollTimer) {
      clearInterval(pollTimer);
    }
    if (typeof process.stdin.setRawMode === "function") {
      process.stdin.setRawMode(false);
    }
    process.stdin.pause();
    out.write("\x1b[?25h"); // show cursor
    out.write("\x1b[?1049l"); // leave alternate screen
  }

  // Enter alternate screen, hide cursor, wire keypresses.
  out.write("\x1b[?1049h");
  out.write("\x1b[?25l");
  out.write("\x1b[2J");

  readline.emitKeypressEvents(process.stdin);
  if (typeof process.stdin.setRawMode === "function") {
    process.stdin.setRawMode(true);
  }
  process.stdin.resume();
  process.stdin.on("keypress", onKey);
  out.on("resize", render);

  process.on("exit", teardown);
  process.on("SIGINT", () => {
    teardown();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    teardown();
    process.exit(0);
  });
  process.on("uncaughtException", (error) => {
    teardown();
    // eslint-disable-next-line no-console
    console.error("TUI error:", error);
    process.exit(1);
  });

  // First paint + initial loads, then poll status on a timer.
  render();
  void refreshStatus();
  void refreshSettings();
  pollTimer = setInterval(() => {
    void refreshStatus();
    if (state.tab === "trades") {
      void refreshTrades();
    }
  }, POLL_MS);
}

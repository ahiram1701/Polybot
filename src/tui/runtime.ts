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
import { applyNumber, applyToggle, buildSettingsFields, filterSettingsFields, isModeId } from "./settingsModel.js";
import type { SettingsField } from "./settingsModel.js";
import type { AnalysisData, Message, Tab, ViewModel } from "./render.js";
import { maxBodyScroll, maxTradesScroll, renderScreen, settingsRowsPerPage, TABS, tradeRowsPerPage } from "./render.js";

const RESET_STATE_PHRASE = "RESET";
const POLL_MS = 2000;
const MAX_WIDTH = 120;
/**
 * Cuánto dura un aviso antes de borrarse solo.
 *
 * Antes se quedaban hasta que cambiabas de pestaña, así que un «bot detenido» de hace media hora seguía
 * en el pie mientras el bot volvía a correr: el sitio donde se leen los errores era también el sitio
 * donde vivía la información más vieja de la pantalla.
 */
const MESSAGE_TTL_MS = 6000;

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
  /** Lista completa de campos. Se guarda aparte para poder rehacer el filtro sin volver a pedir nada. */
  settingsAllFields?: SettingsField[];
  /** Lo que se pinta: `settingsAllFields` pasado por `settingsFilter`. */
  settingsFields?: SettingsField[];
  settingsSelected: number;
  settingsScroll: number;
  settingsFilter?: string;
  /** Desplazamiento del cuerpo en Dashboard y Análisis, que no paginan por dentro. */
  bodyScroll: number;
  lastUpdateMs?: number;
  help: boolean;
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
    bodyScroll: 0,
    help: false,
  };

  const out = process.stdout;
  let pollTimer: NodeJS.Timeout | undefined;
  let messageTimer: NodeJS.Timeout | undefined;
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
      settingsFilter: state.settingsFilter,
      bodyScroll: state.bodyScroll,
      lastUpdateMs: state.lastUpdateMs,
      help: state.help,
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
      // Solo se sella cuando el dato es BUENO: es lo que deja ver que la pantalla lleva un minuto
      // enseñando números de hace un minuto.
      state.lastUpdateMs = Date.now();
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
      state.settingsAllFields = buildSettingsFields(state.settings);
      applySettingsFilter();
      ensureSelectable(0);
    } catch (error) {
      setMessage(errMsg(error), "error");
    }
    render();
  }

  /** Recalcula la lista visible desde la completa. Se llama al recargar y al cambiar el filtro. */
  function applySettingsFilter(): void {
    const all = state.settingsAllFields;
    if (!all) {
      return;
    }
    state.settingsFields = state.settingsFilter ? filterSettingsFields(all, state.settingsFilter) : all;
  }

  function setSettingsFilter(query: string | undefined): void {
    state.settingsFilter = query && query !== "" ? query : undefined;
    applySettingsFilter();
    // La selección se refiere a la lista visible, y esa acaba de cambiar de tamaño: volver arriba es lo
    // único que no deja el cursor apuntando a un ajuste distinto del que estaba señalando.
    state.settingsSelected = 0;
    state.settingsScroll = 0;
    ensureSelectable(1);
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
    const rows = settingsRowsPerPage(height());
    if (index < state.settingsScroll) {
      state.settingsScroll = index;
    } else if (index >= state.settingsScroll + rows) {
      state.settingsScroll = index - rows + 1;
    }
  }

  /**
   * Mueve la selección `delta` filas y aterriza en la más cercana que se pueda editar.
   *
   * Paso a paso (±1) da la vuelta por los extremos, que es lo cómodo en una lista larga. Un salto de
   * página se RECORTA en los extremos: envolver veinte filas no lleva a ningún sitio reconocible, y
   * antes el salto además se repetía —de veinte en veinte— hasta topar con una fila editable.
   */
  function moveSelection(delta: number): void {
    const fields = state.settingsFields;
    if (!fields || fields.length === 0) {
      return;
    }
    const step = delta >= 0 ? 1 : -1;
    const salto = Math.abs(delta) === 1;
    let index = salto
      ? (state.settingsSelected + delta + fields.length) % fields.length
      : Math.max(0, Math.min(fields.length - 1, state.settingsSelected + delta));

    // Buscar la editable más cercana en la dirección del movimiento; si no queda ninguna hacia ese
    // lado (cabeceras al final de la lista), volver hacia atrás en vez de quedarse en una no editable.
    const buscar = (from: number, dir: number): number | undefined => {
      for (let i = from; i >= 0 && i < fields.length; i += dir) {
        if (fields[i].editable) {
          return i;
        }
      }
      return undefined;
    };
    index = buscar(index, step) ?? buscar(index, -step) ?? state.settingsSelected;

    state.settingsSelected = index;
    ensureSelectable(step);
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
    if (messageTimer) {
      clearTimeout(messageTimer);
    }
    // Los errores se quedan: son la única traza de que algo salió mal y borrarlos a los seis segundos
    // los haría desaparecer justo mientras uno lee el resto de la pantalla. Lo demás caduca.
    if (kind !== "error") {
      messageTimer = setTimeout(() => {
        state.message = undefined;
        render();
      }, MESSAGE_TTL_MS);
      messageTimer.unref?.();
    }
    render();
  }

  function clearMessage(): void {
    if (messageTimer) {
      clearTimeout(messageTimer);
      messageTimer = undefined;
    }
    state.message = undefined;
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
      state.settingsAllFields = buildSettingsFields(state.settings);
      applySettingsFilter();
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
    clearMessage();
    // Cada pestaña empieza por arriba: heredar el desplazamiento de la anterior aterriza a media caja.
    state.bodyScroll = 0;
    state.help = false;
    // El Dashboard también necesita los trades: el desglose por estrategia se calcula sobre ellos, y sin
    // pedirlos la caja solo aparecía después de haber visitado Trades y vuelto.
    if ((tab === "trades" || tab === "dashboard") && !state.trades) {
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

  // ---- desplazamiento ------------------------------------------------------

  /**
   * Una sola puerta para ↑/↓, PgUp/PgDn e Inicio/Fin, sea cual sea la pestaña.
   *
   * `delta` en líneas; `Infinity`/`-Infinity` son Fin e Inicio. Cada superficie tiene su propio tope y
   * los tres sitios lo respetan, que es lo que faltaba: Trades solo sumaba, sin límite ninguno.
   */
  function scrollBy(delta: number): void {
    if (!state.help && state.tab === "settings") {
      // En Settings lo que se mueve es la SELECCIÓN, no la vista: desplazar sin mover el cursor dejaría
      // seleccionada una fila que ya no se ve, y Enter editaría algo que no está en pantalla.
      const filas = state.settingsFields?.length ?? 0;
      moveSelection(Number.isFinite(delta) ? delta : delta > 0 ? filas : -filas);
      return;
    }
    if (!state.help && state.tab === "trades") {
      const max = maxTradesScroll(state.trades?.length ?? 0, height());
      state.tradesScroll = clampScroll(state.tradesScroll, delta, max);
      render();
      return;
    }
    const max = maxBodyScroll(toViewModel());
    state.bodyScroll = clampScroll(state.bodyScroll, delta, max);
    render();
  }

  function clampScroll(current: number, delta: number, max: number): number {
    if (delta === Infinity) {
      return max;
    }
    if (delta === -Infinity) {
      return 0;
    }
    return Math.max(0, Math.min(max, current + delta));
  }

  /** Salto de página: casi una pantalla, dejando dos líneas de solape para no perder el hilo. */
  function pageSize(): number {
    const rows = state.tab === "trades" ? tradeRowsPerPage(height()) : Math.max(1, height() - 5);
    return Math.max(1, rows - 2);
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
      case "escape":
        // Una sola tecla para «deshaz lo que me tapa la vista», en orden de lo más encima a lo menos.
        if (state.help) {
          state.help = false;
        } else if (state.settingsFilter && state.tab === "settings") {
          setSettingsFilter(undefined);
          return;
        } else {
          clearMessage();
        }
        render();
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
        scrollBy(-1);
        return;
      case "down":
        scrollBy(1);
        return;
      case "pageup":
        scrollBy(-pageSize());
        return;
      case "pagedown":
        scrollBy(pageSize());
        return;
      case "home":
        scrollBy(-Infinity);
        return;
      case "end":
        scrollBy(Infinity);
        return;
      default:
        break;
    }

    // La ayuda se abre y se cierra con la misma tecla, desde cualquier pestaña.
    if (str === "?") {
      state.help = !state.help;
      state.bodyScroll = 0;
      render();
      return;
    }
    if (state.help) {
      // Con la ayuda abierta no se dispara ninguna acción: es una pantalla de lectura, y un atajo del
      // dashboard escrito ahí dentro no debería ejecutarse por leerlo.
      return;
    }

    // Number keys jump straight to a tab.
    if (str && str >= "1" && str <= String(TABS.length)) {
      setTab(TABS[Number(str) - 1].id);
      return;
    }

    if (state.tab === "settings") {
      if (key.name === "return" || key.name === "enter") {
        editSelectedSetting();
        return;
      }
      if (str === "/") {
        openPrompt({
          title: "Filtrar ajustes:",
          hint: "Enter aplica · vacío o Esc limpia",
          onSubmit: (value) => setSettingsFilter(value),
        });
        return;
      }
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
    if (messageTimer) {
      clearTimeout(messageTimer);
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
  void refreshTrades();
  void refreshSettings();
  pollTimer = setInterval(() => {
    void refreshStatus();
    // Las dos pestañas que leen operaciones: Trades las lista y el Dashboard las reparte por estrategia.
    if (state.tab === "trades" || state.tab === "dashboard") {
      void refreshTrades();
    }
  }, POLL_MS);
}

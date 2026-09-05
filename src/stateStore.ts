import { appendFile, copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { writeFileAtomic } from "./atomicWrite.js";

import type { BotState, Mode, TradeAttempt, TradeEvent, WindowOpening } from "./types.js";
import { dailySpendKey } from "./time.js";

const MODES: readonly Mode[] = ["sim", "live"];

/** Clave del contador de gasto separada por modo. Prefijo delante para que nunca choque con la vieja. */
function modeDailySpendKey(mode: Mode, day: string): string {
  return `${mode}|${day}`;
}

const EMPTY_STATE: BotState = {
  version: 1,
  openings: {},
  tradedMarkets: {},
  dailySpendUsd: {},
  pnlResetAtMs: {},
  riskHaltResetAtMs: {},
};

// Openings are only needed for the current 5-minute window (at trade time) and for recent display.
// Keep an hour's worth so they never accumulate unbounded (the map used to grow forever), while
// still covering the current window plus a generous margin of recent ones.
const OPENINGS_RETENTION_MS = 60 * 60 * 1000;

interface StateFileCacheEntry {
  signature: string;
  state: BotState;
}

const stateFileCache = new Map<string, StateFileCacheEntry>();

export class StateStore {
  private state: BotState = structuredClone(EMPTY_STATE);
  private loaded = false;
  private loadedSignature = "unloaded";

  // timeZone drives the daily-spend calendar day (undefined = legacy UTC cut).
  constructor(
    private readonly dataDir: string,
    private readonly timeZone?: string,
  ) {}

  get statePath(): string {
    return join(this.dataDir, "state.json");
  }

  get tradesPath(): string {
    return join(this.dataDir, "trades.jsonl");
  }

  async load(): Promise<void> {
    let signature = await getStateFileSignature(this.statePath);
    const cached = stateFileCache.get(this.statePath);
    if (cached?.signature === signature) {
      this.state = structuredClone(cached.state);
      this.loadedSignature = signature;
      this.loaded = true;
      return;
    }

    if (signature === "missing") {
      this.state = structuredClone(EMPTY_STATE);
    } else {
      try {
        const contents = await readFile(this.statePath, "utf8");
        const parsed = JSON.parse(contents) as BotState;
        this.state = {
          version: 1,
          openings: parsed.openings ?? {},
          tradedMarkets: normalizeTradedMarkets(parsed.tradedMarkets ?? {}),
          dailySpendUsd: parsed.dailySpendUsd ?? {},
          pnlResetAtMs: normalizePnlResetAtMs(parsed.pnlResetAtMs),
          riskHaltResetAtMs: normalizePnlResetAtMs(parsed.riskHaltResetAtMs),
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
        signature = "missing";
        this.state = structuredClone(EMPTY_STATE);
      }
    }

    // The P&L reset marker in state.json is fragile (a stale in-memory save can wipe it), but the
    // pnl_reset events are durable in the append-only trades log. Reconcile from the log so a reset
    // survives even if state.json was clobbered, and self-heals on the next save.
    this.state.pnlResetAtMs = await this.reconcilePnlResetFromLog(this.state.pnlResetAtMs ?? {});

    this.loadedSignature = signature;
    this.loaded = true;
    stateFileCache.set(this.statePath, { signature, state: structuredClone(this.state) });
  }

  private async reconcilePnlResetFromLog(
    current: Partial<Record<Mode, number>>,
  ): Promise<Partial<Record<Mode, number>>> {
    let contents: string;
    try {
      contents = await readFile(this.tradesPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return current;
      }
      throw error;
    }

    const merged: Partial<Record<Mode, number>> = { ...current };
    for (const line of contents.split(/\r?\n/)) {
      if (!line.trim()) {
        continue;
      }
      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (!event || typeof event !== "object") {
        continue;
      }
      const record = event as { type?: unknown; mode?: unknown; resetAtMs?: unknown };
      if (
        record.type === "pnl_reset" &&
        (record.mode === "sim" || record.mode === "live") &&
        typeof record.resetAtMs === "number" &&
        Number.isFinite(record.resetAtMs)
      ) {
        const previous = merged[record.mode];
        if (previous === undefined || record.resetAtMs > previous) {
          merged[record.mode] = record.resetAtMs;
        }
      }
    }
    return merged;
  }

  getLoadedSignature(): string {
    this.assertLoaded();
    return this.loadedSignature;
  }

  getOpening(slug: string): WindowOpening | undefined {
    this.assertLoaded();
    return this.state.openings[slug];
  }

  /**
   * Si esta ventana ya tiene una operacion DE ESE TRAMO. Los dos tramos del favorito conviven en la
   * misma ventana, asi que preguntar solo por slug+modo cerraria la puerta al segundo.
   */
  hasTraded(slug: string, mode?: Mode, entryKind?: TradeAttempt["entryKind"], reentry?: number): boolean {
    this.assertLoaded();
    return this.findTradeKey(slug, mode, entryKind, reentry) !== undefined;
  }

  getTradedMarket(
    slug: string,
    mode?: Mode,
    entryKind?: TradeAttempt["entryKind"],
    reentry?: number,
  ): TradeAttempt | undefined {
    this.assertLoaded();
    const key = this.findTradeKey(slug, mode, entryKind, reentry);
    return key ? this.state.tradedMarkets[key] : undefined;
  }

  listTrades(): TradeAttempt[] {
    this.assertLoaded();
    return Object.values(this.state.tradedMarkets);
  }

  /**
   * Gasto de hoy. Con `mode`, solo el de ese modo; sin el, el total.
   *
   * El desglose por modo importa desde que cada estrategia puede correr en un modo distinto: si el
   * direccional en papel gastara del mismo contador que el arbitraje real, unas operaciones ficticias
   * agotarian el presupuesto del dinero de verdad y frenarian lo unico que gana.
   *
   * Las entradas viejas se guardaron solo por dia, sin modo. Se siguen leyendo como respaldo para no
   * perder el gasto ya acumulado hoy al actualizar; el dia del cambio ambos modos ven ese resto, que
   * sobreestima el gasto y por tanto se equivoca del lado prudente.
   */
  getDailySpend(nowMs = Date.now(), timeZone?: string, mode?: Mode): number {
    this.assertLoaded();
    const day = dailySpendKey(nowMs, timeZone ?? this.timeZone);
    const legacy = this.state.dailySpendUsd[day] ?? 0;
    if (mode) {
      return (this.state.dailySpendUsd[modeDailySpendKey(mode, day)] ?? 0) + legacy;
    }
    let total = legacy;
    for (const mode of MODES) {
      total += this.state.dailySpendUsd[modeDailySpendKey(mode, day)] ?? 0;
    }
    return total;
  }

  getPnlResetAtMs(): Partial<Record<Mode, number>> {
    this.assertLoaded();
    return { ...(this.state.pnlResetAtMs ?? {}) };
  }

  getRiskHaltResetAtMs(): Partial<Record<Mode, number>> {
    this.assertLoaded();
    return { ...(this.state.riskHaltResetAtMs ?? {}) };
  }

  getSnapshot(): BotState {
    this.assertLoaded();
    return structuredClone(this.state);
  }

  async saveOpening(opening: WindowOpening): Promise<void> {
    this.assertLoaded();
    // Union in any openings another instance persisted since we loaded, so an opening write never
    // drops openings this in-memory copy didn't know about (the same "stale in-memory save" hazard
    // the pnl_reset reconciliation guards against). Then bound growth by pruning old ones.
    await this.reconcileOpeningsFromDisk();
    this.state.openings[opening.slug] = opening;
    this.pruneOpenings(opening.windowStartMs);
    await this.save();
  }

  private pruneOpenings(nowMs: number): void {
    const cutoff = nowMs - OPENINGS_RETENTION_MS;
    for (const [slug, opening] of Object.entries(this.state.openings)) {
      if (opening.windowStartMs < cutoff) {
        delete this.state.openings[slug];
      }
    }
  }

  private async reconcileOpeningsFromDisk(): Promise<void> {
    let contents: string;
    try {
      contents = await readFile(this.statePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw error;
    }
    let parsed: BotState;
    try {
      parsed = JSON.parse(contents) as BotState;
    } catch {
      return;
    }
    for (const [slug, opening] of Object.entries(parsed.openings ?? {})) {
      // In-memory wins for a slug we already hold; only fill in ones we're missing.
      if (!(slug in this.state.openings) && opening) {
        this.state.openings[slug] = opening;
      }
    }
  }

  async recordTradeAttempt(trade: TradeAttempt): Promise<void> {
    this.assertLoaded();
    this.state.tradedMarkets[tradeStateKey(trade.mode, trade.slug, trade.entryKind, trade.reentry)] = trade;
    const key = modeDailySpendKey(trade.mode, dailySpendKey(trade.createdAtMs, this.timeZone));
    this.state.dailySpendUsd[key] = (this.state.dailySpendUsd[key] ?? 0) + trade.amountUsd;
    await this.save();
    await this.appendTradeEvent({ type: "trade_attempt", trade });
  }

  async recordTradeReconciliation(trade: TradeAttempt): Promise<void> {
    this.assertLoaded();
    const key =
      this.findTradeKeyById(trade.id) ?? this.findTradeKey(trade.slug, trade.mode, trade.entryKind, trade.reentry);
    if (!key) {
      return;
    }
    this.state.tradedMarkets[key] = trade;
    await this.save();
    await this.appendTradeEvent({ type: "trade_reconciliation", trade });
  }

  /**
   * Apunta la VENTA anticipada sobre la fila que la sufrio.
   *
   * Solo por `id`, sin respaldo por slug: una ventana puede tener varias filas —los dos tramos y las
   * rondas de rebalanceo— y equivocarse de fila aqui no da un error, da un P&L que cuadra en el total
   * pero miente en cada linea. El llamador siempre tiene el id, porque acaba de leer la posicion.
   *
   * NO toca `dailySpendUsd`: ese contador mide gasto BRUTO y un rebalanceo gasta de verdad dos veces.
   * Devolver el dinero de la venta al presupuesto convertiria el limite diario en algo que no frena
   * nada mientras las ventas cubran las compras.
   */
  async recordTradeExit(tradeId: string, exit: NonNullable<TradeAttempt["exit"]>): Promise<void> {
    this.assertLoaded();
    const key = this.findTradeKeyById(tradeId);
    const trade = key ? this.state.tradedMarkets[key] : undefined;
    if (!trade) {
      return;
    }
    trade.exit = exit;
    await this.save();
    await this.appendTradeEvent({ type: "trade_exit", trade, exit });
  }

  /**
   * `tradeId` es opcional por compatibilidad con los llamadores viejos, pero los del bucle lo pasan
   * SIEMPRE: es lo unico que distingue las dos entradas de una misma ventana.
   */
  async recordTradeResolution(
    slug: string,
    resolution: NonNullable<TradeAttempt["resolved"]>,
    mode?: Mode,
    tradeId?: string,
  ): Promise<void> {
    this.assertLoaded();
    const key = (tradeId ? this.findTradeKeyById(tradeId) : undefined) ?? this.findTradeKey(slug, mode);
    const trade = key ? this.state.tradedMarkets[key] : undefined;
    if (!trade) {
      return;
    }
    trade.resolved = resolution;
    await this.save();
    await this.appendTradeEvent({ type: "trade_resolution", trade, resolution });
  }

  async recordSimResolution(slug: string, resolution: NonNullable<TradeAttempt["resolved"]>): Promise<void> {
    await this.recordTradeResolution(slug, resolution, "sim");
  }

  /**
   * Persist the OFFICIAL Polymarket outcome check for a live trade. When it contradicts the feed-based
   * resolution, the resolution itself is overwritten too (the official result is who pays).
   */
  async recordTradeOfficialResolution(
    slug: string,
    mode: Mode,
    officialResolution: NonNullable<TradeAttempt["officialResolution"]>,
    tradeId?: string,
  ): Promise<void> {
    this.assertLoaded();
    const key = (tradeId ? this.findTradeKeyById(tradeId) : undefined) ?? this.findTradeKey(slug, mode);
    const trade = key ? this.state.tradedMarkets[key] : undefined;
    if (!trade || !trade.resolved) {
      return;
    }
    trade.officialResolution = officialResolution;
    if (officialResolution.corrected) {
      trade.resolved = {
        ...trade.resolved,
        winningOutcome: officialResolution.winningOutcome,
        won: officialResolution.winningOutcome === trade.outcome,
      };
    }
    await this.save();
    await this.appendTradeEvent({ type: "trade_official_resolution", trade, officialResolution });
  }

  async resetPnl(mode: Mode, resetAtMs = Date.now()): Promise<void> {
    this.assertLoaded();
    this.state.pnlResetAtMs = {
      ...(this.state.pnlResetAtMs ?? {}),
      [mode]: resetAtMs,
    };
    await this.save();
    await this.appendTradeEvent({ type: "pnl_reset", mode, resetAtMs });
  }

  async resetRiskHalt(mode: Mode, resetAtMs = Date.now()): Promise<void> {
    this.assertLoaded();
    this.state.riskHaltResetAtMs = {
      ...(this.state.riskHaltResetAtMs ?? {}),
      [mode]: resetAtMs,
    };
    await this.save();
  }

  /**
   * La ranura EXACTA de una operacion ya guardada.
   *
   * El `id` manda cuando se conoce, y no es un detalle: con dos tramos en la misma ventana hay dos
   * filas con el mismo slug y el mismo modo, y el barrido de abajo devuelve siempre la PRIMERA. Sin
   * esta rama, resolver la segunda entrada escribiria sobre la primera y la segunda se quedaria
   * `pending` para siempre — envenenando `openStakeUsd`, que es lo que impide que el tramo de
   * conviccion vuelva a apostar el capital ya comprometido.
   */
  private findTradeKeyById(id: string): string | undefined {
    return Object.entries(this.state.tradedMarkets).find(([, trade]) => trade.id === id)?.[0];
  }

  private findTradeKey(
    slug: string,
    mode?: Mode,
    entryKind?: TradeAttempt["entryKind"],
    reentry?: number,
  ): string | undefined {
    const preferredKey = mode ? tradeStateKey(mode, slug, entryKind, reentry) : undefined;
    if (preferredKey && this.state.tradedMarkets[preferredKey]) {
      return preferredKey;
    }
    const legacyTrade = this.state.tradedMarkets[slug];
    if (legacyTrade && (!mode || legacyTrade.mode === mode)) {
      return slug;
    }
    // Barrido de ultimo recurso. Con `entryKind` presente se exige que coincida: sin eso, preguntar
    // por el tramo de conviccion encontraria la fila de la banda y diria "ya operado" en falso. La
    // ronda se exige igual y por lo mismo: preguntar por la ronda 1 no puede encontrar la entrada
    // original y declararla ya operada, que dejaria la ventana sin poder reentrar nunca.
    return Object.entries(this.state.tradedMarkets).find(
      ([, trade]) =>
        trade.slug === slug &&
        (!mode || trade.mode === mode) &&
        (entryKind === undefined || (trade.entryKind ?? "banda") === entryKind) &&
        (reentry === undefined || (trade.reentry ?? 0) === reentry),
    )?.[0];
  }

  async reset(): Promise<void> {
    this.assertLoaded();
    // A reset is destructive (it wipes the full trade ledger), so archive both files first — an
    // accidental click must always be recoverable from data/backups/.
    const backupDir = join(this.dataDir, "backups", `reset-${new Date().toISOString().replaceAll(":", "-")}`);
    await mkdir(backupDir, { recursive: true });
    for (const [source, name] of [
      [this.statePath, "state.json"],
      [this.tradesPath, "trades.jsonl"],
    ] as const) {
      try {
        await copyFile(source, join(backupDir, name));
      } catch {
        // Missing file (fresh install) — nothing to back up.
      }
    }
    this.state = structuredClone(EMPTY_STATE);
    await this.save();
    await mkdir(dirname(this.tradesPath), { recursive: true });
    await writeFile(this.tradesPath, "", "utf8");
  }

  private async appendTradeEvent(event: TradeEvent): Promise<void> {
    await mkdir(dirname(this.tradesPath), { recursive: true });
    await appendFile(this.tradesPath, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`, "utf8");
  }

  private async save(): Promise<void> {
    await writeFileAtomic(this.statePath, `${JSON.stringify(this.state, null, 2)}\n`);
    await this.refreshStateFileCache();
  }

  private assertLoaded(): void {
    if (!this.loaded) {
      throw new Error("StateStore.load() must be called before use.");
    }
  }

  private async refreshStateFileCache(): Promise<void> {
    const signature = await getStateFileSignature(this.statePath);
    this.loadedSignature = signature;
    stateFileCache.set(this.statePath, { signature, state: structuredClone(this.state) });
  }
}

async function getStateFileSignature(path: string): Promise<string> {
  try {
    const stats = await stat(path, { bigint: true });
    return `${stats.size}:${stats.mtimeNs}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return "missing";
    }
    throw error;
  }
}

/**
 * Reconstruye las claves al cargar del disco.
 *
 * La clave se calcula CON `entryKind`, y no es cosmetico: sin el, las dos filas de una misma ventana
 * —la banda y la conviccion— colapsan en la misma ranura y la segunda BORRA a la primera en cada
 * arranque. `tradeStateKey` ya lo tenia resuelto al ESCRIBIR; el que reconstruia al LEER se habia
 * quedado atras, asi que el ledger perdia una fila con solo reiniciar el proceso — y con ella su
 * P&L, que es justo lo que `openStakeUsd` necesita para no volver a comprometer capital ya gastado.
 */
function normalizeTradedMarkets(tradedMarkets: Record<string, TradeAttempt>): Record<string, TradeAttempt> {
  const normalized: Record<string, TradeAttempt> = {};
  for (const trade of Object.values(tradedMarkets)) {
    if (!trade?.slug) {
      continue;
    }
    normalized[tradeStateKey(normalizeMode(trade.mode), trade.slug, trade.entryKind, trade.reentry)] = {
      ...trade,
      mode: normalizeMode(trade.mode),
    };
  }
  return normalized;
}

function normalizeMode(mode: TradeAttempt["mode"] | undefined): Mode {
  return mode === "live" ? "live" : "sim";
}

/**
 * Ranura del ledger para una operacion.
 *
 * El tramo entra en la CLAVE, no en `trade.slug`. Es la diferencia con el apaño del arbitraje
 * (`${slug}#arb`): alli el sufijo va en el slug y por eso `verifyOfficialResolutions` no puede
 * preguntarle a Gamma por el —tiene que excluirse—. Aqui el slug se queda real y la consulta oficial
 * sigue funcionando para los dos tramos.
 *
 * `banda` y ausente producen la MISMA clave que antes de existir este campo, asi que las filas ya
 * guardadas en state.json se siguen encontrando sin migrar nada.
 */
function tradeStateKey(
  mode: Mode,
  slug: string,
  entryKind?: TradeAttempt["entryKind"],
  reentry?: number,
): string {
  const tramo = entryKind === "conviccion" ? "#conviccion" : "";
  // La RONDA de rebalanceo, por el mismo mecanismo y por la misma razon que el tramo: tras vender, la
  // ventana puede volver a entrar, y sin distinguir la ronda la entrada nueva pisaria a la vendida —
  // borrando su P&L, que es justamente el dato que justifica la salida.
  //
  // Ausente o 0 produce la clave de SIEMPRE, byte a byte, asi que las filas ya guardadas en
  // state.json se siguen encontrando sin migrar nada.
  const ronda = typeof reentry === "number" && reentry > 0 ? `#r${reentry}` : "";
  return `${mode}:${slug}${tramo}${ronda}`;
}

function normalizePnlResetAtMs(value: Partial<Record<Mode, number>> | undefined): Partial<Record<Mode, number>> {
  return {
    ...(isFiniteTimestamp(value?.sim) ? { sim: value.sim } : {}),
    ...(isFiniteTimestamp(value?.live) ? { live: value.live } : {}),
  };
}

function isFiniteTimestamp(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value);
}

import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { writeFileAtomic } from "./atomicWrite.js";

import type { BotState, Mode, TradeAttempt, TradeEvent, WindowOpening } from "./types.js";
import { dailySpendKey } from "./time.js";

const EMPTY_STATE: BotState = {
  version: 1,
  openings: {},
  tradedMarkets: {},
  dailySpendUsd: {},
  pnlResetAtMs: {},
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

  constructor(private readonly dataDir: string) {}

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

  hasTraded(slug: string, mode?: Mode): boolean {
    this.assertLoaded();
    return this.findTradeKey(slug, mode) !== undefined;
  }

  getTradedMarket(slug: string, mode?: Mode): TradeAttempt | undefined {
    this.assertLoaded();
    const key = this.findTradeKey(slug, mode);
    return key ? this.state.tradedMarkets[key] : undefined;
  }

  listTrades(): TradeAttempt[] {
    this.assertLoaded();
    return Object.values(this.state.tradedMarkets);
  }

  getDailySpend(nowMs = Date.now()): number {
    this.assertLoaded();
    return this.state.dailySpendUsd[dailySpendKey(nowMs)] ?? 0;
  }

  getPnlResetAtMs(): Partial<Record<Mode, number>> {
    this.assertLoaded();
    return { ...(this.state.pnlResetAtMs ?? {}) };
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
    this.state.tradedMarkets[tradeStateKey(trade.mode, trade.slug)] = trade;
    const key = dailySpendKey(trade.createdAtMs);
    this.state.dailySpendUsd[key] = (this.state.dailySpendUsd[key] ?? 0) + trade.amountUsd;
    await this.save();
    await this.appendTradeEvent({ type: "trade_attempt", trade });
  }

  async recordTradeReconciliation(trade: TradeAttempt): Promise<void> {
    this.assertLoaded();
    const key = this.findTradeKey(trade.slug, trade.mode);
    if (!key) {
      return;
    }
    this.state.tradedMarkets[key] = trade;
    await this.save();
    await this.appendTradeEvent({ type: "trade_reconciliation", trade });
  }

  async recordTradeResolution(slug: string, resolution: NonNullable<TradeAttempt["resolved"]>, mode?: Mode): Promise<void> {
    this.assertLoaded();
    const key = this.findTradeKey(slug, mode);
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

  async resetPnl(mode: Mode, resetAtMs = Date.now()): Promise<void> {
    this.assertLoaded();
    this.state.pnlResetAtMs = {
      ...(this.state.pnlResetAtMs ?? {}),
      [mode]: resetAtMs,
    };
    await this.save();
    await this.appendTradeEvent({ type: "pnl_reset", mode, resetAtMs });
  }

  private findTradeKey(slug: string, mode?: Mode): string | undefined {
    const preferredKey = mode ? tradeStateKey(mode, slug) : undefined;
    if (preferredKey && this.state.tradedMarkets[preferredKey]) {
      return preferredKey;
    }
    const legacyTrade = this.state.tradedMarkets[slug];
    if (legacyTrade && (!mode || legacyTrade.mode === mode)) {
      return slug;
    }
    return Object.entries(this.state.tradedMarkets)
      .find(([, trade]) => trade.slug === slug && (!mode || trade.mode === mode))?.[0];
  }

  async reset(): Promise<void> {
    this.assertLoaded();
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

function normalizeTradedMarkets(tradedMarkets: Record<string, TradeAttempt>): Record<string, TradeAttempt> {
  const normalized: Record<string, TradeAttempt> = {};
  for (const trade of Object.values(tradedMarkets)) {
    if (!trade?.slug) {
      continue;
    }
    normalized[tradeStateKey(normalizeMode(trade.mode), trade.slug)] = {
      ...trade,
      mode: normalizeMode(trade.mode),
    };
  }
  return normalized;
}

function normalizeMode(mode: TradeAttempt["mode"] | undefined): Mode {
  return mode === "live" ? "live" : "sim";
}

function tradeStateKey(mode: Mode, slug: string): string {
  return `${mode}:${slug}`;
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

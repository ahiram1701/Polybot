import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { BotState, TradeAttempt, TradeEvent, WindowOpening } from "./types.js";
import { dailySpendKey } from "./time.js";

const EMPTY_STATE: BotState = {
  version: 1,
  openings: {},
  tradedMarkets: {},
  dailySpendUsd: {},
};

export class StateStore {
  private state: BotState = structuredClone(EMPTY_STATE);
  private loaded = false;

  constructor(private readonly dataDir: string) {}

  get statePath(): string {
    return join(this.dataDir, "state.json");
  }

  get tradesPath(): string {
    return join(this.dataDir, "trades.jsonl");
  }

  async load(): Promise<void> {
    try {
      const contents = await readFile(this.statePath, "utf8");
      const parsed = JSON.parse(contents) as BotState;
      this.state = {
        version: 1,
        openings: parsed.openings ?? {},
        tradedMarkets: parsed.tradedMarkets ?? {},
        dailySpendUsd: parsed.dailySpendUsd ?? {},
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
      this.state = structuredClone(EMPTY_STATE);
    }
    this.loaded = true;
  }

  getOpening(slug: string): WindowOpening | undefined {
    this.assertLoaded();
    return this.state.openings[slug];
  }

  hasTraded(slug: string): boolean {
    this.assertLoaded();
    return this.state.tradedMarkets[slug] !== undefined;
  }

  getTradedMarket(slug: string): TradeAttempt | undefined {
    this.assertLoaded();
    return this.state.tradedMarkets[slug];
  }

  listTrades(): TradeAttempt[] {
    this.assertLoaded();
    return Object.values(this.state.tradedMarkets);
  }

  getDailySpend(nowMs = Date.now()): number {
    this.assertLoaded();
    return this.state.dailySpendUsd[dailySpendKey(nowMs)] ?? 0;
  }

  getSnapshot(): BotState {
    this.assertLoaded();
    return structuredClone(this.state);
  }

  async saveOpening(opening: WindowOpening): Promise<void> {
    this.assertLoaded();
    this.state.openings[opening.slug] = opening;
    await this.save();
  }

  async recordTradeAttempt(trade: TradeAttempt): Promise<void> {
    this.assertLoaded();
    this.state.tradedMarkets[trade.slug] = trade;
    const key = dailySpendKey(trade.createdAtMs);
    this.state.dailySpendUsd[key] = (this.state.dailySpendUsd[key] ?? 0) + trade.amountUsd;
    await this.save();
    await this.appendTradeEvent({ type: "trade_attempt", trade });
  }

  async recordTradeReconciliation(trade: TradeAttempt): Promise<void> {
    this.assertLoaded();
    if (!this.state.tradedMarkets[trade.slug]) {
      return;
    }
    this.state.tradedMarkets[trade.slug] = trade;
    await this.save();
    await this.appendTradeEvent({ type: "trade_reconciliation", trade });
  }

  async recordTradeResolution(slug: string, resolution: NonNullable<TradeAttempt["resolved"]>): Promise<void> {
    this.assertLoaded();
    const trade = this.state.tradedMarkets[slug];
    if (!trade) {
      return;
    }
    trade.resolved = resolution;
    await this.save();
    await this.appendTradeEvent({ type: "trade_resolution", trade, resolution });
  }

  async recordSimResolution(slug: string, resolution: NonNullable<TradeAttempt["resolved"]>): Promise<void> {
    await this.recordTradeResolution(slug, resolution);
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
    await mkdir(dirname(this.statePath), { recursive: true });
    const tempPath = `${this.statePath}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(this.state, null, 2)}\n`, "utf8");
    await rename(tempPath, this.statePath);
  }

  private assertLoaded(): void {
    if (!this.loaded) {
      throw new Error("StateStore.load() must be called before use.");
    }
  }
}

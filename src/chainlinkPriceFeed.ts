import WebSocket from "ws";

import { logger } from "./logger.js";
import { getMarketDefinition, marketSymbolFromPriceFeedSymbol, SUPPORTED_MARKETS } from "./markets.js";
import type { MarketSymbol, PriceTick } from "./types.js";

type TickHandler = (tick: PriceTick) => void;

export class ChainlinkPriceFeed {
  private socket?: WebSocket;
  private pingTimer?: NodeJS.Timeout;
  private reconnectTimer?: NodeJS.Timeout;
  private stopped = true;
  private latestTick?: PriceTick;
  private lastTickAtMs = 0;
  private reconnectAttempts = 0;
  private readonly latestTicks = new Map<MarketSymbol, PriceTick>();
  private readonly recentTicks = new Map<MarketSymbol, PriceTick[]>();
  private readonly handlers = new Set<TickHandler>();

  constructor(
    private readonly url: string,
    private readonly reconnectDelayMs = 3_000,
    private readonly markets: readonly MarketSymbol[] = SUPPORTED_MARKETS,
    private readonly historyWindowMs = 10 * 60 * 1000,
    private readonly noTickTimeoutMs = 30_000,
    private readonly maxReconnectDelayMs = 30_000,
  ) {}

  start(): void {
    if (!this.stopped) {
      return;
    }
    this.stopped = false;
    this.reconnectAttempts = 0;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.clearPing();
    this.cleanupSocket();
  }

  getLatestTick(market: MarketSymbol = "BTC"): PriceTick | undefined {
    return this.latestTicks.get(market) ?? (market === "BTC" && this.latestTick?.market === "BTC" ? this.latestTick : undefined);
  }

  getTickInRange(market: MarketSymbol, startMs: number, endMs: number): PriceTick | undefined {
    return this.recentTicks.get(market)?.find((tick) => tick.timestampMs >= startMs && tick.timestampMs <= endMs);
  }

  onTick(handler: TickHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  waitForTick(timeoutMs: number, market: MarketSymbol = "BTC"): Promise<PriceTick> {
    const latestTick = this.getLatestTick(market);
    if (latestTick) {
      return Promise.resolve(latestTick);
    }

    return new Promise((resolve, reject) => {
      const unsubscribe = this.onTick((tick) => {
        if (tick.market !== market) {
          return;
        }
        clearTimeout(timeout);
        unsubscribe();
        resolve(tick);
      });

      const timeout = setTimeout(() => {
        unsubscribe();
        reject(new Error(`Timed out waiting ${timeoutMs}ms for Chainlink ${market}/USD tick.`));
      }, timeoutMs);
    });
  }

  private connect(): void {
    // Drop any previous socket (and its listeners) so only one connection is ever live.
    this.cleanupSocket();

    const socket = new WebSocket(this.url);
    this.socket = socket;
    // Give the fresh connection a grace period to deliver its first tick before the
    // watchdog considers it dead.
    this.lastTickAtMs = Date.now();

    socket.on("open", () => {
      if (this.socket !== socket) {
        socket.close();
        return;
      }
      logger.info("Connected to Polymarket RTDS Chainlink feed.");
      this.reconnectAttempts = 0;
      this.lastTickAtMs = Date.now();
      this.subscribe();
      this.startPing();
    });

    socket.on("message", (data) => {
      if (this.socket !== socket) {
        return;
      }
      this.handleRawMessage(data.toString());
    });

    socket.on("error", (error) => {
      if (this.stopped) {
        return;
      }
      logger.warn("RTDS websocket error.", { error: error.message });
    });

    socket.on("close", () => {
      if (this.socket !== socket) {
        // A newer socket already replaced this one; ignore the stale close.
        return;
      }
      this.clearPing();
      if (!this.stopped) {
        this.scheduleReconnect();
      }
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) {
      return;
    }
    this.reconnectAttempts += 1;
    const delay = Math.min(this.reconnectDelayMs * 2 ** (this.reconnectAttempts - 1), this.maxReconnectDelayMs);
    logger.warn("RTDS websocket closed; reconnecting soon.", {
      attempt: this.reconnectAttempts,
      delayMs: delay,
    });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, delay);
  }

  private cleanupSocket(): void {
    if (!this.socket) {
      return;
    }
    const socket = this.socket;
    this.socket = undefined;
    socket.removeAllListeners();
    try {
      socket.terminate();
    } catch {
      // ignore teardown errors
    }
  }

  private subscribe(markets: readonly MarketSymbol[] = this.markets): void {
    if (markets.length === 0) {
      return;
    }

    this.socket?.send(
      JSON.stringify({
        action: "subscribe",
        subscriptions: markets.map((market) => ({
          topic: "crypto_prices_chainlink",
          type: "*",
          filters: JSON.stringify({ symbol: getMarketDefinition(market).priceFeedSymbol }),
        })),
      }),
    );
  }

  private startPing(): void {
    this.clearPing();
    this.pingTimer = setInterval(() => {
      const socket = this.socket;
      if (socket?.readyState !== WebSocket.OPEN) {
        return;
      }
      // Watchdog: reconnect when the feed stops delivering *valid ticks* — not merely
      // any message. A flood of non-tick frames must not be mistaken for a healthy feed.
      if (this.lastTickAtMs > 0 && Date.now() - this.lastTickAtMs > this.noTickTimeoutMs) {
        logger.warn("RTDS feed delivering no ticks; forcing reconnect.", {
          inactiveMs: Date.now() - this.lastTickAtMs,
        });
        socket.close();
        return;
      }
      socket.send("PING");
    }, 5_000);
  }

  private clearPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = undefined;
    }
  }

  private handleRawMessage(raw: string): void {
    if (!raw || raw === "PONG" || raw === "PING") {
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }

    const messages = Array.isArray(parsed) ? parsed : [parsed];
    for (const message of messages) {
      for (const tick of parseChainlinkTicks(message)) {
        this.lastTickAtMs = Date.now();
        this.rememberTick(tick);
        this.latestTick = tick;
        this.latestTicks.set(tick.market, tick);
        for (const handler of this.handlers) {
          handler(tick);
        }
      }
    }
  }

  private rememberTick(tick: PriceTick): void {
    const ticks = this.recentTicks.get(tick.market) ?? [];
    const existingIndex = ticks.findIndex((item) => item.timestampMs === tick.timestampMs);
    if (existingIndex >= 0) {
      ticks[existingIndex] = tick;
    } else {
      ticks.push(tick);
    }

    const minTimestampMs = tick.timestampMs - this.historyWindowMs;
    const pruned = ticks
      .filter((item) => item.timestampMs >= minTimestampMs)
      .sort((left, right) => left.timestampMs - right.timestampMs);
    this.recentTicks.set(tick.market, pruned);
  }
}

export function parseChainlinkTick(message: unknown): PriceTick | null {
  return parseChainlinkTicks(message).at(-1) ?? null;
}

export function parseChainlinkTicks(message: unknown): PriceTick[] {
  if (!message || typeof message !== "object") {
    return [];
  }

  const record = message as Record<string, unknown>;
  if (record.topic === "crypto_prices") {
    return parseCryptoPricesTick(record);
  }

  if (record.topic !== "crypto_prices_chainlink") {
    return [];
  }

  const payload = record.payload as Record<string, unknown> | undefined;
  if (!payload) {
    return [];
  }

  return asTickArray(parseTickPoint(payload.symbol, payload.value, payload.timestamp));
}

function parseCryptoPricesTick(record: Record<string, unknown>): PriceTick[] {
  const payload = record.payload as Record<string, unknown> | undefined;
  if (!payload) {
    return [];
  }

  const data = Array.isArray(payload.data) ? payload.data : undefined;
  if (data) {
    return data
      .flatMap((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) {
          return [];
        }
        const point = item as Record<string, unknown>;
        return asTickArray(parseTickPoint(payload.symbol, point.value, point.timestamp));
      })
      .sort((left, right) => left.timestampMs - right.timestampMs);
  }

  return asTickArray(parseTickPoint(payload.symbol, payload.value, payload.timestamp));
}

function parseTickPoint(symbolValue: unknown, valueValue: unknown, timestampValue: unknown): PriceTick | null {
  const symbol = String(symbolValue ?? "").toLowerCase();
  const market = marketSymbolFromPriceFeedSymbol(symbol);
  const value = Number(valueValue);
  const timestampMs = Number(timestampValue);
  if (!market || !Number.isFinite(value) || !Number.isFinite(timestampMs)) {
    return null;
  }

  return {
    market,
    symbol: symbol as PriceTick["symbol"],
    value,
    timestampMs,
    receivedAtMs: Date.now(),
  };
}

function asTickArray(tick: PriceTick | null): PriceTick[] {
  return tick ? [tick] : [];
}

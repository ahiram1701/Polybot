import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ExecutionInput } from "../src/executionEngine.js";
import type { BotConfig, MarketInfo, WindowOpening } from "../src/types.js";

const mocks = vi.hoisted(() => {
  const transport = { kind: "http-transport" };
  const account = { address: "0x1111111111111111111111111111111111111111" };
  const signer = { account };
  const polygon = { id: 137, name: "Polygon" };
  const apiCreds = { key: "key", secret: "secret", passphrase: "passphrase" };
  const createOrDeriveApiKey = vi.fn(async () => apiCreds);
  const createAndPostMarketOrder = vi.fn(async (): Promise<Record<string, unknown>> => ({ status: "matched", orderID: "order-1" }));
  const cancelOrder = vi.fn(async () => ({ canceled: true }));
  const clobClient = vi.fn(function ClobClient() {
    return {
      createOrDeriveApiKey,
      createAndPostMarketOrder,
      cancelOrder,
    };
  });

  return {
    account,
    signer,
    polygon,
    transport,
    apiCreds,
    createWalletClient: vi.fn(() => signer),
    http: vi.fn(() => transport),
    privateKeyToAccount: vi.fn(() => account),
    clobClient,
    createOrDeriveApiKey,
    createAndPostMarketOrder,
  };
});

vi.mock("viem", () => ({
  createWalletClient: mocks.createWalletClient,
  http: mocks.http,
}));

vi.mock("viem/accounts", () => ({
  privateKeyToAccount: mocks.privateKeyToAccount,
}));

vi.mock("viem/chains", () => ({
  polygon: mocks.polygon,
}));

vi.mock("@polymarket/clob-client-v2", () => ({
  Chain: { POLYGON: 137 },
  ClobClient: mocks.clobClient,
  OrderType: { FAK: "FAK" },
  Side: { BUY: "BUY" },
}));

describe("LiveExecutionEngine", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("builds the viem signer with the configured Polygon RPC URL", async () => {
    const { LiveExecutionEngine } = await import("../src/executionEngine.js");
    const engine = new LiveExecutionEngine(baseConfig());

    await engine.execute(baseInput());

    expect(mocks.http).toHaveBeenCalledWith("https://rpc.example/polygon");
    expect(mocks.createWalletClient).toHaveBeenCalledWith({
      account: mocks.account,
      chain: mocks.polygon,
      transport: mocks.transport,
    });
    expect(mocks.clobClient).toHaveBeenCalledTimes(2);
    expect(mocks.clobClient).toHaveBeenNthCalledWith(
      1,
      expect.not.objectContaining({
        throwOnError: true,
      }),
    );
    expect(mocks.clobClient).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        creds: mocks.apiCreds,
        throwOnError: true,
      }),
    );
    expect(mocks.createAndPostMarketOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        tokenID: "up-token",
        amount: 5,
        // Priced near the best-ask (0.91 + 0.02 tolerance), NOT at the 0.98 cap — anti-slippage.
        price: 0.93,
      }),
      expect.objectContaining({
        tickSize: "0.01",
        negRisk: false,
      }),
      "FAK",
    );
  });

  it("stores live fill details from the CLOB response", async () => {
    mocks.createAndPostMarketOrder.mockResolvedValueOnce({
      success: true,
      errorMsg: "",
      status: "matched",
      orderID: "order-2",
      makingAmount: "5000000",
      takingAmount: "5494500",
      transactionsHashes: ["0xhash"],
      tradeIDs: ["trade-1"],
    });
    const { LiveExecutionEngine } = await import("../src/executionEngine.js");
    const engine = new LiveExecutionEngine(baseConfig());

    const trade = await engine.execute(baseInput());

    expect(trade.fillDetected).toBe(true);
    expect(trade.entryWindowSeconds).toBe(20);
    expect(trade.filledAmountUsd).toBe(5);
    expect(trade.filledShares).toBe(5.4945);
    expect(trade.averageFillPrice).toBeCloseTo(0.91);
    expect(trade.fillSource).toBe("order_response");
    expect(trade.tradeIds).toEqual(["trade-1"]);
  });
});

function baseConfig(): BotConfig {
  return {
    mode: "live",
    confirmLive: true,
    minBtcDistanceUsd: 20,
    enabledMarkets: ["BTC"],
    minDistanceUsdByMarket: { BTC: 20, ETH: 5, DOGE: 0.0005 },
    entryWindowSeconds: 20,
    entryWindowSecondsByMarket: { BTC: 20, ETH: 20, DOGE: 20 },
    simTradeAmountUsd: 1,
    liveTradeAmountUsd: 1,
    autoMinLive: true,
    maxAskPrice: 0.98,
    dailySpendLimitUsd: 50,
    tickStaleMs: 10_000,
    pollIntervalMs: 1_000,
    openingCaptureGraceMs: 15_000,
    dataDir: "data",
    gammaHost: "https://gamma-api.polymarket.com",
    clobHost: "https://clob.polymarket.com",
    rtdsUrl: "wss://ws-live-data.polymarket.com",
    polygonRpcUrl: "https://rpc.example/polygon",
    privateKey: `0x${"1".repeat(64)}` as `0x${string}`,
    signatureType: 0,
    funderAddress: `0x${"2".repeat(40)}` as `0x${string}`,
  };
}

function baseInput(): ExecutionInput {
  const windowStartMs = Date.UTC(2026, 4, 7, 8, 45);
  const market: MarketInfo = {
    asset: "BTC",
    slug: "btc-updown-5m-1778143500",
    title: "Bitcoin Up or Down",
    conditionId: "0xcondition",
    windowStartMs,
    endMs: windowStartMs + 300_000,
    eventStartTimeMs: windowStartMs,
    acceptingOrders: true,
    active: true,
    closed: false,
    tickSize: "0.01",
    negRisk: false,
    orderMinSize: 5,
    outcomes: {
      UP: { outcome: "UP", label: "Up", tokenId: "up-token" },
      DOWN: { outcome: "DOWN", label: "Down", tokenId: "down-token" },
    },
  };
  const opening: WindowOpening = {
    asset: "BTC",
    slug: market.slug,
    windowStartMs,
    openingPrice: 81_247,
    openingTickTimestampMs: windowStartMs,
    capturedAtMs: windowStartMs,
  };

  return {
    market,
    outcome: "UP",
    amountUsd: 5,
    maxAskPrice: 0.98,
    quote: {
      tokenId: "up-token",
      bestAsk: 0.91,
      availableUsdUnderCap: 100,
      estimatedSharesForAmount: 5.49,
      rawAskLevels: [],
    },
    opening,
    tick: {
      market: "BTC",
      symbol: "btc/usd",
      value: 81_270,
      timestampMs: windowStartMs + 290_000,
      receivedAtMs: windowStartMs + 290_000,
    },
    distanceUsd: 23,
    entryWindowSeconds: 20,
  };
}

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ExecutionInput, ExitExecutionInput } from "../src/executionEngine.js";
import type { BotConfig, MarketInfo, WindowOpening } from "../src/types.js";

/** Nunca el `data/` real: un test no debe poder escribir en produccion. */
const TEST_DATA_DIR = mkdtempSync(join(tmpdir(), "polybot-test-data-"));

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
    cancelOrder,
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
  // SELL tiene que estar aqui. Sin el, `Side.SELL` es `undefined`, la orden viaja SIN LADO al
  // exchange y este test pasa verde igual: el mock no valida nada. Es el agujero mas peligroso de
  // todo el camino de venta, porque solo se descubre con dinero real.
  Side: { BUY: "BUY", SELL: "SELL" },
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

  describe("venta", () => {
    it("manda un SELL con PARTICIPACIONES, no con dolares", async () => {
      // El fallo que ningun tipo puede atrapar: `amount` es `number` en los dos lados, asi que pasar
      // los dolares en vez de las participaciones compila igual de bien y vende una cantidad
      // completamente distinta de la que se pretendia.
      const { LiveExecutionEngine } = await import("../src/executionEngine.js");
      const engine = new LiveExecutionEngine(baseConfig());

      await engine.sell(baseExitInput());

      expect(mocks.createAndPostMarketOrder).toHaveBeenCalledWith(
        expect.objectContaining({
          tokenID: "up-token",
          side: "SELL",
          // 12,5 participaciones. NO los ~$8,5 que valen.
          amount: 12.5,
          // Precio pegado al mejor bid (0,68) menos la tolerancia de 0,02, redondeado a tick.
          price: 0.66,
        }),
        expect.objectContaining({ tickSize: "0.01", negRisk: false }),
        "FAK",
      );
    });

    it("lee el llenado con el mapeo de VENTA, no con el de compra", async () => {
      // makingAmount son las participaciones ENTREGADAS y takingAmount los dolares RECIBIDOS: al
      // reves que en una compra. Con el resumen de compra, esta venta de $8,50 se apuntaria como
      // 8,5 participaciones y 12,5 dolares.
      mocks.createAndPostMarketOrder.mockResolvedValueOnce({
        success: true,
        status: "matched",
        orderID: "order-sell",
        makingAmount: "12500000",
        takingAmount: "8500000",
        tradeIDs: ["trade-sell"],
      });
      const { LiveExecutionEngine } = await import("../src/executionEngine.js");
      const engine = new LiveExecutionEngine(baseConfig());

      const exit = await engine.sell(baseExitInput());

      expect(exit.soldShares).toBe(12.5);
      expect(exit.proceedsUsd).toBe(8.5);
      expect(exit.averageExitPrice).toBeCloseTo(0.68, 6);
      expect(exit.tradeIds).toEqual(["trade-sell"]);
    });

    it("cancela una venta que se queda viva en el libro", async () => {
      // Una FAK que queda `live` no es una venta: es una orden en reposo que nadie va a vigilar.
      mocks.createAndPostMarketOrder.mockResolvedValueOnce({ status: "live", orderID: "order-viva" });
      const { LiveExecutionEngine } = await import("../src/executionEngine.js");
      const engine = new LiveExecutionEngine(baseConfig());

      const exit = await engine.sell(baseExitInput());

      expect(mocks.cancelOrder).toHaveBeenCalledWith({ orderID: "order-viva" });
      expect(exit.soldShares).toBe(0);
    });

    it("el error de venta expone el BID que se miro, no un ask inventado", async () => {
      // Meter un bid en el campo `quotedBestAsk` de la compra daria un diagnostico que miente sobre
      // que precio se estaba mirando, que es peor que no tener diagnostico.
      mocks.createAndPostMarketOrder.mockRejectedValueOnce(new Error("no liquidity"));
      const { LiveExecutionEngine, LiveExitError } = await import("../src/executionEngine.js");
      const engine = new LiveExecutionEngine(baseConfig());

      const error = await engine.sell(baseExitInput()).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(LiveExitError);
      expect((error as InstanceType<typeof LiveExitError>).details).toMatchObject({
        quotedBestBid: 0.68,
        quotedBidDepthUsd: 340,
        shares: 12.5,
        orderPrice: 0.66,
        tokenId: "up-token",
      });
    });

    it("el precio limite nunca baja del suelo", async () => {
      const { LiveExecutionEngine } = await import("../src/executionEngine.js");
      const engine = new LiveExecutionEngine(baseConfig());

      await engine.sell({ ...baseExitInput(), minBidPrice: 0.67 });

      expect(mocks.createAndPostMarketOrder).toHaveBeenCalledWith(
        expect.objectContaining({ price: 0.67 }),
        expect.anything(),
        "FAK",
      );
    });
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
    dataDir: TEST_DATA_DIR,
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
      availableUsdAllLevels: 100,
      estimatedSharesForAmount: 5.49,
      rawAskLevels: [],
      rawBidLevels: [],
      availableBidUsdAllLevels: 0,
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

function baseExitInput(): ExitExecutionInput {
  const { market } = baseInput();
  return {
    market,
    outcome: "UP",
    // 12,5 participaciones: lo que dan $10 comprados a 0,80.
    shares: 12.5,
    quote: {
      tokenId: "up-token",
      quotedAtMs: Date.now() - 500,
      bestAsk: 0.7,
      bestBid: 0.68,
      availableUsdUnderCap: 100,
      availableUsdAllLevels: 100,
      estimatedSharesForAmount: 0,
      rawAskLevels: [],
      rawBidLevels: [{ price: 0.68, size: 500 }],
      availableBidUsdAllLevels: 340,
    },
    minBidPrice: 0.05,
    reason: "stop_bajo_banda",
  };
}

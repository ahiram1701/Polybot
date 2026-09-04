import { mkdtempSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AnalyticsRecorder } from "../src/analyticsRecorder.js";
import { startBandProgram } from "../src/bandProbeProgram.js";
import { PROBE_MAX_PER_MARKET_DAY } from "../src/probeWindow.js";
import { BotRunner } from "../src/botRunner.js";
import type { ChainlinkPriceFeed } from "../src/chainlinkPriceFeed.js";
import { LiveOrderError } from "../src/executionEngine.js";
import type { ExecutionInput, TradeExecutor } from "../src/executionEngine.js";
import type { TradeReconciler } from "../src/liveTradeReconciler.js";
import type { MarketWatcher } from "../src/marketWatcher.js";
import type { OrderbookService } from "../src/orderbookService.js";
import type { StateStore } from "../src/stateStore.js";
import type {
  BotConfig,
  MarketInfo,
  MarketSymbol,
  Outcome,
  StrategyAnalysisResponse,
  StrategyCandidate,
  TradeAttempt,
  WindowOpening,
} from "../src/types.js";

const arbTemps: string[] = [];

/**
 * Directorio de datos por defecto de los tests. Antes `baseConfig()` devolvia `dataDir: "data"`, que
 * resuelve al directorio de datos REAL del proyecto: cualquier test que ejercitara un camino con
 * escritura ensuciaba produccion en silencio. Paso de verdad — 12 oportunidades de arbitraje falsas
 * acabaron en `data/arb-opportunities.jsonl` y contaminaron el panel de la UI y los analisis. Ahora
 * el defecto es un temporal, asi que olvidarse de pasar `dataDir` ya no puede tocar `data/`.
 */
const TEST_DATA_DIR = mkdtempSync(join(tmpdir(), "polybot-test-data-"));

/**
 * Guardia contra el fallo que ya ocurrio: `baseConfig()` devolvia el directorio de datos REAL, asi que
 * cualquier test con un camino de escritura ensuciaba produccion sin que nada lo dijera.
 */
describe("aislamiento de los tests", () => {
  it("baseConfig() no apunta al directorio de datos real", () => {
    const dir = baseConfig().dataDir;
    expect(dir).not.toBe("data");
    expect(resolve(dir)).not.toBe(resolve(process.cwd(), "data"));
    expect(dir.startsWith(tmpdir())).toBe(true);
  });
});

describe("BotRunner", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(arbTemps.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it("keeps the continuous loop alive after a transient API failure", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    let runner!: BotRunner;
    let calls = 0;
    const watcher = {
      getCurrentMarket: vi.fn(async () => {
        calls += 1;
        if (calls === 1) {
          throw new TypeError("fetch failed");
        }
        runner.stop();
        return null;
      }),
    } as unknown as MarketWatcher;
    const priceFeed = fakePriceFeed();

    runner = new BotRunner(baseConfig(), {
      watcher,
      orderbook: {} as unknown as OrderbookService,
      priceFeed,
      state: fakeState(),
      executor: {} as TradeExecutor,
      reconciler: fakeReconciler(),
    });

    await runner.start();

    // 3 llamadas, una por mercado, TODAS en la misma iteracion: el fallo del primero ya no aborta la
    // pasada. Antes eran 4 porque la excepcion tumbaba la iteracion entera y habia que empezar otra —
    // ~6s de ceguera (timeout + sleep) en los que se perdian apertura, analitica, arbitraje y entrada
    // de los tres mercados por culpa de uno.
    expect(watcher.getCurrentMarket).toHaveBeenCalledTimes(3);
    expect(priceFeed.stop).toHaveBeenCalled();
  });

  it("still surfaces one-shot failures to callers", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const watcher = {
      getCurrentMarket: vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    } as unknown as MarketWatcher;
    const priceFeed = fakePriceFeed();
    const runner = new BotRunner(baseConfig(), {
      watcher,
      orderbook: {} as unknown as OrderbookService,
      priceFeed,
      state: fakeState(),
      executor: {} as TradeExecutor,
      reconciler: fakeReconciler(),
    });

    await expect(runner.start({ once: true })).rejects.toThrow("fetch failed");
    expect(priceFeed.stop).toHaveBeenCalledTimes(1);
  });

  it("does not stop a borrowed (shared) price feed", () => {
    const priceFeed = fakePriceFeed();
    const runner = BotRunner.create(baseConfig(), { priceFeed });

    runner.stop();

    expect(priceFeed.stop).not.toHaveBeenCalled();
  });

  it("can trade BTC, ETH, and DOGE in the same iteration", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const windowStartMs = Date.UTC(2026, 4, 7, 4, 25, 0, 0);
    const nowMs = windowStartMs + 290_000;
    const markets: Partial<Record<MarketSymbol, MarketInfo>> = {
      BTC: marketInfo("BTC", "btc", windowStartMs),
      ETH: marketInfo("ETH", "eth", windowStartMs),
      DOGE: marketInfo("DOGE", "doge", windowStartMs),
    };
    const openings = new Map(
      Object.values(markets).map((market) => [
        market.slug,
        {
          asset: market.asset,
          slug: market.slug,
          windowStartMs,
          openingPrice: market.asset === "DOGE" ? 0.1 : 100,
          openingTickTimestampMs: windowStartMs,
          capturedAtMs: windowStartMs,
        },
      ]),
    );
    const trades: TradeAttempt[] = [];
    const watcher = {
      getCurrentMarket: vi.fn(async (_nowMs: number, market: MarketSymbol = "BTC") => markets[market] ?? null),
    } as unknown as MarketWatcher;
    const priceFeed = {
      start: vi.fn(),
      stop: vi.fn(),
      getLatestTick: vi.fn((market: MarketSymbol = "BTC") => ({
        market,
        symbol: priceFeedSymbol(market),
        value: market === "DOGE" ? 0.1007 : 130,
        timestampMs: nowMs,
        receivedAtMs: nowMs,
      })),
    } as unknown as ChainlinkPriceFeed;
    const state = {
      load: vi.fn(async () => undefined),
      listTrades: vi.fn(() => []),
      getOpening: vi.fn((slug: string) => openings.get(slug)),
      hasTraded: vi.fn(() => false),
      getDailySpend: vi.fn(() => 0),
      recordTradeAttempt: vi.fn(async (trade: TradeAttempt) => {
        trades.push(trade);
      }),
    } as unknown as StateStore;
    const executor = {
      execute: vi.fn(async (input: ExecutionInput) => ({
        id: `${input.market.slug}-${input.outcome}`,
        asset: input.market.asset,
        slug: input.market.slug,
        mode: "sim" as const,
        conditionId: input.market.conditionId,
        outcome: input.outcome,
        tokenId: input.market.outcomes[input.outcome].tokenId,
        amountUsd: input.amountUsd,
        maxAskPrice: 0.98,
        bestAsk: input.quote.bestAsk,
        estimatedShares: input.quote.estimatedSharesForAmount,
        openingPrice: input.opening.openingPrice,
        entryPrice: input.tick.value,
        distanceUsd: input.distanceUsd,
        entryWindowSeconds: input.entryWindowSeconds,
        windowStartMs: input.market.windowStartMs,
        endMs: input.market.endMs,
        createdAtMs: nowMs,
      })),
    } satisfies TradeExecutor;

    const runner = new BotRunner(
      {
        ...baseConfig(),
        enabledMarkets: ["BTC", "ETH", "DOGE"],
        minDistanceUsdByMarket: { BTC: 20, ETH: 5, DOGE: 0.0005 },
      },
      {
        watcher,
        orderbook: fakeOrderbook(),
        priceFeed,
        state,
        executor,
        reconciler: fakeReconciler(),
      },
    );

    await runner.runOnce(nowMs);

    expect(executor.execute).toHaveBeenCalledTimes(3);
    expect(trades.map((trade) => trade.asset)).toEqual(["BTC", "ETH", "DOGE"]);
  });

  it("skips entries below the configured ask floor (cheap reversal bets)", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const windowStartMs = Date.UTC(2026, 4, 7, 4, 25, 0, 0);
    const nowMs = windowStartMs + 290_000;
    const market = marketInfo("ETH", "eth", windowStartMs);
    const opening = {
      asset: market.asset,
      slug: market.slug,
      windowStartMs,
      openingPrice: 100,
      openingTickTimestampMs: windowStartMs,
      capturedAtMs: windowStartMs,
    };
    const watcher = {
      getCurrentMarket: vi.fn(async (_n: number, m: MarketSymbol = "BTC") => (m === "ETH" ? market : null)),
    } as unknown as MarketWatcher;
    const priceFeed = {
      start: vi.fn(),
      stop: vi.fn(),
      getLatestTick: vi.fn((m: MarketSymbol = "BTC") => ({
        market: m,
        symbol: priceFeedSymbol(m),
        value: 130,
        timestampMs: nowMs,
        receivedAtMs: nowMs,
      })),
    } as unknown as ChainlinkPriceFeed;
    const state = {
      load: vi.fn(async () => undefined),
      listTrades: vi.fn(() => []),
      getOpening: vi.fn(() => opening),
      hasTraded: vi.fn(() => false),
      getDailySpend: vi.fn(() => 0),
      recordTradeAttempt: vi.fn(async () => undefined),
    } as unknown as StateStore;
    const executor = {
      execute: vi.fn(async (input: ExecutionInput) => ({
        id: `${input.market.slug}-${input.outcome}`,
        asset: input.market.asset,
        slug: input.market.slug,
        mode: "sim" as const,
        conditionId: input.market.conditionId,
        outcome: input.outcome,
        tokenId: input.market.outcomes[input.outcome].tokenId,
        amountUsd: input.amountUsd,
        maxAskPrice: 0.98,
        bestAsk: input.quote.bestAsk,
        estimatedShares: input.quote.estimatedSharesForAmount,
        openingPrice: input.opening.openingPrice,
        entryPrice: input.tick.value,
        distanceUsd: input.distanceUsd,
        entryWindowSeconds: input.entryWindowSeconds,
        windowStartMs: input.market.windowStartMs,
        endMs: input.market.endMs,
        createdAtMs: nowMs,
      })),
    } satisfies TradeExecutor;

    const config = {
      ...baseConfig(),
      enabledMarkets: ["ETH"] as MarketSymbol[],
      minDistanceUsdByMarket: { BTC: 20, ETH: 5, DOGE: 0.0005 },
      minAskPriceByMarketOutcome: {
        BTC: { UP: 0.01, DOWN: 0.01 },
        ETH: { UP: 0.3, DOWN: 0.3 },
        DOGE: { UP: 0.01, DOWN: 0.01 },
      },
    };

    // Ask 0.15 < piso 0.30 -> no debe operar.
    const cheap = new BotRunner(config, {
      watcher,
      orderbook: fakeOrderbook(0.15),
      priceFeed,
      state,
      executor,
      reconciler: fakeReconciler(),
    });
    await cheap.runOnce(nowMs);
    expect(executor.execute).not.toHaveBeenCalled();

    // Ask 0.45 dentro de la ventana -> sí opera.
    const inWindow = new BotRunner(config, {
      watcher,
      orderbook: fakeOrderbook(0.45),
      priceFeed,
      state,
      executor,
      reconciler: fakeReconciler(),
    });
    await inWindow.runOnce(nowMs);
    expect(executor.execute).toHaveBeenCalledTimes(1);
  });

  describe("la estrategia favorito ve el libro durante toda la ventana", () => {
    // El favorito ELIGE lado con los libros de la fase de captura. Mientras esos solo se pedian en los
    // ultimos ANALYTICS_WINDOW_SECONDS (120 de 300), abrir la ventana de entrada no servia de nada: el
    // selector recibia un mapa de quotes vacio y registraba favorite_missing_quote en bucle.
    /** Libro con asks DISTINTOS por lado: sin eso los dos empatan y el selector dice `no_favorite`. */
    function libroConFavorito(upAsk: number, downAsk: number): OrderbookService {
      return {
        getQuote: vi.fn(async (tokenId: string) => {
          const ask = tokenId.endsWith("-up") ? upAsk : downAsk;
          return {
            tokenId,
            bestAsk: ask,
            bestBid: ask - 0.01,
            availableUsdUnderCap: 100,
            availableUsdAllLevels: 100,
            estimatedSharesForAmount: 1 / ask,
            rawAskLevels: [],
            rawBidLevels: [],
            availableBidUsdAllLevels: 100,
          };
        }),
      } as unknown as OrderbookService;
    }

    function escenarioTemprano(overrides: Partial<BotConfig> = {}, upAsk = 0.8, downAsk = 0.32) {
      const windowStartMs = Date.UTC(2026, 4, 7, 4, 25, 0, 0);
      // t+50s: quedan 250s, MUY fuera de la ventana de analitica de 120s.
      const nowMs = windowStartMs + 50_000;
      const market = marketInfo("BTC", "btc", windowStartMs);
      const watcher = {
        getCurrentMarkets: vi.fn(async () => [market]),
        getCurrentMarket: vi.fn(async () => market),
      } as unknown as MarketWatcher;
      const priceFeed = {
        start: vi.fn(),
        stop: vi.fn(),
        getLatestTick: vi.fn(() => ({
          market: "BTC" as MarketSymbol,
          symbol: priceFeedSymbol("BTC"),
          value: 130,
          timestampMs: nowMs,
          receivedAtMs: nowMs,
        })),
      } as unknown as ChainlinkPriceFeed;
      const state = {
        load: vi.fn(async () => undefined),
        listTrades: vi.fn(() => []),
        getOpening: vi.fn(() => ({
          asset: "BTC" as MarketSymbol,
          slug: market.slug,
          windowStartMs,
          openingPrice: 100,
          openingTickTimestampMs: windowStartMs,
          capturedAtMs: windowStartMs,
        })),
        hasTraded: vi.fn(() => false),
        getDailySpend: vi.fn(() => 0),
        recordTradeAttempt: vi.fn(async () => undefined),
        saveOpening: vi.fn(async () => undefined),
      } as unknown as StateStore;
      const orderbook = libroConFavorito(upAsk, downAsk);
      const executor = { execute: vi.fn(async () => ({ status: "filled" })) } as unknown as TradeExecutor;
      const config: BotConfig = {
        ...baseConfig(),
        favoriteStrategyEnabled: true,
        arbEnabled: false,
        // La ventana abierta a los 300s: es el ajuste que sin el suministro temprano no hacia nada.
        entryWindowSeconds: 300,
        entryWindowSecondsByMarket: { BTC: 300, ETH: 300, DOGE: 300 },
        ...overrides,
      };
      const runner = new BotRunner(config, {
        watcher,
        orderbook,
        priceFeed,
        state,
        executor,
        reconciler: fakeReconciler(),
      });
      return { runner, orderbook, executor, nowMs };
    }

    it("pide el libro fuera de la ventana de analitica cuando el favorito esta encendido", async () => {
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      // Ventana de entrada estrecha a proposito: asi el unico que puede pedir el libro es la FASE DE
      // CAPTURA. Con la ventana abierta, el camino direccional tambien cotiza bajo demanda y las dos
      // causas quedan indistinguibles.
      const { runner, orderbook, nowMs } = escenarioTemprano({
        entryWindowSeconds: 20,
        entryWindowSecondsByMarket: { BTC: 20, ETH: 20, DOGE: 20 },
      });

      await runner.runOnce(nowMs);

      // Los dos lados: el favorito necesita el contrario para distinguir un favorito real de un libro
      // muerto, aunque solo vaya a comprar uno.
      expect(orderbook.getQuote).toHaveBeenCalledTimes(2);
    });

    it("sin favorito ni arbitraje la fase de captura sigue sin pedir libro", async () => {
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      const { runner, orderbook, nowMs } = escenarioTemprano({
        favoriteStrategyEnabled: false,
        entryWindowSeconds: 20,
        entryWindowSecondsByMarket: { BTC: 20, ETH: 20, DOGE: 20 },
      });

      await runner.runOnce(nowMs);

      expect(orderbook.getQuote).not.toHaveBeenCalled();
    });

    it("respeta la cadencia reducida: no cotiza en cada iteracion", async () => {
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      const { runner, orderbook, nowMs } = escenarioTemprano({
        entryWindowSeconds: 20,
        entryWindowSecondsByMarket: { BTC: 20, ETH: 20, DOGE: 20 },
      });

      await runner.runOnce(nowMs);
      // Un segundo despues, dentro del intervalo de 3s: no debe volver a pedir el libro. Cotizar en
      // cada iteracion durante los 300s es lo que llevo el p50 del loop de 56ms a 281ms.
      await runner.runOnce(nowMs + 1_000);
      expect(orderbook.getQuote).toHaveBeenCalledTimes(2);

      // Pasado el intervalo, vuelve a mirar.
      await runner.runOnce(nowMs + 3_500);
      expect(orderbook.getQuote).toHaveBeenCalledTimes(4);
    });

    it("opera a 250s del cierre, que con la ventana de 20s era imposible", async () => {
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      // UP a 0,80 (en banda 0,76-0,85), DOWN a 0,32: suma 1,12, por debajo del tope de libro muerto.
      const { runner, executor, nowMs } = escenarioTemprano();

      await runner.runOnce(nowMs);

      expect(executor.execute).toHaveBeenCalledTimes(1);
    });

    it("con la ventana estrecha el descarte DICE que fue la ventana", async () => {
      const logs: unknown[] = [];
      vi.spyOn(console, "log").mockImplementation((line: unknown) => {
        logs.push(line);
      });
      // Mismo libro que el test de arriba (el favorito SI entra en banda), pero con 250s por delante y
      // una ventana de 20s. Antes esto salia por un return sin motivo, asi que el panel decia "no
      // opera" y no habia forma de saber que la causa era la ventana.
      const { runner, executor, nowMs } = escenarioTemprano({
        entryWindowSeconds: 20,
        entryWindowSecondsByMarket: { BTC: 20, ETH: 20, DOGE: 20 },
      });

      await runner.runOnce(nowMs);

      expect(executor.execute).not.toHaveBeenCalled();
      expect(JSON.stringify(logs)).toContain("outside_entry_window");
    });
  });

  describe("banda y conviccion en la MISMA ventana", () => {
    // El ask cambia entre iteraciones: primero cae en la banda, luego se dispara por encima de 0,98.
    // Es el recorrido normal de un favorito que se va confirmando, y es justo el caso en el que antes
    // la banda se llevaba la unica ranura de la ventana y dejaba a la conviccion fuera.
    function escenarioDosTramos(opts: { saldoUsd: number; asks: number[] }) {
      const windowStartMs = Date.UTC(2026, 4, 7, 4, 25, 0, 0);
      const nowMs = windowStartMs + 200_000;
      const market = marketInfo("BTC", "btc", windowStartMs);
      let paso = 0;
      const askActual = () => opts.asks[Math.min(paso, opts.asks.length - 1)];
      const abiertas: TradeAttempt[] = [];
      const operados = new Set<string>();
      const executed: Array<{ amountUsd: number; entryKind?: string }> = [];

      const orderbook = {
        getQuote: vi.fn(async (tokenId: string, amountUsd: number) => {
          const up = askActual();
          const ask = tokenId.endsWith("-up") ? up : Math.round((1 - up) * 100) / 100;
          return {
            tokenId,
            bestAsk: ask,
            bestBid: ask - 0.01,
            availableUsdUnderCap: 5_000,
            availableUsdAllLevels: 5_000,
            estimatedSharesForAmount: amountUsd / ask,
            estimatedAveragePrice: ask,
            rawAskLevels: [{ price: ask, size: 1_000 }],
            rawBidLevels: [],
            availableBidUsdAllLevels: 0,
          };
        }),
      } as unknown as OrderbookService;

      const runner = new BotRunner(
        {
          ...baseConfig(),
          favoriteStrategyEnabled: true,
          favoriteMinAsk: 0.79,
          favoriteMaxAsk: 0.9,
          favoriteMaxSizeEnabled: true,
          favoriteMaxSizeAsk: 0.98,
          maxAskPrice: 0.99,
          maxAskPriceCeiling: 0.99,
          autoMinLive: true,
          dailySpendLimitUsd: 100_000,
          entryWindowSeconds: 150,
          entryWindowSecondsByMarket: { BTC: 150, ETH: 150, DOGE: 150 },
        },
        {
          watcher: {
            getCurrentMarkets: vi.fn(async () => [market]),
            getCurrentMarket: vi.fn(async () => market),
          } as unknown as MarketWatcher,
          orderbook,
          priceFeed: {
            start: vi.fn(),
            stop: vi.fn(),
            getLatestTick: vi.fn(() => ({
              market: "BTC" as MarketSymbol,
              symbol: priceFeedSymbol("BTC"),
              value: 130,
              timestampMs: nowMs,
              receivedAtMs: nowMs,
            })),
          } as unknown as ChainlinkPriceFeed,
          state: {
            load: vi.fn(async () => undefined),
            listTrades: vi.fn(() => abiertas),
            getOpening: vi.fn(() => ({
              asset: "BTC" as MarketSymbol,
              slug: market.slug,
              windowStartMs,
              openingPrice: 100,
              openingTickTimestampMs: windowStartMs,
              capturedAtMs: windowStartMs,
            })),
            hasTraded: vi.fn((slug: string, _m?: unknown, entryKind?: string) =>
              operados.has(slug + ":" + (entryKind ?? "banda")),
            ),
            getDailySpend: vi.fn(() => 0),
            recordTradeAttempt: vi.fn(async () => undefined),
            recordTradeResolution: vi.fn(async () => undefined),
            saveOpening: vi.fn(async () => undefined),
          } as unknown as StateStore,
          executor: {
            execute: vi.fn(
              async (input: { amountUsd: number; market: MarketInfo; outcome: Outcome; entryKind?: "banda" | "conviccion" }) => {
                executed.push({ amountUsd: input.amountUsd, entryKind: input.entryKind });
                operados.add(input.market.slug + ":" + (input.entryKind ?? "banda"));
                abiertas.push({
                  mode: "sim",
                  market: "BTC",
                  slug: input.market.slug,
                  outcome: input.outcome,
                  amountUsd: input.amountUsd,
                  bestAsk: askActual(),
                  estimatedShares: input.amountUsd / askActual(),
                  entryKind: input.entryKind,
                  endMs: nowMs + 3_600_000,
                } as unknown as TradeAttempt);
                return { status: "filled" };
              },
            ),
          } as unknown as TradeExecutor,
          reconciler: fakeReconciler(),
          bankrollSource: { read: vi.fn(async () => ({ usd: opts.saldoUsd, atMs: nowMs })) },
        },
      );
      return { runner, executed, nowMs, avanzar: () => { paso += 1; } };
    }

    it("entran las DOS: primero la banda, luego la conviccion", async () => {
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      const { runner, executed, nowMs, avanzar } = escenarioDosTramos({ saldoUsd: 100, asks: [0.85, 0.99] });

      // Primera pasada: solo lee el saldo (la lectura va sin await). Segunda: ask 0,85 -> banda.
      await runner.runOnce(nowMs);
      await runner.runOnce(nowMs + 1_000);
      expect(executed.map((e) => e.entryKind)).toEqual(["banda"]);

      // El ask se dispara: la ventana YA tiene una operacion, pero de otro tramo.
      avanzar();
      await runner.runOnce(nowMs + 2_000);

      expect(executed.map((e) => e.entryKind)).toEqual(["banda", "conviccion"]);
    });

    it("la conviccion descuenta lo que ya se llevo la banda", async () => {
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      const { runner, executed, nowMs, avanzar } = escenarioDosTramos({ saldoUsd: 100, asks: [0.85, 0.99] });
      await runner.runOnce(nowMs);
      await runner.runOnce(nowMs + 1_000);
      avanzar();
      await runner.runOnce(nowMs + 2_000);

      // $100 de saldo menos los $5 que ya estan atados en la entrada de banda. Es la invariante que
      // impide apostar dos veces el mismo dinero.
      const banda = executed[0].amountUsd;
      expect(executed[1].amountUsd).toBeCloseTo(100 - banda, 2);
    });

    it("una SEGUNDA entrada del mismo tramo se sigue descartando", async () => {
      const logs: unknown[] = [];
      vi.spyOn(console, "log").mockImplementation((l: unknown) => { logs.push(l); });
      const { runner, executed, nowMs } = escenarioDosTramos({ saldoUsd: 100, asks: [0.85] });
      await runner.runOnce(nowMs);
      await runner.runOnce(nowMs + 1_000);
      await runner.runOnce(nowMs + 2_000);
      await runner.runOnce(nowMs + 3_000);

      expect(executed).toHaveLength(1);
      expect(JSON.stringify(logs)).toContain("market_already_traded");
    });

    it("la conviccion NO entra si la banda no opero esa ventana", async () => {
      const logs: unknown[] = [];
      vi.spyOn(console, "log").mockImplementation((l: unknown) => { logs.push(l); });
      // El libro abre YA decidido: pasa de 0,98 sin haber estado nunca en la banda. Medido, es el
      // 19,2% de las ventanas. La conviccion dobla sobre una eleccion de la banda; sin esa eleccion
      // seria una apuesta suelta del capital entero.
      const { runner, executed, nowMs } = escenarioDosTramos({ saldoUsd: 100, asks: [0.99] });

      await runner.runOnce(nowMs);
      await runner.runOnce(nowMs + 1_000);
      await runner.runOnce(nowMs + 2_000);

      expect(executed).toHaveLength(0);
      expect(JSON.stringify(logs)).toContain("favorite_max_size_sin_banda");
    });

    it("y SI entra en cuanto la banda ha operado antes en esa ventana", async () => {
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      // Mismo libro, pero pasando primero por la banda: 0,85 -> 0,99.
      const { runner, executed, nowMs, avanzar } = escenarioDosTramos({ saldoUsd: 100, asks: [0.85, 0.99] });
      await runner.runOnce(nowMs);
      await runner.runOnce(nowMs + 1_000);
      avanzar();
      await runner.runOnce(nowMs + 2_000);

      expect(executed.map((e) => e.entryKind)).toEqual(["banda", "conviccion"]);
    });
  });

  describe("tramo de maxima conviccion: dimensionado por el saldo real", () => {
    function libroProfundo(upAsk: number, downAsk: number, profundidadUsd: number): OrderbookService {
      return {
        getQuote: vi.fn(async (tokenId: string, amountUsd: number) => {
          const ask = tokenId.endsWith("-up") ? upAsk : downAsk;
          return {
            tokenId,
            bestAsk: ask,
            bestBid: ask - 0.01,
            availableUsdUnderCap: profundidadUsd,
            availableUsdAllLevels: profundidadUsd,
            // Depende del importe PEDIDO: es lo que hace detectable una recotizacion ausente.
            estimatedSharesForAmount: amountUsd / ask,
            estimatedAveragePrice: ask,
            rawAskLevels: [{ price: ask, size: profundidadUsd / ask }],
            rawBidLevels: [],
            availableBidUsdAllLevels: 0,
          };
        }),
      } as unknown as OrderbookService;
    }

    function escenario(
      opts: {
        saldoUsd?: number;
        profundidadUsd?: number;
        limiteDiarioUsd?: number;
        mercados?: MarketSymbol[];
        /** 0,99 = tramo de conviccion (por defecto). 0,85 = banda. */
        askUp?: number;
        /** La conviccion exige banda previa; los tests de la propia banda la necesitan sin operar. */
        bandaYaOperada?: boolean;
      } = {},
    ) {
      const windowStartMs = Date.UTC(2026, 4, 7, 4, 25, 0, 0);
      const nowMs = windowStartMs + 200_000;
      const simbolos = opts.mercados ?? (["BTC"] as MarketSymbol[]);
      const operados = new Set<string>();
      // Posiciones abiertas acumuladas, como haria el StateStore real: son las que atan capital.
      const abiertas: TradeAttempt[] = [];
      // La conviccion exige que la banda YA haya operado esta ventana. Se marca sin añadir a
      // `abiertas` a proposito: estos tests miden el dimensionado, no el capital que ataria la banda.
      if (opts.bandaYaOperada !== false) {
        for (const m of simbolos) {
          operados.add(marketInfo(m, m.toLowerCase(), windowStartMs).slug + ":banda");
        }
      }
      const mercados = simbolos.map((m) => marketInfo(m, m.toLowerCase(), windowStartMs));
      const watcher = {
        getCurrentMarkets: vi.fn(async () => mercados),
        getCurrentMarket: vi.fn(async () => mercados[0]),
      } as unknown as MarketWatcher;
      const priceFeed = {
        start: vi.fn(),
        stop: vi.fn(),
        getLatestTick: vi.fn((m: MarketSymbol = "BTC") => ({
          market: m,
          symbol: priceFeedSymbol(m),
          value: 130,
          timestampMs: nowMs,
          receivedAtMs: nowMs,
        })),
      } as unknown as ChainlinkPriceFeed;
      const state = {
        load: vi.fn(async () => undefined),
        listTrades: vi.fn(() => abiertas),
        getOpening: vi.fn((slug: string) => ({
          asset: mercados.find((m) => m.slug === slug)?.asset ?? "BTC",
          slug,
          windowStartMs,
          openingPrice: 100,
          openingTickTimestampMs: windowStartMs,
          capturedAtMs: windowStartMs,
        })),
        // Con memoria, como el StateStore real: sin ella la segunda pasada vuelve a operar el mismo
        // mercado y el test mediria dos ventanas creyendo que mide una.
        hasTraded: vi.fn((slug: string, _mode?: unknown, entryKind?: string) =>
          operados.has(slug + ":" + (entryKind ?? "banda")),
        ),
        // Las abiertas: es de donde sale el capital ATADO que ya no esta disponible.
        getDailySpend: vi.fn(() => 0),
        recordTradeAttempt: vi.fn(async () => undefined),
        recordTradeResolution: vi.fn(async () => undefined),
        saveOpening: vi.fn(async () => undefined),
      } as unknown as StateStore;
      const askUp = opts.askUp ?? 0.99;
      const orderbook = libroProfundo(askUp, Math.round((1 - askUp) * 100) / 100, opts.profundidadUsd ?? 5_000);
      const executed: Array<{ amountUsd: number; entryKind?: string }> = [];
      const executor = {
        execute: vi.fn(
          async (input: { amountUsd: number; market: MarketInfo; outcome: Outcome; entryKind?: "banda" | "conviccion" }) => {
          executed.push({ amountUsd: input.amountUsd, entryKind: input.entryKind });
          operados.add(input.market.slug + ":" + (input.entryKind ?? "banda"));
          abiertas.push({
            mode: "sim",
            market: input.market.asset,
            slug: input.market.slug,
            outcome: input.outcome,
            amountUsd: input.amountUsd,
            bestAsk: askUp,
            estimatedShares: input.amountUsd / askUp,
            entryKind: input.entryKind,
            // Sin cerrar: es lo que la mantiene contando como capital atado.
            endMs: nowMs + 3_600_000,
          } as unknown as TradeAttempt);
          return { status: "filled" };
        },
        ),
      } as unknown as TradeExecutor;
      const config: BotConfig = {
        ...baseConfig(),
        favoriteStrategyEnabled: true,
        favoriteMinAsk: 0.79,
        favoriteMaxAsk: 0.9,
        favoriteMaxSizeEnabled: true,
        favoriteMaxSizeAsk: 0.98,
        // El techo tiene que dejar pasar el 0,99 o la entrada muere antes en best_ask_above_cap.
        maxAskPrice: 0.99,
        maxAskPriceCeiling: 0.99,
        // ENCENDIDO a proposito: autoMinLive es un SUSTITUTO, no un minimo. Si el tramo pasara por
        // resolveTradeAmountUsd, el tamaño saldria aplastado a orderMinSize sin decir nada.
        autoMinLive: true,
        dailySpendLimitUsd: opts.limiteDiarioUsd ?? 100_000,
        enabledMarkets: simbolos,
        enabledMarketOutcomes: {
          BTC: { UP: true, DOWN: true },
          ETH: { UP: true, DOWN: true },
          DOGE: { UP: true, DOWN: true },
        },
        entryWindowSeconds: 150,
        entryWindowSecondsByMarket: { BTC: 150, ETH: 150, DOGE: 150 },
      };
      const runner = new BotRunner(config, {
        watcher,
        orderbook,
        priceFeed,
        state,
        executor,
        reconciler: fakeReconciler(),
        // La lectura on-chain. Ausente = no se pudo leer, que NO es lo mismo que un saldo de cero.
        bankrollSource:
          opts.saldoUsd === undefined
            ? undefined
            : { read: vi.fn(async () => ({ usd: opts.saldoUsd as number, atMs: nowMs })) },
      });
      return { runner, orderbook, executor, executed, nowMs };
    }

    // Dos pasadas en cada test: la lectura del saldo se dispara SIN await, asi que la primera
    // iteracion todavia no la tiene. Es el comportamiento real, no un arreglo del test.
    it("invierte el saldo entero cuando el libro y el limite dan de sobra", async () => {
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      const { runner, executed, nowMs } = escenario({ saldoUsd: 742.5 });
      await runner.runOnce(nowMs);
      await runner.runOnce(nowMs + 1_000);
      expect(executed).toHaveLength(1);
      expect(executed[0].amountUsd).toBeCloseTo(742.5, 2);
    });

    it("autoMinLive NO aplasta el tamaño a orderMinSize", async () => {
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      const { runner, executed, nowMs } = escenario({ saldoUsd: 400 });
      await runner.runOnce(nowMs);
      await runner.runOnce(nowMs + 1_000);
      expect(executed[0]?.amountUsd).toBeGreaterThan(100);
    });

    it("la profundidad del libro manda cuando es menor que el saldo", async () => {
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      const { runner, executed, nowMs } = escenario({ saldoUsd: 5_000, profundidadUsd: 88.4 });
      await runner.runOnce(nowMs);
      await runner.runOnce(nowMs + 1_000);
      expect(executed[0]?.amountUsd).toBeCloseTo(88.4, 2);
    });

    it("el hueco del limite diario manda cuando es el mas pequeño", async () => {
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      const { runner, executed, nowMs } = escenario({ saldoUsd: 5_000, limiteDiarioUsd: 250 });
      await runner.runOnce(nowMs);
      await runner.runOnce(nowMs + 1_000);
      expect(executed[0]?.amountUsd).toBeCloseTo(250, 2);
    });

    it("un saldo ILEGIBLE para la entrada en vez de dejarla sin limite", async () => {
      const logs: unknown[] = [];
      vi.spyOn(console, "log").mockImplementation((l: unknown) => { logs.push(l); });
      // Sin bankrollSource (= sin POLYMARKET_FUNDER_ADDRESS) el saldo nunca se lee.
      const { runner, executed, nowMs } = escenario({ saldoUsd: undefined });
      await runner.runOnce(nowMs);
      await runner.runOnce(nowMs + 1_000);
      expect(executed).toHaveLength(0);
      expect(JSON.stringify(logs)).toContain("favorite_max_size_bankroll_unknown");
    });

    it("un saldo LEIDO de cero tambien para, y por su propio motivo", async () => {
      const logs: unknown[] = [];
      vi.spyOn(console, "log").mockImplementation((l: unknown) => { logs.push(l); });
      const { runner, executed, nowMs } = escenario({ saldoUsd: 0 });
      await runner.runOnce(nowMs);
      await runner.runOnce(nowMs + 1_000);
      expect(executed).toHaveLength(0);
      // Un 0 leido es autoritativo: se sabe que no hay dinero, no que no se pudo mirar.
      expect(JSON.stringify(logs)).toContain("favorite_max_size_below_min");
    });

    it("los tres mercados COMPARTEN la cuenta en vez de pedirla enteros cada uno", async () => {
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      const { runner, executed, nowMs } = escenario({ saldoUsd: 300, mercados: ["BTC", "ETH", "DOGE"] });
      await runner.runOnce(nowMs);
      await runner.runOnce(nowMs + 1_000);
      // Sin el contador por iteracion, cada mercado pediria $300 y la suma seria $900 de dinero que
      // solo existe una vez.
      const total = executed.reduce((sum, t) => sum + t.amountUsd, 0);
      expect(total).toBeLessThanOrEqual(300.01);
      expect(executed.length).toBeGreaterThan(0);
      // Y no solo dentro de una pasada: una tercera iteracion tampoco puede reinvertir el mismo
      // dinero, porque sigue atado en la posicion abierta.
      await runner.runOnce(nowMs + 2_000);
      const totalTrasTercera = executed.reduce((sum, t) => sum + t.amountUsd, 0);
      expect(totalTrasTercera).toBeLessThanOrEqual(300.01);
    });

it("tres mercados de banda NO pueden sumar mas que la cuenta", async () => {
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      // Medido en produccion antes de arreglarlo: BTC, ETH y DOGE entraban a $5 cada uno contra un
      // saldo de $12,42. Los tres se evaluan en la MISMA pasada y sus operaciones no llegan al ledger
      // hasta ejecutarse, asi que `openStakeUsd()` los veia a todos en cero.
      // Saldo por debajo de lo que suman las tres entradas ($1 cada una en este doble): sin la reserva
      // intra-iteracion las tres pasan la guarda, porque ninguna ha llegado aun al ledger.
      const { runner, executed, nowMs } = escenario({
        saldoUsd: 2.5,
        mercados: ["BTC", "ETH", "DOGE"],
        profundidadUsd: 5_000,
        // BANDA, no conviccion: es el camino que no tenia contador y por eso sobrepasaba la cuenta.
        askUp: 0.85,
        bandaYaOperada: false,
      });

      await runner.runOnce(nowMs);
      await runner.runOnce(nowMs + 1_000);

      const total = executed.reduce((sum, t) => sum + t.amountUsd, 0);
      expect(executed.length).toBeGreaterThan(0);
      expect(total).toBeLessThanOrEqual(2.51);
    });

    it("recotiza con el importe grande: sin eso el P&L puntuaria otra operacion", async () => {
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      const { runner, orderbook, nowMs } = escenario({ saldoUsd: 742.5 });
      await runner.runOnce(nowMs);
      await runner.runOnce(nowMs + 1_000);
      // El quote de la fase de captura se pide con el importe pequeño; tiene que haber OTRA llamada
      // con el importe final, o estimatedSharesForAmount seria el de la operacion equivocada.
      const importes = (orderbook.getQuote as unknown as { mock: { calls: unknown[][] } }).mock.calls.map(
        (c) => c[1] as number,
      );
      expect(importes).toContain(742.5);
    });
  });

  it("records analytics for all supported markets even when no market is enabled for directional trading", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const windowStartMs = Date.UTC(2026, 4, 7, 4, 25, 0, 0);
    const nowMs = windowStartMs + 290_000;
    const markets: Record<MarketSymbol, MarketInfo> = {
      BTC: marketInfo("BTC", "btc", windowStartMs),
      ETH: marketInfo("ETH", "eth", windowStartMs),
      DOGE: marketInfo("DOGE", "doge", windowStartMs),
    };
    const openings = new Map(
      Object.values(markets).map((market) => [
        market.slug,
        {
          asset: market.asset,
          slug: market.slug,
          windowStartMs,
          openingPrice: market.asset === "DOGE" ? 0.1 : 100,
          openingTickTimestampMs: windowStartMs,
          capturedAtMs: windowStartMs,
        },
      ]),
    );
    const watcher = {
      getCurrentMarkets: vi.fn(async (requestedMarkets: MarketSymbol[]) =>
        requestedMarkets.map((market) => markets[market]),
      ),
      getCurrentMarket: vi.fn(async () => null),
    } as unknown as MarketWatcher;
    const priceFeed = {
      start: vi.fn(),
      stop: vi.fn(),
      getLatestTick: vi.fn((market: MarketSymbol = "BTC") => ({
        market,
        symbol: priceFeedSymbol(market),
        value: market === "DOGE" ? 0.1007 : 130,
        timestampMs: nowMs,
        receivedAtMs: nowMs,
      })),
    } as unknown as ChainlinkPriceFeed;
    const state = {
      load: vi.fn(async () => undefined),
      listTrades: vi.fn(() => []),
      getOpening: vi.fn((slug: string) => openings.get(slug)),
      hasTraded: vi.fn(() => false),
      getDailySpend: vi.fn(() => 0),
      recordTradeAttempt: vi.fn(async () => undefined),
    } as unknown as StateStore;
    const executor = {
      execute: vi.fn(async () => {
        throw new Error("should not execute");
      }),
    } satisfies TradeExecutor;
    const analyticsRecorder = {
      observeMarket: vi.fn(async () => undefined),
      recordResolvedTrade: vi.fn(async () => undefined),
    } as unknown as AnalyticsRecorder;

    const runner = new BotRunner(
      {
        ...baseConfig(),
        // El arbitraje mantiene la captura abierta sin operar nada direccional, que es justo el caso
        // que este test protege: la analitica cubre los 3 mercados aunque no se opere ninguno.
        arbEnabled: true,
        enabledMarkets: [],
        enabledMarketOutcomes: {
          BTC: { UP: false, DOWN: false },
          ETH: { UP: false, DOWN: false },
          DOGE: { UP: false, DOWN: false },
        },
      },
      {
        watcher,
        orderbook: fakeOrderbook(),
        priceFeed,
        state,
        executor,
        reconciler: fakeReconciler(),
        analyticsRecorder,
      },
    );

    await runner.runOnce(nowMs);

    expect(watcher.getCurrentMarkets).toHaveBeenCalledWith(["BTC", "ETH", "DOGE"], nowMs);
    expect(analyticsRecorder.observeMarket).toHaveBeenCalledTimes(3);
    expect(executor.execute).not.toHaveBeenCalled();
  });

  it("skips the crypto capture entirely when nothing consumes it", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const windowStartMs = Date.UTC(2026, 4, 7, 4, 25, 0, 0);
    const nowMs = windowStartMs + 290_000;
    const watcher = {
      getCurrentMarkets: vi.fn(async () => []),
      getCurrentMarket: vi.fn(async () => null),
      prefetchNextWindow: vi.fn(),
    } as unknown as MarketWatcher;
    const orderbook = fakeOrderbook();
    const analyticsRecorder = {
      observeMarket: vi.fn(async () => undefined),
      recordResolvedTrade: vi.fn(async () => undefined),
    } as unknown as AnalyticsRecorder;

    const runner = new BotRunner(
      {
        ...baseConfig(),
        // Ni direccional, ni arbitraje, ni maker sobre cripto de 5m: nadie lee esos mercados.
        arbEnabled: false,
        enabledMarkets: [],
        enabledMarketOutcomes: {
          BTC: { UP: false, DOWN: false },
          ETH: { UP: false, DOWN: false },
          DOGE: { UP: false, DOWN: false },
        },
      },
      {
        watcher,
        orderbook,
        priceFeed: { start: vi.fn(), stop: vi.fn(), getLatestTick: vi.fn(() => undefined) } as unknown as ChainlinkPriceFeed,
        state: {
          load: vi.fn(async () => undefined),
          listTrades: vi.fn(() => []),
          getOpening: vi.fn(() => undefined),
          hasTraded: vi.fn(() => false),
          getDailySpend: vi.fn(() => 0),
        } as unknown as StateStore,
        executor: { execute: vi.fn(async () => { throw new Error("should not execute"); }) } satisfies TradeExecutor,
        reconciler: fakeReconciler(),
        analyticsRecorder,
      },
    );

    await runner.runOnce(nowMs);

    // Ni la lista de mercados, ni el prefetch de la siguiente ventana, ni una sola lectura de libro.
    expect(watcher.getCurrentMarkets).not.toHaveBeenCalled();
    expect(watcher.prefetchNextWindow).not.toHaveBeenCalled();
    expect(orderbook.getQuote).not.toHaveBeenCalled();
    expect(analyticsRecorder.observeMarket).not.toHaveBeenCalled();
  });

  it("no consulta el historico de precios por operaciones ya resueltas", async () => {
    // El estado real acumula 1.362 operaciones, TODAS resueltas y ninguna pendiente, y el bucle pagaba
    // dos busquedas de historico por cada una en cada iteracion. No fallaba nada: se manifestaba como
    // timeouts de 2 s leyendo libros en la pasada del maker, con el bucle demasiado ocupado para
    // atender la respuesta a tiempo.
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const nowMs = Date.UTC(2026, 4, 7, 4, 30, 0, 0);
    const priceFeed = {
      start: vi.fn(),
      stop: vi.fn(),
      getLatestTick: vi.fn(() => ({
        market: "BTC" as const,
        symbol: priceFeedSymbol("BTC"),
        value: 130,
        timestampMs: nowMs,
        receivedAtMs: nowMs,
      })),
      getTwapAtOrBefore: vi.fn(() => undefined),
      getTickAtOrBefore: vi.fn(() => undefined),
    };
    const resueltos = Array.from({ length: 50 }, (_, i) => ({
      slug: `btc-updown-5m-${i}`,
      asset: "BTC" as const,
      endMs: nowMs - 600_000,
      resolved: true,
      mode: "sim" as const,
      twapWindowSeconds: 60,
    }));

    const runner = new BotRunner(
      {
        ...baseConfig(),
        arbEnabled: false,
        enabledMarkets: [],
        enabledMarketOutcomes: {
          BTC: { UP: false, DOWN: false },
          ETH: { UP: false, DOWN: false },
          DOGE: { UP: false, DOWN: false },
        },
      },
      {
        watcher: {
          getCurrentMarkets: vi.fn(async () => []),
          getCurrentMarket: vi.fn(async () => null),
        } as unknown as MarketWatcher,
        orderbook: fakeOrderbook(),
        priceFeed: priceFeed as unknown as ChainlinkPriceFeed,
        state: {
          load: vi.fn(async () => undefined),
          listTrades: vi.fn(() => resueltos),
          getOpening: vi.fn(() => undefined),
          hasTraded: vi.fn(() => false),
          getDailySpend: vi.fn(() => 0),
        } as unknown as StateStore,
        executor: { execute: vi.fn(async () => { throw new Error("should not execute"); }) } satisfies TradeExecutor,
        reconciler: fakeReconciler(),
      },
    );

    await runner.runOnce(nowMs);

    expect(priceFeed.getTwapAtOrBefore).not.toHaveBeenCalled();
    expect(priceFeed.getTickAtOrBefore).not.toHaveBeenCalled();
  });

  it("con el maker detenido por el suelo, no paga el escaneo de mercados", async () => {
    // El escaneo son ~25 mercados por red: 9,7 s medidos en produccion, 53 avisos de iteracion lenta
    // en catorce minutos. Un maker que no va a operar no puede pagarlos en cada pasada.
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const nowMs = Date.UTC(2026, 4, 7, 4, 30, 0, 0);
    const mejores = vi.fn(async () => []);
    const runner = new BotRunner(
      {
        ...baseConfig(),
        makerEnabled: true,
        makerMode: "live",
        // Suelo por encima del saldo: el veredicto sera "retirar" en todas las pasadas.
        makerStopBelowUsd: 100,
        liveBankrollUsd: 10,
        arbEnabled: false,
        enabledMarkets: [],
        enabledMarketOutcomes: {
          BTC: { UP: false, DOWN: false },
          ETH: { UP: false, DOWN: false },
          DOGE: { UP: false, DOWN: false },
        },
      },
      {
        watcher: {
          getCurrentMarkets: vi.fn(async () => []),
          getCurrentMarket: vi.fn(async () => null),
        } as unknown as MarketWatcher,
        orderbook: fakeOrderbook(),
        priceFeed: { start: vi.fn(), stop: vi.fn(), getLatestTick: vi.fn(() => undefined) } as unknown as ChainlinkPriceFeed,
        state: {
          load: vi.fn(async () => undefined),
          listTrades: vi.fn(() => []),
          getOpening: vi.fn(() => undefined),
          hasTraded: vi.fn(() => false),
          getDailySpend: vi.fn(() => 0),
        } as unknown as StateStore,
        executor: { execute: vi.fn(async () => { throw new Error("should not execute"); }) } satisfies TradeExecutor,
        reconciler: fakeReconciler(),
        rewardParams: { paraMercado: vi.fn(async () => undefined) },
        rewardScanner: { mejores },
      },
    );

    // Primera pasada: es la TRANSICION a detenido, y ahi si hace falta la lista para retirar.
    await runner.runOnce(nowMs);
    const trasLaPrimera = mejores.mock.calls.length;
    // Sin esto el test pasaria por vacio: si el escaneo no se llamara NUNCA, la comparacion de abajo
    // seria 0 === 0 y no probaria nada.
    expect(trasLaPrimera).toBeGreaterThan(0);

    // Siguientes pasadas, ya detenido: no queda nada que retirar, asi que no se escanea.
    await runner.runOnce(nowMs + 60_000);
    await runner.runOnce(nowMs + 120_000);

    expect(mejores.mock.calls.length).toBe(trasLaPrimera);
  });

  it("al pararse por el suelo, sigue reportando el dinero que hay fuera", async () => {
    // El resumen de parada ponia `gastadoUsd` y `paresUsd` a CERO, asi que el panel enseñaba
    // "llenado $0.00" con $9,80 en una posicion direccional abierta — justo la cifra que el panel
    // existe para hacer visible, escondida justo cuando hay algo que ver.
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const nowMs = Date.UTC(2026, 4, 7, 4, 30, 0, 0);
    const runner = new BotRunner(
      {
        ...baseConfig(),
        makerEnabled: true,
        makerMode: "live",
        makerStopBelowUsd: 100, // por encima del saldo: se para seguro
        liveBankrollUsd: 10,
        arbEnabled: false,
        enabledMarkets: [],
        enabledMarketOutcomes: {
          BTC: { UP: false, DOWN: false },
          ETH: { UP: false, DOWN: false },
          DOGE: { UP: false, DOWN: false },
        },
      },
      {
        watcher: {
          getCurrentMarkets: vi.fn(async () => []),
          getCurrentMarket: vi.fn(async () => null),
        } as unknown as MarketWatcher,
        orderbook: fakeOrderbook(),
        priceFeed: { start: vi.fn(), stop: vi.fn(), getLatestTick: vi.fn(() => undefined) } as unknown as ChainlinkPriceFeed,
        state: {
          load: vi.fn(async () => undefined),
          listTrades: vi.fn(() => []),
          getOpening: vi.fn(() => undefined),
          hasTraded: vi.fn(() => false),
          getDailySpend: vi.fn(() => 0),
        } as unknown as StateStore,
        executor: { execute: vi.fn(async () => { throw new Error("should not execute"); }) } satisfies TradeExecutor,
        reconciler: fakeReconciler(),
        rewardParams: { paraMercado: vi.fn(async () => undefined) },
        rewardScanner: { mejores: vi.fn(async () => []) },
      },
    );

    await runner.runOnce(nowMs);
    const resumen = runner.getMakerSummary();

    // Detenido, si; pero el dinero de fuera se sigue diciendo. Lo unico que si es cero es el libro.
    expect(resumen?.mercados?.[0]?.motivo).toContain("saldo_bajo_suelo");
    expect(resumen?.vivoUsd).toBe(0);
    expect(resumen?.gastadoUsd).toBeDefined();
    expect(resumen?.paresUsd).toBeDefined();
  });

  it("no arranca el feed de precios cuando nadie va a leer sus ticks", async () => {
    // El runner arrancaba el feed SIEMPRE, asi que gatearlo solo en el controlador lo dejaba
    // encendido igual — y con el controlador creyendo lo contrario, `/api/health` perdia la vigilancia
    // del feed congelado sin que el feed estuviera apagado.
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const priceFeed = { start: vi.fn(), stop: vi.fn(), getLatestTick: vi.fn(() => undefined) };
    const runner = new BotRunner(
      {
        ...baseConfig(),
        makerEnabled: true,
        arbEnabled: false,
        enabledMarkets: [],
        enabledMarketOutcomes: {
          BTC: { UP: false, DOWN: false },
          ETH: { UP: false, DOWN: false },
          DOGE: { UP: false, DOWN: false },
        },
      },
      {
        watcher: {
          getCurrentMarkets: vi.fn(async () => []),
          getCurrentMarket: vi.fn(async () => null),
        } as unknown as MarketWatcher,
        orderbook: fakeOrderbook(),
        priceFeed: priceFeed as unknown as ChainlinkPriceFeed,
        state: {
          load: vi.fn(async () => undefined),
          listTrades: vi.fn(() => []),
          getOpening: vi.fn(() => undefined),
          hasTraded: vi.fn(() => false),
          getDailySpend: vi.fn(() => 0),
        } as unknown as StateStore,
        executor: { execute: vi.fn(async () => { throw new Error("should not execute"); }) } satisfies TradeExecutor,
        reconciler: fakeReconciler(),
      },
    );

    await runner.start({ once: true });

    expect(priceFeed.start).not.toHaveBeenCalled();
  });

  it("arranca el feed de precios cuando hay un mercado encendido", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const priceFeed = { start: vi.fn(), stop: vi.fn(), getLatestTick: vi.fn(() => undefined) };
    const runner = new BotRunner(
      {
        ...baseConfig(),
        arbEnabled: false,
        enabledMarkets: ["BTC"],
        enabledMarketOutcomes: {
          BTC: { UP: true, DOWN: false },
          ETH: { UP: false, DOWN: false },
          DOGE: { UP: false, DOWN: false },
        },
      },
      {
        watcher: {
          getCurrentMarkets: vi.fn(async () => []),
          getCurrentMarket: vi.fn(async () => null),
        } as unknown as MarketWatcher,
        orderbook: fakeOrderbook(),
        priceFeed: priceFeed as unknown as ChainlinkPriceFeed,
        state: {
          load: vi.fn(async () => undefined),
          listTrades: vi.fn(() => []),
          getOpening: vi.fn(() => undefined),
          hasTraded: vi.fn(() => false),
          getDailySpend: vi.fn(() => 0),
        } as unknown as StateStore,
        executor: { execute: vi.fn(async () => { throw new Error("should not execute"); }) } satisfies TradeExecutor,
        reconciler: fakeReconciler(),
      },
    );

    await runner.start({ once: true });

    expect(priceFeed.start).toHaveBeenCalledTimes(1);
  });

  it("runs the maker pass even with an empty crypto market list", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    // La regresion que cubre: la cola de la iteracion vivia detras de un `return` temprano por lista
    // vacia, asi que el maker —que saca sus mercados de otra fuente— perdia la pasada por algo que no
    // le incumbe. Ahora una lista vacia solo se lleva la captura de cripto.
    const nowMs = Date.UTC(2026, 4, 7, 4, 30, 0, 0);
    const runner = new BotRunner(
      {
        ...baseConfig(),
        makerEnabled: true,
        arbEnabled: false,
        enabledMarkets: [],
        enabledMarketOutcomes: {
          BTC: { UP: false, DOWN: false },
          ETH: { UP: false, DOWN: false },
          DOGE: { UP: false, DOWN: false },
        },
      },
      {
        watcher: {
          getCurrentMarkets: vi.fn(async () => []),
          getCurrentMarket: vi.fn(async () => null),
        } as unknown as MarketWatcher,
        orderbook: fakeOrderbook(),
        priceFeed: { start: vi.fn(), stop: vi.fn(), getLatestTick: vi.fn(() => undefined) } as unknown as ChainlinkPriceFeed,
        state: {
          load: vi.fn(async () => undefined),
          listTrades: vi.fn(() => []),
          getOpening: vi.fn(() => undefined),
          hasTraded: vi.fn(() => false),
          getDailySpend: vi.fn(() => 0),
        } as unknown as StateStore,
        executor: { execute: vi.fn(async () => { throw new Error("should not execute"); }) } satisfies TradeExecutor,
        reconciler: fakeReconciler(),
        // Sin lector de parametros el maker ni se construye, asi que el test no probaria nada.
        rewardParams: { paraMercado: vi.fn(async () => undefined) },
      },
    );

    await runner.runOnce(nowMs);

    expect(runner.getMakerSummary()).toBeDefined();
  });

  it("halts trading when the risk circuit breaker trips, but keeps recording analytics", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const windowStartMs = Date.UTC(2026, 4, 7, 4, 25, 0, 0);
    const nowMs = windowStartMs + 290_000;
    const market = marketInfo("BTC", "btc", windowStartMs);
    const openings = new Map([
      [
        market.slug,
        {
          asset: market.asset,
          slug: market.slug,
          windowStartMs,
          openingPrice: 100,
          openingTickTimestampMs: windowStartMs,
          capturedAtMs: windowStartMs,
        },
      ],
    ]);
    const losingTrade: TradeAttempt = {
      id: "loss-1",
      slug: "btc-updown-5m-prev",
      mode: "sim",
      outcome: "UP",
      tokenId: "token",
      amountUsd: 10,
      maxAskPrice: 0.98,
      bestAsk: 0.5,
      estimatedShares: 20,
      openingPrice: 100,
      entryPrice: 90,
      distanceUsd: -10,
      entryWindowSeconds: 30,
      windowStartMs: 1,
      endMs: 2,
      createdAtMs: nowMs - 60_000,
      resolved: {
        resolvedAtMs: nowMs,
        finalPrice: 90,
        finalTickTimestampMs: nowMs,
        winningOutcome: "DOWN",
        won: false,
      },
    };
    const state = {
      load: vi.fn(async () => undefined),
      listTrades: vi.fn(() => [losingTrade]),
      getOpening: vi.fn((slug: string) => openings.get(slug)),
      hasTraded: vi.fn(() => false),
      getDailySpend: vi.fn(() => 0),
      recordTradeAttempt: vi.fn(async () => undefined),
    } as unknown as StateStore;
    const executor = {
      execute: vi.fn(async () => {
        throw new Error("should not execute while halted");
      }),
    } satisfies TradeExecutor;
    const analyticsRecorder = {
      observeMarket: vi.fn(async () => undefined),
      recordResolvedTrade: vi.fn(async () => undefined),
    } as unknown as AnalyticsRecorder;

    const runner = new BotRunner(
      {
        ...baseConfig(),
        mode: "sim",
        requirePositiveEv: false,
        maxConsecutiveLosses: 1,
      },
      {
        watcher: { getCurrentMarket: vi.fn(async () => market) } as unknown as MarketWatcher,
        orderbook: fakeOrderbook(),
        priceFeed: livePriceFeed("BTC", 130, nowMs),
        state,
        executor,
        reconciler: fakeReconciler(),
        analyticsRecorder,
      },
    );

    await runner.runOnce(nowMs);

    expect(executor.execute).not.toHaveBeenCalled();
    expect(analyticsRecorder.observeMarket).toHaveBeenCalled();
  });

  it("uses the configured entry window for each market", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const windowStartMs = Date.UTC(2026, 4, 7, 4, 25, 0, 0);
    const nowMs = windowStartMs + 270_000;
    const markets: Partial<Record<MarketSymbol, MarketInfo>> = {
      BTC: marketInfo("BTC", "btc", windowStartMs),
      ETH: marketInfo("ETH", "eth", windowStartMs),
    };
    const openings = new Map(
      Object.values(markets).map((market) => [
        market.slug,
        {
          asset: market.asset,
          slug: market.slug,
          windowStartMs,
          openingPrice: 100,
          openingTickTimestampMs: windowStartMs,
          capturedAtMs: windowStartMs,
        },
      ]),
    );
    const watcher = {
      getCurrentMarket: vi.fn(async (_nowMs: number, market: MarketSymbol = "BTC") => markets[market] ?? null),
    } as unknown as MarketWatcher;
    const priceFeed = {
      start: vi.fn(),
      stop: vi.fn(),
      getLatestTick: vi.fn((market: MarketSymbol = "BTC") => ({
        market,
        symbol: priceFeedSymbol(market),
        value: 130,
        timestampMs: nowMs,
        receivedAtMs: nowMs,
      })),
    } as unknown as ChainlinkPriceFeed;
    const state = {
      load: vi.fn(async () => undefined),
      listTrades: vi.fn(() => []),
      getOpening: vi.fn((slug: string) => openings.get(slug)),
      hasTraded: vi.fn(() => false),
      getDailySpend: vi.fn(() => 0),
      recordTradeAttempt: vi.fn(async () => undefined),
    } as unknown as StateStore;
    const executor = {
      execute: vi.fn(async (input: ExecutionInput) => ({
        id: `${input.market.slug}-${input.outcome}`,
        asset: input.market.asset,
        slug: input.market.slug,
        mode: "sim" as const,
        conditionId: input.market.conditionId,
        outcome: input.outcome,
        tokenId: input.market.outcomes[input.outcome].tokenId,
        amountUsd: input.amountUsd,
        maxAskPrice: 0.98,
        bestAsk: input.quote.bestAsk,
        estimatedShares: input.quote.estimatedSharesForAmount,
        openingPrice: input.opening.openingPrice,
        entryPrice: input.tick.value,
        distanceUsd: input.distanceUsd,
        entryWindowSeconds: input.entryWindowSeconds,
        windowStartMs: input.market.windowStartMs,
        endMs: input.market.endMs,
        createdAtMs: nowMs,
      })),
    } satisfies TradeExecutor;

    const runner = new BotRunner(
      {
        ...baseConfig(),
        enabledMarkets: ["BTC", "ETH"],
        entryWindowSecondsByMarket: { BTC: 20, ETH: 35, DOGE: 20 },
      },
      {
        watcher,
        orderbook: fakeOrderbook(),
        priceFeed,
        state,
        executor,
        reconciler: fakeReconciler(),
      },
    );

    await runner.runOnce(nowMs);

    expect(executor.execute).toHaveBeenCalledTimes(1);
    expect(executor.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        market: expect.objectContaining({ asset: "ETH" }),
        entryWindowSeconds: 35,
      }),
    );
  });

  it("uses side-specific window, distance, amount, and ask cap", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const windowStartMs = Date.UTC(2026, 4, 7, 4, 25, 0, 0);
    const nowMs = windowStartMs + 270_000;
    const market = marketInfo("BTC", "btc", windowStartMs);
    const openings = new Map([
      [
        market.slug,
        {
          asset: market.asset,
          slug: market.slug,
          windowStartMs,
          openingPrice: 100,
          openingTickTimestampMs: windowStartMs,
          capturedAtMs: windowStartMs,
        },
      ],
    ]);
    const watcher = {
      getCurrentMarket: vi.fn(async () => market),
    } as unknown as MarketWatcher;
    const priceFeed = {
      start: vi.fn(),
      stop: vi.fn(),
      getLatestTick: vi.fn(() => ({
        market: "BTC",
        symbol: "btc/usd",
        value: 85,
        timestampMs: nowMs,
        receivedAtMs: nowMs,
      })),
    } as unknown as ChainlinkPriceFeed;
    const state = {
      load: vi.fn(async () => undefined),
      listTrades: vi.fn(() => []),
      getOpening: vi.fn((slug: string) => openings.get(slug)),
      hasTraded: vi.fn(() => false),
      getDailySpend: vi.fn(() => 0),
      recordTradeAttempt: vi.fn(async () => undefined),
    } as unknown as StateStore;
    const orderbook = {
      getQuote: vi.fn(async () => ({
        tokenId: "token",
        bestAsk: 0.7,
        bestBid: 0.69,
        availableUsdUnderCap: 100,
        availableUsdAllLevels: 100,
        estimatedSharesForAmount: 10,
        rawAskLevels: [],
      })),
    } as unknown as OrderbookService;
    const executor = {
      execute: vi.fn(async (input: ExecutionInput) => ({
        id: `${input.market.slug}-${input.outcome}`,
        asset: input.market.asset,
        slug: input.market.slug,
        mode: "sim" as const,
        conditionId: input.market.conditionId,
        outcome: input.outcome,
        tokenId: input.market.outcomes[input.outcome].tokenId,
        amountUsd: input.amountUsd,
        maxAskPrice: input.maxAskPrice,
        bestAsk: input.quote.bestAsk,
        estimatedShares: input.quote.estimatedSharesForAmount,
        openingPrice: input.opening.openingPrice,
        entryPrice: input.tick.value,
        distanceUsd: input.distanceUsd,
        entryWindowSeconds: input.entryWindowSeconds,
        windowStartMs: input.market.windowStartMs,
        endMs: input.market.endMs,
        createdAtMs: nowMs,
      })),
    } satisfies TradeExecutor;

    const runner = new BotRunner(
      {
        ...baseConfig(),
        minDistanceUsdByMarketOutcome: {
          BTC: { UP: 10, DOWN: 12 },
          ETH: { UP: 5, DOWN: 5 },
          DOGE: { UP: 0.0005, DOWN: 0.0005 },
        },
        entryWindowSecondsByMarketOutcome: {
          BTC: { UP: 20, DOWN: 35 },
          ETH: { UP: 20, DOWN: 20 },
          DOGE: { UP: 20, DOWN: 20 },
        },
        // autoMinLive ahora aplica en AMBOS modos; este test mide el monto por lado, asi que lo apaga
        // para que no lo sustituya el minimo del exchange.
        autoMinLive: false,
        // Monto por trade: fuente UNICA (los ajustes "live") en ambos modos desde la unificacion
        // sim/live — antes cada modo leia el suyo y el sim no reproducia el tamano real.
        liveTradeAmountUsdByMarketOutcome: {
          BTC: { UP: 1, DOWN: 7 },
          ETH: { UP: 1, DOWN: 1 },
          DOGE: { UP: 1, DOWN: 1 },
        },
        maxAskPriceByMarketOutcome: {
          BTC: { UP: 0.98, DOWN: 0.72 },
          ETH: { UP: 0.98, DOWN: 0.98 },
          DOGE: { UP: 0.98, DOWN: 0.98 },
        },
      },
      {
        watcher,
        orderbook,
        priceFeed,
        state,
        executor,
        reconciler: fakeReconciler(),
      },
    );

    await runner.runOnce(nowMs);

    expect(orderbook.getQuote).toHaveBeenCalledWith("BTC-down", 7, 0.72);
    expect(executor.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "DOWN",
        amountUsd: 7,
        maxAskPrice: 0.72,
        distanceUsd: 15,
        entryWindowSeconds: 35,
      }),
    );
  });

  it("clamps the ask cap to maxAskPriceCeiling for both quoting and trading", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const windowStartMs = Date.UTC(2026, 4, 7, 4, 25, 0, 0);
    const nowMs = windowStartMs + 270_000;
    const market = marketInfo("BTC", "btc", windowStartMs);
    const openings = new Map([
      [
        market.slug,
        {
          asset: market.asset,
          slug: market.slug,
          windowStartMs,
          openingPrice: 100,
          openingTickTimestampMs: windowStartMs,
          capturedAtMs: windowStartMs,
        },
      ],
    ]);
    const watcher = { getCurrentMarket: vi.fn(async () => market) } as unknown as MarketWatcher;
    const priceFeed = {
      start: vi.fn(),
      stop: vi.fn(),
      getLatestTick: vi.fn(() => ({ market: "BTC", symbol: "btc/usd", value: 85, timestampMs: nowMs, receivedAtMs: nowMs })),
    } as unknown as ChainlinkPriceFeed;
    const state = {
      load: vi.fn(async () => undefined),
      listTrades: vi.fn(() => []),
      getOpening: vi.fn((slug: string) => openings.get(slug)),
      hasTraded: vi.fn(() => false),
      getDailySpend: vi.fn(() => 0),
      recordTradeAttempt: vi.fn(async () => undefined),
    } as unknown as StateStore;
    // Quote sits above the 0.80 ceiling but below the configured 0.95 cap.
    const orderbook = {
      getQuote: vi.fn(async () => ({
        tokenId: "token",
        bestAsk: 0.85,
        bestBid: 0.84,
        availableUsdUnderCap: 100,
        availableUsdAllLevels: 100,
        estimatedSharesForAmount: 10,
        rawAskLevels: [],
      })),
    } as unknown as OrderbookService;
    const executor = { execute: vi.fn() } as unknown as TradeExecutor;

    const runner = new BotRunner(
      {
        ...baseConfig(),
        maxAskPriceCeiling: 0.8,
        minDistanceUsdByMarketOutcome: { BTC: { UP: 10, DOWN: 12 }, ETH: { UP: 5, DOWN: 5 }, DOGE: { UP: 0.0005, DOWN: 0.0005 } },
        entryWindowSecondsByMarketOutcome: { BTC: { UP: 35, DOWN: 35 }, ETH: { UP: 20, DOWN: 20 }, DOGE: { UP: 20, DOWN: 20 } },
        maxAskPriceByMarketOutcome: { BTC: { UP: 0.95, DOWN: 0.95 }, ETH: { UP: 0.95, DOWN: 0.95 }, DOGE: { UP: 0.95, DOWN: 0.95 } },
      },
      { watcher, orderbook, priceFeed, state, executor, reconciler: fakeReconciler() },
    );

    await runner.runOnce(nowMs);

    // The quote is requested at the clamped ceiling (0.80), not the configured 0.95...
    expect(orderbook.getQuote).toHaveBeenCalledWith(expect.any(String), expect.any(Number), 0.8);
    // ...and since bestAsk (0.85) exceeds the effective cap, no trade is executed.
    expect(executor.execute).not.toHaveBeenCalled();
  });

  it("skips a signal when that market side is disabled", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const windowStartMs = Date.UTC(2026, 4, 7, 4, 25, 0, 0);
    const nowMs = windowStartMs + 290_000;
    const market = marketInfo("BTC", "btc", windowStartMs);
    const watcher = {
      getCurrentMarket: vi.fn(async () => market),
    } as unknown as MarketWatcher;
    const priceFeed = {
      start: vi.fn(),
      stop: vi.fn(),
      getLatestTick: vi.fn(() => ({
        market: "BTC",
        symbol: "btc/usd",
        value: 80,
        timestampMs: nowMs,
        receivedAtMs: nowMs,
      })),
    } as unknown as ChainlinkPriceFeed;
    const state = {
      load: vi.fn(async () => undefined),
      listTrades: vi.fn(() => []),
      getOpening: vi.fn(() => ({
        asset: "BTC",
        slug: market.slug,
        windowStartMs,
        openingPrice: 100,
        openingTickTimestampMs: windowStartMs,
        capturedAtMs: windowStartMs,
      })),
      hasTraded: vi.fn(() => false),
      getDailySpend: vi.fn(() => 0),
      recordTradeAttempt: vi.fn(async () => undefined),
    } as unknown as StateStore;
    const executor = {
      execute: vi.fn(async () => {
        throw new Error("should not execute");
      }),
    } satisfies TradeExecutor;

    const runner = new BotRunner(
      {
        ...baseConfig(),
        enabledMarkets: ["BTC"],
        enabledMarketOutcomes: {
          BTC: { UP: true, DOWN: false },
          ETH: { UP: false, DOWN: false },
          DOGE: { UP: false, DOWN: false },
        },
      },
      {
        watcher,
        orderbook: fakeOrderbook(),
        priceFeed,
        state,
        executor,
        reconciler: fakeReconciler(),
      },
    );

    await runner.runOnce(nowMs);

    expect(executor.execute).not.toHaveBeenCalled();
  });

  it("uses updated strategy settings on the next iteration", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const windowStartMs = Date.UTC(2026, 4, 7, 4, 25, 0, 0);
    const nowMs = windowStartMs + 270_000;
    const market = marketInfo("BTC", "btc", windowStartMs);
    const openings = new Map([
      [
        market.slug,
        {
          asset: market.asset,
          slug: market.slug,
          windowStartMs,
          openingPrice: 100,
          openingTickTimestampMs: windowStartMs,
          capturedAtMs: windowStartMs,
        },
      ],
    ]);
    const watcher = {
      getCurrentMarket: vi.fn(async () => market),
    } as unknown as MarketWatcher;
    const priceFeed = {
      start: vi.fn(),
      stop: vi.fn(),
      getLatestTick: vi.fn(() => ({
        market: "BTC",
        symbol: "btc/usd",
        value: 115,
        timestampMs: nowMs,
        receivedAtMs: nowMs,
      })),
    } as unknown as ChainlinkPriceFeed;
    const state = {
      load: vi.fn(async () => undefined),
      listTrades: vi.fn(() => []),
      getOpening: vi.fn((slug: string) => openings.get(slug)),
      hasTraded: vi.fn(() => false),
      getDailySpend: vi.fn(() => 0),
      recordTradeAttempt: vi.fn(async () => undefined),
    } as unknown as StateStore;
    const executor = {
      execute: vi.fn(async (input: ExecutionInput) => ({
        id: `${input.market.slug}-${input.outcome}`,
        asset: input.market.asset,
        slug: input.market.slug,
        mode: "sim" as const,
        conditionId: input.market.conditionId,
        outcome: input.outcome,
        tokenId: input.market.outcomes[input.outcome].tokenId,
        amountUsd: input.amountUsd,
        maxAskPrice: 0.98,
        bestAsk: input.quote.bestAsk,
        estimatedShares: input.quote.estimatedSharesForAmount,
        openingPrice: input.opening.openingPrice,
        entryPrice: input.tick.value,
        distanceUsd: input.distanceUsd,
        entryWindowSeconds: input.entryWindowSeconds,
        windowStartMs: input.market.windowStartMs,
        endMs: input.market.endMs,
        createdAtMs: nowMs,
      })),
    } satisfies TradeExecutor;

    const runner = new BotRunner(baseConfig(), {
      watcher,
      orderbook: fakeOrderbook(),
      priceFeed,
      state,
      executor,
      reconciler: fakeReconciler(),
    });

    await runner.runOnce(nowMs);
    expect(executor.execute).not.toHaveBeenCalled();

    runner.updateStrategySettings({
      minDistanceUsdByMarket: { BTC: 10, ETH: 5, DOGE: 0.0005 },
      entryWindowSeconds: 35,
      entryWindowSecondsByMarket: { BTC: 35, ETH: 20, DOGE: 20 },
    });
    await runner.runOnce(nowMs);

    expect(executor.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        distanceUsd: 15,
        entryWindowSeconds: 35,
      }),
    );
  });

  it("blocks live trades that fail the conservative EV gate", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const windowStartMs = Date.UTC(2026, 4, 7, 4, 25, 0, 0);
    const nowMs = windowStartMs + 290_000;
    const market = marketInfo("BTC", "btc", windowStartMs);
    const openings = new Map([
      [
        market.slug,
        {
          asset: market.asset,
          slug: market.slug,
          windowStartMs,
          openingPrice: 100,
          openingTickTimestampMs: windowStartMs,
          capturedAtMs: windowStartMs,
        },
      ],
    ]);
    const state = {
      load: vi.fn(async () => undefined),
      listTrades: vi.fn(() => []),
      getOpening: vi.fn((slug: string) => openings.get(slug)),
      hasTraded: vi.fn(() => false),
      getDailySpend: vi.fn(() => 0),
      recordTradeAttempt: vi.fn(async () => undefined),
    } as unknown as StateStore;
    const executor = {
      execute: vi.fn(async () => {
        throw new Error("should not execute");
      }),
    } satisfies TradeExecutor;
    const strategyAnalysisEngine = {
      analyze: vi.fn(async () =>
        strategyAnalysisResponse(bestStrategy("BTC", "UP", 20, 20, 0.98, {
          tradeCount: 20,
          winCount: 15,
          lossCount: 5,
        })),
      ),
      estimateSetupWinRate: vi.fn(
        async () => bestStrategy("BTC", "UP", 20, 20, 0.98, { tradeCount: 20, winCount: 15, lossCount: 5 }).metrics,
      ),
    };

    const runner = new BotRunner(
      {
        ...baseConfig(),
        mode: "live",
        requirePositiveEv: true,
      },
      {
        watcher: { getCurrentMarket: vi.fn(async () => market) } as unknown as MarketWatcher,
        orderbook: fakeOrderbook(0.9),
        priceFeed: livePriceFeed("BTC", 130, nowMs),
        state,
        executor,
        reconciler: fakeReconciler(),
        strategyAnalysisEngine,
      },
    );

    await runner.runOnce(nowMs);

    expect(strategyAnalysisEngine.estimateSetupWinRate).toHaveBeenCalled();
    expect(executor.execute).not.toHaveBeenCalled();
    expect(state.recordTradeAttempt).not.toHaveBeenCalled();
  });

  it("executes live trades when adjusted probability and EV clear the gate", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const windowStartMs = Date.UTC(2026, 4, 7, 4, 25, 0, 0);
    const nowMs = windowStartMs + 290_000;
    const market = marketInfo("BTC", "btc", windowStartMs);
    const openings = new Map([
      [
        market.slug,
        {
          asset: market.asset,
          slug: market.slug,
          windowStartMs,
          openingPrice: 100,
          openingTickTimestampMs: windowStartMs,
          capturedAtMs: windowStartMs,
        },
      ],
    ]);
    const state = {
      load: vi.fn(async () => undefined),
      listTrades: vi.fn(() => []),
      getOpening: vi.fn((slug: string) => openings.get(slug)),
      hasTraded: vi.fn(() => false),
      getDailySpend: vi.fn(() => 0),
      recordTradeAttempt: vi.fn(async () => undefined),
    } as unknown as StateStore;
    const executor = {
      execute: vi.fn(async (input: ExecutionInput) => ({
        id: `${input.market.slug}-${input.outcome}`,
        asset: input.market.asset,
        slug: input.market.slug,
        mode: "live" as const,
        conditionId: input.market.conditionId,
        outcome: input.outcome,
        tokenId: input.market.outcomes[input.outcome].tokenId,
        amountUsd: input.amountUsd,
        maxAskPrice: input.maxAskPrice,
        bestAsk: input.quote.bestAsk,
        expectedValue: input.expectedValue,
        estimatedShares: input.quote.estimatedSharesForAmount,
        openingPrice: input.opening.openingPrice,
        entryPrice: input.tick.value,
        distanceUsd: input.distanceUsd,
        entryWindowSeconds: input.entryWindowSeconds,
        windowStartMs: input.market.windowStartMs,
        endMs: input.market.endMs,
        createdAtMs: nowMs,
      })),
    } satisfies TradeExecutor;
    const strategyAnalysisEngine = {
      analyze: vi.fn(async () =>
        strategyAnalysisResponse(bestStrategy("BTC", "UP", 20, 20, 0.98, {
          tradeCount: 20,
          winCount: 18,
          lossCount: 2,
        })),
      ),
      estimateSetupWinRate: vi.fn(
        async () => bestStrategy("BTC", "UP", 20, 20, 0.98, { tradeCount: 20, winCount: 18, lossCount: 2 }).metrics,
      ),
    };

    const runner = new BotRunner(
      {
        ...baseConfig(),
        mode: "live",
        requirePositiveEv: true,
      },
      {
        watcher: { getCurrentMarket: vi.fn(async () => market) } as unknown as MarketWatcher,
        orderbook: fakeOrderbook(0.7),
        priceFeed: livePriceFeed("BTC", 130, nowMs),
        state,
        executor,
        reconciler: fakeReconciler(),
        strategyAnalysisEngine,
      },
    );

    await runner.runOnce(nowMs);

    expect(executor.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedValue: expect.objectContaining({
          askPrice: 0.7,
          // Prior anchored to the market (ask 0.7): (18 + 2*0.7) / (20 + 2).
          adjustedWinProbability: 19.4 / 22,
          passesRecommendedEntry: true,
        }),
      }),
    );
    expect(state.recordTradeAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedValue: expect.objectContaining({ passesRecommendedEntry: true }),
      }),
    );
  });

  /**
   * Con un bankroll pequeño el minimo de orden del exchange ($5) obliga a arriesgar una fraccion
   * enorme del capital por entrada, y la ruina llega antes que el edge: simulado con el edge REAL
   * (83% de aciertos, ROI +4.3%/operacion — GANADORA), con $10 la probabilidad de quedarse sin poder
   * operar en un mes es del 67.6%. Se pierde dinero teniendo razon, asi que la aritmetica la impone
   * el codigo y no la disciplina.
   */
  describe("puerta de capital para el direccional", () => {
    const setup = (mode: "sim" | "live") => {
      const windowStartMs = Date.UTC(2026, 4, 7, 4, 25, 0, 0);
      const nowMs = windowStartMs + 290_000;
      const market = marketInfo("BTC", "btc", windowStartMs);
      const openings = new Map([
        [
          market.slug,
          {
            asset: market.asset,
            slug: market.slug,
            windowStartMs,
            openingPrice: 100,
            openingTickTimestampMs: windowStartMs,
            capturedAtMs: windowStartMs,
          },
        ],
      ]);
      const state = {
        load: vi.fn(async () => undefined),
        listTrades: vi.fn(() => []),
        getOpening: vi.fn((slug: string) => openings.get(slug)),
        hasTraded: vi.fn(() => false),
        getDailySpend: vi.fn(() => 0),
        recordTradeAttempt: vi.fn(async () => undefined),
      } as unknown as StateStore;
      const executor = {
        execute: vi.fn(async (input: ExecutionInput) => ({
          id: `${input.market.slug}-${input.outcome}`,
          asset: input.market.asset,
          slug: input.market.slug,
          mode,
          outcome: input.outcome,
          tokenId: input.market.outcomes[input.outcome].tokenId,
          amountUsd: input.amountUsd,
          maxAskPrice: input.maxAskPrice,
          bestAsk: input.quote.bestAsk,
          estimatedShares: input.amountUsd / 0.7,
          openingPrice: 100,
          entryPrice: 130,
          distanceUsd: input.distanceUsd,
          windowStartMs: input.market.windowStartMs,
          endMs: input.market.endMs,
          createdAtMs: nowMs,
        })),
      } satisfies TradeExecutor;
      const runner = new BotRunner(
        {
          ...baseConfig(),
          mode,
          requirePositiveEv: false,
          liveBankrollUsd: 20,
          minBankrollForDirectionalUsd: 50,
        },
        {
          watcher: { getCurrentMarket: vi.fn(async () => market) } as unknown as MarketWatcher,
          orderbook: fakeOrderbook(0.7),
          priceFeed: livePriceFeed("BTC", 130, nowMs), // +30 sobre apertura: señal clara
          state,
          executor,
          reconciler: fakeReconciler(),
        },
      );
      return { runner, executor, nowMs };
    };

    it("no opera direccional en LIVE cuando el capital esta por debajo del minimo", async () => {
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      const { runner, executor, nowMs } = setup("live");
      await runner.runOnce(nowMs);
      expect(executor.execute).not.toHaveBeenCalled();
    });

    it("NO afecta a sim: seguir generando muestras es lo que valida la estrategia", async () => {
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      const { runner, executor, nowMs } = setup("sim");
      await runner.runOnce(nowMs);
      expect(executor.execute).toHaveBeenCalled();
    });
  });

  /**
   * El autoajuste no puede ver bandas donde nunca ha operado — el bot no opera fuera de su ventana, asi
   * que esas bandas tienen n=0 para siempre. Los sondeos rompen ese bucle dejando entrar unas pocas
   * operaciones al precio de la banda candidata, con presupuesto acotado.
   */
  describe("sondeos de banda", () => {
    const montar = (askDelLibro: number) => {
      const windowStartMs = Date.UTC(2026, 4, 7, 4, 25, 0, 0);
      const nowMs = windowStartMs + 290_000;
      const market = marketInfo("BTC", "btc", windowStartMs);
      const openings = new Map([
        [
          market.slug,
          {
            asset: market.asset,
            slug: market.slug,
            windowStartMs,
            openingPrice: 100,
            openingTickTimestampMs: windowStartMs,
            capturedAtMs: windowStartMs,
          },
        ],
      ]);
      const state = {
        load: vi.fn(async () => undefined),
        listTrades: vi.fn(() => []),
        getOpening: vi.fn((slug: string) => openings.get(slug)),
        hasTraded: vi.fn(() => false),
        getDailySpend: vi.fn(() => 0),
        recordTradeAttempt: vi.fn(async () => undefined),
      } as unknown as StateStore;
      const executor = {
        execute: vi.fn(async (input: ExecutionInput) => ({
          id: `${input.market.slug}-${input.outcome}`,
          asset: input.market.asset,
          slug: input.market.slug,
          mode: "sim" as const,
          outcome: input.outcome,
          tokenId: input.market.outcomes[input.outcome].tokenId,
          amountUsd: input.amountUsd,
          maxAskPrice: input.maxAskPrice,
          bestAsk: input.quote.bestAsk,
          estimatedShares: input.amountUsd / askDelLibro,
          openingPrice: 100,
          entryPrice: 130,
          distanceUsd: input.distanceUsd,
          windowStartMs: input.market.windowStartMs,
          endMs: input.market.endMs,
          createdAtMs: nowMs,
        })),
      } satisfies TradeExecutor;
      const runner = new BotRunner(
        {
          ...baseConfig(),
          requirePositiveEv: false,
          // Ventana configurada [0.70, 0.80]: el libro a 0.88 queda FUERA.
          maxAskPrice: 0.8,
          maxAskPriceByMarketOutcome: {
            BTC: { UP: 0.8, DOWN: 0.8 },
            ETH: { UP: 0.8, DOWN: 0.8 },
            DOGE: { UP: 0.8, DOWN: 0.8 },
          },
          minAskPriceByMarketOutcome: {
            BTC: { UP: 0.7, DOWN: 0.7 },
            ETH: { UP: 0.7, DOWN: 0.7 },
            DOGE: { UP: 0.7, DOWN: 0.7 },
          },
        },
        {
          watcher: { getCurrentMarket: vi.fn(async () => market) } as unknown as MarketWatcher,
          orderbook: fakeOrderbook(askDelLibro),
          priceFeed: livePriceFeed("BTC", 130, nowMs),
          state,
          executor,
          reconciler: fakeReconciler(),
        },
      );
      return { runner, executor, nowMs };
    };

    const programa = () =>
      startBandProgram({
        market: "BTC",
        lo: 0.85,
        hi: 0.9,
        expectedNetPerTradeUsd: 0.3,
        outOfSampleTrades: 60,
        reason: "gana en ambas mitades",
        nowMs: 0,
      });

    it("sin sondeo, un precio por encima del techo se descarta como siempre", async () => {
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      const { runner, executor, nowMs } = montar(0.88);
      await runner.runOnce(nowMs);
      expect(executor.execute).not.toHaveBeenCalled();
    });

    it("con sondeo en curso, ese mismo precio SI entra", async () => {
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      const { runner, executor, nowMs } = montar(0.88);
      runner.setBandPrograms([programa()]);
      await runner.runOnce(nowMs);
      expect(executor.execute).toHaveBeenCalled();
    });

    it("el sondeo se agota: el presupuesto diario acota lo que cuesta comprobar una banda", async () => {
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      const { runner, executor, nowMs } = montar(0.88);
      runner.setBandPrograms([programa()]);
      // Cada iteracion es una ventana distinta, asi que la guardia de "ya operado" no interfiere.
      for (let i = 0; i < 6; i += 1) {
        await runner.runOnce(nowMs + i * 300_000);
      }
      expect((executor.execute as ReturnType<typeof vi.fn>).mock.calls.length).toBeLessThanOrEqual(
        PROBE_MAX_PER_MARKET_DAY,
      );
    });

    it("un programa ya decidido no abre nada: solo sondea el que esta en pruebas", async () => {
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      const { runner, executor, nowMs } = montar(0.88);
      runner.setBandPrograms([{ ...programa(), status: "confirmed" as const }]);
      await runner.runOnce(nowMs);
      expect(executor.execute).not.toHaveBeenCalled();
    });
  });

  /**
   * Las ventanas de 15m son TRES veces mas oportunidades de arbitraje, la unica estrategia con ventaja
   * estructural. Se añaden solo para eso: el direccional necesitaria una dimension de duracion en
   * todos los ajustes por mercado, y no hay evidencia de que pague ni en 5m.
   */
  describe("arbitraje en ventanas de 15m", () => {
    const montar = async (opts: { arb15mEnabled: boolean }) => {
      const dataDir = await mkdtemp(join(tmpdir(), "polybot-15m-"));
      arbTemps.push(dataDir);
      const windowStartMs = Date.UTC(2026, 4, 7, 4, 25, 0, 0);
      const nowMs = windowStartMs + 200_000;
      const m5 = { ...marketInfo("ETH", "eth", windowStartMs), orderMinSize: 5 };
      const m15 = { ...m5, slug: "eth-updown-15m-1", orderMinSize: 5 };
      const openings = new Map(
        [m5, m15].map((m) => [
          m.slug,
          {
            asset: m.asset,
            slug: m.slug,
            windowStartMs,
            openingPrice: 100,
            openingTickTimestampMs: windowStartMs,
            capturedAtMs: windowStartMs,
          },
        ]),
      );
      const recorded: TradeAttempt[] = [];
      const state = {
        load: vi.fn(async () => undefined),
        listTrades: vi.fn(() => recorded),
        getOpening: vi.fn((slug: string) => openings.get(slug)),
        hasTraded: vi.fn((slug: string) => recorded.some((t) => t.slug === slug)),
        getDailySpend: vi.fn(() => 0),
        recordTradeAttempt: vi.fn(async (t: TradeAttempt) => {
          recorded.push(t);
        }),
      } as unknown as StateStore;
      // Par a 0.80: arbitraje claro en ambas duraciones.
      const orderbook = {
        getQuote: vi.fn(async (_t: string, amountUsd: number) => ({
          tokenId: "token",
          bestAsk: 0.4,
          bestBid: 0.39,
          availableUsdUnderCap: 400,
          availableUsdAllLevels: 400,
          estimatedSharesForAmount: amountUsd / 0.4,
          rawAskLevels: [],
          rawBidLevels: [],
        })),
      } as unknown as OrderbookService;
      const executor = {
        execute: vi.fn(async (input: ExecutionInput) => ({
          id: `${input.market.slug}-${input.outcome}`,
          asset: input.market.asset,
          slug: input.market.slug,
          mode: "sim" as const,
          outcome: input.outcome,
          tokenId: input.market.outcomes[input.outcome].tokenId,
          amountUsd: input.amountUsd,
          maxAskPrice: input.maxAskPrice,
          bestAsk: input.quote.bestAsk,
          estimatedShares: input.amountUsd / 0.4,
          fillDetected: true,
          filledAmountUsd: input.amountUsd,
          filledShares: input.amountUsd / 0.4,
          openingPrice: 100,
          entryPrice: 100.5,
          distanceUsd: input.distanceUsd,
          windowStartMs: input.market.windowStartMs,
          endMs: input.market.endMs,
          createdAtMs: nowMs,
        })),
      } satisfies TradeExecutor;
      const runner = new BotRunner(
        {
          ...baseConfig(),
          dataDir,
          arbEnabled: true,
          arb15mEnabled: opts.arb15mEnabled,
          arbMaxUsdPerOpportunity: 25,
          arbMinNetPerSet: 0.02,
        },
        {
          watcher: {
            getCurrentMarket: vi.fn(async () => m5),
            getCurrentMarketsForDuration: vi.fn(async () => [m15]),
          } as unknown as MarketWatcher,
          orderbook,
          priceFeed: livePriceFeed("ETH", 100.5, nowMs),
          state,
          executor,
          reconciler: fakeReconciler(),
          analyticsRecorder: {
            observeMarket: vi.fn(async () => undefined),
            recordResolvedTrade: vi.fn(async () => undefined),
          } as unknown as AnalyticsRecorder,
          notifier: { notify: vi.fn(async () => undefined) },
        },
      );
      return { runner, executor, recorded, nowMs };
    };

    it("con el interruptor apagado no toca las ventanas de 15m", async () => {
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      const { runner, recorded, nowMs } = await montar({ arb15mEnabled: false });
      await runner.runOnce(nowMs);
      expect(recorded.some((t) => t.slug.includes("-15m-"))).toBe(false);
    });

    it("encendido, ejecuta arbitraje tambien en 15m", async () => {
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      const { runner, recorded, nowMs } = await montar({ arb15mEnabled: true });
      await runner.runOnce(nowMs);
      expect(recorded.some((t) => t.slug.includes("-15m-"))).toBe(true);
    });

    it("en 15m SOLO hace arbitraje, nunca direccional", async () => {
      // Es la garantia del alcance: el direccional necesitaria ajustes por duracion que no existen.
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      const { runner, recorded, nowMs } = await montar({ arb15mEnabled: true });
      await runner.runOnce(nowMs);
      const de15m = recorded.filter((t) => t.slug.includes("-15m-"));
      expect(de15m.length).toBeGreaterThan(0);
      expect(de15m.every((t) => t.kind === "arb")).toBe(true);
    });
  });

  it("does not block simulation trades with the conservative live gate", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const windowStartMs = Date.UTC(2026, 4, 7, 4, 25, 0, 0);
    const nowMs = windowStartMs + 290_000;
    const market = marketInfo("BTC", "btc", windowStartMs);
    const openings = new Map([
      [
        market.slug,
        {
          asset: market.asset,
          slug: market.slug,
          windowStartMs,
          openingPrice: 100,
          openingTickTimestampMs: windowStartMs,
          capturedAtMs: windowStartMs,
        },
      ],
    ]);
    const state = {
      load: vi.fn(async () => undefined),
      listTrades: vi.fn(() => []),
      getOpening: vi.fn((slug: string) => openings.get(slug)),
      hasTraded: vi.fn(() => false),
      getDailySpend: vi.fn(() => 0),
      recordTradeAttempt: vi.fn(async () => undefined),
    } as unknown as StateStore;
    const executor = {
      execute: vi.fn(async (input: ExecutionInput) => ({
        id: `${input.market.slug}-${input.outcome}`,
        asset: input.market.asset,
        slug: input.market.slug,
        mode: "sim" as const,
        conditionId: input.market.conditionId,
        outcome: input.outcome,
        tokenId: input.market.outcomes[input.outcome].tokenId,
        amountUsd: input.amountUsd,
        maxAskPrice: input.maxAskPrice,
        bestAsk: input.quote.bestAsk,
        estimatedShares: input.quote.estimatedSharesForAmount,
        openingPrice: input.opening.openingPrice,
        entryPrice: input.tick.value,
        distanceUsd: input.distanceUsd,
        entryWindowSeconds: input.entryWindowSeconds,
        windowStartMs: input.market.windowStartMs,
        endMs: input.market.endMs,
        createdAtMs: nowMs,
      })),
    } satisfies TradeExecutor;

    const runner = new BotRunner(
      baseConfig(),
      {
        watcher: { getCurrentMarket: vi.fn(async () => market) } as unknown as MarketWatcher,
        orderbook: fakeOrderbook(0.9),
        priceFeed: livePriceFeed("BTC", 130, nowMs),
        state,
        executor,
        reconciler: fakeReconciler(),
      },
    );

    await runner.runOnce(nowMs);

    expect(executor.execute).toHaveBeenCalled();
    expect(state.recordTradeAttempt).toHaveBeenCalled();
  });

  it("blocks simulation trades that fail the EV gate when requirePositiveEv is on", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const windowStartMs = Date.UTC(2026, 4, 7, 4, 25, 0, 0);
    const nowMs = windowStartMs + 290_000;
    const market = marketInfo("BTC", "btc", windowStartMs);
    const openings = new Map([
      [
        market.slug,
        {
          asset: market.asset,
          slug: market.slug,
          windowStartMs,
          openingPrice: 100,
          openingTickTimestampMs: windowStartMs,
          capturedAtMs: windowStartMs,
        },
      ],
    ]);
    const state = {
      load: vi.fn(async () => undefined),
      listTrades: vi.fn(() => []),
      getOpening: vi.fn((slug: string) => openings.get(slug)),
      hasTraded: vi.fn(() => false),
      getDailySpend: vi.fn(() => 0),
      recordTradeAttempt: vi.fn(async () => undefined),
    } as unknown as StateStore;
    const executor = {
      execute: vi.fn(async () => {
        throw new Error("should not execute");
      }),
    } satisfies TradeExecutor;
    const strategyAnalysisEngine = {
      analyze: vi.fn(async () =>
        strategyAnalysisResponse(bestStrategy("BTC", "UP", 20, 20, 0.98, {
          tradeCount: 20,
          winCount: 15,
          lossCount: 5,
        })),
      ),
      estimateSetupWinRate: vi.fn(
        async () => bestStrategy("BTC", "UP", 20, 20, 0.98, { tradeCount: 20, winCount: 15, lossCount: 5 }).metrics,
      ),
    };

    const runner = new BotRunner(
      {
        ...baseConfig(),
        mode: "sim",
        requirePositiveEv: true,
      },
      {
        watcher: { getCurrentMarket: vi.fn(async () => market) } as unknown as MarketWatcher,
        orderbook: fakeOrderbook(0.9),
        priceFeed: livePriceFeed("BTC", 130, nowMs),
        state,
        executor,
        reconciler: fakeReconciler(),
        strategyAnalysisEngine,
      },
    );

    await runner.runOnce(nowMs);

    expect(strategyAnalysisEngine.estimateSetupWinRate).toHaveBeenCalled();
    expect(executor.execute).not.toHaveBeenCalled();
    expect(state.recordTradeAttempt).not.toHaveBeenCalled();
  });

  describe("cold-start exploration", () => {
    function explorationScenario(opts: {
      tradeCount: number;
      winCount: number;
      bestAsk: number;
      explorationEnabled?: boolean;
    }) {
      const windowStartMs = Date.UTC(2026, 4, 7, 4, 25, 0, 0);
      const nowMs = windowStartMs + 290_000;
      const market = marketInfo("BTC", "btc", windowStartMs);
      const openings = new Map([
        [
          market.slug,
          {
            asset: market.asset,
            slug: market.slug,
            windowStartMs,
            openingPrice: 100,
            openingTickTimestampMs: windowStartMs,
            capturedAtMs: windowStartMs,
          },
        ],
      ]);
      const state = {
        load: vi.fn(async () => undefined),
        listTrades: vi.fn(() => []),
        getOpening: vi.fn((slug: string) => openings.get(slug)),
        hasTraded: vi.fn(() => false),
        getDailySpend: vi.fn(() => 0),
        recordTradeAttempt: vi.fn(async () => undefined),
      } as unknown as StateStore;
      const executor = {
        execute: vi.fn(async (input: ExecutionInput) => ({
          id: `${input.market.slug}-${input.outcome}`,
          asset: input.market.asset,
          slug: input.market.slug,
          mode: "sim" as const,
          conditionId: input.market.conditionId,
          outcome: input.outcome,
          tokenId: input.market.outcomes[input.outcome].tokenId,
          amountUsd: input.amountUsd,
          maxAskPrice: input.maxAskPrice,
          bestAsk: input.quote.bestAsk,
          expectedValue: input.expectedValue,
          estimatedShares: input.quote.estimatedSharesForAmount,
          openingPrice: input.opening.openingPrice,
          entryPrice: input.tick.value,
          distanceUsd: input.distanceUsd,
          entryWindowSeconds: input.entryWindowSeconds,
          windowStartMs: input.market.windowStartMs,
          endMs: input.market.endMs,
          createdAtMs: nowMs,
        })),
      } satisfies TradeExecutor;
      const metrics = () =>
        bestStrategy("BTC", "UP", 20, 20, 0.98, {
          tradeCount: opts.tradeCount,
          winCount: opts.winCount,
          lossCount: opts.tradeCount - opts.winCount,
        }).metrics;
      const strategyAnalysisEngine = {
        analyze: vi.fn(async () => strategyAnalysisResponse(bestStrategy("BTC", "UP", 20, 20, 0.98, metrics()))),
        estimateSetupWinRate: vi.fn(async () => metrics()),
      };
      const runner = new BotRunner(
        {
          ...baseConfig(),
          mode: "sim",
          requirePositiveEv: true,
          evMinHistoryTrades: 15, // force the short-history branch (tradeCount < 15)
          explorationEnabled: opts.explorationEnabled ?? true,
        },
        {
          watcher: { getCurrentMarket: vi.fn(async () => market) } as unknown as MarketWatcher,
          orderbook: fakeOrderbook(opts.bestAsk),
          priceFeed: livePriceFeed("BTC", 130, nowMs),
          state,
          executor,
          reconciler: fakeReconciler(),
          strategyAnalysisEngine,
        },
      );
      return { runner, executor, nowMs };
    }

    it("probes a short-history setup when the shrunk EV is still positive", async () => {
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      // Edge modesto (5/8 => 0.60 contra ask 0.50 = +0.10): creible. Un 7/8 declararia +0.30 y ahora
      // se rechaza por implausible, que es justo lo que se quiere.
      const { runner, executor, nowMs } = explorationScenario({ tradeCount: 8, winCount: 5, bestAsk: 0.5 });
      await runner.runOnce(nowMs);
      expect(executor.execute).toHaveBeenCalled();
    });

    it("blocks the same short-history setup when exploration is disabled", async () => {
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      const { runner, executor, nowMs } = explorationScenario({
        tradeCount: 8,
        winCount: 5,
        bestAsk: 0.5,
        explorationEnabled: false,
      });
      await runner.runOnce(nowMs);
      expect(executor.execute).not.toHaveBeenCalled();
    });

    it("refuses to explore a short-history setup with no edge", async () => {
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      // Win rate == ask => zero/negative edge after shrinkage: exploration must not fire on noise.
      const { runner, executor, nowMs } = explorationScenario({ tradeCount: 8, winCount: 4, bestAsk: 0.5 });
      await runner.runOnce(nowMs);
      expect(executor.execute).not.toHaveBeenCalled();
    });
  });

  it("refuses to enter when the spread is wide", async () => {
    // Medido sobre 1.742 ventanas: el resultado se degrada de forma monotona con el spread (hasta 0.02
    // gana 60.8% contra 53.0% de break-even; por encima de 0.12 gana 50.9% contra 55.0%). Mecanismo:
    // spread ancho = poca contraparte, precio cotizado poco fiable y pagas el diferencial completo.
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const windowStartMs = Date.UTC(2026, 4, 7, 4, 25, 0, 0);
    const nowMs = windowStartMs + 200_000;
    const market = marketInfo("BTC", "btc", windowStartMs);
    const openings = new Map([
      [market.slug, { asset: market.asset, slug: market.slug, windowStartMs, openingPrice: 100, openingTickTimestampMs: windowStartMs, capturedAtMs: windowStartMs }],
    ]);
    const state = {
      load: vi.fn(async () => undefined),
      listTrades: vi.fn(() => []),
      getOpening: vi.fn((slug: string) => openings.get(slug)),
      hasTraded: vi.fn(() => false),
      getDailySpend: vi.fn(() => 0),
      recordTradeAttempt: vi.fn(async () => undefined),
    } as unknown as StateStore;
    const executor = { execute: vi.fn(async () => { throw new Error("no debe ejecutar"); }) } satisfies TradeExecutor;
    // Libro con spread de 0.20: muy por encima del maximo.
    const wideBook = {
      getQuote: vi.fn(async () => ({
        tokenId: "token", bestAsk: 0.5, bestBid: 0.3, availableUsdUnderCap: 100,
        availableUsdAllLevels: 100,
        estimatedSharesForAmount: 2, rawAskLevels: [],
      })),
    } as unknown as OrderbookService;
    const runner = new BotRunner(
      { ...baseConfig(), mode: "sim", requirePositiveEv: false, entryWindowSecondsByMarket: { BTC: 120, ETH: 120, DOGE: 120 } },
      {
        watcher: { getCurrentMarket: vi.fn(async () => market) } as unknown as MarketWatcher,
        orderbook: wideBook,
        priceFeed: livePriceFeed("BTC", 130, nowMs),
        state, executor, reconciler: fakeReconciler(),
      },
    );
    await runner.runOnce(nowMs);
    expect(executor.execute).not.toHaveBeenCalled();
  });

  it("refuses to enter in the final seconds of the window", async () => {
    // Medido en el ledger: entrar con <10s restantes realizo 32.4% de aciertos y -19.8% de ROI (n=34).
    // El mecanismo se conocia: cerca del cierre el CLOB bloquea takers (post-only), la profundidad se
    // adelgaza y el precio ya esta resuelto. Antes el bot solo desistia DESPUES del rechazo.
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const windowStartMs = Date.UTC(2026, 4, 7, 4, 25, 0, 0);
    const market = marketInfo("BTC", "btc", windowStartMs);
    const nowMs = market.endMs - 4_000; // quedan 4s: por debajo del minimo
    const openings = new Map([
      [market.slug, { asset: market.asset, slug: market.slug, windowStartMs, openingPrice: 100, openingTickTimestampMs: windowStartMs, capturedAtMs: windowStartMs }],
    ]);
    const state = {
      load: vi.fn(async () => undefined),
      listTrades: vi.fn(() => []),
      getOpening: vi.fn((slug: string) => openings.get(slug)),
      hasTraded: vi.fn(() => false),
      getDailySpend: vi.fn(() => 0),
      recordTradeAttempt: vi.fn(async () => undefined),
    } as unknown as StateStore;
    const executor = { execute: vi.fn(async () => { throw new Error("no debe ejecutar"); }) } satisfies TradeExecutor;
    const runner = new BotRunner(
      { ...baseConfig(), mode: "sim", requirePositiveEv: false, entryWindowSecondsByMarket: { BTC: 120, ETH: 120, DOGE: 120 } },
      {
        watcher: { getCurrentMarket: vi.fn(async () => market) } as unknown as MarketWatcher,
        orderbook: fakeOrderbook(0.5),
        priceFeed: livePriceFeed("BTC", 130, nowMs),
        state,
        executor,
        reconciler: fakeReconciler(),
      },
    );
    await runner.runOnce(nowMs);
    expect(executor.execute).not.toHaveBeenCalled();
  });

  it("still enters with comfortable time left in the window", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const windowStartMs = Date.UTC(2026, 4, 7, 4, 25, 0, 0);
    const market = marketInfo("BTC", "btc", windowStartMs);
    const nowMs = market.endMs - 60_000; // 60s restantes: muy por encima del minimo
    const openings = new Map([
      [market.slug, { asset: market.asset, slug: market.slug, windowStartMs, openingPrice: 100, openingTickTimestampMs: windowStartMs, capturedAtMs: windowStartMs }],
    ]);
    const state = {
      load: vi.fn(async () => undefined),
      listTrades: vi.fn(() => []),
      getOpening: vi.fn((slug: string) => openings.get(slug)),
      hasTraded: vi.fn(() => false),
      getDailySpend: vi.fn(() => 0),
      recordTradeAttempt: vi.fn(async () => undefined),
    } as unknown as StateStore;
    const executor = {
      execute: vi.fn(async (input: ExecutionInput) => ({
        id: "t", asset: input.market.asset, slug: input.market.slug, mode: "sim" as const,
        conditionId: input.market.conditionId, outcome: input.outcome,
        tokenId: input.market.outcomes[input.outcome].tokenId, amountUsd: input.amountUsd,
        maxAskPrice: input.maxAskPrice, bestAsk: input.quote.bestAsk,
        estimatedShares: input.quote.estimatedSharesForAmount, openingPrice: input.opening.openingPrice,
        entryPrice: input.tick.value, distanceUsd: input.distanceUsd,
        entryWindowSeconds: input.entryWindowSeconds, windowStartMs: input.market.windowStartMs,
        endMs: input.market.endMs, createdAtMs: nowMs,
      })),
    } satisfies TradeExecutor;
    const runner = new BotRunner(
      { ...baseConfig(), mode: "sim", requirePositiveEv: false, entryWindowSecondsByMarket: { BTC: 120, ETH: 120, DOGE: 120 } },
      {
        watcher: { getCurrentMarket: vi.fn(async () => market) } as unknown as MarketWatcher,
        orderbook: fakeOrderbook(0.5),
        priceFeed: livePriceFeed("BTC", 130, nowMs),
        state,
        executor,
        reconciler: fakeReconciler(),
      },
    );
    await runner.runOnce(nowMs);
    expect(executor.execute).toHaveBeenCalled();
  });

  it("does not trade when the price move is below the distance floor", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const windowStartMs = Date.UTC(2026, 4, 7, 4, 25, 0, 0);
    const nowMs = windowStartMs + 290_000;
    const market = marketInfo("BTC", "btc", windowStartMs);
    const openings = new Map([
      [
        market.slug,
        {
          asset: market.asset,
          slug: market.slug,
          windowStartMs,
          openingPrice: 100,
          openingTickTimestampMs: windowStartMs,
          capturedAtMs: windowStartMs,
        },
      ],
    ]);
    const state = {
      load: vi.fn(async () => undefined),
      listTrades: vi.fn(() => []),
      getOpening: vi.fn((slug: string) => openings.get(slug)),
      hasTraded: vi.fn(() => false),
      getDailySpend: vi.fn(() => 0),
      recordTradeAttempt: vi.fn(async () => undefined),
    } as unknown as StateStore;
    const executor = {
      execute: vi.fn(async () => {
        throw new Error("should not execute");
      }),
    } satisfies TradeExecutor;

    const runner = new BotRunner(
      {
        ...baseConfig(),
        mode: "sim",
        requirePositiveEv: false,
        minDistanceUsdByMarket: { BTC: 8, ETH: 5, DOGE: 0.0005 },
        minDistanceUsdByMarketOutcome: {
          BTC: { UP: 8, DOWN: 8 },
          ETH: { UP: 5, DOWN: 5 },
          DOGE: { UP: 0.0005, DOWN: 0.0005 },
        },
        minDistanceFloorUsdByMarket: { BTC: 25, ETH: 1, DOGE: 0.0005 },
      },
      {
        watcher: { getCurrentMarket: vi.fn(async () => market) } as unknown as MarketWatcher,
        orderbook: fakeOrderbook(0.5),
        // Price 115 vs opening 100 => distance 15: above the configured 8 but below the 25 floor.
        priceFeed: livePriceFeed("BTC", 115, nowMs),
        state,
        executor,
        reconciler: fakeReconciler(),
      },
    );

    await runner.runOnce(nowMs);

    expect(executor.execute).not.toHaveBeenCalled();
    expect(state.recordTradeAttempt).not.toHaveBeenCalled();
  });

  it("skips a trade when the book can only fill a fraction below minFillRatio", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const windowStartMs = Date.UTC(2026, 4, 7, 4, 25, 0, 0);
    const nowMs = windowStartMs + 290_000;
    const market = marketInfo("BTC", "btc", windowStartMs);
    const openings = new Map([
      [
        market.slug,
        {
          asset: market.asset,
          slug: market.slug,
          windowStartMs,
          openingPrice: 100,
          openingTickTimestampMs: windowStartMs,
          capturedAtMs: windowStartMs,
        },
      ],
    ]);
    const state = {
      load: vi.fn(async () => undefined),
      listTrades: vi.fn(() => []),
      getOpening: vi.fn((slug: string) => openings.get(slug)),
      hasTraded: vi.fn(() => false),
      getDailySpend: vi.fn(() => 0),
      recordTradeAttempt: vi.fn(async () => undefined),
    } as unknown as StateStore;
    const executor = {
      execute: vi.fn(async () => {
        throw new Error("should not execute a thin partial fill");
      }),
    } satisfies TradeExecutor;
    // Requested $1 but the book can only fill $0.30 under the cap => ratio 0.30 < the 0.5 default.
    const thinOrderbook = {
      getQuote: vi.fn(async () => ({
        tokenId: "token",
        bestAsk: 0.7,
        bestBid: 0.69,
        availableUsdUnderCap: 0.3,
        availableUsdAllLevels: 0.3,
        estimatedSharesForAmount: 0.3 / 0.7,
        rawAskLevels: [],
      })),
    } as unknown as OrderbookService;

    const runner = new BotRunner(
      {
        ...baseConfig(),
        mode: "sim",
        requirePositiveEv: false,
      },
      {
        watcher: { getCurrentMarket: vi.fn(async () => market) } as unknown as MarketWatcher,
        orderbook: thinOrderbook,
        // Price 130 vs opening 100 => distance 30, above the configured 20: a valid signal.
        priceFeed: livePriceFeed("BTC", 130, nowMs),
        state,
        executor,
        reconciler: fakeReconciler(),
      },
    );

    await runner.runOnce(nowMs);

    expect(thinOrderbook.getQuote).toHaveBeenCalled();
    expect(executor.execute).not.toHaveBeenCalled();
    expect(state.recordTradeAttempt).not.toHaveBeenCalled();
  });

  it("executes a complete-set arbitrage as ONE synthetic pair trade when enabled", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const dataDir = await mkdtemp(join(tmpdir(), "polybot-arb-"));
    arbTemps.push(dataDir);

    const windowStartMs = Date.UTC(2026, 4, 7, 4, 25, 0, 0);
    const nowMs = windowStartMs + 200_000;
    const market = marketInfo("ETH", "eth", windowStartMs);
    const openings = new Map([
      [
        market.slug,
        {
          asset: market.asset,
          slug: market.slug,
          windowStartMs,
          openingPrice: 100,
          openingTickTimestampMs: windowStartMs,
          capturedAtMs: windowStartMs,
        },
      ],
    ]);
    const recorded: TradeAttempt[] = [];
    const state = {
      load: vi.fn(async () => undefined),
      listTrades: vi.fn(() => recorded),
      getOpening: vi.fn((slug: string) => openings.get(slug)),
      // Reflect recorded trades so the once-per-window guard works (the watcher mock returns the same
      // market for all three symbols, so without this the pair would execute three times).
      hasTraded: vi.fn((slug: string) => recorded.some((trade) => trade.slug === slug)),
      getDailySpend: vi.fn(() => 0),
      recordTradeAttempt: vi.fn(async (trade: TradeAttempt) => {
        recorded.push(trade);
      }),
    } as unknown as StateStore;
    // Pair costs 0.80 with $40 depth per side: net/set ~0.166 post-fee, way above the 0.02 minimum.
    const orderbook = {
      getQuote: vi.fn(async (_tokenId: string, amountUsd: number) => ({
        tokenId: "token",
        bestAsk: 0.4,
        bestBid: 0.39,
        availableUsdUnderCap: 40,
        availableUsdAllLevels: 40,
        estimatedSharesForAmount: amountUsd / 0.4,
        rawAskLevels: [],
      })),
    } as unknown as OrderbookService;
    const executor = {
      execute: vi.fn(async (input: ExecutionInput) => ({
        id: `${input.market.slug}-${input.outcome}`,
        asset: input.market.asset,
        slug: input.market.slug,
        mode: "sim" as const,
        outcome: input.outcome,
        tokenId: input.market.outcomes[input.outcome].tokenId,
        amountUsd: input.amountUsd,
        maxAskPrice: input.maxAskPrice,
        bestAsk: input.quote.bestAsk,
        estimatedShares: input.amountUsd / 0.4,
        fillDetected: true,
        filledAmountUsd: input.amountUsd,
        filledShares: input.amountUsd / 0.4,
        openingPrice: 100,
        entryPrice: 100.5,
        distanceUsd: input.distanceUsd,
        windowStartMs: input.market.windowStartMs,
        endMs: input.market.endMs,
        createdAtMs: nowMs,
      })),
    } satisfies TradeExecutor;
    const notifier = { notify: vi.fn(async () => undefined) };

    const analyticsRecorder = {
      observeMarket: vi.fn(async () => undefined),
      recordResolvedTrade: vi.fn(async () => undefined),
    } as unknown as AnalyticsRecorder;
    const runner = new BotRunner(
      { ...baseConfig(), dataDir, arbEnabled: true, arbMaxUsdPerOpportunity: 25, arbMinNetPerSet: 0.02 },
      {
        watcher: { getCurrentMarket: vi.fn(async () => market) } as unknown as MarketWatcher,
        orderbook,
        // Price near opening: no momentum signal, so any execution comes from the arb path only.
        priceFeed: livePriceFeed("ETH", 100.5, nowMs),
        state,
        executor,
        reconciler: fakeReconciler(),
        analyticsRecorder,
        notifier,
      },
    );

    await runner.runOnce(nowMs);

    // Both legs bought (UP and DOWN), stored as ONE synthetic pair on the "#arb" slug.
    expect(executor.execute).toHaveBeenCalledTimes(2);
    const outcomes = (executor.execute as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[0].outcome).sort();
    expect(outcomes).toEqual(["DOWN", "UP"]);
    expect(state.recordTradeAttempt).toHaveBeenCalledTimes(1);
    expect(state.recordTradeAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "arb",
        arbPairComplete: true,
        slug: `${market.slug}#arb`,
        filledShares: expect.closeTo(31.25, 1),
      }),
    );
    expect(notifier.notify).toHaveBeenCalledWith(expect.objectContaining({ title: "Arbitraje ejecutado" }));
  });

  it("records the naked leg honestly when the second arb leg fails", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const dataDir = await mkdtemp(join(tmpdir(), "polybot-arb-"));
    arbTemps.push(dataDir);

    const windowStartMs = Date.UTC(2026, 4, 7, 4, 25, 0, 0);
    const nowMs = windowStartMs + 200_000;
    const market = marketInfo("ETH", "eth", windowStartMs);
    const state = {
      load: vi.fn(async () => undefined),
      listTrades: vi.fn(() => []),
      getOpening: vi.fn(() => ({
        asset: market.asset,
        slug: market.slug,
        windowStartMs,
        openingPrice: 100,
        openingTickTimestampMs: windowStartMs,
        capturedAtMs: windowStartMs,
      })),
      hasTraded: vi.fn(() => false),
      getDailySpend: vi.fn(() => 0),
      recordTradeAttempt: vi.fn(async () => undefined),
    } as unknown as StateStore;
    const orderbook = {
      getQuote: vi.fn(async (_tokenId: string, amountUsd: number) => ({
        tokenId: "token",
        bestAsk: 0.4,
        bestBid: 0.39,
        availableUsdUnderCap: 40,
        availableUsdAllLevels: 40,
        estimatedSharesForAmount: amountUsd / 0.4,
        rawAskLevels: [],
      })),
    } as unknown as OrderbookService;
    let calls = 0;
    const executor = {
      execute: vi.fn(async (input: ExecutionInput) => {
        calls += 1;
        if (calls > 1) {
          throw new Error("not enough liquidity");
        }
        return {
          id: `${input.market.slug}-${input.outcome}`,
          asset: input.market.asset,
          slug: input.market.slug,
          mode: "sim" as const,
          outcome: input.outcome,
          tokenId: "token",
          amountUsd: input.amountUsd,
          maxAskPrice: input.maxAskPrice,
          bestAsk: 0.4,
          estimatedShares: input.amountUsd / 0.4,
          fillDetected: true,
          filledAmountUsd: input.amountUsd,
          filledShares: input.amountUsd / 0.4,
          openingPrice: 100,
          entryPrice: 100.5,
          distanceUsd: 0,
          windowStartMs: input.market.windowStartMs,
          endMs: input.market.endMs,
          createdAtMs: nowMs,
        };
      }),
    } satisfies TradeExecutor;
    const notifier = { notify: vi.fn(async () => undefined) };

    const analyticsRecorder = {
      observeMarket: vi.fn(async () => undefined),
      recordResolvedTrade: vi.fn(async () => undefined),
    } as unknown as AnalyticsRecorder;
    const runner = new BotRunner(
      { ...baseConfig(), dataDir, arbEnabled: true },
      {
        watcher: { getCurrentMarket: vi.fn(async () => market) } as unknown as MarketWatcher,
        orderbook,
        priceFeed: livePriceFeed("ETH", 100.5, nowMs),
        state,
        executor,
        reconciler: fakeReconciler(),
        analyticsRecorder,
        notifier,
      },
    );

    await runner.runOnce(nowMs);

    expect(state.recordTradeAttempt).toHaveBeenCalledTimes(1);
    expect(state.recordTradeAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "arb", arbPairComplete: false, slug: `${market.slug}#arb` }),
    );
    expect(notifier.notify).toHaveBeenCalledWith(expect.objectContaining({ title: "Arbitraje incompleto" }));
  });

  it("only observes (never executes) arbitrage when the toggle is off", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const dataDir = await mkdtemp(join(tmpdir(), "polybot-arb-"));
    arbTemps.push(dataDir);

    const windowStartMs = Date.UTC(2026, 4, 7, 4, 25, 0, 0);
    const nowMs = windowStartMs + 200_000;
    const market = marketInfo("ETH", "eth", windowStartMs);
    const state = {
      load: vi.fn(async () => undefined),
      listTrades: vi.fn(() => []),
      getOpening: vi.fn(() => undefined),
      hasTraded: vi.fn(() => false),
      getDailySpend: vi.fn(() => 0),
      recordTradeAttempt: vi.fn(async () => undefined),
    } as unknown as StateStore;
    const orderbook = {
      getQuote: vi.fn(async (_tokenId: string, amountUsd: number) => ({
        tokenId: "token",
        bestAsk: 0.4,
        bestBid: 0.39,
        availableUsdUnderCap: 40,
        availableUsdAllLevels: 40,
        estimatedSharesForAmount: amountUsd / 0.4,
        rawAskLevels: [],
      })),
    } as unknown as OrderbookService;
    const executor = {
      execute: vi.fn(async () => {
        throw new Error("should not execute");
      }),
    } satisfies TradeExecutor;

    const analyticsRecorder = {
      observeMarket: vi.fn(async () => undefined),
      recordResolvedTrade: vi.fn(async () => undefined),
    } as unknown as AnalyticsRecorder;
    const runner = new BotRunner(
      { ...baseConfig(), dataDir }, // arbEnabled undefined -> off
      {
        watcher: { getCurrentMarket: vi.fn(async () => market) } as unknown as MarketWatcher,
        orderbook,
        priceFeed: livePriceFeed("ETH", 100.5, nowMs),
        state,
        executor,
        reconciler: fakeReconciler(),
        analyticsRecorder,
      },
    );

    await runner.runOnce(nowMs);
    expect(executor.execute).not.toHaveBeenCalled();
    expect(state.recordTradeAttempt).not.toHaveBeenCalled();
  });

  /**
   * El minimo del exchange esta en DOLARES ($5, confirmado contra gamma y contra la semantica de
   * `amount` del cliente CLOB, que para BUY son dolares). La comprobacion anterior chocaba unidades
   * — comparaba `sets` (participaciones) contra ese $5 — asi que dejaba pasar tamaños cuyas dos patas
   * salian por debajo del minimo y el exchange rechazaba. Es la razon de que el arbitraje tuviera 0
   * ejecuciones en live pese a detectar oportunidades.
   */
  it("no manda un arbitraje cuyas patas quedarian por debajo del minimo EN DOLARES", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const dataDir = await mkdtemp(join(tmpdir(), "polybot-arb-"));
    arbTemps.push(dataDir);

    const windowStartMs = Date.UTC(2026, 4, 7, 4, 25, 0, 0);
    const nowMs = windowStartMs + 200_000;
    // orderMinSize real de estos mercados: $5.
    const market = { ...marketInfo("ETH", "eth", windowStartMs), orderMinSize: 5 };
    const state = {
      load: vi.fn(async () => undefined),
      listTrades: vi.fn(() => []),
      getOpening: vi.fn(() => undefined),
      hasTraded: vi.fn(() => false),
      getDailySpend: vi.fn(() => 0),
      recordTradeAttempt: vi.fn(async () => undefined),
    } as unknown as StateStore;
    // Par a 0.80 (0.40 cada lado): con un presupuesto de $8 salen 10 sets, o sea dos patas de $4.00.
    // La regla vieja (`sets` 10 >= 5) lo dejaba pasar; ambas patas son sub-minimo.
    const orderbook = {
      getQuote: vi.fn(async (_tokenId: string, amountUsd: number) => ({
        tokenId: "token",
        bestAsk: 0.4,
        bestBid: 0.39,
        availableUsdUnderCap: 40,
        availableUsdAllLevels: 40,
        estimatedSharesForAmount: amountUsd / 0.4,
        rawAskLevels: [],
      })),
    } as unknown as OrderbookService;
    const executor = { execute: vi.fn() } satisfies TradeExecutor;
    const analyticsRecorder = {
      observeMarket: vi.fn(async () => undefined),
      recordResolvedTrade: vi.fn(async () => undefined),
    } as unknown as AnalyticsRecorder;

    const runner = new BotRunner(
      { ...baseConfig(), dataDir, arbEnabled: true, arbMaxUsdPerOpportunity: 8, arbMinNetPerSet: 0.02 },
      {
        watcher: { getCurrentMarket: vi.fn(async () => market) } as unknown as MarketWatcher,
        orderbook,
        priceFeed: livePriceFeed("ETH", 100.5, nowMs),
        state,
        executor,
        reconciler: fakeReconciler(),
        analyticsRecorder,
        notifier: { notify: vi.fn(async () => undefined) },
      },
    );

    await runner.runOnce(nowMs);

    // Ni una sola orden: mandar $4 seria un rechazo del exchange, y si solo llenase una pata el
    // arbitraje se convierte en una posicion direccional desnuda.
    expect(executor.execute).not.toHaveBeenCalled();
    expect(state.recordTradeAttempt).not.toHaveBeenCalled();
  });

  /**
   * El arbitraje solo carece de riesgo direccional si llenan las DOS patas. Dimensionarlo por encima
   * del colateral real garantiza lo contrario: la primera llena, la segunda se queda sin fondos y
   * queda una apuesta desnuda. Con $10 de saldo y presupuesto de $25 pasaria en cada oportunidad.
   */
  describe("arbitraje en LIVE: el tamaño no puede superar el colateral real", () => {
    const montarArb = async (opciones: {
      liveBankrollUsd?: number;
      budget: number;
      mercados?: number;
      perdidaPreviaUsd?: number;
      fallaSegundaPata?: boolean;
      nakedLegHaltStreak?: number;
      /** Falla la PRIMERA pata como lo hace el exchange de verdad, con contexto adjunto. */
      fallaPrimeraPataConDetalle?: boolean;
      /** Ask que devuelve el libro A PARTIR de la recotizacion (las 2 primeras llamadas son la deteccion). */
      askTrasRecotizar?: number;
      // Modo global del bot y modos por estrategia. Ausentes = live global, como era antes.
      modo?: "sim" | "live";
      arbMode?: "sim" | "live";
      directionalMode?: "sim" | "live";
      // Inyecta un ejecutor por modo para poder ver CUAL de los dos recibio cada orden.
      porModo?: boolean;
    }) => {
      const dataDir = await mkdtemp(join(tmpdir(), "polybot-arb-live-"));
      arbTemps.push(dataDir);
      const windowStartMs = Date.UTC(2026, 4, 7, 4, 25, 0, 0);
      const nowMs = windowStartMs + 200_000;
      const market = { ...marketInfo("ETH", "eth", windowStartMs), orderMinSize: 5 };
      // Un slug distinto por mercado, si no el guardia de "ya operado" tapa el segundo arbitraje.
      const mercados = Array.from({ length: opciones.mercados ?? 1 }, (_unused, i) => ({
        ...market,
        slug: `${market.slug}-${i}`,
      }));
      const openings = new Map(
        mercados.map((m) => [
          m.slug,
          {
            asset: m.asset,
            slug: m.slug,
            windowStartMs,
            openingPrice: 100,
            openingTickTimestampMs: windowStartMs,
            capturedAtMs: windowStartMs,
          },
        ]),
      );
      let siguienteMercado = 0;
      const recorded: TradeAttempt[] = [];
      if (opciones.perdidaPreviaUsd) {
        recorded.push({
          id: "perdida-previa",
          asset: "ETH",
          slug: "eth-perdida-previa",
          mode: "live",
          outcome: "UP",
          tokenId: "t",
          amountUsd: opciones.perdidaPreviaUsd,
          maxAskPrice: 0.9,
          bestAsk: 0.9,
          estimatedShares: opciones.perdidaPreviaUsd / 0.9,
          fillDetected: true,
          filledAmountUsd: opciones.perdidaPreviaUsd,
          filledShares: opciones.perdidaPreviaUsd / 0.9,
          openingPrice: 100,
          entryPrice: 100.5,
          distanceUsd: 1,
          windowStartMs,
          endMs: windowStartMs + 300_000,
          createdAtMs: windowStartMs - 60_000,
          resolved: {
            resolvedAtMs: windowStartMs - 30_000,
            finalPrice: 90,
            finalTickTimestampMs: windowStartMs - 30_000,
            winningOutcome: "DOWN",
            won: false,
          },
        } as unknown as TradeAttempt);
      }
      const state = {
        load: vi.fn(async () => undefined),
        listTrades: vi.fn(() => recorded),
        getOpening: vi.fn((slug: string) => openings.get(slug)),
        hasTraded: vi.fn((slug: string) => recorded.some((trade) => trade.slug === slug)),
        getDailySpend: vi.fn(() => 0),
        recordTradeAttempt: vi.fn(async (trade: TradeAttempt) => {
          recorded.push(trade);
        }),
      } as unknown as StateStore;
      // Par a 0.80 con profundidad de sobra: net/set ~0.166, muy por encima del minimo.
      let llamadasQuote = 0;
      const orderbook = {
        getQuote: vi.fn(async (_tokenId: string, amountUsd: number) => {
          llamadasQuote += 1;
          // Las dos primeras son la deteccion; de la tercera en adelante, la recotizacion.
          const bestAsk =
            opciones.askTrasRecotizar !== undefined && llamadasQuote > 2 ? opciones.askTrasRecotizar : 0.4;
          return {
          tokenId: "token",
          bestAsk,
          bestBid: 0.39,
          availableUsdUnderCap: 400,
          availableUsdAllLevels: 400,
          estimatedSharesForAmount: amountUsd / bestAsk,
          rawAskLevels: [],
          };
        }),
      } as unknown as OrderbookService;
      const executor = {
        execute: vi.fn(async (input: ExecutionInput) => {
          if (opciones.fallaPrimeraPataConDetalle && input.outcome === "UP") {
            throw new LiveOrderError(
              "no orders found to match with FAK order. FAK orders are partially filled or killed if no match is found.",
              {
                orderPrice: 0.42,
                quotedBestAsk: 0.4,
                quotedDepthUsd: 485.59,
                amountUsd: input.amountUsd,
                quoteAgeMs: 742,
                tokenId: "token",
              },
            );
          }
          // La primera pata es UP (profundidad igual en ambos lados): fallar DOWN deja pata suelta.
          if (opciones.fallaSegundaPata && input.outcome === "DOWN") {
            throw new Error("no funds");
          }
          return {
            id: `${input.market.slug}-${input.outcome}`,
          asset: input.market.asset,
          slug: input.market.slug,
          mode: "live" as const,
          outcome: input.outcome,
          tokenId: input.market.outcomes[input.outcome].tokenId,
          amountUsd: input.amountUsd,
          maxAskPrice: input.maxAskPrice,
          bestAsk: input.quote.bestAsk,
          estimatedShares: input.amountUsd / 0.4,
          fillDetected: true,
          filledAmountUsd: input.amountUsd,
          filledShares: input.amountUsd / 0.4,
          openingPrice: 100,
          entryPrice: 100.5,
          distanceUsd: input.distanceUsd,
          windowStartMs: input.market.windowStartMs,
          endMs: input.market.endMs,
            createdAtMs: nowMs,
          };
        }),
      } satisfies TradeExecutor;
      // La lambda no sobra: `vi.fn(unMock)` devuelve ESE mock, asi que los dos espias serian el mismo
      // objeto y el test pasaria mirase donde mirase.
      const espiar = (): TradeExecutor => ({ execute: vi.fn((input: ExecutionInput) => executor.execute(input)) });
      const executorSim = espiar();
      const executorLive = espiar();
      const runner = new BotRunner(
        {
          ...baseConfig(),
          dataDir,
          mode: opciones.modo ?? "live",
          confirmLive: true,
          arbMode: opciones.arbMode,
          directionalMode: opciones.directionalMode,
          arbEnabled: true,
          arbMaxUsdPerOpportunity: opciones.budget,
          arbNakedLegHaltStreak: opciones.nakedLegHaltStreak,
          arbMinNetPerSet: 0.02,
          liveBankrollUsd: opciones.liveBankrollUsd ?? 0,
          minBankrollForDirectionalUsd: 0,
          maxDailyLossUsd: 10,
          riskHaltCooldownHours: 1,
        },
        {
          watcher: {
            getCurrentMarket: vi.fn(async () => mercados[siguienteMercado++ % mercados.length]),
          } as unknown as MarketWatcher,
          orderbook,
          priceFeed: livePriceFeed("ETH", 100.5, nowMs),
          state,
          executor,
          executorByMode: opciones.porModo ? { sim: executorSim, live: executorLive } : undefined,
          reconciler: fakeReconciler(),
          analyticsRecorder: {
            observeMarket: vi.fn(async () => undefined),
            recordResolvedTrade: vi.fn(async () => undefined),
          } as unknown as AnalyticsRecorder,
          notifier: { notify: vi.fn(async () => undefined) },
        },
      );
      return { runner, executor, executorSim, executorLive, state, orderbook, nowMs };
    };

    describe("modo independiente por estrategia", () => {
      const llamadas = (executor: TradeExecutor) =>
        (executor.execute as ReturnType<typeof vi.fn>).mock.calls.length;

      it("con el bot en sim pero el arbitraje en live, las patas van al motor REAL", async () => {
        vi.spyOn(console, "log").mockImplementation(() => undefined);
        // Es el reparto que piden los numeros: arbitraje con dinero real, direccional en papel.
        const { runner, executorSim, executorLive, nowMs } = await montarArb({
          liveBankrollUsd: 12,
          budget: 25,
          porModo: true,
          modo: "sim",
          arbMode: "live",
          directionalMode: "sim",
        });
        await runner.runOnce(nowMs);
        expect(llamadas(executorLive)).toBe(2);
        expect(llamadas(executorSim)).toBe(0);
      });

      it("con el bot en live pero el arbitraje en sim, las patas NO tocan el motor real", async () => {
        vi.spyOn(console, "log").mockImplementation(() => undefined);
        // El reverso importa igual: leer el modo global aqui mandaria dinero real sin permiso.
        const { runner, executorSim, executorLive, nowMs } = await montarArb({
          liveBankrollUsd: 12,
          budget: 25,
          porModo: true,
          modo: "live",
          arbMode: "sim",
        });
        await runner.runOnce(nowMs);
        expect(llamadas(executorSim)).toBe(2);
        expect(llamadas(executorLive)).toBe(0);
      });

      it("cada estrategia consulta el gasto diario y lo ya operado con SU modo", async () => {
        vi.spyOn(console, "log").mockImplementation(() => undefined);
        const { runner, state, nowMs } = await montarArb({
          liveBankrollUsd: 12,
          budget: 25,
          porModo: true,
          modo: "sim",
          arbMode: "live",
          directionalMode: "sim",
        });
        await runner.runOnce(nowMs);
        // Si el papel gastara del contador del dinero real, unas operaciones ficticias agotarian el
        // presupuesto de lo unico que gana.
        const modosGasto = (state.getDailySpend as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[2]);
        expect(modosGasto).toContain("live");
        expect(modosGasto).toContain("sim");
        const modosOperado = (state.hasTraded as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[1]);
        expect(modosOperado).toContain("live");
      });
    });

    it("acota el tamaño al capital declarado en vez de gastar el presupuesto entero", async () => {
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      // Presupuesto $25 pero solo $12 de capital: cada pata debe salir de esos $12, no de los $25.
      const { runner, executor, nowMs } = await montarArb({ liveBankrollUsd: 12, budget: 25 });
      await runner.runOnce(nowMs);
      const importes = (executor.execute as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0].amountUsd);
      expect(importes.length).toBe(2);
      expect(importes.reduce((a: number, b: number) => a + b, 0)).toBeLessThanOrEqual(12);
      // ...y aun asi ambas patas superan el minimo del exchange, o no habria que mandarlas.
      for (const importe of importes) {
        expect(importe).toBeGreaterThanOrEqual(5);
      }
    });

    it("no compromete el mismo saldo dos veces cuando dos mercados dan arbitraje a la vez", async () => {
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      // Los tres mercados comparten la ventana de 5 min: sus oportunidades aparecen correlacionadas.
      const { runner, executor, nowMs } = await montarArb({ liveBankrollUsd: 12, budget: 25, mercados: 2 });
      await runner.runOnce(nowMs);
      const importes = (executor.execute as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0].amountUsd);
      const total = importes.reduce((a: number, b: number) => a + b, 0);
      // El segundo arbitraje solo puede usar lo que sobra del primero, no los $12 otra vez.
      expect(total).toBeLessThanOrEqual(12);
    });

    it("el cortacircuitos de riesgo NO frena el arbitraje: un par completo no tiene riesgo direccional", async () => {
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      // Perdida diaria por encima del limite: el direccional queda parado, el arbitraje no debe.
      const { runner, executor, nowMs } = await montarArb({
        liveBankrollUsd: 12,
        budget: 25,
        perdidaPreviaUsd: 40,
      });
      await runner.runOnce(nowMs);
      expect(executor.execute).toHaveBeenCalledTimes(2);
    });

    it("deja de intentar arbitrajes tras UNA pata suelta", async () => {
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      // Si la segunda pata deja de llenar de forma sistematica, cada intento abre una posicion
      // direccional que nadie pidio. Eso SI tiene que parar, aunque el cortacircuitos no aplique.
      //
      // Corta a la PRIMERA mientras el arbitraje en live no tenga historial: con capital de ~$18, dos
      // apuestas desnudas de ~$8.50 se lo comen entero.
      const { runner, executor, nowMs } = await montarArb({
        liveBankrollUsd: 40,
        budget: 25,
        mercados: 3,
        fallaSegundaPata: true,
      });
      await runner.runOnce(nowMs);
      // Un solo mercado intentado (2 patas); el segundo y el tercero ya no se intentan.
      expect(executor.execute).toHaveBeenCalledTimes(2);
    });

    it("recotiza justo antes de mandar, no reutiliza la cotizacion de la captura", async () => {
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      const { runner, orderbook, executor, nowMs } = await montarArb({ liveBankrollUsd: 12, budget: 25 });
      await runner.runOnce(nowMs);
      // 2 llamadas de la deteccion + 2 de la recotizacion.
      expect((orderbook.getQuote as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(4);
      expect(executor.execute).toHaveBeenCalledTimes(2);
    });

    it("si el arbitraje se evaporo entre la cotizacion y la orden, NO manda nada", async () => {
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      // El par pasa de 0.80 a 1.10: ya no hay arbitraje. Antes se mandaba igual, contra un libro que ya
      // no ofrecia nada — que es como murieron los dos primeros intentos en live.
      const { runner, executor, nowMs } = await montarArb({
        liveBankrollUsd: 12,
        budget: 25,
        askTrasRecotizar: 0.55,
      });
      await runner.runOnce(nowMs);
      expect(executor.execute).not.toHaveBeenCalled();
    });

    it("dimensiona con el ask RECOTIZADO, no con el que vio en la captura", async () => {
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      // Sigue siendo arbitraje (0.45+0.45=0.90) pero mas caro que lo visto (0.80).
      const { runner, executor, nowMs } = await montarArb({
        liveBankrollUsd: 40,
        budget: 20,
        askTrasRecotizar: 0.45,
      });
      await runner.runOnce(nowMs);
      const llamadas = (executor.execute as ReturnType<typeof vi.fn>).mock.calls;
      expect(llamadas.length).toBe(2);
      for (const [input] of llamadas) {
        expect(input.quote.bestAsk).toBe(0.45);
      }
    });

    it("un rechazo del exchange registra QUE se mando, no solo que fallo", async () => {
      // El logger escribe TODO por console.log, incluidos los warn.
      const lineas: string[] = [];
      vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
        lineas.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
      });
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      // Los dos primeros arbitrajes en live murieron con "no orders found to match" y el log no dejaba
      // distinguir si el libro se habia movido, si el precio iba bajo o si la cotizacion llegaba vieja.
      const { runner, nowMs } = await montarArb({
        liveBankrollUsd: 12,
        budget: 25,
        fallaPrimeraPataConDetalle: true,
      });
      await runner.runOnce(nowMs);

      const aviso = lineas.find((linea) => linea.includes("rechazado por el exchange"));
      expect(aviso).toBeDefined();
      expect(aviso).toContain("precioEnviado");
      expect(aviso).toContain("0.42");
      expect(aviso).toContain("askCotizado");
      // El margen que llevaba sobre el ask: si el rechazo llega igual, el libro se fue mas alla.
      expect(aviso).toContain("margenSobreAsk");
      // La sospecha numero uno tiene que ser medible, no deducible.
      expect(aviso).toContain("edadCotizacionMs");
      expect(aviso).toContain("742");
      expect(aviso).toContain("profundidadCotizadaUsd");
    });

    it("el freno de patas sueltas sale del AJUSTE, no de la constante", async () => {
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
      // Hace una hora este numero solo se podia cambiar recompilando, y el usuario tuvo que pedirmelo.
      // Con 2 debe tolerar una pata suelta e intentar el siguiente mercado; con 1 no.
      const conDos = await montarArb({
        liveBankrollUsd: 40,
        budget: 25,
        mercados: 3,
        fallaSegundaPata: true,
        nakedLegHaltStreak: 2,
      });
      await conDos.runner.runOnce(conDos.nowMs);
      expect(conDos.executor.execute).toHaveBeenCalledTimes(4);

      const conUno = await montarArb({
        liveBankrollUsd: 40,
        budget: 25,
        mercados: 3,
        fallaSegundaPata: true,
        nakedLegHaltStreak: 1,
      });
      await conUno.runner.runOnce(conUno.nowMs);
      expect(conUno.executor.execute).toHaveBeenCalledTimes(2);
    });

    it("un freno invalido cae al default en vez de parar el arbitraje entero", async () => {
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      // Un 0 significaria "parar antes del primer intento", que es lo contrario de "sin freno".
      const { runner, executor, nowMs } = await montarArb({
        liveBankrollUsd: 12,
        budget: 25,
        nakedLegHaltStreak: 0,
      });
      await runner.runOnce(nowMs);
      expect(executor.execute).toHaveBeenCalledTimes(2);
    });

    it("NO opera si el capital real se desconoce: dimensionar a ciegas es la pata desnuda", async () => {
      vi.spyOn(console, "log").mockImplementation(() => undefined);
      const { runner, executor, nowMs } = await montarArb({ liveBankrollUsd: 0, budget: 25 });
      await runner.runOnce(nowMs);
      expect(executor.execute).not.toHaveBeenCalled();
    });
  });

  it("corrects a live resolution when Polymarket's official outcome contradicts the feed", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const windowStartMs = Date.UTC(2026, 4, 7, 4, 25, 0, 0);
    const endMs = windowStartMs + 300_000;
    const nowMs = endMs + 10 * 60_000; // well past the official-resolution grace
    // Feed-based resolution said UP won (photo-finish); the official market paid DOWN.
    const misResolved: TradeAttempt = {
      id: "live-photo-finish",
      asset: "ETH",
      slug: `eth-updown-5m-${Math.floor(windowStartMs / 1000)}`,
      mode: "live",
      outcome: "DOWN",
      tokenId: "token",
      amountUsd: 5,
      maxAskPrice: 0.85,
      bestAsk: 0.25,
      estimatedShares: 20,
      fillDetected: true,
      filledAmountUsd: 5,
      filledShares: 20,
      openingPrice: 1806.0976,
      entryPrice: 1805.578,
      distanceUsd: -0.52,
      windowStartMs,
      endMs,
      createdAtMs: endMs - 60_000,
      resolved: {
        resolvedAtMs: endMs + 3_000,
        finalPrice: 1806.103,
        finalTickTimestampMs: endMs + 1_000,
        winningOutcome: "UP",
        won: false,
      },
    };
    const state = {
      load: vi.fn(async () => undefined),
      listTrades: vi.fn(() => [misResolved]),
      getOpening: vi.fn(() => undefined),
      hasTraded: vi.fn(() => true),
      getDailySpend: vi.fn(() => 0),
      recordTradeAttempt: vi.fn(async () => undefined),
      recordTradeOfficialResolution: vi.fn(async () => undefined),
    } as unknown as StateStore;
    const officialMarket = {
      ...marketInfo("ETH", "eth", windowStartMs),
      closed: true,
      outcomes: {
        UP: { outcome: "UP" as const, label: "Up", tokenId: "eth-up", impliedPrice: 0 },
        DOWN: { outcome: "DOWN" as const, label: "Down", tokenId: "eth-down", impliedPrice: 1 },
      },
    };
    const watcher = {
      getCurrentMarket: vi.fn(async () => null),
      getMarketBySlug: vi.fn(async () => officialMarket),
    } as unknown as MarketWatcher;
    const notifier = { notify: vi.fn(async () => undefined) };

    const runner = new BotRunner(baseConfig(), {
      watcher,
      orderbook: fakeOrderbook(),
      priceFeed: fakePriceFeed(),
      state,
      executor: {} as TradeExecutor,
      reconciler: fakeReconciler(),
      notifier,
    });

    await runner.runOnce(nowMs);

    expect(watcher.getMarketBySlug).toHaveBeenCalledWith(misResolved.slug, nowMs);
    expect(state.recordTradeOfficialResolution).toHaveBeenCalledWith(
      misResolved.slug,
      "live",
      { winningOutcome: "DOWN", verifiedAtMs: nowMs, corrected: true },
      // El id: sin el, con dos tramos en la ventana la verificacion oficial escribiria en la otra fila.
      misResolved.id,
    );
    expect(notifier.notify).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Resolución corregida" }),
    );

    // Throttled: an immediate second pass does not re-query gamma.
    await runner.runOnce(nowMs + 1_000);
    expect(watcher.getMarketBySlug).toHaveBeenCalledTimes(1);
  });

  it("corrects a SIM resolution against the official outcome too (sim must predict live)", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const windowStartMs = Date.UTC(2026, 6, 17, 4, 25, 0, 0);
    const endMs = windowStartMs + 300_000;
    const nowMs = endMs + 10 * 60_000;
    // Sim feed resolved DOWN (opening captured late during a spike); the official market paid UP.
    const misResolved: TradeAttempt = {
      id: "sim-late-open",
      asset: "ETH",
      slug: `eth-updown-5m-${Math.floor(windowStartMs / 1000)}`,
      mode: "sim",
      outcome: "UP",
      tokenId: "token",
      amountUsd: 5,
      maxAskPrice: 0.85,
      bestAsk: 0.5,
      estimatedShares: 10,
      fillDetected: true,
      filledAmountUsd: 5,
      filledShares: 10,
      openingPrice: 1832.05,
      entryPrice: 1831,
      distanceUsd: -1.68,
      windowStartMs,
      endMs,
      createdAtMs: endMs - 60_000,
      resolved: {
        resolvedAtMs: endMs + 3_000,
        finalPrice: 1830.19,
        finalTickTimestampMs: endMs,
        winningOutcome: "DOWN",
        won: false,
      },
    };
    const state = {
      load: vi.fn(async () => undefined),
      listTrades: vi.fn(() => [misResolved]),
      getOpening: vi.fn(() => undefined),
      hasTraded: vi.fn(() => true),
      getDailySpend: vi.fn(() => 0),
      recordTradeAttempt: vi.fn(async () => undefined),
      recordTradeOfficialResolution: vi.fn(async () => undefined),
    } as unknown as StateStore;
    const officialMarket = {
      ...marketInfo("ETH", "eth", windowStartMs),
      closed: true,
      outcomes: {
        UP: { outcome: "UP" as const, label: "Up", tokenId: "eth-up", impliedPrice: 1 },
        DOWN: { outcome: "DOWN" as const, label: "Down", tokenId: "eth-down", impliedPrice: 0 },
      },
    };
    const watcher = {
      getCurrentMarket: vi.fn(async () => null),
      getMarketBySlug: vi.fn(async () => officialMarket),
    } as unknown as MarketWatcher;
    const notifier = { notify: vi.fn(async () => undefined) };

    const runner = new BotRunner(baseConfig(), {
      watcher,
      orderbook: fakeOrderbook(),
      priceFeed: fakePriceFeed(),
      state,
      executor: {} as TradeExecutor,
      reconciler: fakeReconciler(),
      notifier,
    });

    await runner.runOnce(nowMs);

    expect(state.recordTradeOfficialResolution).toHaveBeenCalledWith(
      misResolved.slug,
      "sim",
      { winningOutcome: "UP", verifiedAtMs: nowMs, corrected: true },
      // El id: sin el, con dos tramos en la ventana la verificacion oficial escribiria en la otra fila.
      misResolved.id,
    );
  });

  it("stops retrying a window once the CLOB rejects with post-only mode", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const windowStartMs = Date.UTC(2026, 4, 7, 4, 25, 0, 0);
    const nowMs = windowStartMs + 290_000;
    const market = marketInfo("BTC", "btc", windowStartMs);
    const openings = new Map([
      [
        market.slug,
        {
          asset: market.asset,
          slug: market.slug,
          windowStartMs,
          openingPrice: 100,
          openingTickTimestampMs: windowStartMs,
          capturedAtMs: windowStartMs,
        },
      ],
    ]);
    const state = {
      load: vi.fn(async () => undefined),
      listTrades: vi.fn(() => []),
      getOpening: vi.fn((slug: string) => openings.get(slug)),
      hasTraded: vi.fn(() => false),
      getDailySpend: vi.fn(() => 0),
      recordTradeAttempt: vi.fn(async () => undefined),
    } as unknown as StateStore;
    const executor = {
      execute: vi.fn(async () => {
        throw new Error("post-only mode: only post-only orders and cancels are allowed");
      }),
    } satisfies TradeExecutor;
    const orderbook = fakeOrderbook(0.5);

    const runner = new BotRunner(
      {
        ...baseConfig(),
        mode: "sim",
        requirePositiveEv: false,
      },
      {
        watcher: { getCurrentMarket: vi.fn(async () => market) } as unknown as MarketWatcher,
        orderbook,
        priceFeed: livePriceFeed("BTC", 130, nowMs),
        state,
        executor,
        reconciler: fakeReconciler(),
      },
    );

    await runner.runOnce(nowMs);
    expect(executor.execute).toHaveBeenCalledTimes(1);

    // Same window, next poll ticks: the slug is marked post-only, so no more quoting or executing.
    await runner.runOnce(nowMs + 2_000);
    await runner.runOnce(nowMs + 4_000);
    expect(executor.execute).toHaveBeenCalledTimes(1);
    expect(state.recordTradeAttempt).not.toHaveBeenCalled();
  });

  it("blocks live trades with no exact strategy history at normal asks", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const windowStartMs = Date.UTC(2026, 4, 7, 4, 25, 0, 0);
    const nowMs = windowStartMs + 290_000;
    const market = marketInfo("BTC", "btc", windowStartMs);
    const openings = new Map([
      [
        market.slug,
        {
          asset: market.asset,
          slug: market.slug,
          windowStartMs,
          openingPrice: 100,
          openingTickTimestampMs: windowStartMs,
          capturedAtMs: windowStartMs,
        },
      ],
    ]);
    const state = {
      load: vi.fn(async () => undefined),
      listTrades: vi.fn(() => []),
      getOpening: vi.fn((slug: string) => openings.get(slug)),
      hasTraded: vi.fn(() => false),
      getDailySpend: vi.fn(() => 0),
      recordTradeAttempt: vi.fn(async () => undefined),
    } as unknown as StateStore;
    const executor = {
      execute: vi.fn(async () => {
        throw new Error("should not execute");
      }),
    } satisfies TradeExecutor;
    const strategyAnalysisEngine = {
      analyze: vi.fn(async () =>
        strategyAnalysisResponse(bestStrategy("BTC", "UP", 20, 20, 0.98, {
          tradeCount: 0,
          winCount: 0,
          lossCount: 0,
        })),
      ),
      estimateSetupWinRate: vi.fn(
        async () => bestStrategy("BTC", "UP", 20, 20, 0.98, { tradeCount: 0, winCount: 0, lossCount: 0 }).metrics,
      ),
    };

    const runner = new BotRunner(
      {
        ...baseConfig(),
        mode: "live",
        requirePositiveEv: true,
      },
      {
        watcher: { getCurrentMarket: vi.fn(async () => market) } as unknown as MarketWatcher,
        orderbook: fakeOrderbook(0.9),
        priceFeed: livePriceFeed("BTC", 130, nowMs),
        state,
        executor,
        reconciler: fakeReconciler(),
        strategyAnalysisEngine,
      },
    );

    await runner.runOnce(nowMs);

    expect(executor.execute).not.toHaveBeenCalled();
    expect(state.recordTradeAttempt).not.toHaveBeenCalled();
  });

  it.each([
    { finalPrice: 130, title: "Trade ganado", level: "info" as const, won: true },
    { finalPrice: 90, title: "Trade perdido", level: "warn" as const, won: false },
  ])("notifies Telegram when a trade is resolved as $title", async ({ finalPrice, title, level, won }) => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const nowMs = Date.UTC(2026, 4, 7, 4, 29, 30, 0);
    const windowStartMs = nowMs - 600_000;
    const trade: TradeAttempt = {
      id: `btc-up-${won ? "win" : "loss"}`,
      asset: "BTC",
      slug: `btc-updown-5m-${won ? "win" : "loss"}`,
      mode: "sim",
      conditionId: "BTC-condition",
      outcome: "UP",
      tokenId: "BTC-up",
      amountUsd: 1,
      maxAskPrice: 0.98,
      bestAsk: 0.5,
      estimatedShares: 2,
      openingPrice: 100,
      entryPrice: 120,
      distanceUsd: 20,
      entryWindowSeconds: 20,
      windowStartMs,
      endMs: windowStartMs + 300_000,
      createdAtMs: windowStartMs + 270_000,
    };
    const notifier = {
      notify: vi.fn(async () => undefined),
    };
    const state = {
      load: vi.fn(async () => undefined),
      listTrades: vi.fn(() => [trade]),
      recordTradeResolution: vi.fn(async (_slug: string, resolution: NonNullable<TradeAttempt["resolved"]>) => {
        trade.resolved = resolution;
      }),
      getDailySpend: vi.fn(() => 0),
    } as unknown as StateStore;
    const priceFeed = {
      start: vi.fn(),
      stop: vi.fn(),
      getLatestTick: vi.fn(() => ({
        market: "BTC",
        symbol: "btc/usd",
        value: finalPrice,
        timestampMs: nowMs,
        receivedAtMs: nowMs,
      })),
    } as unknown as ChainlinkPriceFeed;
    const runner = new BotRunner(baseConfig(), {
      watcher: { getCurrentMarket: vi.fn(async () => null) } as unknown as MarketWatcher,
      orderbook: fakeOrderbook(),
      priceFeed,
      state,
      executor: {} as TradeExecutor,
      reconciler: fakeReconciler(),
      notifier,
    });

    await runner.runOnce(nowMs);

    expect(state.recordTradeResolution).toHaveBeenCalledWith(
      trade.slug,
      expect.objectContaining({ won }),
      "sim",
      // El id apunta a la fila exacta: con banda y conviccion en la misma ventana, buscar por slug
      // resolveria siempre la primera.
      trade.id,
    );
    expect(notifier.notify).toHaveBeenCalledWith(
      expect.objectContaining({
        key: `trade-resolved:${trade.id}`,
        level,
        title,
        body: expect.stringContaining(`Slug: ${trade.slug}.`),
      }),
    );
    const notifiedBody = (notifier.notify as ReturnType<typeof vi.fn>).mock.calls[0][0].body as string;
    // The running P&L line carries the record AND its win percentage.
    expect(notifiedBody).toContain(won ? "1-0 (100% win)" : "0-1 (0% win)");
  });

  it("keeps trying other markets when one execution fails", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const windowStartMs = Date.UTC(2026, 4, 7, 4, 25, 0, 0);
    const nowMs = windowStartMs + 290_000;
    const markets: Partial<Record<MarketSymbol, MarketInfo>> = {
      BTC: marketInfo("BTC", "btc", windowStartMs),
      DOGE: marketInfo("DOGE", "doge", windowStartMs),
    };
    const openings = new Map(
      Object.values(markets).map((market) => [
        market.slug,
        {
          asset: market.asset,
          slug: market.slug,
          windowStartMs,
          openingPrice: market.asset === "DOGE" ? 0.1 : 100,
          openingTickTimestampMs: windowStartMs,
          capturedAtMs: windowStartMs,
        },
      ]),
    );
    const trades: TradeAttempt[] = [];
    const watcher = {
      getCurrentMarket: vi.fn(async (_nowMs: number, market: MarketSymbol = "BTC") => markets[market] ?? null),
    } as unknown as MarketWatcher;
    const priceFeed = {
      start: vi.fn(),
      stop: vi.fn(),
      getLatestTick: vi.fn((market: MarketSymbol = "BTC") => ({
        market,
        symbol: priceFeedSymbol(market),
        value: market === "DOGE" ? 0.1007 : 130,
        timestampMs: nowMs,
        receivedAtMs: nowMs,
      })),
    } as unknown as ChainlinkPriceFeed;
    const state = {
      load: vi.fn(async () => undefined),
      listTrades: vi.fn(() => []),
      getOpening: vi.fn((slug: string) => openings.get(slug)),
      hasTraded: vi.fn(() => false),
      getDailySpend: vi.fn(() => 0),
      recordTradeAttempt: vi.fn(async (trade: TradeAttempt) => {
        trades.push(trade);
      }),
    } as unknown as StateStore;
    const executor = {
      execute: vi.fn(async (input: ExecutionInput) => {
        if (input.market.asset === "BTC") {
          throw new Error("CLOB rejected BTC");
        }
        return {
          id: `${input.market.slug}-${input.outcome}`,
          asset: input.market.asset,
          slug: input.market.slug,
          mode: "sim" as const,
          conditionId: input.market.conditionId,
          outcome: input.outcome,
          tokenId: input.market.outcomes[input.outcome].tokenId,
          amountUsd: input.amountUsd,
          maxAskPrice: 0.98,
          bestAsk: input.quote.bestAsk,
          estimatedShares: input.quote.estimatedSharesForAmount,
          openingPrice: input.opening.openingPrice,
          entryPrice: input.tick.value,
          distanceUsd: input.distanceUsd,
          entryWindowSeconds: input.entryWindowSeconds,
          windowStartMs: input.market.windowStartMs,
          endMs: input.market.endMs,
          createdAtMs: nowMs,
        };
      }),
    } satisfies TradeExecutor;

    const runner = new BotRunner(
      {
        ...baseConfig(),
        enabledMarkets: ["BTC", "DOGE"],
        minDistanceUsdByMarket: { BTC: 20, ETH: 5, DOGE: 0.0005 },
      },
      {
        watcher,
        orderbook: fakeOrderbook(),
        priceFeed,
        state,
        executor,
        reconciler: fakeReconciler(),
      },
    );

    await runner.runOnce(nowMs);

    expect(executor.execute).toHaveBeenCalledTimes(2);
    expect(trades.map((trade) => trade.asset)).toEqual(["DOGE"]);
  });

  it("uses historical feed ticks to capture an opening processed after the grace window", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const windowStartMs = Date.UTC(2026, 4, 7, 4, 25, 0, 0);
    const nowMs = windowStartMs + 290_000;
    const market = marketInfo("ETH", "eth", windowStartMs);
    const openings = new Map<string, WindowOpening>();
    const watcher = {
      getCurrentMarket: vi.fn(async () => market),
    } as unknown as MarketWatcher;
    const priceFeed = {
      start: vi.fn(),
      stop: vi.fn(),
      getLatestTick: vi.fn(() => ({
        market: "ETH",
        symbol: "eth/usd",
        value: 2297,
        timestampMs: nowMs,
        receivedAtMs: nowMs,
      })),
      getTickInRange: vi.fn(() => ({
        market: "ETH",
        symbol: "eth/usd",
        value: 2290,
        timestampMs: windowStartMs + 1_000,
        receivedAtMs: nowMs,
      })),
    } as unknown as ChainlinkPriceFeed;
    const state = {
      load: vi.fn(async () => undefined),
      listTrades: vi.fn(() => []),
      getOpening: vi.fn((slug: string) => openings.get(slug)),
      saveOpening: vi.fn(async (opening: WindowOpening) => {
        openings.set(opening.slug, opening);
      }),
      hasTraded: vi.fn(() => false),
      getDailySpend: vi.fn(() => 0),
      recordTradeAttempt: vi.fn(async () => undefined),
    } as unknown as StateStore;
    const executor = {
      execute: vi.fn(async (input: ExecutionInput) => ({
        id: `${input.market.slug}-${input.outcome}`,
        asset: input.market.asset,
        slug: input.market.slug,
        mode: "sim" as const,
        conditionId: input.market.conditionId,
        outcome: input.outcome,
        tokenId: input.market.outcomes[input.outcome].tokenId,
        amountUsd: input.amountUsd,
        maxAskPrice: 0.98,
        bestAsk: input.quote.bestAsk,
        estimatedShares: input.quote.estimatedSharesForAmount,
        openingPrice: input.opening.openingPrice,
        entryPrice: input.tick.value,
        distanceUsd: input.distanceUsd,
        entryWindowSeconds: input.entryWindowSeconds,
        windowStartMs: input.market.windowStartMs,
        endMs: input.market.endMs,
        createdAtMs: nowMs,
      })),
    } satisfies TradeExecutor;

    const runner = new BotRunner(
      {
        ...baseConfig(),
        enabledMarkets: ["ETH"],
        minDistanceUsdByMarket: { BTC: 20, ETH: 5, DOGE: 0.0005 },
      },
      {
        watcher,
        orderbook: fakeOrderbook(),
        priceFeed,
        state,
        executor,
        reconciler: fakeReconciler(),
      },
    );

    await runner.runOnce(nowMs);

    expect(state.saveOpening).toHaveBeenCalledWith(
      expect.objectContaining({
        asset: "ETH",
        openingPrice: 2290,
        openingTickTimestampMs: windowStartMs + 1_000,
      }),
    );
    expect(executor.execute).toHaveBeenCalledWith(expect.objectContaining({ opening: expect.objectContaining({ openingPrice: 2290 }) }));
  });
});

function baseConfig(): BotConfig {
  return {
    mode: "sim",
    confirmLive: false,
    minBtcDistanceUsd: 20,
    enabledMarkets: ["BTC"],
    minDistanceUsdByMarket: { BTC: 20, ETH: 5, DOGE: 0.0005 },
    entryWindowSeconds: 20,
    entryWindowSecondsByMarket: { BTC: 20, ETH: 20, DOGE: 20 },
    simTradeAmountUsd: 1,
    liveTradeAmountUsd: 1,
    autoMinLive: true,
    maxAskPrice: 0.98,
    maxAskPriceCeiling: 0.98,
    requirePositiveEv: false,
    dailySpendLimitUsd: 50,
    tickStaleMs: 10_000,
    pollIntervalMs: 1,
    openingCaptureGraceMs: 15_000,
    dataDir: TEST_DATA_DIR,
    gammaHost: "https://gamma-api.polymarket.com",
    clobHost: "https://clob.polymarket.com",
    rtdsUrl: "wss://ws-live-data.polymarket.com",
    polygonRpcUrl: "https://polygon-rpc.com",
    signatureType: 0,
  };
}

function fakePriceFeed(): ChainlinkPriceFeed {
  return {
    start: vi.fn(),
    stop: vi.fn(),
    getLatestTick: vi.fn(() => undefined),
  } as unknown as ChainlinkPriceFeed;
}

function livePriceFeed(market: MarketSymbol, value: number, nowMs: number): ChainlinkPriceFeed {
  return {
    start: vi.fn(),
    stop: vi.fn(),
    getLatestTick: vi.fn(() => ({
      market,
      symbol: priceFeedSymbol(market),
      value,
      timestampMs: nowMs,
      receivedAtMs: nowMs,
    })),
  } as unknown as ChainlinkPriceFeed;
}

function fakeState(): StateStore {
  return {
    load: vi.fn(async () => undefined),
    listTrades: vi.fn(() => []),
  } as unknown as StateStore;
}

function fakeReconciler(): TradeReconciler {
  return {
    reconcile: vi.fn(async () => undefined),
  };
}

function fakeOrderbook(bestAsk = 0.5): OrderbookService {
  return {
    getQuote: vi.fn(async () => ({
      tokenId: "token",
      bestAsk,
      bestBid: bestAsk - 0.01,
      availableUsdUnderCap: 100,
        availableUsdAllLevels: 100,
      estimatedSharesForAmount: 1 / bestAsk,
      rawAskLevels: [],
    })),
  } as unknown as OrderbookService;
}

function bestStrategy(
  market: MarketSymbol,
  outcome: "UP" | "DOWN",
  entryWindowSeconds: number,
  minDistanceUsd: number,
  maxAskPrice: number,
  metricsOverrides: Partial<StrategyCandidate["metrics"]> = {},
): StrategyCandidate {
  const tradeCount = metricsOverrides.tradeCount ?? 5;
  const winCount = metricsOverrides.winCount ?? 4;
  const lossCount = metricsOverrides.lossCount ?? tradeCount - winCount;
  const averageAsk = metricsOverrides.averageAsk ?? 0.5;
  const adjustedWinProbability = metricsOverrides.adjustedWinProbability ?? (winCount + 1) / (tradeCount + 2);
  const edge = metricsOverrides.edge ?? adjustedWinProbability - averageAsk;
  const evRoi = metricsOverrides.evRoi ?? adjustedWinProbability / averageAsk - 1;
  return {
    market,
    outcome,
    entryWindowSeconds,
    minDistanceUsd,
    maxAskPrice,
    isCurrent: false,
    confidence: "medium",
    riskFlags: [],
    qualityScore: 0.5,
    evDeltaVsCurrent: 0.25,
    metrics: {
      sampleCount: 10,
      signalCount: 8,
      tradeCount,
      winCount,
      lossCount,
      quoteCoverage: 1,
      winRate: tradeCount > 0 ? winCount / tradeCount : undefined,
      realWinProbability: tradeCount > 0 ? winCount / tradeCount : undefined,
      adjustedWinProbability,
      averageAsk,
      historicalRoi: 0.6,
      evRoi,
      expectedRoi: evRoi,
      expectedValueUsd: evRoi,
      minExpectedValueUsd: 0.01,
      winProfitUsd: 1 / averageAsk - 1,
      lossUsd: -1,
      breakEvenProbability: averageAsk,
      edge,
      liveTradeAmountUsd: 1,
      askGuidance: "cheap",
      passesBasicEntry: adjustedWinProbability > averageAsk,
      passesSafetyMargin: adjustedWinProbability >= averageAsk + 0.02,
      passesExpectedValue: evRoi >= 0.01,
      passesRecommendedEntry: adjustedWinProbability >= averageAsk + 0.02 && evRoi >= 0.01,
      evDecisionReason: adjustedWinProbability >= averageAsk + 0.02 && evRoi >= 0.01 ? "passes" : "safety_margin",
      maxDrawdown: 1,
      ...metricsOverrides,
    },
  };
}

function strategyAnalysisResponse(strategy: StrategyCandidate): StrategyAnalysisResponse {
  return {
    generatedAtMs: Date.UTC(2026, 4, 7, 4, 25, 0, 0),
    strategies: [strategy],
    currentStrategies: [],
    summary: {
      sampleCount: 10,
      analyzedSampleCount: 10,
      strategyCount: 1,
      currentStrategyCount: 0,
      reliableStrategyCount: 1,
      bestEvRoi: strategy.metrics.evRoi,
      bestTradeCount: strategy.metrics.tradeCount,
      bestReliableEvRoi: strategy.metrics.evRoi,
      bestReliableTradeCount: strategy.metrics.tradeCount,
    },
  };
}

function marketInfo(asset: MarketSymbol, slugPrefix: string, windowStartMs: number): MarketInfo {
  return {
    asset,
    slug: `${slugPrefix}-updown-5m-${Math.floor(windowStartMs / 1000)}`,
    title: `${asset} Up or Down`,
    conditionId: `${asset}-condition`,
    windowStartMs,
    endMs: windowStartMs + 300_000,
    eventStartTimeMs: windowStartMs,
    acceptingOrders: true,
    active: true,
    closed: false,
    tickSize: "0.01",
    negRisk: false,
    orderMinSize: 1,
    outcomes: {
      UP: { outcome: "UP", label: "Up", tokenId: `${asset}-up` },
      DOWN: { outcome: "DOWN", label: "Down", tokenId: `${asset}-down` },
    },
  };
}

function priceFeedSymbol(market: MarketSymbol) {
  if (market === "ETH") {
    return "eth/usd";
  }
  if (market === "DOGE") {
    return "doge/usd";
  }
  return "btc/usd";
}

/**
 * Estrategia "favorito": comprar el lado que el LIBRO declara ganador.
 *
 * El escenario esta montado con el oraculo y el libro APUNTANDO A LADOS DISTINTOS (Chainlink sube de
 * 100 a 130, o sea UP; el libro pone caro DOWN). Es la unica forma de comprobar que la seleccion
 * cambio de criterio de verdad y no que las dos rutas coinciden por casualidad.
 */
describe("estrategia favorito", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const windowStartMs = Date.UTC(2026, 4, 7, 4, 25, 0, 0);
  // 10s para el cierre: dentro de la ventana de entrada (20s), dentro de la de analitica (120s) y
  // justo en el limite de `DEFAULT_MIN_SECONDS_TO_END` (10), que rechaza con `<`.
  const nowMs = windowStartMs + 290_000;

  function escenario(args: { upAsk: number; downAsk: number; overrides?: Partial<BotConfig> }) {
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    const market = marketInfo("ETH", "eth", windowStartMs);
    const opening: WindowOpening = {
      asset: market.asset,
      slug: market.slug,
      windowStartMs,
      openingPrice: 100,
      openingTickTimestampMs: windowStartMs,
      capturedAtMs: windowStartMs,
    };
    const watcher = {
      getCurrentMarket: vi.fn(async (_n: number, m: MarketSymbol = "BTC") => (m === "ETH" ? market : null)),
    } as unknown as MarketWatcher;
    const priceFeed = {
      start: vi.fn(),
      stop: vi.fn(),
      getLatestTick: vi.fn((m: MarketSymbol = "BTC") => ({
        market: m,
        symbol: priceFeedSymbol(m),
        value: 130,
        timestampMs: nowMs,
        receivedAtMs: nowMs,
      })),
    } as unknown as ChainlinkPriceFeed;
    const state = {
      load: vi.fn(async () => undefined),
      listTrades: vi.fn(() => []),
      getOpening: vi.fn(() => opening),
      hasTraded: vi.fn(() => false),
      getDailySpend: vi.fn(() => 0),
      recordTradeAttempt: vi.fn(async () => undefined),
    } as unknown as StateStore;
    const executor = {
      execute: vi.fn(async (input: ExecutionInput) => ({
        id: `${input.market.slug}-${input.outcome}`,
        asset: input.market.asset,
        slug: input.market.slug,
        mode: "sim" as const,
        conditionId: input.market.conditionId,
        outcome: input.outcome,
        tokenId: input.market.outcomes[input.outcome].tokenId,
        amountUsd: input.amountUsd,
        maxAskPrice: 0.98,
        bestAsk: input.quote.bestAsk,
        estimatedShares: input.quote.estimatedSharesForAmount,
        openingPrice: input.opening.openingPrice,
        entryPrice: input.tick.value,
        distanceUsd: input.distanceUsd,
        entryWindowSeconds: input.entryWindowSeconds,
        windowStartMs: input.market.windowStartMs,
        endMs: input.market.endMs,
        createdAtMs: nowMs,
      })),
    } satisfies TradeExecutor;
    const orderbook = {
      getQuote: vi.fn(async (tokenId: string) => {
        const bestAsk = tokenId === market.outcomes.UP.tokenId ? args.upAsk : args.downAsk;
        return {
          tokenId,
          bestAsk,
          bestBid: Math.max(bestAsk - 0.01, 0.01),
          availableUsdUnderCap: 100,
          availableUsdAllLevels: 100,
          estimatedSharesForAmount: 1 / bestAsk,
          rawAskLevels: [],
        };
      }),
    } as unknown as OrderbookService;

    const config: BotConfig = {
      ...baseConfig(),
      enabledMarkets: ["ETH"] as MarketSymbol[],
      favoriteStrategyEnabled: true,
      ...args.overrides,
    };

    const runner = new BotRunner(config, {
      watcher,
      orderbook,
      priceFeed,
      state,
      executor,
      reconciler: fakeReconciler(),
    });
    return { runner, executor };
  }

  it("compra el lado caro del libro aunque el oraculo apunte al contrario", async () => {
    const { runner, executor } = escenario({ upAsk: 0.2, downAsk: 0.8 });

    await runner.runOnce(nowMs);

    expect(executor.execute).toHaveBeenCalledTimes(1);
    // El direccional habria comprado UP (100 -> 130). El favorito compra DOWN, que es lo que pide el libro.
    expect(executor.execute).toHaveBeenCalledWith(expect.objectContaining({ outcome: "DOWN" }));
  });

  it("no entra mientras el mercado sigue repartido", async () => {
    const { runner, executor } = escenario({ upAsk: 0.3, downAsk: 0.7 });

    await runner.runOnce(nowMs);

    expect(executor.execute).not.toHaveBeenCalled();
  });

  it("no entra cuando el favorito ya esta demasiado caro", async () => {
    const { runner, executor } = escenario({ upAsk: 0.08, downAsk: 0.92 });

    await runner.runOnce(nowMs);

    expect(executor.execute).not.toHaveBeenCalled();
  });

  it("no entra en un libro muerto, aunque un lado cotice justo en la banda", async () => {
    const { runner, executor } = escenario({ upAsk: 0.8, downAsk: 0.8 });

    await runner.runOnce(nowMs);

    expect(executor.execute).not.toHaveBeenCalled();
  });

  // El invariante de seguridad: encender la estrategia sin abrir el cierre de live NO debe dejar
  // operando al criterio antiguo con dinero real.
  it("en live sin permiso explicito no opera, y NO cae de vuelta al direccional", async () => {
    const { runner, executor } = escenario({
      upAsk: 0.2,
      downAsk: 0.8,
      overrides: { directionalMode: "live" },
    });

    await runner.runOnce(nowMs);

    expect(executor.execute).not.toHaveBeenCalled();
  });

  it("con el cierre de live abierto, esa misma configuracion si opera", async () => {
    const { runner, executor } = escenario({
      upAsk: 0.2,
      downAsk: 0.8,
      overrides: { directionalMode: "live", favoriteAllowLive: true },
    });

    await runner.runOnce(nowMs);

    expect(executor.execute).toHaveBeenCalledTimes(1);
    expect(executor.execute).toHaveBeenCalledWith(expect.objectContaining({ outcome: "DOWN" }));
  });
});

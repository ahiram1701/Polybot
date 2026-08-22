import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";

import {
  AnalyticsRecorder,
  importAnalyticsSamples,
  contarMuestrasAnalytics,
  parseAnalyticsSamplesText,
  readAnalyticsSamples,
  serializeAnalyticsSamples,
  trimAnalyticsFileToMostRecent,
} from "../src/analyticsRecorder.js";
import type {
  MarketInfo,
  MarketSymbol,
  OrderbookQuote,
  Outcome,
  PriceTick,
  TradeAttempt,
  WindowOpening,
} from "../src/types.js";

const temps: string[] = [];

afterEach(async () => {
  await Promise.all(temps.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("AnalyticsRecorder", () => {
  it("writes resolved market samples with ticks and quotes", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "polybot-analytics-"));
    temps.push(dataDir);
    const recorder = new AnalyticsRecorder(dataDir);
    const windowStartMs = Date.UTC(2026, 4, 8, 12, 0, 0);
    const market = marketInfo("BTC", windowStartMs);
    const opening = openingInfo(market);
    const tick = priceTick("BTC", windowStartMs + 260_000, 125);

    await recorder.observeMarket({
      market,
      opening,
      tick,
      quotes: quotes(),
      nowMs: tick.timestampMs,
    });
    await recorder.observeMarket({
      market,
      opening,
      tick: priceTick("BTC", market.endMs, 130),
      quotes: {},
      nowMs: market.endMs,
    });

    const samples = await recorder.readSamples();
    expect(samples).toHaveLength(1);
    expect(samples[0]).toMatchObject({
      market: "BTC",
      slug: market.slug,
      openingPrice: 100,
      finalPrice: 130,
      winningOutcome: "UP",
    });
    expect(samples[0].ticks).toHaveLength(1);
    expect(samples[0].quotes[0].upBestAsk).toBe(0.52);
  });

  it("keeps samples grouped by market slug", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "polybot-analytics-"));
    temps.push(dataDir);
    const recorder = new AnalyticsRecorder(dataDir);
    const btc = marketInfo("BTC", Date.UTC(2026, 4, 8, 12, 0, 0));
    const eth = marketInfo("ETH", Date.UTC(2026, 4, 8, 12, 5, 0));

    await resolveSample(recorder, btc);
    await resolveSample(recorder, eth);

    const samples = await recorder.readSamples();
    expect(samples.map((sample) => sample.slug)).toEqual([btc.slug, eth.slug]);
    expect(samples.map((sample) => sample.market)).toEqual(["BTC", "ETH"]);
  });

  it("restores active samples after a recorder restart", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "polybot-analytics-"));
    temps.push(dataDir);
    const windowStartMs = Date.UTC(2026, 4, 8, 12, 0, 0);
    const market = marketInfo("BTC", windowStartMs);
    const opening = openingInfo(market);

    await new AnalyticsRecorder(dataDir).observeMarket({
      market,
      opening,
      tick: priceTick("BTC", market.endMs - 20_000, 125),
      quotes: quotes(),
      nowMs: market.endMs - 20_000,
    });
    await new AnalyticsRecorder(dataDir).observeMarket({
      market,
      opening,
      tick: priceTick("BTC", market.endMs, 130),
      quotes: {},
      nowMs: market.endMs,
    });

    const samples = await new AnalyticsRecorder(dataDir).readSamples();
    expect(samples).toHaveLength(1);
    expect(samples[0]).toMatchObject({
      slug: market.slug,
      finalPrice: 130,
      winningOutcome: "UP",
    });
    expect(samples[0].ticks).toHaveLength(1);
    expect(samples[0].quotes[0].upBestAsk).toBe(0.52);
  });

  it("writes a fallback analytics sample from a resolved trade", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "polybot-analytics-"));
    temps.push(dataDir);
    const windowStartMs = Date.UTC(2026, 4, 8, 12, 0, 0);
    const market = marketInfo("BTC", windowStartMs);
    const trade = tradeAttempt(market, "DOWN");

    await new AnalyticsRecorder(dataDir).recordResolvedTrade(trade, {
      resolvedAtMs: market.endMs + 1_000,
      finalPrice: 88,
      finalTickTimestampMs: market.endMs,
      winningOutcome: "DOWN",
      won: true,
    });

    const samples = await new AnalyticsRecorder(dataDir).readSamples();
    expect(samples).toHaveLength(1);
    expect(samples[0]).toMatchObject({
      slug: market.slug,
      market: "BTC",
      openingPrice: 100,
      finalPrice: 88,
      winningOutcome: "DOWN",
    });
    expect(samples[0].ticks[0]).toMatchObject({
      price: 90,
      distanceUsd: -10,
    });
    expect(samples[0].quotes[0].downBestAsk).toBe(0.47);
  });

  it("serializes and parses wrapped analytics samples for export", async () => {
    const sample = analyticsSample(marketInfo("BTC", Date.UTC(2026, 4, 8, 12, 0, 0)));

    const contents = serializeAnalyticsSamples([sample], new Date(Date.UTC(2026, 4, 8, 12, 1, 0)));
    const parsed = parseAnalyticsSamplesText(contents);

    expect(contents).toContain('"type":"analytics_sample"');
    expect(parsed.skippedInvalidCount).toBe(0);
    expect(parsed.duplicateCount).toBe(0);
    expect(parsed.samples).toEqual([sample]);
  });

  it("imports raw and wrapped samples while skipping invalid lines and duplicate slugs", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "polybot-analytics-"));
    temps.push(dataDir);
    const analyticsPath = join(dataDir, "analytics.jsonl");
    const earlier = analyticsSample(marketInfo("BTC", Date.UTC(2026, 4, 8, 12, 0, 0)), { finalPrice: 120 });
    const firstEth = analyticsSample(marketInfo("ETH", Date.UTC(2026, 4, 8, 12, 5, 0)), { finalPrice: 210 });
    const latestEth = analyticsSample(marketInfo("ETH", Date.UTC(2026, 4, 8, 12, 5, 0)), { finalPrice: 220 });

    const result = await importAnalyticsSamples(
      analyticsPath,
      [
        JSON.stringify({ type: "analytics_sample", sample: firstEth }),
        "not-json",
        JSON.stringify(earlier),
        JSON.stringify(latestEth),
      ].join("\n"),
      new Date(Date.UTC(2026, 4, 8, 12, 10, 0)),
    );

    expect(result).toMatchObject({
      importedCount: 2,
      duplicateCount: 1,
      skippedInvalidCount: 1,
      totalKnownSamples: 2,
      validSampleCount: 3,
    });
    const samples = await readAnalyticsSamples(analyticsPath);
    expect(samples.map((sample) => sample.slug)).toEqual([earlier.slug, latestEth.slug]);
    expect(samples[1].finalPrice).toBe(220);
  });

  it("reads incrementally: appends appear, partial lines wait, and a compacted file reloads", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "polybot-analytics-"));
    temps.push(dataDir);
    const analyticsPath = join(dataDir, "analytics.jsonl");
    const base = Date.UTC(2026, 4, 8, 12, 0, 0);
    const first = analyticsSample(marketInfo("BTC", base));
    const second = analyticsSample(marketInfo("ETH", base + 300_000));
    const third = analyticsSample(marketInfo("DOGE", base + 600_000));

    await writeFile(analyticsPath, serializeAnalyticsSamples([first]), "utf8");
    expect((await readAnalyticsSamples(analyticsPath)).map((sample) => sample.slug)).toEqual([first.slug]);

    // A complete appended line shows up on the next read (tail-only parse).
    await appendFile(analyticsPath, serializeAnalyticsSamples([second]), "utf8");
    expect((await readAnalyticsSamples(analyticsPath)).map((sample) => sample.slug)).toEqual([
      first.slug,
      second.slug,
    ]);

    // A PARTIAL line (writer mid-append) must not be consumed until its newline lands.
    const thirdLine = serializeAnalyticsSamples([third]);
    await appendFile(analyticsPath, thirdLine.slice(0, 25), "utf8");
    expect(await readAnalyticsSamples(analyticsPath)).toHaveLength(2);
    await appendFile(analyticsPath, thirdLine.slice(25), "utf8");
    expect((await readAnalyticsSamples(analyticsPath)).map((sample) => sample.slug)).toEqual([
      first.slug,
      second.slug,
      third.slug,
    ]);

    // Compaction rewrites the file smaller: the cache must detect it and fully reload.
    await writeFile(analyticsPath, serializeAnalyticsSamples([third]), "utf8");
    expect((await readAnalyticsSamples(analyticsPath)).map((sample) => sample.slug)).toEqual([third.slug]);
  });

  it("trims the analytics file to the most recent samples and collapses duplicate slugs", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "polybot-analytics-"));
    temps.push(dataDir);
    const analyticsPath = join(dataDir, "analytics.jsonl");
    const base = Date.UTC(2026, 4, 8, 12, 0, 0);
    const samples = Array.from({ length: 12 }, (_value, index) =>
      analyticsSample(marketInfo("BTC", base + index * 300_000)),
    );
    // Append the oldest sample a second time (newer finalPrice) to exercise slug de-duplication.
    const duplicate = { ...samples[0], finalPrice: 999 };
    await writeFile(analyticsPath, serializeAnalyticsSamples([...samples, duplicate]), "utf8");

    const kept = await trimAnalyticsFileToMostRecent(analyticsPath, 5);

    expect(kept).toBe(5);
    const remaining = await readAnalyticsSamples(analyticsPath);
    expect(remaining).toHaveLength(5);
    expect(remaining.map((sample) => sample.windowStartMs)).toEqual(
      samples.slice(-5).map((sample) => sample.windowStartMs),
    );
  });

  it("leaves the analytics file untouched when within the limit", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "polybot-analytics-"));
    temps.push(dataDir);
    const analyticsPath = join(dataDir, "analytics.jsonl");
    const base = Date.UTC(2026, 4, 8, 12, 0, 0);
    const samples = Array.from({ length: 3 }, (_value, index) =>
      analyticsSample(marketInfo("ETH", base + index * 300_000)),
    );
    await writeFile(analyticsPath, serializeAnalyticsSamples(samples), "utf8");

    const kept = await trimAnalyticsFileToMostRecent(analyticsPath, 5);

    expect(kept).toBe(3);
    expect(await readAnalyticsSamples(analyticsPath)).toHaveLength(3);
  });

  /**
   * Guardar NO poda. Es el cambio que evita el congelamiento: podar lee el fichero entero —con 288 MB
   * eso son ~587 MB de buffers y 7,85 segundos de bucle bloqueado, medido— y hacerlo desde el guardado
   * significaba hacerlo dentro de la fase de captura, justo cuando el bot deberia mirar el mercado. Un
   * arbitraje dura segundos: cada parada es una oportunidad perdida.
   */
  it("guardar NO poda: el camino caliente no puede pagar una lectura completa", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "polybot-analytics-"));
    temps.push(dataDir);
    const recorder = new AnalyticsRecorder(dataDir, 3, 0);
    const base = Date.UTC(2026, 4, 8, 12, 0, 0);

    for (let index = 0; index < 6; index += 1) {
      await resolveSample(recorder, marketInfo("BTC", base + index * 300_000));
    }

    // Se escribieron las 6 aunque el tope sea 3: nadie podo por el camino.
    expect(await recorder.readSamples()).toHaveLength(6);
  });

  it("pruneIfNeeded si recorta, y conserva las mas recientes", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "polybot-analytics-"));
    temps.push(dataDir);
    const recorder = new AnalyticsRecorder(dataDir, 3, 0);
    const base = Date.UTC(2026, 4, 8, 12, 0, 0);

    for (let index = 0; index < 6; index += 1) {
      await resolveSample(recorder, marketInfo("BTC", base + index * 300_000));
    }
    await recorder.pruneIfNeeded(true);

    const samples = await recorder.readSamples();
    expect(samples.length).toBeLessThanOrEqual(3);
    expect(Math.max(...samples.map((sample) => sample.windowStartMs))).toBe(base + 5 * 300_000);
  });

  it("por debajo del tope no lee el fichero: la comprobacion tiene que ser gratis", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "polybot-analytics-"));
    temps.push(dataDir);
    const recorder = new AnalyticsRecorder(dataDir, 100, 10);
    const base = Date.UTC(2026, 4, 8, 12, 0, 0);
    await resolveSample(recorder, marketInfo("BTC", base));
    // El primer recuento SI lee (es el del arranque, fuera del bucle).
    await recorder.pruneIfNeeded(true);

    await resolveSample(recorder, marketInfo("BTC", base + 300_000));
    // A partir de ahi la cuenta se lleva en memoria: sin pasarse del tope, no hay lectura que pagar.
    expect(await recorder.pruneIfNeeded()).toBe(2);
  });

  it("does not import analytics samples already known by slug", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "polybot-analytics-"));
    temps.push(dataDir);
    const analyticsPath = join(dataDir, "analytics.jsonl");
    const sample = analyticsSample(marketInfo("BTC", Date.UTC(2026, 4, 8, 12, 0, 0)));

    await importAnalyticsSamples(analyticsPath, JSON.stringify(sample));
    const duplicateResult = await importAnalyticsSamples(analyticsPath, JSON.stringify(sample));

    expect(duplicateResult.importedCount).toBe(0);
    expect(duplicateResult.duplicateCount).toBe(1);
    expect(duplicateResult.totalKnownSamples).toBe(1);
  });
});

async function resolveSample(recorder: AnalyticsRecorder, market: MarketInfo): Promise<void> {
  const opening = openingInfo(market);
  await recorder.observeMarket({
    market,
    opening,
    tick: priceTick(market.asset, market.endMs - 30_000, 110),
    quotes: quotes(),
    nowMs: market.endMs - 30_000,
  });
  await recorder.observeMarket({
    market,
    opening,
    tick: priceTick(market.asset, market.endMs, 112),
    quotes: {},
    nowMs: market.endMs,
  });
}

function marketInfo(asset: MarketSymbol, windowStartMs: number): MarketInfo {
  const prefix = asset.toLowerCase();
  return {
    asset,
    slug: `${prefix}-updown-5m-${Math.floor(windowStartMs / 1000)}`,
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

function openingInfo(market: MarketInfo): WindowOpening {
  return {
    asset: market.asset,
    slug: market.slug,
    windowStartMs: market.windowStartMs,
    openingPrice: 100,
    openingTickTimestampMs: market.windowStartMs,
    capturedAtMs: market.windowStartMs,
  };
}

function priceTick(market: MarketSymbol, timestampMs: number, value: number): PriceTick {
  return {
    market,
    symbol: market === "BTC" ? "btc/usd" : market === "ETH" ? "eth/usd" : "doge/usd",
    value,
    timestampMs,
    receivedAtMs: timestampMs,
  };
}

function quotes(): Partial<Record<Outcome, OrderbookQuote>> {
  return {
    UP: quote("up-token", 0.52),
    DOWN: quote("down-token", 0.48),
  };
}

function quote(tokenId: string, bestAsk: number): OrderbookQuote {
  return {
    tokenId,
    bestAsk,
    bestBid: bestAsk - 0.01,
    availableUsdUnderCap: 100,
      availableUsdAllLevels: 100,
    estimatedSharesForAmount: 1 / bestAsk,
    rawAskLevels: [{ price: bestAsk, size: 100 }],
    rawBidLevels: [{ price: bestAsk - 0.01, size: 100 }],
    availableBidUsdAllLevels: (bestAsk - 0.01) * 100,
  };
}

function analyticsSample(market: MarketInfo, overrides: Partial<ReturnType<typeof analyticsSampleShape>> = {}): ReturnType<typeof analyticsSampleShape> {
  return {
    ...analyticsSampleShape(market),
    ...overrides,
  };
}

function analyticsSampleShape(market: MarketInfo) {
  return {
    version: 1 as const,
    market: market.asset,
    slug: market.slug,
    windowStartMs: market.windowStartMs,
    endMs: market.endMs,
    openingPrice: 100,
    openingTickTimestampMs: market.windowStartMs,
    ticks: [
      {
        timestampMs: market.endMs - 30_000,
        secondsToEnd: 30,
        price: 112,
        distanceUsd: 12,
      },
    ],
    quotes: [
      {
        timestampMs: market.endMs - 30_000,
        secondsToEnd: 30,
        upBestAsk: 0.52,
        upBestBid: 0.51,
        downBestAsk: 0.49,
        downBestBid: 0.48,
      },
    ],
    finalPrice: 112,
    finalTickTimestampMs: market.endMs,
    winningOutcome: "UP" as const,
    resolvedAtMs: market.endMs + 1_000,
  };
}

function tradeAttempt(market: MarketInfo, outcome: Outcome): TradeAttempt {
  return {
    id: `${market.slug}-trade`,
    asset: market.asset,
    slug: market.slug,
    mode: "sim",
    conditionId: market.conditionId,
    outcome,
    tokenId: market.outcomes[outcome].tokenId,
    amountUsd: 1,
    maxAskPrice: 0.98,
    bestAsk: 0.47,
    estimatedShares: 2.12,
    openingPrice: 100,
    entryPrice: outcome === "UP" ? 110 : 90,
    distanceUsd: 10,
    entryWindowSeconds: 30,
    windowStartMs: market.windowStartMs,
    endMs: market.endMs,
    createdAtMs: market.endMs - 30_000,
  };
}

describe("la muestra mide la serie que RESUELVE, no el spot", () => {
  const base = Date.UTC(2026, 7, 12, 12, 0, 0);

  /** Observa una ventana entera y la cierra, con control de spot y TWAP. */
  async function ventana(args: {
    dataDir: string;
    aperturaTwap: boolean;
    spotCierre: number;
    twapCierre?: number;
    apertura: number;
  }) {
    const recorder = new AnalyticsRecorder(args.dataDir, 100, 0);
    const market = { ...marketInfo("BTC", base), twapLookbackSeconds: 60 };
    const opening = {
      asset: "BTC" as const,
      slug: market.slug,
      windowStartMs: base,
      openingPrice: args.apertura,
      openingTickTimestampMs: base,
      priceSource: args.aperturaTwap ? ("twap" as const) : ("spot" as const),
      capturedAtMs: base,
    };
    // Un tick a mitad de ventana que lleva el valor TWAP, y el tick de cierre (spot) que la resuelve.
    await recorder.observeMarket({
      market,
      opening,
      tick: { market: "BTC", symbol: "btc/usd", value: args.spotCierre, timestampMs: base + 250_000, receivedAtMs: base + 250_000 },
      twapTick:
        args.twapCierre === undefined
          ? undefined
          : { market: "BTC", symbol: "btc/usd", value: args.twapCierre, timestampMs: base + 250_000, receivedAtMs: base + 250_000 },
      twapWindowSeconds: 60,
      nowMs: base + 250_000,
    });
    await recorder.observeMarket({
      market,
      opening,
      tick: { market: "BTC", symbol: "btc/usd", value: args.spotCierre, timestampMs: base + 300_001, receivedAtMs: base + 300_001 },
      nowMs: base + 300_001,
    });
    return (await recorder.readSamples()).find((s) => s.slug === market.slug);
  }

  it("con apertura y cierre TWAP, gana el TWAP aunque el spot diga lo contrario", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "polybot-analytics-"));
    temps.push(dataDir);
    // Spot cierra POR DEBAJO de la apertura (diria DOWN); el TWAP cierra por encima (dice UP).
    // El mercado paga por el TWAP, asi que la etiqueta tiene que ser UP.
    const s = await ventana({ dataDir, aperturaTwap: true, apertura: 100, spotCierre: 99, twapCierre: 101 });
    expect(s?.winningOutcome).toBe("UP");
    expect(s?.finalTwapPrice).toBe(101);
    expect(s?.finalPrice).toBe(99);
    expect(s?.twapWindowSeconds).toBe(60);
  });

  it("con apertura SPOT no se mezcla: no compara peras con manzanas", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "polybot-analytics-"));
    temps.push(dataDir);
    // Misma situacion pero la apertura salio del spot. Comparar apertura spot contra cierre TWAP es
    // mezclar dos reglas y produce una etiqueta corrupta que despues nadie puede distinguir.
    const s = await ventana({ dataDir, aperturaTwap: false, apertura: 100, spotCierre: 99, twapCierre: 101 });
    expect(s?.winningOutcome).toBe("DOWN");
    expect(s?.openingPriceSource).toBe("spot");
  });

  it("graba quotes de TODA la ventana, no solo de los ultimos 120 s", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "polybot-analytics-"));
    temps.push(dataDir);
    const recorder = new AnalyticsRecorder(dataDir, 100, 0);
    const market = { ...marketInfo("BTC", base), twapLookbackSeconds: 60 };
    const opening = {
      asset: "BTC" as const, slug: market.slug, windowStartMs: base,
      openingPrice: 100, openingTickTimestampMs: base, priceSource: "twap" as const, capturedAtMs: base,
    };
    const quote = (bid: number, ask: number) => ({
      tokenId: "t", bestAsk: ask, bestBid: bid, quotedAtMs: base + 1_000,
      availableUsdUnderCap: 100, availableUsdAllLevels: 100, availableBidUsdAllLevels: 77,
      estimatedSharesForAmount: 10, rawAskLevels: [], rawBidLevels: [],
    });
    // A 280 s del cierre: fuera de los 120 s que se guardaban antes.
    await recorder.observeMarket({
      market, opening,
      tick: { market: "BTC", symbol: "btc/usd", value: 100, timestampMs: base + 20_000, receivedAtMs: base + 20_000 },
      quotes: { UP: quote(0.48, 0.5), DOWN: quote(0.48, 0.5) },
      nowMs: base + 20_000,
    });
    await recorder.observeMarket({
      market, opening,
      tick: { market: "BTC", symbol: "btc/usd", value: 101, timestampMs: base + 300_001, receivedAtMs: base + 300_001 },
      nowMs: base + 300_001,
    });
    const s = (await recorder.readSamples()).find((x) => x.slug === market.slug);
    const temprana = s?.quotes.find((q) => q.secondsToEnd > 200);
    expect(temprana).toBeDefined();
    // Y con el lado comprador, que hasta ahora se obtenia y se tiraba.
    expect(temprana?.upBidDepthUsd).toBe(77);
    expect(temprana?.quotedAtMs).toBe(base + 1_000);
  });
});

/**
 * Contar muestras no puede costar lo que parsearlas.
 *
 * Cada muestra lleva 260 cotizaciones y 115 ticks por segundo de su ventana —55 KB de mediana—, asi
 * que parsear las 10.000 que se retienen construye ~4,5 millones de objetos. Medido sobre el fichero
 * real de 446 MB el 2026-08-22: contar 248 ms, parsear ~4.817 ms y ~702 MB de heap. **19 veces mas
 * barato**, y sin bloquear el bucle: entre trozo y trozo hay una espera en la que se atienden
 * peticiones.
 *
 * Importa porque el arranque FORZABA la poda, y podar sin saber cuantas hay significaba parsearlo
 * todo. Con `/api/health` ya escuchando, esos segundos hacian que el watchdog lo tomara por muerto.
 */
describe("contar muestras sin parsearlas", () => {
  async function ficheroCon(contenido: string): Promise<string> {
    const dataDir = await mkdtemp(join(tmpdir(), "polybot-contar-"));
    temps.push(dataDir);
    const path = join(dataDir, "analytics.jsonl");
    await writeFile(path, contenido, "utf8");
    return path;
  }

  it("cuenta una linea por muestra", async () => {
    const path = await ficheroCon("a\nb\nc\n");
    expect(await contarMuestrasAnalytics(path)).toBe(3);
  });

  it("la ultima linea sin salto final tambien cuenta", async () => {
    // Un fichero puede quedar asi tras una escritura a medias. Contar de menos haria creer que cabe
    // una muestra mas de las que caben.
    const path = await ficheroCon("a\nb\nc");
    expect(await contarMuestrasAnalytics(path)).toBe(3);
  });

  it("un fichero vacio son cero muestras", async () => {
    expect(await contarMuestrasAnalytics(await ficheroCon(""))).toBe(0);
  });

  it("un fichero que no existe son cero muestras, no un error", async () => {
    // Es el primer arranque, no un fallo.
    const dataDir = await mkdtemp(join(tmpdir(), "polybot-contar-"));
    temps.push(dataDir);
    expect(await contarMuestrasAnalytics(join(dataDir, "no-existe.jsonl"))).toBe(0);
  });

  it("cuenta bien cuando el fichero ocupa varios trozos de lectura", async () => {
    // El bucle lee de 1 MB en 1 MB: una linea a caballo entre dos trozos no puede contarse dos veces
    // ni perderse.
    const linea = "x".repeat(4096);
    const cuantas = 700; // ~2,8 MB, o sea tres trozos
    const path = await ficheroCon(`${Array.from({ length: cuantas }, () => linea).join("\n")}\n`);
    expect(await contarMuestrasAnalytics(path)).toBe(cuantas);
  });
});

describe("el arranque no puede pagar una poda que no hace falta", () => {
  it("un recorder recien creado respeta la holgura en vez de reescribir", async () => {
    // Antes, no saber cuantas muestras hay bastaba para caer en la poda cara, y el arranque la
    // forzaba: se pagaba en CADA arranque —~17 s con el bucle bloqueado sobre 446 MB— con el watchdog
    // mirando. La clave es la HOLGURA: dentro de ella no se toca el fichero aunque se pase del tope,
    // que es justo lo que el codigo viejo no podia saber sin parsearlo todo.
    const dataDir = await mkdtemp(join(tmpdir(), "polybot-analytics-"));
    temps.push(dataDir);
    const base = Date.UTC(2026, 4, 8, 12, 0, 0);
    const sembrador = new AnalyticsRecorder(dataDir, 3, 10);
    for (let i = 0; i < 5; i += 1) {
      await resolveSample(sembrador, marketInfo("BTC", base + i * 300_000));
    }

    const analyticsPath = join(dataDir, "analytics.jsonl");
    const antes = await readFile(analyticsPath, "utf8");

    // Un proceso NUEVO: no sabe cuantas hay. Es exactamente el caso del arranque.
    const recien = new AnalyticsRecorder(dataDir, 3, 10);
    expect(await recien.pruneIfNeeded()).toBe(5); // 5 pasa del tope de 3, pero cabe en la holgura
    expect(await readFile(analyticsPath, "utf8")).toBe(antes); // intacto: no se ha reescrito nada
  });

  it("pero si se ha pasado del tope, poda igual", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "polybot-analytics-"));
    temps.push(dataDir);
    const base = Date.UTC(2026, 4, 8, 12, 0, 0);
    const sembrador = new AnalyticsRecorder(dataDir, 100, 10);
    for (let i = 0; i < 8; i += 1) {
      await resolveSample(sembrador, marketInfo("BTC", base + i * 300_000));
    }

    const recien = new AnalyticsRecorder(dataDir, 3, 0);
    expect(await recien.pruneIfNeeded()).toBe(3);
    const samples = await recien.readSamples();
    expect(samples).toHaveLength(3);
    expect(Math.max(...samples.map((s) => s.windowStartMs))).toBe(base + 7 * 300_000);
  });
});

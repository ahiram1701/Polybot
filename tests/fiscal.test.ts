import { describe, expect, it } from "vitest";

import { buildFiscalRows, serializeFiscalCsv, summarizeFiscalYear } from "../src/fiscal.js";
import { calculateTradePnl } from "../src/pnl.js";
import { emptyFxStore, ensureBanxicoRates, resolveRate, type FxStore } from "../src/fxRates.js";
import type { TradeAttempt } from "../src/types.js";

describe("buildFiscalRows", () => {
  it("includes only resolved LIVE trades and reconciles exactly with calculateTradePnl", () => {
    const liveWin = liveTrade({ id: "live-win", won: true, resolvedAtMs: Date.UTC(2026, 6, 10, 18, 0, 0) });
    const trades: TradeAttempt[] = [
      liveWin,
      liveTrade({ id: "live-pending", won: undefined, resolvedAtMs: 0 }),
      { ...liveTrade({ id: "sim-win", won: true, resolvedAtMs: Date.UTC(2026, 6, 10) }), mode: "sim" },
    ];

    const rows = buildFiscalRows(trades);
    expect(rows).toHaveLength(1);
    const pnl = calculateTradePnl(liveWin);
    expect(rows[0].gananciaUsd).toBeCloseTo(pnl.netUsd ?? NaN);
    expect(rows[0].invertidoUsd).toBeCloseTo(pnl.stakeUsd);
    expect(rows[0].recibidoUsd).toBeCloseTo(pnl.payoutUsd ?? NaN);
  });

  it("converts to MXN only when a rate resolves for the date", () => {
    const rows = buildFiscalRows(
      [
        liveTrade({ id: "with-rate", won: true, resolvedAtMs: Date.UTC(2026, 6, 10, 18, 0, 0) }),
        liveTrade({ id: "no-rate", won: false, resolvedAtMs: Date.UTC(2026, 7, 2, 18, 0, 0) }),
      ],
      (fechaIso) => (fechaIso.startsWith("2026-07") ? 17.5 : undefined),
    );
    const withRate = rows.find((row) => row.id === "with-rate");
    const noRate = rows.find((row) => row.id === "no-rate");
    expect(withRate?.gananciaMxn).toBeCloseTo((withRate?.gananciaUsd ?? 0) * 17.5);
    expect(noRate?.gananciaMxn).toBeUndefined();
  });
});

describe("summarizeFiscalYear", () => {
  it("groups by month within the year and never reports a partial MXN sum", () => {
    const rows = buildFiscalRows(
      [
        liveTrade({ id: "jul-1", won: true, resolvedAtMs: Date.UTC(2026, 6, 5, 18, 0, 0) }),
        liveTrade({ id: "jul-2", won: false, resolvedAtMs: Date.UTC(2026, 6, 20, 18, 0, 0) }),
        liveTrade({ id: "ago-1", won: true, resolvedAtMs: Date.UTC(2026, 7, 3, 18, 0, 0) }),
        liveTrade({ id: "prev-year", won: true, resolvedAtMs: Date.UTC(2025, 11, 31, 18, 0, 0) }),
      ],
      // Rate available for jul-1 only: July has partial coverage, August none.
      (fechaIso) => (fechaIso === "2026-07-05" ? 17 : undefined),
    );

    const summary = summarizeFiscalYear(rows, 2026);
    expect(summary.operaciones).toBe(3);
    expect(summary.months.map((month) => month.month)).toEqual([7, 8]);
    const july = summary.months[0];
    expect(july.operaciones).toBe(2);
    expect(july.gananciaMxn).toBeUndefined(); // partial coverage -> no misleading partial total
    expect(july.operacionesConTasa).toBe(1);
    expect(summary.availableYears).toEqual([2025, 2026]);
  });
});

describe("serializeFiscalCsv", () => {
  it("emits BOM + header and leaves MXN columns empty without a rate", () => {
    const rows = buildFiscalRows([liveTrade({ id: "t1", won: true, resolvedAtMs: Date.UTC(2026, 6, 10, 18, 0, 0) })]);
    const csv = serializeFiscalCsv(rows);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    const [header, line] = csv.slice(1).split("\r\n");
    expect(header).toBe(
      "fecha,id,mercado,lado,resultado,invertido_usd,comision_usd,recibido_usd,ganancia_usd,tipo_cambio_usd_mxn,ganancia_mxn",
    );
    expect(line).toContain("t1,ETH,UP,ganada");
    expect(line.endsWith(",,")).toBe(true); // no rate -> both MXN columns empty
  });
});

describe("resolveRate", () => {
  it("prefers manual exact, then manual month, then cached, then a recent prior cached rate", () => {
    const store: FxStore = {
      manualRates: { "2026-07-10": 18, "2026-07": 17 },
      cachedRates: { "2026-07-10": 16.5, "2026-07-03": 16 },
    };
    expect(resolveRate(store, "2026-07-10")).toBe(18); // manual exact wins
    expect(resolveRate(store, "2026-07-20")).toBe(17); // manual month
    const noManual: FxStore = { manualRates: {}, cachedRates: { "2026-07-10": 16.5, "2026-07-03": 16 } };
    expect(resolveRate(noManual, "2026-07-10")).toBe(16.5); // cached exact
    expect(resolveRate(noManual, "2026-07-05")).toBe(16); // weekend/holiday fallback (2 days back)
    expect(resolveRate(noManual, "2026-07-20")).toBeUndefined(); // beyond fallback window
  });
});

describe("ensureBanxicoRates", () => {
  it("fetches missing dates with the token and caches parsed FIX rates", async () => {
    const store = emptyFxStore();
    store.banxicoToken = "test-token";
    let requestedUrl = "";
    const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
      requestedUrl = String(url);
      expect((init?.headers as Record<string, string>)["Bmx-Token"]).toBe("test-token");
      return {
        ok: true,
        json: async () => ({
          bmx: { series: [{ datos: [{ fecha: "10/07/2026", dato: "17.1234" }, { fecha: "11/07/2026", dato: "N/E" }] }] },
        }),
      } as Response;
    }) as typeof fetch;

    const added = await ensureBanxicoRates(store, ["2026-07-10", "2026-07-11"], fetcher);
    expect(requestedUrl).toContain("/series/SF43718/datos/");
    expect(added).toBe(1); // "N/E" is skipped
    expect(store.cachedRates["2026-07-10"]).toBeCloseTo(17.1234);
    expect(resolveRate(store, "2026-07-11")).toBeCloseTo(17.1234); // prior-day fallback covers the gap
  });

  it("is a no-op without a token", async () => {
    const store = emptyFxStore();
    const added = await ensureBanxicoRates(store, ["2026-07-10"], (() => {
      throw new Error("should not fetch");
    }) as unknown as typeof fetch);
    expect(added).toBe(0);
  });
});

function liveTrade(args: { id: string; won: boolean | undefined; resolvedAtMs: number }): TradeAttempt {
  return {
    id: args.id,
    asset: "ETH",
    slug: `eth-updown-5m-${args.id}`,
    mode: "live",
    outcome: "UP",
    tokenId: "token",
    amountUsd: 7,
    maxAskPrice: 0.85,
    bestAsk: 0.7,
    estimatedShares: 10,
    openingPrice: 1700,
    entryPrice: 1701,
    distanceUsd: 1,
    windowStartMs: 1,
    endMs: 2,
    createdAtMs: args.resolvedAtMs - 60_000,
    fillDetected: true,
    filledAmountUsd: 7,
    filledShares: 10,
    feeUsd: 0.1,
    resolved:
      args.won === undefined
        ? undefined
        : {
            resolvedAtMs: args.resolvedAtMs,
            finalPrice: args.won ? 1710 : 1690,
            finalTickTimestampMs: args.resolvedAtMs,
            winningOutcome: args.won ? "UP" : "DOWN",
            won: args.won,
          },
  };
}

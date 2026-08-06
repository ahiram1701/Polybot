import { describe, expect, it } from "vitest";

import {
  activeProgram,
  decideBandProgram,
  isBandBlacklisted,
  realizedInBand,
  reviewConfirmedProgram,
  startBandProgram,
  type BandProgram,
} from "../src/bandProbeProgram.js";
import type { TradeAttempt } from "../src/types.js";

const T0 = Date.UTC(2026, 7, 6, 12, 0, 0);

function programa(overrides: Partial<BandProgram> = {}): BandProgram {
  return {
    ...startBandProgram({
      market: "ETH",
      lo: 0.85,
      hi: 0.9,
      expectedNetPerTradeUsd: 0.3,
      outOfSampleTrades: 73,
      reason: "gana en ambas mitades",
      nowMs: T0,
    }),
    ...overrides,
  };
}

function trade(overrides: Partial<TradeAttempt> = {}): TradeAttempt {
  return {
    id: "t",
    asset: "ETH",
    slug: "eth-1",
    mode: "sim",
    outcome: "UP",
    tokenId: "tok",
    amountUsd: 5,
    maxAskPrice: 0.95,
    bestAsk: 0.87,
    estimatedShares: 5 / 0.87,
    filledShares: 5 / 0.87,
    filledAmountUsd: 5,
    fillDetected: true,
    openingPrice: 100,
    entryPrice: 101,
    distanceUsd: 1,
    windowStartMs: T0,
    endMs: T0 + 300_000,
    createdAtMs: T0 + 1_000,
    resolved: {
      resolvedAtMs: T0 + 300_000,
      finalPrice: 101,
      finalTickTimestampMs: T0 + 300_000,
      winningOutcome: "UP",
      won: true,
    },
    ...overrides,
  } as TradeAttempt;
}

describe("realizedInBand", () => {
  it("solo cuenta trades del mercado, dentro de la banda y POSTERIORES a la prediccion", () => {
    const p = programa();
    const trades = [
      trade({ id: "dentro" }),
      trade({ id: "otro-mercado", asset: "BTC" }),
      trade({ id: "fuera-de-banda", bestAsk: 0.5 }),
      trade({ id: "anterior", createdAtMs: T0 - 60_000 }),
      trade({ id: "sin-resolver", resolved: undefined }),
    ];
    expect(realizedInBand(trades, p).trades).toBe(1);
  });

  /**
   * El `bestAsk` de un arbitraje es el coste del PAR (~0,93), asi que caeria en la banda alta y
   * envenenaria justo la tabla que decide la ventana direccional.
   */
  it("excluye el arbitraje completo", () => {
    const p = programa({ lo: 0.9, hi: 0.95 });
    const arb = trade({ id: "arb", bestAsk: 0.93, kind: "arb", arbPairComplete: true } as Partial<TradeAttempt>);
    expect(realizedInBand([arb], p).trades).toBe(0);
  });
});

describe("decideBandProgram", () => {
  it("no decide sin muestra: callar no es aprobar", () => {
    const p = programa();
    const decidido = decideBandProgram(p, { trades: 5, netUsd: 3, netPerTradeUsd: 0.6 }, T0 + 1);
    expect(decidido.status).toBe("probing");
    expect(decidido.verdict).toBeUndefined();
  });

  it("confirma cuando la realidad cumple lo prometido", () => {
    const p = programa();
    const decidido = decideBandProgram(p, { trades: 25, netUsd: 7.5, netPerTradeUsd: 0.3 }, T0 + 1);
    expect(decidido.status).toBe("confirmed");
    expect(decidido.realizedTrades).toBe(25);
  });

  it("rechaza si pierde dinero", () => {
    const p = programa();
    const decidido = decideBandProgram(p, { trades: 25, netUsd: -4, netPerTradeUsd: -0.16 }, T0 + 1);
    expect(decidido.status).toBe("rejected");
  });

  /**
   * EL caso que justifica todo esto. La analitica historica guarda solo el mejor precio del libro, asi
   * que la simulacion asume relleno perfecto y sale inflada. Una banda que promete $0,30 y entrega
   * $0,03 GANA dinero — pero el modelo que la eligio esta equivocado, y abrir la ventana del todo
   * fiandose de el es como se pierde dinero despacio.
   */
  it("rechaza lo que gana dinero pero entrega mucho menos de lo prometido", () => {
    const p = programa({ expectedNetPerTradeUsd: 0.3 });
    const decidido = decideBandProgram(p, { trades: 25, netUsd: 0.75, netPerTradeUsd: 0.03 }, T0 + 1);
    expect(decidido.status).toBe("rejected");
    expect(decidido.verdict).toContain("menos de la mitad");
  });

  it("acepta entregar algo menos de lo prometido, pero no cualquier cosa", () => {
    const p = programa({ expectedNetPerTradeUsd: 0.3 });
    expect(decideBandProgram(p, { trades: 25, netUsd: 5, netPerTradeUsd: 0.2 }, T0 + 1).status).toBe("confirmed");
    expect(decideBandProgram(p, { trades: 25, netUsd: 2.5, netPerTradeUsd: 0.1 }, T0 + 1).status).toBe("rejected");
  });

  it("no vuelve a decidir sobre un programa ya cerrado", () => {
    const cerrado = programa({ status: "confirmed" });
    expect(decideBandProgram(cerrado, { trades: 100, netUsd: -50, netPerTradeUsd: -0.5 }, T0 + 1).status).toBe(
      "confirmed",
    );
  });
});

describe("reviewConfirmedProgram", () => {
  it("revierte un cambio ya aplicado si la banda deja de pagar", () => {
    // Ultima red: un error que burle contrafactual, fuera de muestra y sondeos sigue teniendo que
    // sobrevivir al dinero real.
    const confirmado = programa({ status: "confirmed" });
    const revisado = reviewConfirmedProgram(confirmado, { trades: 30, netUsd: -6, netPerTradeUsd: -0.2 }, T0 + 9);
    expect(revisado.status).toBe("rejected");
    expect(revisado.verdict).toContain("Revertido");
  });

  it("no revierte mientras siga pagando", () => {
    const confirmado = programa({ status: "confirmed" });
    expect(reviewConfirmedProgram(confirmado, { trades: 30, netUsd: 6, netPerTradeUsd: 0.2 }, T0 + 9).status).toBe(
      "confirmed",
    );
  });

  it("no revierte sin muestra suficiente", () => {
    const confirmado = programa({ status: "confirmed" });
    expect(reviewConfirmedProgram(confirmado, { trades: 3, netUsd: -2, netPerTradeUsd: -0.66 }, T0 + 9).status).toBe(
      "confirmed",
    );
  });
});

describe("veto y concurrencia", () => {
  it("una banda rechazada no puede reproponerse enseguida", () => {
    const rechazado = programa({ status: "rejected", decidedAtMs: T0 });
    expect(isBandBlacklisted([rechazado], "ETH", 0.85, 0.9, T0 + 1000)).toBe(true);
  });

  it("pero el veto CADUCA: un rechazo no es para siempre", () => {
    // Cerrar la puerta definitivamente es como el autoajuste acababa clavado en ventanas cada vez mas
    // estrechas, sin datos nuevos que pudieran rehabilitarlas.
    const rechazado = programa({ status: "rejected", decidedAtMs: T0 });
    expect(isBandBlacklisted([rechazado], "ETH", 0.85, 0.9, T0 + 15 * 24 * 3_600_000)).toBe(false);
  });

  it("el veto es por banda y mercado, no global", () => {
    const rechazado = programa({ status: "rejected", decidedAtMs: T0 });
    expect(isBandBlacklisted([rechazado], "BTC", 0.85, 0.9, T0 + 1000)).toBe(false);
    expect(isBandBlacklisted([rechazado], "ETH", 0.9, 0.94, T0 + 1000)).toBe(false);
  });

  it("solo un sondeo a la vez por mercado: dos se contaminarian entre si", () => {
    const enCurso = programa();
    expect(activeProgram([enCurso], "ETH")?.lo).toBe(0.85);
    expect(activeProgram([programa({ status: "confirmed" })], "ETH")).toBeUndefined();
  });
});

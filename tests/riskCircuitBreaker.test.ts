import { describe, expect, it } from "vitest";

import { evaluateRiskCircuitBreaker } from "../src/riskCircuitBreaker.js";
import type { Mode, Outcome, TradeAttempt } from "../src/types.js";

const NOW = Date.UTC(2026, 6, 1, 15, 0, 0); // 2026-07-01
const YESTERDAY = Date.UTC(2026, 5, 30, 15, 0, 0);

function trade(args: {
  id: string;
  mode?: Mode;
  won?: boolean;
  resolvedAtMs?: number;
  amountUsd?: number;
  ask?: number;
  resolved?: boolean;
}): TradeAttempt {
  const ask = args.ask ?? 0.5;
  const base: TradeAttempt = {
    id: args.id,
    slug: args.id,
    mode: args.mode ?? "sim",
    outcome: "UP" as Outcome,
    tokenId: "token",
    amountUsd: args.amountUsd ?? 10,
    maxAskPrice: 0.98,
    bestAsk: ask,
    estimatedShares: (args.amountUsd ?? 10) / ask,
    filledShares: (args.amountUsd ?? 10) / ask,
    filledAmountUsd: args.amountUsd ?? 10,
    openingPrice: 100,
    entryPrice: 110,
    distanceUsd: 10,
    entryWindowSeconds: 30,
    windowStartMs: 1,
    endMs: 2,
    createdAtMs: (args.resolvedAtMs ?? NOW) - 60_000,
  };
  if (args.resolved === false) {
    return base;
  }
  return {
    ...base,
    resolved: {
      resolvedAtMs: args.resolvedAtMs ?? NOW,
      finalPrice: args.won ? 130 : 90,
      finalTickTimestampMs: args.resolvedAtMs ?? NOW,
      winningOutcome: (args.won ? "UP" : "DOWN") as Outcome,
      won: args.won ?? false,
    },
  };
}

describe("evaluateRiskCircuitBreaker", () => {
  it("scopes the metrics day to the configured timezone", () => {
    // Loss resolved 2026-07-14 04:30 UTC; evaluated at 12:00 UTC the same day.
    const lossMs = Date.UTC(2026, 6, 14, 4, 30);
    const nowMs = Date.UTC(2026, 6, 14, 12, 0);
    const trades = [trade({ id: "l", won: false, resolvedAtMs: lossMs })];
    const limits = { maxDailyLossUsd: 1, maxConsecutiveLosses: 0 };
    // Same UTC day -> counted -> trips.
    expect(evaluateRiskCircuitBreaker(trades, "sim", limits, nowMs).tripped).toBe(true);
    // In Mexico City the loss belongs to Jul 13 while "now" is Jul 14 -> clean day, no trip.
    expect(
      evaluateRiskCircuitBreaker(trades, "sim", { ...limits, timeZone: "America/Mexico_City" }, nowMs).tripped,
    ).toBe(false);
  });

  it("does not trip when both limits are disabled (0)", () => {
    const trades = [trade({ id: "a", won: false }), trade({ id: "b", won: false })];
    const status = evaluateRiskCircuitBreaker(trades, "sim", { maxDailyLossUsd: 0, maxConsecutiveLosses: 0 }, NOW);
    expect(status.tripped).toBe(false);
    expect(status.dailyLossUsd).toBeGreaterThan(0);
  });

  it("trips on the daily loss limit from losses realized today", () => {
    // 3 losses of $10 stake each today => ~$30 daily loss.
    const trades = [
      trade({ id: "a", won: false }),
      trade({ id: "b", won: false }),
      trade({ id: "c", won: false }),
    ];
    const status = evaluateRiskCircuitBreaker(trades, "sim", { maxDailyLossUsd: 25 }, NOW);
    expect(status.tripped).toBe(true);
    expect(status.reason).toBe("daily_loss_limit");
    expect(status.dailyLossUsd).toBeGreaterThanOrEqual(25);
  });

  it("trips on consecutive losses (most recent trades)", () => {
    const trades = [
      trade({ id: "win", won: true, resolvedAtMs: NOW - 4000 }),
      trade({ id: "l1", won: false, resolvedAtMs: NOW - 3000 }),
      trade({ id: "l2", won: false, resolvedAtMs: NOW - 2000 }),
      trade({ id: "l3", won: false, resolvedAtMs: NOW - 1000 }),
    ];
    const status = evaluateRiskCircuitBreaker(trades, "sim", { maxConsecutiveLosses: 3 }, NOW);
    expect(status.consecutiveLosses).toBe(3);
    expect(status.tripped).toBe(true);
    expect(status.reason).toBe("consecutive_losses");
  });

  it("resets the next UTC day: yesterday's losses do not count today", () => {
    const trades = [
      trade({ id: "y1", won: false, resolvedAtMs: YESTERDAY }),
      trade({ id: "y2", won: false, resolvedAtMs: YESTERDAY }),
      trade({ id: "y3", won: false, resolvedAtMs: YESTERDAY }),
    ];
    const status = evaluateRiskCircuitBreaker(trades, "sim", { maxDailyLossUsd: 25, maxConsecutiveLosses: 2 }, NOW);
    expect(status.tripped).toBe(false);
    expect(status.dailyLossUsd).toBe(0);
    expect(status.consecutiveLosses).toBe(0);
  });

  it("ignores trades from the other mode and pending trades", () => {
    const trades = [
      trade({ id: "live-loss", mode: "live", won: false }),
      trade({ id: "pending", resolved: false }),
    ];
    const status = evaluateRiskCircuitBreaker(trades, "sim", { maxDailyLossUsd: 5, maxConsecutiveLosses: 1 }, NOW);
    expect(status.tripped).toBe(false);
    expect(status.dailyLossUsd).toBe(0);
  });

  it("with a cooldown, stays tripped until the cooldown elapses and reports when it resumes", () => {
    const tripAt = NOW - 30 * 60_000; // tripped 30 minutes ago
    const trades = [
      trade({ id: "l1", won: false, resolvedAtMs: tripAt - 2000 }),
      trade({ id: "l2", won: false, resolvedAtMs: tripAt - 1000 }),
      trade({ id: "l3", won: false, resolvedAtMs: tripAt }),
    ];
    const status = evaluateRiskCircuitBreaker(trades, "sim", { maxDailyLossUsd: 25, cooldownHours: 2 }, NOW);
    expect(status.tripped).toBe(true);
    expect(status.resumeAtMs).toBe(tripAt + 2 * 3_600_000);
  });

  it("with a cooldown, auto re-arms after it elapses with a clean slate", () => {
    const tripAt = NOW - 3 * 3_600_000; // tripped 3h ago, cooldown 2h -> re-armed 1h ago
    const trades = [
      trade({ id: "l1", won: false, resolvedAtMs: tripAt - 2000 }),
      trade({ id: "l2", won: false, resolvedAtMs: tripAt - 1000 }),
      trade({ id: "l3", won: false, resolvedAtMs: tripAt }),
    ];
    const status = evaluateRiskCircuitBreaker(trades, "sim", { maxDailyLossUsd: 25, cooldownHours: 2 }, NOW);
    expect(status.tripped).toBe(false);
    // Pre-trip losses no longer count against the re-armed window.
    expect(status.dailyLossUsd).toBe(0);
  });

  it("with a cooldown, re-trips on NEW losses after the auto re-arm", () => {
    const tripAt = NOW - 3 * 3_600_000;
    const trades = [
      trade({ id: "l1", won: false, resolvedAtMs: tripAt - 2000 }),
      trade({ id: "l2", won: false, resolvedAtMs: tripAt - 1000 }),
      trade({ id: "l3", won: false, resolvedAtMs: tripAt }),
      // After the 2h cooldown re-arm, three fresh losses cross the limit again.
      trade({ id: "n1", won: false, resolvedAtMs: NOW - 3000 }),
      trade({ id: "n2", won: false, resolvedAtMs: NOW - 2000 }),
      trade({ id: "n3", won: false, resolvedAtMs: NOW - 1000 }),
    ];
    const status = evaluateRiskCircuitBreaker(trades, "sim", { maxDailyLossUsd: 25, cooldownHours: 2 }, NOW);
    expect(status.tripped).toBe(true);
    expect(status.reason).toBe("daily_loss_limit");
    expect(status.resumeAtMs).toBe(NOW - 1000 + 2 * 3_600_000);
  });

  it("re-arms when the breaker is reset: losses before the reset are ignored", () => {
    const trades = [
      trade({ id: "l1", won: false, resolvedAtMs: NOW - 3000 }),
      trade({ id: "l2", won: false, resolvedAtMs: NOW - 2000 }),
      trade({ id: "l3", won: false, resolvedAtMs: NOW - 1000 }),
    ];
    // Without a reset: 3 consecutive losses trip the breaker.
    expect(evaluateRiskCircuitBreaker(trades, "sim", { maxConsecutiveLosses: 3 }, NOW).tripped).toBe(true);
    // Reset at NOW-1500 ignores l1/l2 (and l3 is at NOW-1000 > reset, so 1 loss remains): not tripped.
    const afterReset = evaluateRiskCircuitBreaker(trades, "sim", { maxConsecutiveLosses: 3 }, NOW, NOW - 1500);
    expect(afterReset.consecutiveLosses).toBe(1);
    expect(afterReset.tripped).toBe(false);
    // Reset at NOW ignores all past losses: clean slate.
    const fullReset = evaluateRiskCircuitBreaker(trades, "sim", { maxConsecutiveLosses: 3 }, NOW, NOW);
    expect(fullReset.consecutiveLosses).toBe(0);
    expect(fullReset.tripped).toBe(false);
  });

  /**
   * Las salidas anticipadas no tienen `resolved`, y este freno filtraba por ese campo.
   *
   * O sea: las perdidas que se acaban de REALIZAR —las que mas se parecen a lo que el cortacircuitos
   * existe para atrapar— no contaban ni en la perdida diaria ni en la racha. Un bot que sangra
   * cerrando posiciones podia no disparar el freno nunca.
   */
  function conSalida(args: { id: string; exitedAtMs?: number; proceedsUsd: number }): TradeAttempt {
    return {
      ...trade({ id: args.id, resolved: false, amountUsd: 10, ask: 0.8 }),
      exit: {
        exitedAtMs: args.exitedAtMs ?? NOW,
        reason: "stop_bajo_banda",
        orderPrice: 0.7,
        // La posicion entera: 10 / 0,8 = 12,5 participaciones.
        soldShares: 12.5,
        proceedsUsd: args.proceedsUsd,
        averageExitPrice: args.proceedsUsd / 12.5,
      },
    };
  }

  it("una perdida acotada de hoy cuenta en la perdida diaria", () => {
    // $10 de stake, $7 recuperados: -$3 realizados sin que exista `resolved`.
    const trades = [conSalida({ id: "salida", proceedsUsd: 7 })];
    const status = evaluateRiskCircuitBreaker(trades, "sim", { maxDailyLossUsd: 2.5 }, NOW);

    expect(status.dailyLossUsd).toBeCloseTo(3, 6);
    expect(status.tripped).toBe(true);
    expect(status.reason).toBe("daily_loss_limit");
  });

  it("una perdida acotada extiende la racha igual que una resuelta", () => {
    const trades = [
      trade({ id: "l1", won: false, resolvedAtMs: NOW - 3_000 }),
      conSalida({ id: "salida", exitedAtMs: NOW - 2_000, proceedsUsd: 7 }),
      trade({ id: "l2", won: false, resolvedAtMs: NOW - 1_000 }),
    ];
    const status = evaluateRiskCircuitBreaker(trades, "sim", { maxConsecutiveLosses: 3 }, NOW);

    expect(status.consecutiveLosses).toBe(3);
    expect(status.tripped).toBe(true);
  });

  it("una salida GANADORA corta la racha, como cualquier otra ganancia", () => {
    const trades = [
      trade({ id: "l1", won: false, resolvedAtMs: NOW - 3_000 }),
      conSalida({ id: "salida", exitedAtMs: NOW - 2_000, proceedsUsd: 12 }),
      trade({ id: "l2", won: false, resolvedAtMs: NOW - 1_000 }),
    ];
    const status = evaluateRiskCircuitBreaker(trades, "sim", { maxConsecutiveLosses: 3 }, NOW);

    expect(status.consecutiveLosses).toBe(1);
    expect(status.tripped).toBe(false);
  });

  it("una salida PARCIAL sigue abierta y no cuenta todavia", () => {
    const parcial: TradeAttempt = {
      ...conSalida({ id: "parcial", proceedsUsd: 3 }),
      exit: {
        exitedAtMs: NOW,
        reason: "stop_bajo_banda",
        orderPrice: 0.7,
        soldShares: 5,
        proceedsUsd: 3,
        averageExitPrice: 0.6,
      },
    };
    const status = evaluateRiskCircuitBreaker([parcial], "sim", { maxDailyLossUsd: 1 }, NOW);

    expect(status.dailyLossUsd).toBe(0);
    expect(status.tripped).toBe(false);
  });

  it("una salida de AYER no cuenta en el dia de hoy", () => {
    const trades = [conSalida({ id: "vieja", exitedAtMs: YESTERDAY, proceedsUsd: 7 })];
    const status = evaluateRiskCircuitBreaker(trades, "sim", { maxDailyLossUsd: 1 }, NOW);

    expect(status.dailyLossUsd).toBe(0);
    expect(status.tripped).toBe(false);
  });
});

/**
 * El unico limite que para por ir BIEN. Se comporta distinto de los otros dos a proposito, y cada una de
 * esas diferencias esta aqui: no se enfria, no se suelta, y se mide sobre lo realizado del dia.
 */
describe("objetivo del dia", () => {
  // A 0,50 de ask, 10 $ compran 20 participaciones: una ganadora deja +10 $ netos menos comision.
  const gana = (id: string, resolvedAtMs: number) => trade({ id, won: true, resolvedAtMs });
  const pierde = (id: string, resolvedAtMs: number) => trade({ id, won: false, resolvedAtMs });

  it("no hace nada mientras el dia no llegue al objetivo", () => {
    const status = evaluateRiskCircuitBreaker(
      [gana("g1", NOW - 3 * 60_000)],
      "sim",
      { dailyProfitTargetUsd: 50 },
      NOW,
    );

    expect(status.tripped).toBe(false);
    expect(status.dailyNetUsd).toBeGreaterThan(0);
  });

  it("para el dia cuando lo ganado alcanza el objetivo", () => {
    const status = evaluateRiskCircuitBreaker(
      [gana("g1", NOW - 3 * 60_000), gana("g2", NOW - 2 * 60_000)],
      "sim",
      { dailyProfitTargetUsd: 15 },
      NOW,
    );

    expect(status.tripped).toBe(true);
    expect(status.reason).toBe("daily_profit_target");
  });

  it("NO se suelta aunque lo que seguia abierto hunda el dia despues", () => {
    // Dos ganadoras cruzan el objetivo y luego tres perdedoras lo dejan en rojo. El dia sigue cerrado:
    // reabrir seria haber perdido lo ganado y ademas volver a jugar para recuperarlo.
    const trades = [
      gana("g1", NOW - 6 * 60_000),
      gana("g2", NOW - 5 * 60_000),
      pierde("p1", NOW - 4 * 60_000),
      pierde("p2", NOW - 3 * 60_000),
      pierde("p3", NOW - 2 * 60_000),
    ];
    const status = evaluateRiskCircuitBreaker(trades, "sim", { dailyProfitTargetUsd: 15 }, NOW);

    expect(status.tripped).toBe(true);
    expect(status.reason).toBe("daily_profit_target");
    expect(status.dailyNetUsd).toBeLessThan(0);
  });

  it("el enfriamiento NO lo rearma: un objetivo cumplido dura hasta el corte del dia", () => {
    const trades = [gana("g1", NOW - 6 * 60 * 60_000), gana("g2", NOW - 6 * 60 * 60_000 + 1000)];
    // Seis horas despues, con enfriamiento de 2 h: un freno de perdida ya se habria rearmado.
    const status = evaluateRiskCircuitBreaker(trades, "sim", { dailyProfitTargetUsd: 15, cooldownHours: 2 }, NOW);

    expect(status.tripped).toBe(true);
    expect(status.reason).toBe("daily_profit_target");
    expect(status.resumeAtMs).toBeUndefined();
  });

  it("empieza de cero cada dia: lo de ayer no cierra el dia de hoy", () => {
    const trades = [gana("ayer1", YESTERDAY), gana("ayer2", YESTERDAY + 1000)];
    const status = evaluateRiskCircuitBreaker(trades, "sim", { dailyProfitTargetUsd: 15 }, NOW);

    expect(status.tripped).toBe(false);
    expect(status.dailyNetUsd).toBe(0);
  });

  it("el freno de perdida manda si llega antes", () => {
    // Primero dos perdidas que cruzan el limite, y solo despues las ganancias. Lo que decide es el orden
    // CRONOLOGICO, no cual de los dos limites se mire primero.
    const trades = [
      pierde("p1", NOW - 6 * 60_000),
      pierde("p2", NOW - 5 * 60_000),
      gana("g1", NOW - 4 * 60_000),
      gana("g2", NOW - 3 * 60_000),
      gana("g3", NOW - 2 * 60_000),
    ];
    const status = evaluateRiskCircuitBreaker(trades, "sim", { maxDailyLossUsd: 15, dailyProfitTargetUsd: 15 }, NOW);

    expect(status.reason).toBe("daily_loss_limit");
  });

  it("con el objetivo en 0 no existe, pase lo que pase", () => {
    const trades = [gana("g1", NOW - 3 * 60_000), gana("g2", NOW - 2 * 60_000), gana("g3", NOW - 60_000)];
    const status = evaluateRiskCircuitBreaker(trades, "sim", { dailyProfitTargetUsd: 0 }, NOW);

    expect(status.tripped).toBe(false);
  });
});

/**
 * El cortacircuitos del direccional, compartido por el bucle y por la UI.
 *
 * Existe porque los dos lo calculaban por separado y se desincronizaron: el bucle excluia los trades
 * de arbitraje y usaba el modo del direccional, mientras `buildSnapshot` pasaba TODOS los trades y el
 * modo GLOBAL. Con arbitraje en live y direccional en sim —el reparto que recomienda el manual— el
 * chip podia anunciar un halt que el bucle no estaba aplicando.
 */
describe("evaluateDirectionalRiskHalt", () => {
  it("no cuenta los trades de arbitraje", async () => {
    const { evaluateDirectionalRiskHalt } = await import("../src/riskCircuitBreaker.js");
    const arbPerdedor = { ...trade({ id: "a1", mode: "live", won: false, amountUsd: 50 }), kind: "arb" as const };

    const halt = evaluateDirectionalRiskHalt({
      trades: [arbPerdedor],
      directionalMode: "live",
      limits: { maxDailyLossUsd: 1 },
      nowMs: NOW,
    });

    // Un par completo redime $1/set gane quien gane: pararlo por una racha ajena seria dejar de
    // recoger dinero sin riesgo.
    expect(halt.tripped).toBe(false);
  });

  it("usa el modo del direccional, no el global", async () => {
    const { evaluateDirectionalRiskHalt } = await import("../src/riskCircuitBreaker.js");
    const perdidaEnPapel = trade({ id: "s1", mode: "sim", won: false, amountUsd: 50 });

    // Direccional en live: una racha en PAPEL no puede frenar el dinero real.
    expect(
      evaluateDirectionalRiskHalt({
        trades: [perdidaEnPapel],
        directionalMode: "live",
        limits: { maxDailyLossUsd: 1 },
        nowMs: NOW,
      }).tripped,
    ).toBe(false);

    // Y con el direccional en sim, esa misma perdida si cuenta: es la suya.
    expect(
      evaluateDirectionalRiskHalt({
        trades: [perdidaEnPapel],
        directionalMode: "sim",
        limits: { maxDailyLossUsd: 1 },
        nowMs: NOW,
      }).tripped,
    ).toBe(true);
  });

  it("si dispara con las perdidas del direccional", async () => {
    const { evaluateDirectionalRiskHalt } = await import("../src/riskCircuitBreaker.js");
    // En `sim` a proposito: un trade `live` sin posicion resoluble tiene stake 0 por diseno
    // (`getStakeUsd`, para no contar ordenes FAK sin llenado), y entonces no habria perdida que medir.
    const halt = evaluateDirectionalRiskHalt({
      trades: [trade({ id: "d1", mode: "sim", won: false, amountUsd: 50 })],
      directionalMode: "sim",
      limits: { maxDailyLossUsd: 1 },
      nowMs: NOW,
    });
    expect(halt.tripped).toBe(true);
    expect(halt.reason).toBe("daily_loss_limit");
  });

  it("lee el marcador de re-armado del modo que toca", async () => {
    const { evaluateDirectionalRiskHalt } = await import("../src/riskCircuitBreaker.js");
    // Un reset del OTRO modo no puede desarmar este freno: los marcadores van por modo.
    const halt = evaluateDirectionalRiskHalt({
      trades: [trade({ id: "d1", mode: "sim", won: false, amountUsd: 50 })],
      directionalMode: "sim",
      limits: { maxDailyLossUsd: 1 },
      nowMs: NOW,
      haltResetAtMsByMode: { live: NOW + 1 },
    });
    expect(halt.tripped).toBe(true);

    // Y el marcador de SU modo si lo desarma.
    expect(
      evaluateDirectionalRiskHalt({
        trades: [trade({ id: "d1", mode: "sim", won: false, amountUsd: 50 })],
        directionalMode: "sim",
        limits: { maxDailyLossUsd: 1 },
        nowMs: NOW,
        haltResetAtMsByMode: { sim: NOW + 1 },
      }).tripped,
    ).toBe(false);
  });
});

/**
 * La guardia de capital del direccional, fijada por un test porque su valor es una DECISION, no un
 * detalle: se bajo de 50 a 10 el 2026-09-03 para poder operar con $12, en contra de lo que dice la
 * simulacion de ruina (67,6% de probabilidad de quedarse sin poder operar en un mes con $10, y eso
 * asumiendo un edge ganador). Si alguien lo cambia, que sea a sabiendas y no por arrastre.
 */
describe("guardia de capital para el direccional", () => {
  it("el default es 10 y coincide en las tres capas que lo declaran", async () => {
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const leer = (p: string) => readFile(join(process.cwd(), p), "utf8");

    // Esquema de entorno, esquema de la UI y el fallback del cliente. Cuando divergen, el valor que
    // manda depende de por donde arranques — que es como `.env.example` acabo contradiciendo al codigo
    // en `ASK_WINDOW_BASELINE`.
    expect(await leer("src/config.ts")).toContain(
      "MIN_BANKROLL_FOR_DIRECTIONAL_USD: z.coerce.number().nonnegative().default(10)",
    );
    expect(await leer("src/ui/settings.ts")).toContain(
      "minBankrollForDirectionalUsd: z.coerce.number().nonnegative().default(10)",
    );
    expect(await leer(".env.example")).toMatch(/^MIN_BANKROLL_FOR_DIRECTIONAL_USD=10$/m);
  });

  it("la documentacion no promete un valor que el codigo ya no usa", async () => {
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const manual = await readFile(join(process.cwd(), "docs/MANUAL.md"), "utf8");
    expect(manual).not.toContain("`minBankrollForDirectionalUsd`, por defecto 50");
    // Y la tabla de ruina sigue ahi: bajar la guardia no la invalida, y borrarla seria tapar el motivo.
    expect(manual).toContain("67,6%");
  });
});

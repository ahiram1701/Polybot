import { describe, expect, it } from "vitest";

import { netoDeLasSaltadas, simular, type Regla } from "../src/frenoSimulacion.js";
import type { TradeAttempt } from "../src/types.js";

const DIA = Date.UTC(2026, 8, 17); // 2026-09-17, en UTC como el contenedor
const HORA = 3_600_000;
const MINUTO = 60_000;

/** Una entrada del favorito en papel: 5 $, se crea y se resuelve cinco minutos despues. */
function entrada(args: { id: string; creadaMs: number; gana: boolean; importeUsd?: number }): TradeAttempt {
  const amountUsd = args.importeUsd ?? 5;
  return {
    id: args.id,
    asset: "BTC",
    slug: `w-${args.id}`,
    mode: "sim",
    strategy: "favorito",
    outcome: "UP",
    amountUsd,
    estimatedShares: amountUsd / 0.8,
    bestAsk: 0.8,
    createdAtMs: args.creadaMs,
    endMs: args.creadaMs + 5 * MINUTO,
    resolved: { won: args.gana, resolvedAtMs: args.creadaMs + 5 * MINUTO },
  } as unknown as TradeAttempt;
}

/** Entradas cada diez minutos a partir de `desdeMs`, con el resultado que diga `resultados`. */
function serie(desdeMs: number, resultados: readonly boolean[], prefijo = "t"): TradeAttempt[] {
  return resultados.map((gana, i) => entrada({ id: `${prefijo}${i}`, creadaMs: desdeMs + i * 10 * MINUTO, gana }));
}

const SIN_FRENO: Regla = { nombre: "sin freno", limites: {}, topeGastoDiarioUsd: 0 };

describe("simulacion del freno de riesgo", () => {
  it("sin limites no salta nunca y el neto es el de todas las operaciones", () => {
    const candidatas = serie(DIA + 10 * HORA, [true, false, false, true, false]);
    const r = simular(candidatas, SIN_FRENO, "UTC");

    expect(r.n).toBe(5);
    expect(r.saltadas).toBe(0);
    expect(r.diasConFreno).toBe(0);
    expect(netoDeLasSaltadas(candidatas, SIN_FRENO, "UTC")).toBeCloseTo(0, 10);
  });

  it("tras la racha de perdidas, las entradas siguientes del dia no ocurren", () => {
    // Tres perdidas seguidas y luego seis entradas mas. La tercera perdida cierra a las 10:25, asi que el
    // freno ya la ve cuando se decide la cuarta entrada (10:30).
    const candidatas = serie(DIA + 10 * HORA, [false, false, false, true, true, true, true, true, true]);
    const regla: Regla = {
      nombre: "racha 3, enfriamiento de un dia",
      limites: { maxConsecutiveLosses: 3, cooldownHours: 24 },
      topeGastoDiarioUsd: 0,
    };

    const r = simular(candidatas, regla, "UTC");

    expect(r.n).toBe(3);
    expect(r.saltadas).toBe(6);
    expect(r.diasConFreno).toBe(1);
    // Las seis que tira eran ganadoras: el freno acota, no adivina.
    expect(netoDeLasSaltadas(candidatas, regla, "UTC")).toBeGreaterThan(0);
  });

  it("el enfriamiento vuelve a armar el freno y las entradas posteriores si ocurren", () => {
    // Mismas tres perdidas, pero la ultima tanda llega cinco horas despues: con enfriamiento de dos horas
    // el freno ya se re-armo; con el de un dia entero, no.
    const candidatas = [
      ...serie(DIA + 10 * HORA, [false, false, false], "a"),
      ...serie(DIA + 15 * HORA, [true, true, true], "b"),
    ];
    const corto: Regla = { nombre: "enfr. 2h", limites: { maxConsecutiveLosses: 3, cooldownHours: 2 }, topeGastoDiarioUsd: 0 };
    const largo: Regla = { nombre: "enfr. 24h", limites: { maxConsecutiveLosses: 3, cooldownHours: 24 }, topeGastoDiarioUsd: 0 };

    expect(simular(candidatas, corto, "UTC").n).toBe(6);
    expect(simular(candidatas, largo, "UTC").n).toBe(3);
  });

  it("el limite de perdida diaria cuenta dolares, no operaciones", () => {
    // Cuatro perdidas de 5 $ seguidas de una entrada mas. Con el tope en 12 $ el freno salta cuando van
    // 15 $ perdidos, o sea al decidir la cuarta; con el tope en 20 $ deja pasar la cuarta y corta en la
    // quinta, porque las cuatro perdidas suman exactamente el limite y el corte es "alcanzarlo", no
    // "pasarlo".
    const candidatas = serie(DIA + 8 * HORA, [false, false, false, false, true]);
    const apretado: Regla = { nombre: "12$", limites: { maxDailyLossUsd: 12, cooldownHours: 24 }, topeGastoDiarioUsd: 0 };
    const holgado: Regla = { nombre: "20$", limites: { maxDailyLossUsd: 20, cooldownHours: 24 }, topeGastoDiarioUsd: 0 };

    expect(simular(candidatas, apretado, "UTC").n).toBe(3);
    expect(simular(candidatas, holgado, "UTC").n).toBe(4);
  });

  it("el dia del freno es el de la zona configurada, y eso cambia el resultado", () => {
    // Tres perdidas a las 23:00-23:20 UTC y tres entradas mas a partir de las 00:10 UTC del dia siguiente.
    // En UTC son dias distintos y el contador diario se reinicia, asi que pasan las seis. En Mexico (UTC-6)
    // todo cae en la misma tarde: al decidir la cuarta ya van 15 $ perdidos y el freno corta el resto.
    //
    // Esta diferencia no es un detalle de test: la peor caida del papel, -43,45 $, ocurrio entre la 01:45 y
    // las 12:35 UTC, dentro de un mismo dia UTC pero a caballo de dos dias mexicanos.
    const candidatas = [
      ...serie(DIA + 23 * HORA, [false, false, false], "a"),
      ...serie(DIA + 24 * HORA + 10 * MINUTO, [false, false, false], "b"),
    ];
    const regla: Regla = { nombre: "perdida 12$", limites: { maxDailyLossUsd: 12 }, topeGastoDiarioUsd: 0 };

    expect(simular(candidatas, regla, "UTC").n).toBe(6);
    expect(simular(candidatas, regla, "America/Mexico_City").n).toBe(3);
  });

  it("el tope de gasto diario corta por importe acumulado y se reinicia al dia siguiente", () => {
    const candidatas = [
      ...serie(DIA + 6 * HORA, [true, true, true, true, true, true], "a"),
      ...serie(DIA + 24 * HORA + 6 * HORA, [true, true, true], "b"),
    ];
    const regla: Regla = { nombre: "tope 20$/dia", limites: {}, topeGastoDiarioUsd: 20 };

    const r = simular(candidatas, regla, "UTC");

    // Cuatro entradas de 5 $ el primer dia, tres el segundo.
    expect(r.n).toBe(7);
    expect(r.saltadas).toBe(2);
    // El tope de gasto no es el cortacircuitos: no cuenta como dia frenado.
    expect(r.diasConFreno).toBe(0);
  });

  it("con objetivo diario, el dia se para en cuanto lo GANADO llega al objetivo", () => {
    // Cuatro ganadoras de ~0,57 $ netos cada una y luego seis entradas mas. Con el objetivo en 1,50 $ el
    // dia se cierra cuando lo realizado lo alcanza, y lo que venga despues no ocurre.
    const candidatas = serie(DIA + 9 * HORA, [true, true, true, true, false, false, false, false, false, false]);
    const regla: Regla = { nombre: "objetivo 1,50$", limites: {}, topeGastoDiarioUsd: 0, objetivoDiarioUsd: 1.5 };

    const r = simular(candidatas, regla, "UTC");

    expect(r.n).toBeLessThan(candidatas.length);
    expect(r.netoUsd).toBeGreaterThan(0);
    // El dia cierra en verde: es justo lo que se le pide a esta regla.
    expect(r.dias).toHaveLength(1);
    expect(r.dias[0].netoUsd).toBeGreaterThan(0);
  });

  it("el objetivo mira lo COBRADO, no lo que esta en el aire", () => {
    // Diez ganadoras creadas de golpe, todas antes de que ninguna cierre. Al decidir, lo realizado sigue
    // siendo cero, asi que el objetivo no puede haberse alcanzado y entran todas. Contar posiciones
    // abiertas como ganancia seria cerrar el dia con dinero sin cobrar.
    const creadas = Array.from({ length: 10 }, (_, i) =>
      entrada({ id: `g${i}`, creadaMs: DIA + 9 * HORA + i * 1000, gana: true }),
    );
    const regla: Regla = { nombre: "objetivo 1$", limites: {}, topeGastoDiarioUsd: 0, objetivoDiarioUsd: 1 };

    expect(simular(creadas, regla, "UTC").n).toBe(10);
  });

  it("un dia parado en verde puede acabar en rojo: lo ya abierto sigue su curso", () => {
    // Dos ganadoras cierran y disparan el objetivo, pero para entonces ya hay tres perdedoras en vuelo
    // creadas antes. El dia acaba en rojo aunque se haya "parado ganando". No se idealiza.
    // Una ganadora a 0,80 deja +1,18 $ netos, asi que el objetivo de 2 $ necesita DOS.
    const candidatas = [
      entrada({ id: "g0", creadaMs: DIA + 9 * HORA, gana: true }),
      entrada({ id: "g1", creadaMs: DIA + 9 * HORA + MINUTO, gana: true }),
      // Entran a las 09:02-09:04, cuando todavia no ha cerrado nada: el objetivo no puede estar hecho.
      ...[0, 1, 2].map((i) => entrada({ id: `p${i}`, creadaMs: DIA + 9 * HORA + (2 + i) * MINUTO, gana: false })),
      // A las 09:06:30 las dos ganadoras ya cerraron (+2,36 $) y las tres perdedoras siguen en vuelo: el
      // dia se cierra aqui, en verde, y lo que resuelva despues ya no se puede evitar.
      entrada({ id: "tarde0", creadaMs: DIA + 9 * HORA + 6 * MINUTO + 30_000, gana: true }),
      ...serie(DIA + 10 * HORA, [true, true], "tarde"),
    ];
    const regla: Regla = { nombre: "objetivo 2$", limites: {}, topeGastoDiarioUsd: 0, objetivoDiarioUsd: 2 };

    const r = simular(candidatas, regla, "UTC");

    expect(r.dias[0].picoUsd).toBeGreaterThan(0);
    expect(r.dias[0].netoUsd).toBeLessThan(0);
    // Las tres de la tarde no llegan a ocurrir: el dia ya estaba cerrado por objetivo.
    expect(r.n).toBe(5);
  });

  it("el objetivo se reinicia cada dia", () => {
    const candidatas = [
      ...serie(DIA + 9 * HORA, [true, true, true, true], "a"),
      ...serie(DIA + 24 * HORA + 9 * HORA, [true, true, true, true], "b"),
    ];
    const regla: Regla = { nombre: "objetivo 1$", limites: {}, topeGastoDiarioUsd: 0, objetivoDiarioUsd: 1 };

    const r = simular(candidatas, regla, "UTC");

    expect(r.dias).toHaveLength(2);
    for (const dia of r.dias) expect(dia.netoUsd).toBeGreaterThan(0);
  });

  it("no mira el futuro: no frena por perdidas que aun no han cerrado", () => {
    // Tres perdidas que se crean seguidas pero cierran DESPUES de la cuarta entrada. Cuando el bucle decide
    // la cuarta, ninguna ha resuelto todavia, asi que el freno no puede saber nada y la cuarta ocurre.
    const creadas = [0, 1, 2, 3].map((i) =>
      entrada({ id: `p${i}`, creadaMs: DIA + 9 * HORA + i * MINUTO, gana: false }),
    );
    const regla: Regla = { nombre: "racha 3", limites: { maxConsecutiveLosses: 3, cooldownHours: 24 }, topeGastoDiarioUsd: 0 };

    expect(simular(creadas, regla, "UTC").n).toBe(4);
  });
});

import { describe, expect, it } from "vitest";

import { emptyPhases, LOOP_PHASES, PhaseTimer, totalPhaseMs, unaccountedMs } from "../src/loopPhases.js";

/**
 * El bucle solo cronometraba `capture` y `decide`. Sobre 400 iteraciones lentas reales esas dos
 * sumaban 2.011 ms de una mediana de 5.992 ms: el 94% del tiempo lento no lo explicaba ninguna fase,
 * porque la peticion a gamma y la verificacion de resoluciones caian fuera de los dos cronometros.
 *
 * Lo que impide que vuelva a pasar no es tener mas fases, es `unaccountedMs`: anadir trabajo sin
 * cronometrarlo ya no lo esconde, lo empuja a un contador que se publica.
 */
describe("PhaseTimer", () => {
  /** Reloj falso: los tests de tiempo con el reloj real son lentos y ademas inestables. */
  function relojFalso() {
    let ahora = 0;
    return { now: () => ahora, avanzar: (ms: number) => (ahora += ms) };
  }

  it("mide cada fase por separado", async () => {
    const reloj = relojFalso();
    const timer = new PhaseTimer(reloj.now);
    await timer.time("fetch", async () => reloj.avanzar(400));
    await timer.time("capture", async () => reloj.avanzar(120));
    const fases = timer.phases();
    expect(fases.fetch).toBe(400);
    expect(fases.capture).toBe(120);
    expect(fases.decide).toBe(0);
  });

  it("acumula cuando una fase corre dos veces", async () => {
    // `verify` corre en dos sitios distintos segun si hubo mercados; las dos veces cuentan.
    const reloj = relojFalso();
    const timer = new PhaseTimer(reloj.now);
    await timer.time("verify", async () => reloj.avanzar(30));
    await timer.time("verify", async () => reloj.avanzar(70));
    expect(timer.phases().verify).toBe(100);
  });

  it("mide tambien la fase que lanza: un timeout de 5s es justo el que hay que ver", async () => {
    const reloj = relojFalso();
    const timer = new PhaseTimer(reloj.now);
    await expect(
      timer.time("fetch", async () => {
        reloj.avanzar(5_000);
        throw new Error("The operation was aborted due to timeout");
      }),
    ).rejects.toThrow("timeout");
    expect(timer.phases().fetch).toBe(5_000);
  });

  it("el tiempo sin atribuir delata el trabajo no cronometrado", async () => {
    const reloj = relojFalso();
    const timer = new PhaseTimer(reloj.now);
    await timer.time("capture", async () => reloj.avanzar(2_000));
    reloj.avanzar(4_000); // trabajo fuera de toda fase: exactamente el fallo que motivo esto
    const fases = timer.phases();
    expect(totalPhaseMs(fases)).toBe(2_000);
    expect(unaccountedMs(reloj.now(), fases)).toBe(4_000);
  });

  it("sin trabajo suelto, las fases explican el total", async () => {
    const reloj = relojFalso();
    const timer = new PhaseTimer(reloj.now);
    for (const fase of LOOP_PHASES) {
      await timer.time(fase, async () => reloj.avanzar(10));
    }
    expect(unaccountedMs(reloj.now(), timer.phases())).toBe(0);
  });

  it("nunca devuelve un tiempo sin atribuir negativo", () => {
    // El total se mide en un `finally` exterior, asi que un redondeo puede dejarlo bajo la suma.
    const fases = { ...emptyPhases(), capture: 100 };
    expect(unaccountedMs(99, fases)).toBe(0);
  });
});

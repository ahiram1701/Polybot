import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { iniciarLatido, INTERVALO_LATIDO_MS } from "../src/latido.js";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("latido", () => {
  it("sin ruta configurada no escribe nada: el latido es opcional", async () => {
    const escribir = vi.fn().mockResolvedValue(undefined);

    const parar = iniciarLatido({ path: undefined, escribir });
    await vi.advanceTimersByTimeAsync(5 * INTERVALO_LATIDO_MS);

    expect(escribir).not.toHaveBeenCalled();
    parar();
  });

  it("una ruta en blanco tampoco lo enciende", async () => {
    const escribir = vi.fn().mockResolvedValue(undefined);

    const parar = iniciarLatido({ path: "   ", escribir });
    await vi.advanceTimersByTimeAsync(2 * INTERVALO_LATIDO_MS);

    expect(escribir).not.toHaveBeenCalled();
    parar();
  });

  it("late inmediatamente y luego cada intervalo", async () => {
    const escribir = vi.fn().mockResolvedValue(undefined);

    // El primer latido NO espera al intervalo: tras un arranque, el vigilante tiene que ver vida ya.
    const parar = iniciarLatido({ path: "/latido/latido.txt", escribir, intervaloMs: 1000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(escribir).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(3000);
    expect(escribir).toHaveBeenCalledTimes(4);
    parar();
  });

  it("escribe la hora en ISO, que es lo que el lector compara", async () => {
    const escribir = vi.fn().mockResolvedValue(undefined);
    const ahora = () => new Date("2026-09-24T23:45:00.000Z");

    const parar = iniciarLatido({ path: "/latido/latido.txt", escribir, ahora, intervaloMs: 1000 });
    await vi.advanceTimersByTimeAsync(0);

    expect(escribir).toHaveBeenCalledWith("/latido/latido.txt", "2026-09-24T23:45:00.000Z\n");
    parar();
  });

  it("un fallo al escribir NO tumba el proceso y no repite el aviso", async () => {
    // Un diagnostico que mata a su paciente no vale nada: si el disco falla, el bot sigue operando.
    const escribir = vi.fn().mockRejectedValue(new Error("disco lleno"));

    const parar = iniciarLatido({ path: "/latido/latido.txt", escribir, intervaloMs: 1000 });
    await vi.advanceTimersByTimeAsync(5000);

    expect(escribir).toHaveBeenCalledTimes(6);
    parar();
  });

  it("parar corta los latidos", async () => {
    const escribir = vi.fn().mockResolvedValue(undefined);

    const parar = iniciarLatido({ path: "/latido/latido.txt", escribir, intervaloMs: 1000 });
    await vi.advanceTimersByTimeAsync(2000);
    const antes = escribir.mock.calls.length;

    parar();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(escribir).toHaveBeenCalledTimes(antes);
  });
});

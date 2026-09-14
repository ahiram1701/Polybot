import { describe, expect, it } from "vitest";

import { perpsLiveBlockedReason, PERPS_RESTRICTED_JURISDICTIONS, PerpsSessionProvider } from "../src/perpsSession.js";
import type { BotConfig } from "../src/types.js";

function config(overrides: Partial<BotConfig> = {}): BotConfig {
  return {
    perpsAllowLive: false,
    privateKey: "0x1111111111111111111111111111111111111111111111111111111111111111",
    funderAddress: "0x2222222222222222222222222222222222222222",
    ...overrides,
  } as BotConfig;
}

describe("cierre live de perps", () => {
  it("cerrado de fabrica", () => {
    expect(perpsLiveBlockedReason(config())).toBe("perps_live_cerrado");
  });

  it("abrir el cierre NO basta: hace falta declarar la jurisdiccion", () => {
    // Polymarket bloquea perpetuos en EE. UU. y Canada entre otros, y su documentacion pide bloquear
    // el ENVIO de ordenes, no ensenar un aviso.
    expect(perpsLiveBlockedReason(config({ perpsAllowLive: true }))).toBe("perps_jurisdiccion_sin_declarar");
    expect(PERPS_RESTRICTED_JURISDICTIONS).toContain("United States");
    expect(PERPS_RESTRICTED_JURISDICTIONS).toContain("Canada");
  });

  it("y tampoco basta sin credenciales", () => {
    expect(
      perpsLiveBlockedReason(config({ perpsAllowLive: true, perpsJurisdictionOk: true, privateKey: undefined })),
    ).toBe("perps_sin_credenciales");
  });

  it("con los tres cierres abiertos, deja pasar", () => {
    expect(perpsLiveBlockedReason(config({ perpsAllowLive: true, perpsJurisdictionOk: true }))).toBeUndefined();
  });

  it("devuelve el MOTIVO y no un booleano", () => {
    // "No esta configurado", "el operador no lo ha abierto" y "esta jurisdiccion no puede" llevan a
    // acciones distintas del operador, y un `false` unico las hace indistinguibles.
    const motivos = new Set([
      perpsLiveBlockedReason(config()),
      perpsLiveBlockedReason(config({ perpsAllowLive: true })),
      perpsLiveBlockedReason(config({ perpsAllowLive: true, perpsJurisdictionOk: true, funderAddress: undefined })),
    ]);
    expect(motivos.size).toBe(3);
  });
});

describe("PerpsSessionProvider", () => {
  it("con el cierre cerrado NO existe camino a openPerpsSession", async () => {
    // Esta es la propiedad que sostiene toda la entrega: se verifica por test, no leyendo el codigo.
    const provider = new PerpsSessionProvider(config());
    await expect(provider.getSession()).rejects.toThrow(/perps_live_cerrado/);
  });

  it("sin declarar jurisdiccion tampoco", async () => {
    const provider = new PerpsSessionProvider(config({ perpsAllowLive: true }));
    await expect(provider.getSession()).rejects.toThrow(/perps_jurisdiccion_sin_declarar/);
  });
});

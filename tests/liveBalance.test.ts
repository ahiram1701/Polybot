import { describe, expect, it, vi } from "vitest";

import {
  OnChainBankrollSource,
  POLYMARKET_COLLATERAL_ADDRESS,
  resolveEffectiveBankrollUsd,
} from "../src/liveBalance.js";

const client = (impl: () => Promise<unknown>) => ({ readContract: vi.fn(impl) }) as never;

describe("resolveEffectiveBankrollUsd", () => {
  it("prefiere el saldo leido on-chain sobre el declarado a mano", () => {
    expect(resolveEffectiveBankrollUsd({ usd: 137.5, atMs: 1 }, 10)).toEqual({ usd: 137.5, source: "onchain" });
  });

  it("un CERO leido es autoritativo: no se tapa con el valor declarado", () => {
    // Es la mitad del sentido de esta guardia. Si la wallet esta vacia hay que bloquear, y dejar que
    // un numero declarado obsoleto diga lo contrario seria justo el fallo que se viene a corregir.
    expect(resolveEffectiveBankrollUsd({ usd: 0, atMs: 1 }, 500)).toEqual({ usd: 0, source: "onchain" });
  });

  it("si no se pudo leer, cae al declarado", () => {
    expect(resolveEffectiveBankrollUsd(undefined, 20)).toEqual({ usd: 20, source: "declared" });
  });

  it("sin lectura ni valor declarado el resultado es 'unknown', no cero", () => {
    // Quien llama debe poder distinguir "no hay fondos" de "no lo se", para no bloquear por un RPC
    // caido: eso seria un fallo de red disfrazado de politica de riesgo.
    expect(resolveEffectiveBankrollUsd(undefined, 0).source).toBe("unknown");
    expect(resolveEffectiveBankrollUsd(undefined, undefined).source).toBe("unknown");
  });
});

describe("OnChainBankrollSource", () => {
  const funder = "0x1111111111111111111111111111111111111111" as const;

  it("convierte los 6 decimales de USDC a dolares", async () => {
    const source = new OnChainBankrollSource(funder, "http://rpc.test", 60_000, client(async () => 12_345_678n));
    expect((await source.read(1_000))?.usd).toBeCloseTo(12.345678, 6);
  });

  it("cachea: el bucle corre cada segundo y esto es una llamada de red", async () => {
    const read = vi.fn(async () => 5_000_000n);
    const source = new OnChainBankrollSource(funder, "http://rpc.test", 60_000, { readContract: read } as never);
    await source.read(1_000);
    await source.read(2_000);
    await source.read(30_000);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("relee cuando el TTL expira", async () => {
    const read = vi.fn(async () => 5_000_000n);
    const source = new OnChainBankrollSource(funder, "http://rpc.test", 10_000, { readContract: read } as never);
    await source.read(1_000);
    await source.read(20_000);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("un fallo de RPC NO se convierte en un saldo de cero", async () => {
    const source = new OnChainBankrollSource(
      funder,
      "http://rpc.test",
      60_000,
      client(async () => {
        throw new Error("HTTP 401");
      }),
    );
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(await source.read(1_000)).toBeUndefined();
  });

  it("ante un fallo conserva la ultima lectura buena en vez de olvidarla", async () => {
    let ok = true;
    const source = new OnChainBankrollSource(funder, "http://rpc.test", 1, client(async () => {
      if (!ok) {
        throw new Error("RPC caido");
      }
      return 7_000_000n;
    }));
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect((await source.read(1_000))?.usd).toBe(7);
    ok = false;
    // Una lectura buena de hace un momento es mejor que quedarse sin dato.
    expect((await source.read(50_000))?.usd).toBe(7);
  });
});

describe("colateral de Polymarket", () => {
  it("apunta a pUSD (CLOB V2), no al USDC.e antiguo", () => {
    // Leer USDC.e devuelve 0 para una cuenta CON fondos — un cero creible que hace concluir que la
    // wallet esta vacia. Se comprobo contra la cadena: el saldo real vivia en pUSD.
    expect(POLYMARKET_COLLATERAL_ADDRESS).toBe("0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB");
    expect(POLYMARKET_COLLATERAL_ADDRESS).not.toBe("0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174");
  });
});

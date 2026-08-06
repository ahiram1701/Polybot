import { describe, expect, it } from "vitest";
import { getGlobalDispatcher } from "undici";

import { installHttpKeepAlive } from "../src/httpAgent.js";

/**
 * Medido contra gamma: sin keep-alive, 8 peticiones espaciadas 5s producian 8 resoluciones DNS (una
 * por peticion, porque el `keepAliveTimeout` por defecto de undici es de 4s y la cache de mercados
 * tiene TTL de 5s — justo por encima). Con keep-alive bajaron a 3.
 *
 * Importa porque el DNS de la maquina va por Tailscale y bajo ese ritmo sostenido devolvia
 * `getaddrinfo ENOTFOUND` contra dominios que resuelven bien al probarlos sueltos.
 */
describe("installHttpKeepAlive", () => {
  it("instala un dispatcher global", () => {
    const antes = getGlobalDispatcher();
    installHttpKeepAlive();
    expect(getGlobalDispatcher()).not.toBe(antes);
  });

  it("mantiene la conexion viva mas que el hueco mas largo del bucle", () => {
    installHttpKeepAlive();
    const dispatcher = getGlobalDispatcher() as unknown as Record<symbol, { keepAliveTimeout?: number }>;
    const opciones = Object.getOwnPropertySymbols(dispatcher)
      .map((s) => dispatcher[s])
      .find((v) => v && typeof v === "object" && "keepAliveTimeout" in v);
    // El hueco mas largo es el TTL de la cache de mercados (5s). Por debajo de eso, cada peticion
    // reabre conexion y vuelve a resolver DNS — que es exactamente el problema que esto corrige.
    expect(opciones?.keepAliveTimeout ?? 0).toBeGreaterThan(5_000);
  });
});

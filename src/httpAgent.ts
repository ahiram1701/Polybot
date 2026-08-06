import { Agent, setGlobalDispatcher } from "undici";

/**
 * Conexiones HTTP persistentes para todo el proceso.
 *
 * El `keepAliveTimeout` por defecto de undici (el cliente que usa `fetch` por dentro) es de **4
 * segundos**, y varias cadencias del bot caen justo por encima: la cache de mercados de gamma tiene
 * TTL de 5s, asi que cada peticion encontraba la conexion ya cerrada y abria una nueva — con su
 * resolucion DNS y su handshake TCP incluidos, indefinidamente.
 *
 * Eso importa aqui mas de lo normal porque el DNS de esta maquina va por Tailscale (MagicDNS), y bajo
 * ese ritmo sostenido aparecian `getaddrinfo ENOTFOUND` a razon de ~4,5/min contra dominios que
 * resuelven perfectamente al probarlos sueltos (108/108, incluso bajo carga de disco). Con la conexion
 * viva no hay resolucion que fallar: el mejor arreglo para una consulta problematica es no hacerla.
 *
 * `keepAliveTimeout` solo se aplica cuando el servidor NO manda su propia cabecera `Keep-Alive`; si la
 * manda, mandan sus tiempos y `keepAliveMaxTimeout` actua de tope. Por eso subirlo es seguro: no fuerza
 * al servidor a nada, solo evita que cerremos nosotros antes de tiempo.
 */
export function installHttpKeepAlive(): void {
  setGlobalDispatcher(
    new Agent({
      // Cubre con holgura el hueco mas largo entre peticiones del bucle (la cache de gamma, 5s).
      keepAliveTimeout: 30_000,
      keepAliveMaxTimeout: 120_000,
      // Suficiente para las 6 cotizaciones en paralelo por iteracion mas los margenes; sin limite, una
      // rafaga podria abrir decenas de sockets contra el mismo origen y volver al problema de churn.
      connections: 8,
      connect: { timeout: 10_000 },
    }),
  );
}

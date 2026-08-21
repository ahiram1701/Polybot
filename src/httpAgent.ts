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
      // Sockets por origen. El numero NO es libre: si se queda corto, las peticiones hacen cola dentro
      // del cliente y agotan su propio timeout sin que el servidor haya tardado nada.
      //
      // Estuvo en 8, dimensionado para "las 6 cotizaciones en paralelo por iteracion". Luego el maker
      // paso a leer sus mercados en paralelo —hasta 3 mercados x 2 libros— y el pool quedo
      // sobresuscrito: **1.049 timeouts de 2 s en una hora**, con el endpoint respondiendo en 280 ms
      // al medirlo suelto. El bot parecia sano y el maker estaba medio ciego.
      //
      // Cuentas de la peor iteracion: 6 del maker + 6 del direccional/arbitraje + gamma + la
      // resolucion de mercados del escaner. 24 cubria eso con holgura.
      //
      // Desde el 2026-08-21 el maker ordena 25 candidatos en vez de 3 —el orden del registro no predice
      // el rendimiento, asi que mirar a pocos es sortear— y sondea por turnos hasta 6 mercados por
      // pasada: 6 x (1 consulta de ordenes + 2 libros) = **18 en vuelo**, mas los 6 del direccional se
      // comen los 24 justos. Quedarse corto no da un error claro: da timeouts de 2 s con el endpoint
      // respondiendo en 280 ms, que es como el maker estuvo medio ciego una hora entera. El coste de
      // sobrar son sockets ociosos; el de faltar es no verlo.
      connections: 48,
      connect: { timeout: 10_000 },
    }),
  );
}

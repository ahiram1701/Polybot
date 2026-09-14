import { describe, expect, it, vi } from "vitest";

import { PerpsFeed } from "../src/perpsFeed.js";

/**
 * El feed abre un WebSocket de verdad en `connect()`, asi que estos tests NO lo arrancan: se ejercita
 * el estado que se puede observar sin red. Lo que se quiere fijar aqui es la disciplina de trafico,
 * que es lo que decide si una corrida de dias sobrevive.
 */

/** Un doble del socket con lo justo para contar tramas. */
function feedConSocketFalso(): { feed: PerpsFeed; enviadas: string[] } {
  const enviadas: string[] = [];
  const feed = new PerpsFeed("wss://ejemplo.invalid/ws");
  const socketFalso = {
    readyState: 1,
    send: (frame: string) => enviadas.push(frame),
    ping: vi.fn(),
    removeAllListeners: vi.fn(),
    on: vi.fn(),
    terminate: vi.fn(),
  };
  // Se inyecta el estado interno a proposito: la alternativa seria levantar un servidor WebSocket de
  // verdad para comprobar una decision que es puramente de logica.
  const interno = feed as unknown as { socket: unknown; stopped: boolean };
  interno.socket = socketFalso;
  interno.stopped = false;
  return { feed, enviadas };
}

describe("PerpsFeed: disciplina de suscripcion", () => {
  it("NO re-suscribe cuando la lista no cambia", () => {
    const { feed, enviadas } = feedConSocketFalso();
    feed.start([6, 7]);
    expect(enviadas).toHaveLength(1);

    // `PerpsLoop` llama a `start` en CADA pasada, o sea cada 5 segundos. Sin la comparacion serian
    // 17.280 tramas de suscripcion al dia que no aportan nada, y es justo el ruido sostenido por el
    // que un exchange limita o cierra la conexion.
    feed.start([6, 7]);
    feed.start([7, 6]);
    expect(enviadas).toHaveLength(1);
  });

  it("SI re-suscribe cuando la lista cambia de verdad", () => {
    const { feed, enviadas } = feedConSocketFalso();
    feed.start([6]);
    feed.start([6, 7]);
    expect(enviadas).toHaveLength(2);
    expect(enviadas[1]).toContain("tickers::7");
    expect(enviadas[1]).toContain("bbo::7");
  });

  it("pide los dos canales por instrumento, y NO el de libro", () => {
    const { feed, enviadas } = feedConSocketFalso();
    feed.start([6]);
    const trama = JSON.parse(enviadas[0]) as { req: string; chs: string[] };
    expect(trama.req).toBe("sub");
    expect(trama.chs).toEqual(["tickers::6", "bbo::6"]);
    // `book::` manda DELTAS: aplicarlos mal no da un error, da un libro plausible y equivocado. La
    // profundidad se lee por REST, donde una foto de hace cinco segundos vale.
    expect(trama.chs.some((canal) => canal.startsWith("book"))).toBe(false);
  });

  it("sin datos todavia, la salud no miente", () => {
    const feed = new PerpsFeed("wss://ejemplo.invalid/ws");
    // `undefined` = nunca llego nada, que NO es lo mismo que "llego hace 0 ms".
    expect(feed.msSinceLastData()).toBeUndefined();
    expect(feed.ticker(6)).toBeUndefined();
    expect(feed.bbo(6)).toBeUndefined();
  });

  it("arrancar sin instrumentos no abre nada", () => {
    const feed = new PerpsFeed("wss://ejemplo.invalid/ws");
    feed.start([]);
    // Si hubiera conectado, `msSinceLastData` ya no seria undefined (se marca al conectar).
    expect(feed.msSinceLastData()).toBeUndefined();
    feed.stop();
  });
});

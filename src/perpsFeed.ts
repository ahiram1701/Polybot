import WebSocket from "ws";

import { logger } from "./logger.js";

/**
 * Feed en tiempo real de perps por WebSocket.
 *
 * Escucha DOS canales por instrumento y a proposito no escucha el tercero:
 *
 * - `tickers::<id>` — marca, indice y funding. Es la serie que decide el valor de una posicion y la
 *   que mas cambia, asi que es la que gana mas por streamearse.
 * - `bbo::<id>` — mejor bid y mejor ask. Un unico nivel por lado, sin estado que mantener.
 * - `book::<id>` NO. Ese canal manda DELTAS, y aplicar deltas exige llevar el libro entero en memoria
 *   y reconciliarlo por numero de secuencia. Un desfase ahi no da un error: da un libro plausible y
 *   equivocado, que es la peor clase de fallo que tiene este proyecto documentada. La profundidad se
 *   lee por REST a la cadencia del camino de perps, donde una foto de hace cinco segundos vale.
 *
 * El patron de resiliencia es el de `chainlinkPriceFeed.ts`, copiado a conciencia: supervisor
 * INDEPENDIENTE del socket, ping, y backoff topado. El supervisor no mira si el socket esta abierto
 * —mira si siguen llegando datos—, porque un socket abierto que no entrega nada, uno cerrado que
 * nadie reabrio y una cadena de reconexion rota por una excepcion se ven igual desde fuera y se curan
 * igual. Esa leccion costo siete horas de precio congelado con la salud en verde.
 */

export interface PerpsTickerSnapshot {
  instrumentId: number;
  markPrice?: number;
  indexPrice?: number;
  midPrice?: number;
  lastPrice?: number;
  fundingRate?: number;
  nextFundingMs?: number;
  openInterest?: number;
  receivedAtMs: number;
}

export interface PerpsBboSnapshot {
  instrumentId: number;
  bestBid?: number;
  bestAsk?: number;
  bidSize?: number;
  askSize?: number;
  receivedAtMs: number;
}

export class PerpsFeed {
  private socket?: WebSocket;
  private pingTimer?: NodeJS.Timeout;
  private supervisorTimer?: NodeJS.Timeout;
  private reconnectTimer?: NodeJS.Timeout;
  private stopped = true;
  private reconnectAttempts = 0;
  private lastDataAtMs = 0;
  private nextRequestId = 1;
  private instrumentIds: number[] = [];
  private readonly tickers = new Map<number, PerpsTickerSnapshot>();
  private readonly bbos = new Map<number, PerpsBboSnapshot>();

  constructor(
    private readonly url: string,
    private readonly reconnectDelayMs = 3_000,
    private readonly maxReconnectDelayMs = 10_000,
    private readonly noDataTimeoutMs = 30_000,
  ) {}

  start(instrumentIds: readonly number[]): void {
    this.instrumentIds = [...new Set(instrumentIds)];
    if (!this.stopped) {
      // Ya corriendo: solo cambio la lista. Re-suscribir sobre el socket vivo evita tirar una conexion
      // sana cada vez que el catalogo se relee.
      this.subscribe();
      return;
    }
    if (this.instrumentIds.length === 0) {
      return;
    }
    this.stopped = false;
    this.reconnectAttempts = 0;
    this.startSupervisor();
    try {
      this.connect();
    } catch (error) {
      // El PRIMER intento tambien puede lanzar (DNS caido al arrancar). Dejarlo propagar abortaria el
      // arranque del bot entero por un fallo de red transitorio.
      logger.warn("Fallo al conectar el feed de perps al arrancar; se reintenta.", {
        error: error instanceof Error ? error.message : String(error),
      });
      this.scheduleReconnect();
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.supervisorTimer) {
      clearInterval(this.supervisorTimer);
      this.supervisorTimer = undefined;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.clearPing();
    this.cleanupSocket();
  }

  ticker(instrumentId: number): PerpsTickerSnapshot | undefined {
    return this.tickers.get(instrumentId);
  }

  bbo(instrumentId: number): PerpsBboSnapshot | undefined {
    return this.bbos.get(instrumentId);
  }

  /**
   * Milisegundos desde el ultimo dato valido, o `undefined` si nunca llego ninguno.
   *
   * La unica medida honesta de "ve el bot este mercado". El proceso puede responder peticiones y la
   * pantalla ensenar precios con pinta normal mientras el feed lleva horas congelado.
   */
  msSinceLastData(nowMs = Date.now()): number | undefined {
    return this.lastDataAtMs > 0 ? nowMs - this.lastDataAtMs : undefined;
  }

  private connect(): void {
    this.cleanupSocket();
    const socket = new WebSocket(this.url);
    this.socket = socket;
    // Margen para el primer dato antes de que el supervisor lo de por muerto.
    this.lastDataAtMs = Date.now();

    socket.on("open", () => {
      if (this.socket !== socket) {
        socket.close();
        return;
      }
      logger.info("Conectado al WebSocket de Polymarket Perps.");
      this.lastDataAtMs = Date.now();
      this.reconnectAttempts = 0;
      this.subscribe();
      this.startPing();
    });

    socket.on("message", (data) => {
      if (this.socket !== socket) {
        return;
      }
      this.handleRawMessage(data.toString());
    });

    socket.on("error", (error) => {
      if (this.stopped) {
        return;
      }
      logger.warn("Error en el WebSocket de perps.", { error: error.message });
    });

    socket.on("close", () => {
      if (this.socket !== socket) {
        return;
      }
      this.clearPing();
      if (!this.stopped) {
        this.scheduleReconnect();
      }
    });
  }

  private subscribe(): void {
    const socket = this.socket;
    if (socket?.readyState !== WebSocket.OPEN || this.instrumentIds.length === 0) {
      return;
    }
    const chs = this.instrumentIds.flatMap((id) => [`tickers::${id}`, `bbo::${id}`]);
    socket.send(JSON.stringify({ id: this.nextRequestId++, req: "sub", chs }));
  }

  private handleRawMessage(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (!isRecord(parsed)) {
      return;
    }
    const canal = typeof parsed.ch === "string" ? parsed.ch : undefined;
    const data = parsed.data;
    if (!canal || !isRecord(data)) {
      return;
    }
    const instrumentId = toNumber(data.iid);
    if (instrumentId === undefined) {
      return;
    }
    const receivedAtMs = Date.now();

    if (canal.startsWith("tickers")) {
      this.tickers.set(instrumentId, {
        instrumentId,
        markPrice: toNumber(data.mark),
        indexPrice: toNumber(data.idx),
        midPrice: toNumber(data.mid),
        lastPrice: toNumber(data.last),
        fundingRate: toNumber(data.fr),
        nextFundingMs: toNumber(data.nxf),
        openInterest: toNumber(data.oi),
        receivedAtMs,
      });
      // El reloj de salud solo avanza con datos que se han sabido LEER. Una riada de tramas que no se
      // parsean no puede hacerse pasar por un feed sano: es la misma correccion que ya lleva el ping
      // del feed de Chainlink.
      this.lastDataAtMs = receivedAtMs;
      return;
    }

    if (canal.startsWith("bbo")) {
      this.bbos.set(instrumentId, {
        instrumentId,
        bestBid: toNumber(data.bp),
        bestAsk: toNumber(data.ap),
        bidSize: toNumber(data.bq),
        askSize: toNumber(data.aq),
        receivedAtMs,
      });
      this.lastDataAtMs = receivedAtMs;
    }
  }

  /** Vigila que SIGAN LLEGANDO DATOS, sin mirar el estado del socket. Ver la cabecera del modulo. */
  private startSupervisor(): void {
    if (this.supervisorTimer) {
      return;
    }
    this.supervisorTimer = setInterval(() => {
      if (this.stopped) {
        return;
      }
      const inactivoMs = this.lastDataAtMs > 0 ? Date.now() - this.lastDataAtMs : Number.POSITIVE_INFINITY;
      if (inactivoMs <= this.noDataTimeoutMs || this.reconnectTimer) {
        return;
      }
      logger.warn("Feed de perps sin datos; el supervisor fuerza reconexion.", {
        inactivoMs: Number.isFinite(inactivoMs) ? inactivoMs : undefined,
        socketAbierto: this.socket?.readyState === WebSocket.OPEN,
      });
      this.cleanupSocket();
      this.scheduleReconnect();
    }, 5_000);
    this.supervisorTimer.unref?.();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) {
      return;
    }
    this.reconnectAttempts += 1;
    const delay = Math.min(this.reconnectDelayMs * 2 ** (this.reconnectAttempts - 1), this.maxReconnectDelayMs);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      try {
        this.connect();
      } catch (error) {
        // `new WebSocket(url)` puede lanzar de forma SINCRONA (DNS caido). Sin este catch la excepcion
        // se escapa del timer y, como `reconnectTimer` ya esta limpio, no queda nada que reintente: el
        // feed muere en silencio para siempre. Paso de verdad en el feed del binario.
        logger.warn("Fallo al reconectar el feed de perps; se reintenta.", {
          error: error instanceof Error ? error.message : String(error),
        });
        this.scheduleReconnect();
      }
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private cleanupSocket(): void {
    if (!this.socket) {
      return;
    }
    const socket = this.socket;
    this.socket = undefined;
    socket.removeAllListeners();
    // Un socket que aun CONECTABA emite 'error' al terminarlo, y lo emite despues, en otro tick: un
    // try/catch de aqui no lo ve. Sin oyente, ese 'error' sin dueno se lleva el proceso por delante.
    socket.on("error", () => undefined);
    try {
      socket.terminate();
    } catch {
      // ignore teardown errors
    }
  }

  private startPing(): void {
    this.clearPing();
    this.pingTimer = setInterval(() => {
      const socket = this.socket;
      if (socket?.readyState !== WebSocket.OPEN) {
        return;
      }
      socket.ping();
    }, 15_000);
    this.pingTimer.unref?.();
  }

  private clearPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = undefined;
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

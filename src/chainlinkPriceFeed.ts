import WebSocket from "ws";

import { logger } from "./logger.js";
import { getMarketDefinition, marketSymbolFromPriceFeedSymbol, SUPPORTED_MARKETS } from "./markets.js";
import type { MarketSymbol, PriceTick } from "./types.js";

type TickHandler = (tick: PriceTick) => void;

/**
 * Topic RTDS de la serie TWAP de 30 segundos, que es la que resuelve los mercados de 5 minutos.
 *
 * Los de 15m usan `twapLookbackSeconds: 60` y su topic seria `crypto_prices_twap_sixty`. Hoy Polybot
 * solo opera 5m; cuando eso cambie, el lookback correcto sale de `cryptoMarketConfig` del propio
 * mercado y no de una constante.
 */
export const TWAP_TOPIC = "crypto_prices_twap_thirty";

export class ChainlinkPriceFeed {
  private socket?: WebSocket;
  private pingTimer?: NodeJS.Timeout;
  private snapshotRefreshTimer?: NodeJS.Timeout;
  private reconnectTimer?: NodeJS.Timeout;
  /**
   * Vigilante que vive mientras el feed este arrancado, INDEPENDIENTE del socket.
   *
   * El anterior colgaba del socket: se limpiaba al cerrarse y solo actuaba con `readyState === OPEN`.
   * O sea que vigilaba un socket sano y no podia resucitar uno muerto — que es exactamente el fallo
   * que dejo al bot 7 horas con el precio congelado el 2026-08-08, con el proceso vivo y la salud en
   * verde. La unica vigilancia que sirve es la que no depende de aquello que vigila.
   */
  private supervisorTimer?: NodeJS.Timeout;
  private stopped = true;
  private latestTick?: PriceTick;
  private lastTickAtMs = 0;
  private unparsedCount = 0;
  private lastUnparsedLogMs = 0;
  private reconnectAttempts = 0;
  private readonly latestTicks = new Map<MarketSymbol, PriceTick>();
  private readonly recentTicks = new Map<MarketSymbol, PriceTick[]>();
  /**
   * Serie TWAP, SEPARADA de la spot.
   *
   * Desde el 2026-08-07 estos mercados no resuelven por precio spot. Sus reglas son explicitas: "este
   * mercado va del precio segun el data stream TWAP de Chainlink, no segun ninguna otra fuente ni
   * mercados spot". Y la documentacion pide no reconstruir el valor — Polymarket lo publica ya
   * calculado en `crypto_prices_twap_thirty`.
   *
   * Van en mapas distintos a proposito: son dos series que miden cosas distintas, y mezclarlas
   * corromperia a la vez el precio de apertura y la distancia sin dar la cara.
   */
  private readonly recentTwapTicks = new Map<MarketSymbol, PriceTick[]>();
  private readonly latestTwapTicks = new Map<MarketSymbol, PriceTick>();
  private readonly handlers = new Set<TickHandler>();

  constructor(
    private readonly url: string,
    private readonly reconnectDelayMs = 3_000,
    private readonly markets: readonly MarketSymbol[] = SUPPORTED_MARKETS,
    private readonly historyWindowMs = 10 * 60 * 1000,
    private readonly noTickTimeoutMs = 30_000,
    // Tope bajo a proposito. El backoff exponencial existe para no machacar un servidor caido, pero
    // aqui el coste de esperar no es teorico: el precio de apertura se captura en los primeros
    // segundos de cada ventana de 5 min, asi que dormir 30s tras un corte de red tira la ventana
    // entera — direccional Y arbitraje. Con 10s se pierde como mucho el arranque de una.
    private readonly maxReconnectDelayMs = 10_000,
    // Re-subscribe on an interval to pull fresh snapshots. Chainlink pushes some assets (ETH/DOGE)
    // infrequently, so without this their ticks go stale between the sparse streaming updates and
    // the opening tick can't be captured. Must be well under the opening capture grace (~15s).
    private readonly snapshotRefreshMs = 5_000,
  ) {}

  start(): void {
    if (!this.stopped) {
      return;
    }
    this.stopped = false;
    this.reconnectAttempts = 0;
    this.startSupervisor();
    // El PRIMER intento tambien puede lanzar (DNS caido al arrancar), y dejarlo propagar aborta el
    // arranque del bot entero por un fallo de red transitorio. Se programa un reintento, que es lo
    // mismo que se hace con cualquier otra caida.
    try {
      this.connect();
    } catch (error) {
      logger.warn("Fallo al conectar el feed al arrancar; se reintenta.", {
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
    this.clearSnapshotRefresh();
    this.cleanupSocket();
  }

  /**
   * Milisegundos desde el ultimo tick valido, o `undefined` si nunca llego ninguno.
   *
   * Es la unica medida honesta de "¿ve el bot el mercado?". El proceso puede responder peticiones y
   * el status enseñar precios con pinta normal mientras el feed lleva horas congelado — paso el
   * 2026-08-08, siete horas.
   */
  msSinceLastTick(nowMs = Date.now()): number | undefined {
    return this.lastTickAtMs > 0 ? nowMs - this.lastTickAtMs : undefined;
  }

  getLatestTick(market: MarketSymbol = "BTC"): PriceTick | undefined {
    return this.latestTicks.get(market) ?? (market === "BTC" && this.latestTick?.market === "BTC" ? this.latestTick : undefined);
  }

  getTickInRange(market: MarketSymbol, startMs: number, endMs: number): PriceTick | undefined {
    return this.recentTicks.get(market)?.find((tick) => tick.timestampMs >= startMs && tick.timestampMs <= endMs);
  }

  /**
   * Last tick at-or-before `timestampMs`: the oracle value in effect at that moment (Chainlink is a
   * step function). This is what official market resolution uses for a window close.
   */
  getTickAtOrBefore(market: MarketSymbol, timestampMs: number): PriceTick | undefined {
    const ticks = this.recentTicks.get(market);
    if (!ticks) {
      return undefined;
    }
    let best: PriceTick | undefined;
    for (const tick of ticks) {
      // recentTicks is kept sorted ascending, so the last match is the most recent at-or-before.
      if (tick.timestampMs <= timestampMs) {
        best = tick;
      }
    }
    return best;
  }

  /**
   * Best tick to represent the window opening: the most recent tick within a symmetric grace around
   * the window start. Chainlink prices are step functions, so for sparsely-updated assets (ETH/DOGE)
   * the last tick just BEFORE the window start is the price in effect at the open — accepting it
   * avoids "missing opening" when no fresh update lands inside the window.
   */
  getOpeningTick(market: MarketSymbol, windowStartMs: number, graceMs: number): PriceTick | undefined {
    const ticks = this.recentTicks.get(market);
    if (!ticks) {
      return undefined;
    }
    // Official criterion (same as resolution): the opening price is the oracle value IN EFFECT at the
    // window start = the last tick at-or-before it. Preferring "most recent in ±grace" captured ticks
    // up to 15s AFTER the open, so a momentary spike became the reference and windows resolved against
    // the wrong side (~8% of samples measured). The first post-open tick within grace remains only as
    // a cold-start fallback (no history at the boundary yet).
    const lo = windowStartMs - graceMs;
    let atOrBefore: PriceTick | undefined;
    let firstAfter: PriceTick | undefined;
    for (const tick of ticks) {
      // recentTicks is kept sorted ascending.
      if (tick.timestampMs <= windowStartMs) {
        if (tick.timestampMs >= lo) {
          atOrBefore = tick;
        }
      } else if (firstAfter === undefined && tick.timestampMs <= windowStartMs + graceMs) {
        firstAfter = tick;
      }
    }
    return atOrBefore ?? firstAfter;
  }

  onTick(handler: TickHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  waitForTick(timeoutMs: number, market: MarketSymbol = "BTC"): Promise<PriceTick> {
    const latestTick = this.getLatestTick(market);
    if (latestTick) {
      return Promise.resolve(latestTick);
    }

    return new Promise((resolve, reject) => {
      const unsubscribe = this.onTick((tick) => {
        if (tick.market !== market) {
          return;
        }
        clearTimeout(timeout);
        unsubscribe();
        resolve(tick);
      });

      const timeout = setTimeout(() => {
        unsubscribe();
        reject(new Error(`Timed out waiting ${timeoutMs}ms for Chainlink ${market}/USD tick.`));
      }, timeoutMs);
    });
  }

  private connect(): void {
    // Drop any previous socket (and its listeners) so only one connection is ever live.
    this.cleanupSocket();

    const socket = new WebSocket(this.url);
    this.socket = socket;
    // Give the fresh connection a grace period to deliver its first tick before the
    // watchdog considers it dead.
    this.lastTickAtMs = Date.now();

    socket.on("open", () => {
      if (this.socket !== socket) {
        socket.close();
        return;
      }
      logger.info("Connected to Polymarket RTDS Chainlink feed.");
      this.lastTickAtMs = Date.now();
      this.subscribe();
      this.startPing();
      this.startSnapshotRefresh();
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
      logger.warn("RTDS websocket error.", { error: error.message });
    });

    socket.on("close", () => {
      if (this.socket !== socket) {
        // A newer socket already replaced this one; ignore the stale close.
        return;
      }
      this.clearPing();
      this.clearSnapshotRefresh();
      if (!this.stopped) {
        this.scheduleReconnect();
      }
    });
  }

  /**
   * Comprueba periodicamente que SIGUEN LLEGANDO TICKS, sin mirar el estado del socket.
   *
   * Un socket abierto que no entrega nada, uno cerrado que nadie reabrio, o una cadena de reconexion
   * rota por una excepcion: los tres se ven igual desde aqui — no hay ticks frescos — y los tres se
   * curan igual. Por eso no distingue.
   */
  private startSupervisor(): void {
    if (this.supervisorTimer) {
      return;
    }
    this.supervisorTimer = setInterval(() => {
      if (this.stopped) {
        return;
      }
      const inactivoMs = this.lastTickAtMs > 0 ? Date.now() - this.lastTickAtMs : Number.POSITIVE_INFINITY;
      if (inactivoMs <= this.noTickTimeoutMs) {
        return;
      }
      // Ya hay un reintento en camino: dejarlo llegar en vez de encadenar reconexiones.
      if (this.reconnectTimer) {
        return;
      }
      logger.warn("Feed sin ticks; el supervisor fuerza reconexion.", {
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
    logger.warn("RTDS websocket closed; reconnecting soon.", {
      attempt: this.reconnectAttempts,
      delayMs: delay,
    });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      try {
        this.connect();
      } catch (error) {
        // `new WebSocket(url)` puede lanzar de forma sincrona — con el DNS caido, por ejemplo. Sin este
        // catch la excepcion se escapaba del timer, y como `reconnectTimer` ya estaba limpio no
        // quedaba NADA que reintentara: el feed moria en silencio para siempre. Paso de verdad.
        logger.warn("Fallo al reconectar el feed; se reintenta.", {
          error: error instanceof Error ? error.message : String(error),
        });
        this.scheduleReconnect();
      }
    }, delay);
  }

  private cleanupSocket(): void {
    if (!this.socket) {
      return;
    }
    const socket = this.socket;
    this.socket = undefined;
    socket.removeAllListeners();
    try {
      socket.terminate();
    } catch {
      // ignore teardown errors
    }
  }

  private subscribe(markets: readonly MarketSymbol[] = this.markets): void {
    if (markets.length === 0) {
      return;
    }

    this.socket?.send(
      JSON.stringify({
        action: "subscribe",
        // SIN filtros de simbolo, en ninguno de los dos topics.
        //
        // Mezclar suscripciones filtradas y sin filtrar rompio el feed: al añadir la del TWAP sin
        // filtro, ETH y DOGE dejaron de recibir spot durante 11 minutos mientras BTC seguia bien. Y
        // con filtro por simbolo en el topic TWAP pasaba lo simetrico — solo llegaba BTC. El servidor
        // no trata la lista como yo suponia, asi que se deja de depender de eso: llegan todos los
        // activos y los que no interesan se descartan al parsear, que es barato y no depende de nadie.
        subscriptions: [
          { topic: "crypto_prices_chainlink", type: "*" },
          { topic: TWAP_TOPIC, type: "update" },
        ],
      }),
    );
  }

  private startPing(): void {
    this.clearPing();
    this.pingTimer = setInterval(() => {
      const socket = this.socket;
      if (socket?.readyState !== WebSocket.OPEN) {
        return;
      }
      // Watchdog: reconnect when the feed stops delivering *valid ticks* — not merely
      // any message. A flood of non-tick frames must not be mistaken for a healthy feed.
      if (this.lastTickAtMs > 0 && Date.now() - this.lastTickAtMs > this.noTickTimeoutMs) {
        logger.warn("RTDS feed delivering no ticks; forcing reconnect.", {
          inactiveMs: Date.now() - this.lastTickAtMs,
        });
        socket.close();
        return;
      }
      socket.send("PING");
    }, 5_000);
  }

  private clearPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = undefined;
    }
  }

  private startSnapshotRefresh(): void {
    this.clearSnapshotRefresh();
    if (this.markets.length === 0 || this.snapshotRefreshMs <= 0) {
      return;
    }
    this.snapshotRefreshTimer = setInterval(() => {
      if (this.socket?.readyState === WebSocket.OPEN) {
        this.subscribe();
      }
    }, this.snapshotRefreshMs);
  }

  private clearSnapshotRefresh(): void {
    if (this.snapshotRefreshTimer) {
      clearInterval(this.snapshotRefreshTimer);
      this.snapshotRefreshTimer = undefined;
    }
  }

  private handleRawMessage(raw: string): void {
    if (!raw || raw === "PONG" || raw === "PING") {
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }

    const messages = Array.isArray(parsed) ? parsed : [parsed];
    for (const message of messages) {
      // La serie TWAP se enruta por topic ANTES del parseo spot, que la rechaza a proposito.
      if (this.handleTwapMessage(message)) {
        continue;
      }
      const ticks = parseChainlinkTicks(message);
      if (ticks.length === 0) {
        this.noteUnparsedMessage(message);
        continue;
      }
      for (const tick of ticks) {
        this.lastTickAtMs = Date.now();
        // Los intentos se reinician con un TICK, no al abrir el socket. Abrir y no recibir nada es
        // precisamente el fallo que hay que castigar con espera creciente; darlo por bueno al abrir
        // hacia que una conexion muda contara como exito.
        this.reconnectAttempts = 0;
        this.rememberTick(tick);
        this.latestTick = tick;
        this.latestTicks.set(tick.market, tick);
        for (const handler of this.handlers) {
          handler(tick);
        }
      }
    }
  }

  /**
   * Deja constancia de los mensajes que llegan y NO producen ningun tick.
   *
   * Antes se descartaban en silencio absoluto. Si Polymarket cambia el formato del payload, el bot se
   * queda sin precios y lo unico que se ve es "RTDS feed delivering no ticks; forcing reconnect", sin
   * ninguna pista de la causa — el bot reconecta en bucle contra un feed que funciona perfectamente.
   * Se registra la FORMA (topic, type, claves) y nunca el contenido, y con throttle para que un
   * formato incompatible no inunde el log a varios mensajes por segundo.
   */
  private noteUnparsedMessage(message: unknown): void {
    this.unparsedCount += 1;
    const nowMs = Date.now();
    if (nowMs - this.lastUnparsedLogMs < 60_000) {
      return;
    }
    this.lastUnparsedLogMs = nowMs;
    const record = (message ?? {}) as Record<string, unknown>;
    const payload = record.payload as Record<string, unknown> | undefined;
    logger.warn("Mensajes del RTDS que no producen ticks.", {
      count: this.unparsedCount,
      topic: record.topic,
      type: record.type,
      payloadKeys: payload ? Object.keys(payload).sort() : undefined,
    });
    this.unparsedCount = 0;
  }

  /** `true` si el mensaje era de la serie TWAP y ya se ha consumido. */
  private handleTwapMessage(message: unknown): boolean {
    if (!message || typeof message !== "object") {
      return false;
    }
    const record = message as Record<string, unknown>;
    if (record.topic !== TWAP_TOPIC) {
      return false;
    }
    const payload = (record.payload ?? record) as Record<string, unknown>;
    const tick = parseTwapPoint(payload);
    if (!tick) {
      return true; // era del topic TWAP aunque no se pudiera leer: no reintentar como spot
    }
    // Cuenta como señal de vida: si llega TWAP el socket esta sano aunque el spot vaya lento.
    this.lastTickAtMs = Date.now();
    this.reconnectAttempts = 0;
    this.latestTwapTicks.set(tick.market, tick);
    const serie = this.recentTwapTicks.get(tick.market) ?? [];
    if (!serie.some((item) => item.timestampMs === tick.timestampMs)) {
      serie.push(tick);
    }
    const minMs = tick.timestampMs - this.historyWindowMs;
    this.recentTwapTicks.set(
      tick.market,
      serie.filter((item) => item.timestampMs >= minMs).sort((l, r) => l.timestampMs - r.timestampMs),
    );
    return true;
  }

  /** Ultimo valor TWAP publicado, o `undefined` si aun no ha llegado ninguno. */
  getLatestTwapTick(market: MarketSymbol): PriceTick | undefined {
    return this.latestTwapTicks.get(market);
  }

  /**
   * Valor TWAP vigente en un instante: el ultimo publicado en o antes de el.
   *
   * Sirve tanto para la apertura (valor al inicio de la ventana) como para el cierre, que es
   * exactamente como estan escritas las reglas del mercado.
   */
  getTwapAtOrBefore(market: MarketSymbol, timestampMs: number, maxAgeMs = 60_000): PriceTick | undefined {
    const serie = this.recentTwapTicks.get(market);
    if (!serie) {
      return undefined;
    }
    let mejor: PriceTick | undefined;
    for (const tick of serie) {
      if (tick.timestampMs <= timestampMs) {
        mejor = tick;
      }
    }
    // Un valor de hace media hora no representa "el precio en ese instante". Antes de devolver algo
    // viejo es mejor no devolver nada: quien llama decide, y aqui abstenerse es barato.
    return mejor && timestampMs - mejor.timestampMs <= maxAgeMs ? mejor : undefined;
  }

  private rememberTick(tick: PriceTick): void {
    const ticks = this.recentTicks.get(tick.market) ?? [];
    const existingIndex = ticks.findIndex((item) => item.timestampMs === tick.timestampMs);
    if (existingIndex >= 0) {
      ticks[existingIndex] = tick;
    } else {
      ticks.push(tick);
    }

    const minTimestampMs = tick.timestampMs - this.historyWindowMs;
    const pruned = ticks
      .filter((item) => item.timestampMs >= minTimestampMs)
      .sort((left, right) => left.timestampMs - right.timestampMs);
    this.recentTicks.set(tick.market, pruned);
  }
}

export function parseChainlinkTick(message: unknown): PriceTick | null {
  return parseChainlinkTicks(message).at(-1) ?? null;
}

export function parseChainlinkTicks(message: unknown): PriceTick[] {
  if (!message || typeof message !== "object") {
    return [];
  }

  const record = message as Record<string, unknown>;
  if (record.topic === "crypto_prices") {
    return parseCryptoPricesTick(record);
  }

  if (record.topic !== "crypto_prices_chainlink") {
    return [];
  }

  const payload = record.payload as Record<string, unknown> | undefined;
  if (!payload) {
    return [];
  }

  // Un payload con marca de VENTANA TEMPORAL es un feed TWAP, no la serie spot sobre la que se mide
  // toda la estrategia. Chainlink publica TWAPs de 30 y 60 segundos, y la suscripcion usa comodin
  // (`type: "*"`), asi que si algun dia aparecen bajo este mismo topic entrarian solas. Mezclarlas con
  // el spot corrompe a la vez el precio de apertura y la distancia — los dos terminos de la señal —
  // sin dar la cara. Se rechazan aqui; `handleRawMessage` deja constancia de que llegó algo que no se
  // reconoce, para que sea un fallo visible y no uno mudo.
  // `window_s` es la forma REAL del payload RTDS (verificada en vivo); `windowSeconds` es la del
  // cliente tipado y `feedID` la de Chainlink Data Streams. Se comprueban las tres porque la
  // suscripcion usa comodin y basta con que una se cuele para envenenar la serie spot.
  if (payload.windowSeconds !== undefined || payload.window_s !== undefined || payload.feedID !== undefined) {
    return [];
  }

  return asTickArray(parseTickPoint(payload.symbol, payload.value, payload.timestamp));
}

/**
 * Un punto de la serie TWAP. Exige `window_s` presente: sin esa marca no es un valor TWAP, y aceptarlo
 * seria colar un precio spot en la serie que decide quien gana.
 */
export function parseTwapPoint(payload: Record<string, unknown>): PriceTick | undefined {
  if (payload.window_s === undefined && payload.windowSeconds === undefined) {
    return undefined;
  }
  return parseTickPoint(payload.symbol, payload.value, payload.timestamp) ?? undefined;
}

function parseCryptoPricesTick(record: Record<string, unknown>): PriceTick[] {
  const payload = record.payload as Record<string, unknown> | undefined;
  if (!payload) {
    return [];
  }

  const data = Array.isArray(payload.data) ? payload.data : undefined;
  if (data) {
    return data
      .flatMap((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) {
          return [];
        }
        const point = item as Record<string, unknown>;
        return asTickArray(parseTickPoint(payload.symbol, point.value, point.timestamp));
      })
      .sort((left, right) => left.timestampMs - right.timestampMs);
  }

  return asTickArray(parseTickPoint(payload.symbol, payload.value, payload.timestamp));
}

function parseTickPoint(symbolValue: unknown, valueValue: unknown, timestampValue: unknown): PriceTick | null {
  const symbol = String(symbolValue ?? "").toLowerCase();
  const market = marketSymbolFromPriceFeedSymbol(symbol);
  const value = Number(valueValue);
  const timestampMs = Number(timestampValue);
  if (!market || !Number.isFinite(value) || !Number.isFinite(timestampMs)) {
    return null;
  }

  return {
    market,
    symbol: symbol as PriceTick["symbol"],
    value,
    timestampMs,
    receivedAtMs: Date.now(),
  };
}

function asTickArray(tick: PriceTick | null): PriceTick[] {
  return tick ? [tick] : [];
}

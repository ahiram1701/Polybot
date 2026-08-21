/**
 * El bucle que mantiene ordenes en reposo cobrando recompensas de liquidez.
 *
 * Cada pasada: mira que mercados pagan, cuanto compite ya en la banda, elige donde cabe el capital, y
 * deja puestas las ordenes que puntuan. No predice nada — de eso va justamente este rediseno.
 *
 * Tres guardas que no son opcionales, y las tres salieron de perder $41,41 en 40 minutos el 2026-08-19:
 *
 *  - **Los dos lados o ninguno.** Cotizar solo UP no es hacer de maker, es comprar direccional: una
 *    compra en reposo solo se llena cuando el precio CAE hasta ella. Ver `planificarDosLados`.
 *  - **El tope cuenta el GASTO, no solo lo comprometido.** Una orden que se llena deja de estar viva,
 *    liberaba el presupuesto y la pasada siguiente colocaba otra. Asi una ventana de 5 minutos gasto
 *    $85 con el tope en $12. Ahora los llenados se acumulan y descuentan.
 *  - **Se retira antes del cierre.** Una orden llena cerca del final deja una posicion direccional que
 *    resuelve en segundos, sin margen para deshacerla.
 */
import { logger } from "./logger.js";
import type { MakerEngine } from "./makerEngine.js";
import {
  elegirMercados,
  medioContrario,
  planificarDosLados,
  puntuacionRecompensa,
} from "./makerQuoting.js";
import type { CandidatoMercado, Inventario, OrdenViva, ParametrosRecompensa } from "./makerQuoting.js";
import type { OrderbookService } from "./orderbookService.js";
import type { RecompensaMercado, RewardParamsReader } from "./rewardParams.js";
import { secondsToEnd } from "./time.js";
import type { MercadoMaker } from "./makerMarket.js";
import type { Outcome } from "./types.js";

export interface MakerLoopDeps {
  orderbook: Pick<OrderbookService, "getQuote">;
  rewards: Pick<RewardParamsReader, "paraMercado">;
  engine: MakerEngine;
}

export interface MakerLoopConfig {
  /** Tope duro de dolares en riesgo a la vez —comprometidos MAS gastados— en TODOS los mercados. */
  capitalUsd: number;
  /** Segundos antes del cierre en los que se deja de cotizar y se retira todo. */
  retirarSegundosAntesDelCierre: number;
  /** A cuantos ticks del medio se coloca. Ver `TICKS_DEL_MEDIO` en `makerQuoting`. */
  ticksDelMedio?: number;
  /**
   * Intervalo minimo entre recolocaciones en el mismo mercado.
   *
   * Sin esto el ritmo medido en simulacion fue de ~1.400 recolocaciones/hora: la banda que puntua
   * (1,5 centavos) es mas estrecha que lo que se mueve el precio, asi que la orden se sale una y otra
   * vez. El coste no es perder turno en la cola —para recompensas eso no cuenta— sino los limites de
   * peticiones del exchange.
   */
  minMsEntreRecolocaciones?: number;
  /**
   * Cuantos mercados NO cotizados se sondean (libro + ordenes) en cada pasada.
   *
   * El escaner propone hasta 25 candidatos, y leerlos todos en cada pasada serian 75 peticiones cada
   * 15 s contra un pool de 24 conexiones. Ese exceso ya se pago una vez: **1.049 timeouts de 2 s en
   * una hora** con el endpoint respondiendo en 280 ms al medirlo suelto, y el maker medio ciego sin
   * que nada pareciera roto. Se sondea por turnos, del mas rancio al mas fresco.
   */
  sondeosPorPasada?: number;
  /**
   * Cuanto vale una medida de competencia para ORDENAR mercados.
   *
   * Solo para ordenar. Colocar con un punto medio rancio seria peor que no colocar: la banda que
   * puntua son 1,5-4,5 centavos, asi que un medio de hace un minuto puede dejar las dos ordenes fuera
   * y con el dinero igualmente inmovilizado. Antes de cotizar en un mercado se le relee el libro.
   */
  ttlCompetenciaMs?: number;
  /** Cuanto mejor tiene que ser un aspirante para quitarle el capital al que ya cotiza. Ver `elegirMercados`. */
  margenRelevo?: number;
  /** Cada cuanto deja constancia de que sigue vivo aunque no cambie nada. Ver `dejarConstancia`. */
  intervaloLatidoMs?: number;
}

export interface ResumenPasada {
  colocadas: number;
  canceladas: number;
  comprometidoUsd: number;
  /** Dolares ya GASTADOS en llenados y todavia atados a posiciones sin resolver. */
  gastadoUsd: number;
  /**
   * Dolares inmovilizados en ordenes propias VIVAS al TERMINAR la pasada, sumando todos los mercados.
   *
   * No es `comprometidoUsd`, que solo cuenta lo colocado en ESTA pasada. Hace falta por separado
   * porque una orden en reposo baja el saldo del exchange sin ser una perdida: el dinero sigue siendo
   * nuestro. Quien mire solo el saldo para decidir si parar, parara en operacion normal.
   *
   * Al terminar, no al empezar, y contando TODOS los mercados leidos —no solo los que llegaron a ser
   * candidatos—. Medirlo antes describia un estado que dejaba de ser cierto en la misma pasada, y
   * dejar fuera a un mercado cuyo libro no llego reportaba $0 con dinero de verdad atado. Los dos
   * errores empujan en la misma direccion: hacia parar el maker sin motivo.
   *
   * Un mercado cuya lectura falla ENTERA no aparece: no se puede contar lo que no se ha podido ver.
   */
  vivoUsd: number;
  /**
   * Valor GARANTIZADO de los pares completos que se tienen, a $1 el par.
   *
   * Un par (una participacion de cada lado) redime exactamente $1 gane quien gane: no es una posicion
   * de riesgo, es dinero con fecha. Las participaciones SUELTAS —el lado del que se es largo sin su
   * pareja— se valoran a CERO a proposito: son justo lo que puede irse a cero, y esto alimenta una
   * guarda de perdida, donde equivocarse por optimista cuesta dinero.
   *
   * Sin esto, un suelo de saldo saltaba en operacion normal: al llenarse un par el efectivo baja pero
   * el dinero no se ha perdido, solo ha cambiado de forma.
   */
  paresUsd: number;
  /** Participaciones que se llenaron desde la pasada anterior. Cada una es posicion direccional. */
  llenadas?: number;
  mercados: Array<{ slug: string; motivo?: string; esperadoUsdDia?: number }>;
}

/** 15 s: recorta el ritmo ~10 veces y sigue reaccionando dentro de una ventana de 5 minutos. */
const MIN_MS_ENTRE_RECOLOCACIONES = 15_000;

/**
 * Cuantos mercados nuevos se miran por pasada. Con 25 candidatos y pasadas de 15 s, todos quedan
 * revisados en ~95 s: de sobra para ORDENAR, y sin acercarse al limite de sockets.
 */
const SONDEOS_POR_PASADA = 4;

/** Dos minutos: mas que el barrido completo, para que ningun candidato caiga del ranking por turno. */
const TTL_COMPETENCIA_MS = 120_000;

/**
 * 25% mejor para merecer el relevo.
 *
 * Medido sobre 21,8 h: 10,7 mudanzas por hora, el 86% abandonando un mercado que seguia disponible.
 * Entre los que caben en $20 hay 54 empatados por bote, asi que sin margen se cambia de sitio con el
 * ruido de la foto del libro.
 */
const MARGEN_RELEVO = 0.25;

/**
 * Cada cuanto deja constancia de que sigue vivo aunque no cambie nada.
 *
 * Cinco minutos son 288 lineas al dia, que es poco al lado de la ambiguedad que quitan: hasta ahora el
 * log SOLO hablaba cuando algo cambiaba, asi que un maker parado en su mejor mercado y uno que no
 * encuentra donde entrar escribian exactamente lo mismo —nada— y habia que preguntarle a la API para
 * distinguirlos. Ocho minutos de silencio no decian si todo iba bien.
 */
const INTERVALO_LATIDO_MS = 5 * 60_000;

/**
 * A partir de aqui, no cotizar en NINGUN sitio deja de ser normal y pasa a ser un aviso.
 *
 * Quedarse sin cotizar unos minutos es corriente: un mercado que cierra, una rotacion del escaner, una
 * pasada sin libro. Un cuarto de hora entero sin una sola orden viva no lo es, y es justo el estado que
 * no se distinguia del de un maker sano.
 */
const MINUTOS_MUDO_PARA_AVISAR = 15;

/** Lo ultimo que se midio de un mercado. Sirve para ordenar; para cotizar hace falta relectura. */
interface FichaCompetencia {
  poolDiaUsd: number;
  qRivalBid: number;
  qRivalAsk: number;
  mid: number;
  tickSize: number;
  params: ParametrosRecompensa;
  enMs: number;
}

/** Lo que hay que recordar de un mercado entre pasadas. Muere cuando su ventana se cierra. */
interface EstadoMercado {
  /** Dolares gastados en llenados dentro de esta ventana. */
  gastadoUsd: number;
  /** Participaciones compradas de cada lado: define hacia donde estamos expuestos. */
  inventario: Inventario;
  /** Cuando se recoloco por ultima vez, para no martillear al exchange. */
  ultimaRecolocacionMs?: number;
}

export class MakerLoop {
  /** Tamano que quedaba vivo la ultima vez que se vio cada orden, para detectar llenados. */
  private readonly tamanoConocido = new Map<string, number>();

  /** Precio y lado de cada orden conocida, para valorar el llenado cuando la orden ya no esta. */
  private readonly datosOrden = new Map<string, { price: number; outcome: Outcome }>();

  private readonly estados = new Map<string, EstadoMercado>();

  /**
   * Mercados en los que hemos llegado a cotizar, aunque ya no esten en la lista.
   *
   * Los mercados ROTAN: el escaner rehace su seleccion cada cinco minutos y los de un dia expiran. Un
   * mercado que sale de la lista se deja de recorrer, asi que sus ordenes quedarian vivas en el libro
   * sin que nadie volviera a mirarlas — y una orden viva puede llenarse y resolver sola.
   */
  private readonly cotizados = new Map<string, MercadoMaker>();

  /**
   * Ultima medida de competencia de cada mercado, para poder ORDENAR muchos leyendo pocos.
   *
   * Es lo que hace asequible mirar 25 candidatos en vez de 3. Y mirar 3 costaba caro: entre los
   * mercados que caben en $20 hay 54 empatados por bote, el orden del registro **no predice el
   * rendimiento real** (Spearman 0,007 medido sobre 60 mercados) y el rendimiento va de 10,2 a 0,004
   * dolares al dia por dolar. Elegir el mejor de 3 al azar rinde menos de la mitad que el mejor de 20.
   */
  private readonly fichas = new Map<string, FichaCompetencia>();

  /** Cuando se dejo constancia por ultima vez, para que el latido no compita con el log de cambios. */
  private ultimoLatidoMs = 0;

  /** Desde cuando no hay ni una orden viva en ningun sitio. `undefined` = si la hay. */
  private sinCotizarDesdeMs: number | undefined;

  constructor(
    private readonly deps: MakerLoopDeps,
    private readonly config: MakerLoopConfig,
  ) {}

  private estado(slug: string): EstadoMercado {
    let e = this.estados.get(slug);
    if (!e) {
      e = { gastadoUsd: 0, inventario: { UP: 0, DOWN: 0 } };
      this.estados.set(slug, e);
    }
    return e;
  }

  /**
   * Retira TODAS las ordenes vivas. Se llama al detener el bot.
   *
   * Sin esto, parar el bot dejaba ordenes reales descansando en el libro sin nadie mirandolas: se
   * pueden llenar en cualquier momento y la posicion resultante resuelve sola. Y no es un caso raro —
   * el watchdog reinicia el proceso a diario y la maquina se apaga sin avisar.
   */
  async retirarTodo(markets: MercadoMaker[]): Promise<number> {
    // Se suma lo COTIZADO aunque ya no este en la lista: si un mercado roto entre la ultima cotizacion
    // y la parada, sus ordenes seguirian vivas y el llamante no tiene forma de saberlo.
    const porSlug = new Map(markets.map((m) => [m.slug, m]));
    for (const [slug, market] of this.cotizados) {
      if (!porSlug.has(slug)) {
        porSlug.set(slug, market);
      }
    }
    markets = [...porSlug.values()];

    let canceladas = 0;
    for (const market of markets) {
      try {
        const vivas = await this.deps.engine.ordenesVivas(market);
        canceladas += (await this.cancelar(vivas.map((o) => o.id), market.slug)).length;
      } catch (error) {
        // Se sigue con los demas mercados: dejar ordenes vivas en UNO es malo, en TODOS es peor.
        logger.warn("No se pudieron retirar las ordenes de un mercado.", {
          slug: market.slug,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (canceladas > 0) {
      logger.info("Maker: ordenes retiradas al parar.", { canceladas });
    }

    // COMPROBAR que no queda nada. Cancelar y creerselo es como se pierden ordenes de vista: si el
    // exchange rechazo alguna, esta es la ultima oportunidad de enterarse antes de que el proceso muera
    // y nadie vuelva a mirar el libro.
    let quedan = 0;
    for (const market of markets) {
      try {
        quedan += (await this.deps.engine.ordenesVivas(market)).length;
      } catch {
        // Si no se puede comprobar, se dice: un silencio aqui es peor que un aviso de mas.
        quedan += 1;
      }
    }
    if (quedan > 0) {
      logger.error("QUEDAN ORDENES MAKER VIVAS tras intentar retirarlas. Hay dinero real expuesto.", {
        vivas: quedan,
        mercados: markets.length,
      });
    }
    return canceladas;
  }

  /**
   * Cancela y ADEMAS olvida la orden.
   *
   * Sin este olvido, la orden desaparecida se contaria como llenada en la pasada siguiente: el gasto
   * acumulado se dispararia solo y el tope dejaria al maker mudo sin que nadie hubiera comprado nada.
   */
  private async cancelar(ids: string[], slug: string): Promise<string[]> {
    // Se olvida SOLO lo que el exchange confirma haber cancelado.
    //
    // Borrar el rastro por adelantado era peligroso: una orden que el exchange se negara a cancelar
    // quedaba viva en el libro y ademas invisible —su llenado no se detectaba ni contaba contra el
    // tope—. Ahora lo que no se cancela se sigue vigilando, y en la pasada siguiente se vuelve a
    // intentar porque sigue apareciendo en `ordenesVivas`.
    const canceladas = await this.deps.engine.cancelar(ids);
    for (const id of canceladas) {
      this.tamanoConocido.delete(`${slug}|${id}`);
      this.datosOrden.delete(`${slug}|${id}`);
    }
    return canceladas;
  }

  /**
   * Cancela, apunta el recuento en el resumen y devuelve los DOLARES que quedan REALMENTE libres.
   *
   * Existe porque el reparto de capital necesita las dos cosas a la vez y antes solo tenia una: se
   * contaban las cancelaciones pero no se devolvia su dinero al bote. Y devolver el dinero de lo que
   * se PIDIO cancelar seria peor que no devolverlo: una orden que el exchange se niega a cancelar
   * sigue viva y sigue costando. Solo libera lo confirmado.
   */
  private async retirarYLiberar(
    ordenes: Array<{ id: string; price: number; size: number }>,
    slug: string,
    resumen: ResumenPasada,
  ): Promise<number> {
    if (ordenes.length === 0) {
      return 0;
    }
    const confirmadas = new Set(await this.cancelar(ordenes.map((o) => o.id), slug));
    resumen.canceladas += confirmadas.size;
    return ordenes.filter((o) => confirmadas.has(o.id)).reduce((s, o) => s + o.price * o.size, 0);
  }

  /**
   * Un llenado seria INVISIBLE si nadie lo buscara: el maker solo mira si la orden sigue puntuando, y
   * una orden que desaparece del libro por haberse llenado se parece a una que ya no existe.
   *
   * Se cuentan las dos formas de llenarse, y la segunda faltaba:
   *  - **Parcial**: la orden sigue viva con menos tamano.
   *  - **Total**: la orden DESAPARECE. Seria indistinguible de una cancelacion, y por eso `cancelar()`
   *    borra el rastro de lo que quitamos nosotros: lo que desaparece sin ese borrado, se llenó.
   */
  private detectarLlenados(market: MercadoMaker, vivas: OrdenViva[], resumen: ResumenPasada): void {
    const prefijo = `${market.slug}|`;
    const porId = new Map(vivas.map((o) => [o.id, o.size]));
    const estado = this.estado(market.slug);

    for (const [clave, tamanoPrevio] of [...this.tamanoConocido]) {
      if (!clave.startsWith(prefijo)) {
        continue;
      }
      const idOrden = clave.slice(prefijo.length);
      const ahora = porId.get(idOrden);
      // Si la orden ya no esta y NOSOTROS no la cancelamos, se llenó: `cancelar()` borra el rastro de
      // las que quitamos, asi que llegar aqui sin la orden viva solo puede significar un llenado.
      const desaparecida = ahora === undefined;
      const restante = ahora ?? 0;
      if (restante >= tamanoPrevio) {
        continue;
      }
      const llenado = tamanoPrevio - restante;
      const datos = this.datosOrden.get(clave);
      resumen.llenadas = (resumen.llenadas ?? 0) + llenado;
      if (datos) {
        estado.gastadoUsd += llenado * datos.price;
        estado.inventario[datos.outcome] += llenado;
      }
      logger.warn("Maker: orden LLENADA — hay posicion direccional abierta.", {
        slug: market.slug,
        orden: idOrden,
        participaciones: llenado,
        costeUsd: datos ? Number((llenado * datos.price).toFixed(4)) : undefined,
        inventario: estado.inventario,
      });
      if (desaparecida) {
        this.tamanoConocido.delete(clave);
        this.datosOrden.delete(clave);
      }
    }

    for (const o of vivas) {
      this.tamanoConocido.set(`${prefijo}${o.id}`, o.size);
      this.datosOrden.set(`${prefijo}${o.id}`, { price: o.price, outcome: o.outcome });
    }
  }

  /**
   * El libro REAL de un token, fusionando los dos que publica el exchange.
   *
   * En Polymarket una venta de UP casi nunca esta en el libro de UP: esta en el de DOWN como compra,
   * porque comprar DOWN a `p` es exactamente vender UP a `1-p`. Leer un solo libro daba `Q_two = 0` y
   * dos consecuencias graves: el punto medio salia indefinido (1.187 pasadas perdidas en un dia) y el
   * estimador se creia dueño del bote entero.
   */
  /**
   * A que mercados se les lee el estado ESTA pasada.
   *
   * Donde ya se cotiza va siempre: ahi hay dinero, y hay que ver si la orden sigue puntuando y si
   * alguien la lleno. Del resto entra un turno, del mas rancio al que se miro hace menos, para que
   * ninguno se quede sin medir. Nunca se sondea la lista entera: 25 candidatos x 3 peticiones cada
   * 15 s contra un pool de 24 conexiones es exactamente como se llego a 1.049 timeouts en una hora.
   */
  private aQuienSondear(markets: MercadoMaker[]): Set<string> {
    const elegidos = new Set<string>();
    const resto: MercadoMaker[] = [];
    for (const market of markets) {
      // El criterio es "queda alguna orden nuestra viva ahi", NO "hemos cotizado ahi alguna vez".
      // `cotizados` es lo segundo y ademas gobierna otra cosa —cuando olvidar el gasto de una ventana
      // cerrada—, asi que usarlo aqui hacia dos cosas malas: los mercados abandonados se comian el cupo
      // de sondeo para siempre, y podarlo para arreglarlo dejaba el gasto contando eternamente contra
      // el tope. Son dos preguntas distintas y ahora tienen dos respuestas distintas.
      if (this.tieneRastroDeOrdenes(market.slug)) {
        elegidos.add(market.slug);
      } else {
        resto.push(market);
      }
    }
    const cupo = Math.max(0, this.config.sondeosPorPasada ?? SONDEOS_POR_PASADA);
    // Los nunca vistos tienen ficha en el instante 0, asi que entran los primeros por construccion.
    const porAntiguedad = [...resto].sort(
      (izq, der) => (this.fichas.get(izq.slug)?.enMs ?? 0) - (this.fichas.get(der.slug)?.enMs ?? 0),
    );
    for (const market of porAntiguedad.slice(0, cupo)) {
      elegidos.add(market.slug);
    }
    return elegidos;
  }

  /**
   * Todo lo que hay que saber de UN mercado para decidir: que tenemos vivo, si paga y como esta el libro.
   *
   * Un fallo leyendo uno no puede tumbar la pasada entera. Sin este intento, una excepcion de
   * `ordenesVivas` —un timeout, un 429— abortaba tambien los mercados que si respondian, y ademas
   * dejaba sin recorrer la retirada de los que estaban cerca del cierre.
   */
  private async inspeccionar(
    market: MercadoMaker,
    nowMs: number,
  ): Promise<
    | {
        market: MercadoMaker;
        vivas: OrdenViva[];
        cerca: boolean;
        params: RecompensaMercado | undefined;
        libro: { bids: Array<{ price: number; size: number }>; asks: Array<{ price: number; size: number }> } | undefined;
      }
    | undefined
  > {
    try {
      const vivas = await this.deps.engine.ordenesVivas(market);
      const cerca = secondsToEnd(market.endMs, nowMs) <= this.config.retirarSegundosAntesDelCierre;
      if (cerca) {
        return { market, vivas, cerca, params: undefined, libro: undefined };
      }
      const params = await this.deps.rewards.paraMercado(market.conditionId, market.slug);
      const libro = params ? await this.libroFusionado(market) : undefined;
      return { market, vivas, cerca, params, libro };
    } catch (error) {
      logger.warn("Maker: no se pudo leer el estado de un mercado; se salta esta pasada.", {
        slug: market.slug,
        error: error instanceof Error ? error.message : String(error),
      });
      // Sin saber que hay vivo no se toca nada: ni se cotiza ni se cancela a ciegas.
      return undefined;
    }
  }

  private async libroFusionado(
    market: MercadoMaker,
  ): Promise<{ bids: Array<{ price: number; size: number }>; asks: Array<{ price: number; size: number }> } | undefined> {
    // Leer los dos libros DUPLICA la exposicion a un timeout, y una excepcion aqui aborta la pasada
    // entera —incluidos los mercados que si respondian—. Un libro que no llega es "no se puede
    // cotizar aqui", no un error del bucle.
    const [up, down] = await Promise.all(
      [market.outcomes.UP.tokenId, market.outcomes.DOWN.tokenId].map(async (tokenId) => {
        try {
          return await this.deps.orderbook.getQuote(tokenId, 25, 0.99);
        } catch (error) {
          logger.warn("Maker: no se pudo leer un libro.", {
            slug: market.slug,
            error: error instanceof Error ? error.message : String(error),
          });
          return undefined;
        }
      }),
    );
    if (!up || !down) {
      return undefined;
    }
    const espejo = (n: { price: number; size: number }) => ({ price: 1 - n.price, size: n.size });
    const bids = [...up.rawBidLevels, ...down.rawAskLevels.map(espejo)].sort((a, b) => b.price - a.price);
    const asks = [...up.rawAskLevels, ...down.rawBidLevels.map(espejo)].sort((a, b) => a.price - b.price);
    if (bids.length === 0 || asks.length === 0) {
      return undefined;
    }
    return { bids, asks };
  }

  /** Puntuacion de los rivales por lado, descontando lo nuestro para no competir contra uno mismo. */
  private competencia(
    libro: { bids: Array<{ price: number; size: number }>; asks: Array<{ price: number; size: number }> },
    mid: number,
    params: ParametrosRecompensa,
    vivas: OrdenViva[],
  ): { qRivalBid: number; qRivalAsk: number } {
    const suma = (niveles: Array<{ price: number; size: number }>) =>
      niveles.reduce((s, n) => s + puntuacionRecompensa(n.size, n.price - mid, params), 0);

    // Nuestras compras de UP estan en el lado bid; las de DOWN aparecen en el ask como `1 - precio`.
    let propiaBid = 0;
    let propiaAsk = 0;
    for (const o of vivas) {
      if (o.side !== "BUY") {
        continue;
      }
      if (o.outcome === "UP") {
        propiaBid += puntuacionRecompensa(o.size, o.price - mid, params);
      } else {
        propiaAsk += puntuacionRecompensa(o.size, 1 - o.price - mid, params);
      }
    }
    return {
      qRivalBid: Math.max(0, suma(libro.bids) - propiaBid),
      qRivalAsk: Math.max(0, suma(libro.asks) - propiaAsk),
    };
  }

  async runOnce(markets: MercadoMaker[], nowMs: number): Promise<ResumenPasada> {
    const resumen: ResumenPasada = {
      colocadas: 0,
      canceladas: 0,
      comprometidoUsd: 0,
      gastadoUsd: 0,
      vivoUsd: 0,
      paresUsd: 0,
      mercados: [],
    };

    // Mercados que se han caido de la lista: se les retiran las ordenes ANTES de olvidarlos.
    //
    // Su ventana se cerro o el escaner encontro algo mejor. En los dos casos dejan de recorrerse, asi
    // que lo que quede vivo ahi seria una orden que nadie vuelve a mirar y que puede llenarse y
    // resolver sola. Y su gasto deja de contar contra el tope: esas posiciones ya resolvieron.
    const vigentes = new Set(markets.map((m) => m.slug));
    // Dinero que sigue atado en mercados que ya no se recorren porque el exchange no acepto retirarlo.
    // Cuenta contra el tope igual que el resto: sigue siendo dinero fuera del bolsillo.
    let atadoHuerfanoUsd = 0;
    for (const [slug, market] of [...this.cotizados]) {
      if (vigentes.has(slug)) {
        continue;
      }
      try {
        const huerfanas = await this.deps.engine.ordenesVivas(market);
        if (huerfanas.length > 0) {
          logger.warn("Maker: retirando ordenes de un mercado que ya no se sigue.", {
            slug,
            ordenes: huerfanas.length,
          });
          const liberado = await this.retirarYLiberar(huerfanas, slug, resumen);
          const restante = huerfanas.reduce((suma, o) => suma + o.price * o.size, 0) - liberado;
          if (restante > 0) {
            // Cancelar puede confirmar SOLO una parte. Olvidar el mercado aqui dejaria las que
            // sobreviven vivas, sin que nadie vuelva a mirarlas y ademas invisibles para el tope. Se
            // conserva para reintentarlo, igual que cuando la llamada falla entera.
            atadoHuerfanoUsd += restante;
            continue;
          }
        }
      } catch (error) {
        // Si no se pueden retirar, se conserva el mercado para reintentarlo en la pasada siguiente:
        // olvidarlo aqui seria perder de vista ordenes vivas de verdad.
        logger.warn("Maker: no se pudieron retirar las ordenes huerfanas.", {
          slug,
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      this.cotizados.delete(slug);
      this.estados.delete(slug);
    }
    const candidatos: Array<
      CandidatoMercado & { market: MercadoMaker; vivas: OrdenViva[]; fresco: boolean }
    > = [];

    /**
     * DOLARES ATADOS AHORA MISMO en ordenes propias vivas, en todos los mercados. Cuenta unica.
     *
     * Antes habia dos medias cuentas y las dos mentian. Solo sumaba los mercados que llegaban a ser
     * CANDIDATOS, asi que un libro que no llegaba —y llegan ~1.000 timeouts a la hora— borraba sus
     * ordenes de la contabilidad sin retirarlas: el tope se pasaba (medido en banco de pruebas: $98
     * con el tope en $60) y `vivoUsd` reportaba $0 con dinero de verdad inmovilizado, que es justo lo
     * que lee el suelo de patrimonio para decidir si parar. Y el dinero de un mercado descartado no
     * volvia al bote hasta la pasada siguiente, asi que el mercado que GANABA el ranking se quedaba
     * sin cotizar por falta de un capital que ya estaba libre.
     *
     * Sube al colocar y baja SOLO con cancelaciones confirmadas. Lo que no se puede leer no se puede
     * contar: un mercado cuya lectura falla entera queda fuera, y por eso ahi tampoco se toca nada.
     */
    let atadoUsd = atadoHuerfanoUsd;

    // La LECTURA de los mercados va en paralelo; la DECISION, en serie.
    //
    // Leer en serie costaba 28 segundos por pasada —tres peticiones por mercado con timeout de 2 s— y
    // bloqueaba el bucle entero hasta que el watchdog reiniciaba el proceso. Nada de esto se escribe,
    // asi que paralelizarlo es seguro; lo que si tiene que seguir en orden es repartir el capital,
    // porque cada mercado consume del mismo presupuesto que el anterior.
    //
    // Y se lee a POCOS: donde ya cotizamos —ahi hay dinero— mas un turno de los demas. Los que no
    // tocan esta vez entran al ranking con su ultima ficha; ninguno se cotiza sin relectura.
    const aSondear = this.aQuienSondear(markets);
    const leidos = await Promise.all(
      markets.filter((m) => aSondear.has(m.slug)).map((m) => this.inspeccionar(m, nowMs)),
    );

    for (const leido of leidos) {
      if (!leido) {
        continue;
      }
      const { market, vivas, cerca, params, libro } = leido;
      this.detectarLlenados(market, vivas, resumen);
      atadoUsd += vivas.reduce((suma, o) => suma + o.price * o.size, 0);

      // Cerca del cierre no se cotiza y se retira lo que haya: una orden llena aqui deja una posicion
      // que resuelve en segundos y no da tiempo a deshacerla.
      if (cerca) {
        atadoUsd -= await this.retirarYLiberar(vivas, market.slug, resumen);
        resumen.mercados.push({ slug: market.slug, motivo: "cerca_del_cierre" });
        continue;
      }

      if (!params) {
        atadoUsd -= await this.retirarYLiberar(vivas, market.slug, resumen);
        resumen.mercados.push({ slug: market.slug, motivo: "sin_programa_de_recompensas" });
        continue;
      }

      if (!libro) {
        resumen.mercados.push({ slug: market.slug, motivo: "sin_punto_medio" });
        continue;
      }
      const mid = (libro.bids[0]!.price + libro.asks[0]!.price) / 2;

      const parametros = { minSize: params.minSize, maxSpreadCents: params.maxSpreadCents };
      const { qRivalBid, qRivalAsk } = this.competencia(libro, mid, parametros, vivas);

      const ficha: FichaCompetencia = {
        poolDiaUsd: params.ratePerDay,
        qRivalBid,
        qRivalAsk,
        mid,
        tickSize: Number(market.tickSize),
        params: parametros,
        enMs: nowMs,
      };
      this.fichas.set(market.slug, ficha);
      candidatos.push({
        ...ficha,
        slug: market.slug,
        market,
        vivas,
        fresco: true,
        esTitular: vivas.length > 0,
      });
    }

    // Los que no tocaban esta vez compiten con su ultima ficha. Ordenar con un dato de hace un minuto
    // es barato y casi siempre correcto; COTIZAR con el no lo es, y por eso el ganador se relee abajo.
    const ttlFicha = this.config.ttlCompetenciaMs ?? TTL_COMPETENCIA_MS;
    for (const market of markets) {
      if (aSondear.has(market.slug)) {
        continue;
      }
      const ficha = this.fichas.get(market.slug);
      if (!ficha || nowMs - ficha.enMs > ttlFicha) {
        continue; // sin medida vigente no se puede ni ordenar; le tocara turno de sondeo
      }
      // `vivas` vacio no es un supuesto: todo mercado con rastro de una orden nuestra se sondea
      // siempre. Un mercado que no se sondea es un mercado donde no tenemos nada vivo.
      candidatos.push({ ...ficha, slug: market.slug, market, vivas: [], fresco: false, esTitular: false });
    }

    const gastadoGlobal = [...this.estados.values()].reduce((s, e) => s + e.gastadoUsd, 0);
    resumen.gastadoUsd = Number(gastadoGlobal.toFixed(4));
    resumen.paresUsd = this.paresUsd();

    // EL tope de verdad: lo atado en ordenes vivas MAS lo ya gastado en llenados. Contar solo lo
    // comprometido es lo que dejo que una ventana de 5 minutos gastara $85 con el tope en $12.
    //
    // El presupuesto de cada mercado sale de `atadoUsd`, que se mantiene al dia sobre la marcha, asi
    // que al planificar uno ya refleja lo que los anteriores han cancelado o colocado en ESTA pasada.
    // Su propio dinero atado NO se le descuenta: puede cancelarlo y reutilizarlo.

    const margen = this.config.margenRelevo ?? MARGEN_RELEVO;
    /** Elegidos cuya relectura dice que ahi ya no se puede cotizar. Salen del ranking, no del bucle. */
    const descartados = new Set<string>();
    const enJuego = () => candidatos.filter((c) => !descartados.has(c.slug));
    const rankear = (capital: number) =>
      elegirMercados(enJuego(), capital, this.config.ticksDelMedio, margen);

    let elegidos = rankear(this.config.capitalUsd);

    // UN ASPIRANTE CON FICHA RANCIA NO PUEDE DESBANCAR A QUIEN YA COTIZA.
    //
    // El titular se mide fresco en cada pasada —tiene dinero puesto, se le mira siempre—, mientras que
    // los demas compiten con una ficha de hasta dos minutos. Esa asimetria empuja sistematicamente a
    // mudarse: a quien se le tomo la ficha en un buen momento sigue compitiendo con ESE numero aunque
    // desde entonces se le haya llenado de competencia, contra un titular que compite con el suyo
    // honesto y actual.
    //
    // Medido sobre 3,5 h de produccion: 6 mudanzas/hora, 16 de 21 decididas por el ranking, muchas
    // hacia mercados de menos valor. Y reproducido en banco: con la ficha del aspirante tomada 20 s
    // antes, el maker se mudaba a un mercado que en ese instante era PEOR.
    //
    // La relectura que ya habia corregia el PRECIO antes de colocar, pero no la DECISION, que estaba
    // tomada con el dato viejo. Asi que cuando el ganador es rancio Y hay un titular al que desbancar,
    // se relee y se vuelve a decidir con todos frescos. No cuesta una pasada de retraso: cuesta las
    // lecturas de los elegidos, que son uno o dos.
    const hayTitularDesbancado = () =>
      candidatos.some((c) => c.vivas.length > 0 && !elegidos.some((e) => e.slug === c.slug));
    const ganadorRancio = () =>
      elegidos.some((e) => enJuego().find((c) => c.slug === e.slug)?.fresco === false);

    if (ganadorRancio() && hayTitularDesbancado()) {
      for (const elegido of elegidos) {
        const candidato = candidatos.find((c) => c.slug === elegido.slug);
        if (!candidato || candidato.fresco) {
          continue;
        }
        const refresco = await this.refrescarCandidato(candidato, nowMs, resumen);
        atadoUsd += refresco.atadoUsd;
        if (!refresco.ok) {
          descartados.add(candidato.slug);
        }
      }
      elegidos = rankear(this.config.capitalUsd);
    }

    const elegidosPorSlug = new Set(elegidos.map((e) => e.slug));

    // Cuanto vale CADA candidato ahora mismo, no solo el ganador.
    //
    // Sin esto el log registraba el mercado al que se muda y nada del que abandona, asi que desde
    // fuera no habia forma de juzgar si la mudanza estaba justificada: hubo que reproducirla en un
    // banco de pruebas para entenderla. Es un reparto sin tope, o sea la evaluacion pura.
    const evaluados = new Map(
      rankear(Number.POSITIVE_INFINITY).map((e) => [e.slug, e.esperadoUsdDia] as const),
    );
    let sinFinanciar = 0;
    /** El descartado mas BARATO cuando no se financia ninguno: dice cuanto capital falta. */
    let faltaCapital: { slug: string; costeUsd: number; cuantos: number } | undefined;

    // PRIMERO se suelta TODO lo descartado, y solo DESPUES se reparte. El orden no es un detalle de
    // estilo: en un solo recorrido, el presupuesto del ganador depende de si el mercado al que releva
    // aparecia antes o despues que el en la lista. Observado en el banco de ensayo — el titular
    // cancelado y el ganador con `capital_insuficiente_necesita_19.80` en la MISMA pasada, dejando al
    // maker sin cotizar en ningun sitio con el tope entero libre. En dos fases no puede pasar.
    for (const candidato of candidatos) {
      if (elegidosPorSlug.has(candidato.slug)) {
        continue;
      }
      // Un mercado que no entra en el presupuesto no se queda con ordenes puestas: inmovilizarian
      // dinero que otro mercado esta rindiendo mejor. Y su dinero vuelve al bote EN ESTA PASADA.
      atadoUsd -= await this.retirarYLiberar(candidato.vivas, candidato.slug, resumen);
      // Se distinguen dos situaciones que antes compartian mensaje, y esa ambiguedad me tuvo
      // persiguiendo un fantasma: si NO se financio ninguno, el problema es que el tope no da para
      // el minimo a los precios de ahora — decir "el capital se fue a otro mercado" es falso y
      // manda a mirar donde no es.
      const coste = candidato.params.minSize; // el par cuesta ~$1 por participacion
      if (candidato.vivas.length > 0) {
        // Quien PIERDE el capital se nombra siempre, y con lo que vale AHORA. Es la unica forma de
        // juzgar una mudanza desde el log: con solo el ganador anotado, el valor del saliente que
        // quedaba en el historial era el de su ultima pasada con movimiento, a veces de hace media
        // hora, y comparar contra eso no dice nada.
        resumen.mercados.push({
          slug: candidato.slug,
          motivo: elegidos.length > 0 ? "relevado" : "retirado_sin_relevo",
          esperadoUsdDia: evaluados.get(candidato.slug),
        });
      } else if (elegidos.length === 0) {
        // Se resume en UNA linea con la entrada mas barata de todas, que es el dato accionable:
        // "cuanto capital hace falta para poder cotizar en algun sitio". Una linea por candidato
        // eran 25 lineas identicas por pasada desde que el escaner propone 25.
        faltaCapital =
          faltaCapital && faltaCapital.costeUsd <= coste
            ? { ...faltaCapital, cuantos: faltaCapital.cuantos + 1 }
            : { slug: candidato.slug, costeUsd: coste, cuantos: (faltaCapital?.cuantos ?? 0) + 1 };
      } else {
        // Con el escaner mirando 25 mercados y capital para uno, listarlos todos escribia 24 lineas
        // identicas por pasada. Se cuentan y ya: saber CUAL de los descartados es cual no aporta
        // nada, y el ruido tapa lo que si importa.
        sinFinanciar += 1;
      }
    }

    // El reparto va en ORDEN DE RANKING, que es el orden en el que `elegirMercados` repartio el
    // capital. Recorrer el array de candidatos daba un orden distinto al que se uso para decidir.
    for (const elegido of elegidos) {
      const candidato = candidatos.find((c) => c.slug === elegido.slug);
      if (!candidato) {
        continue;
      }

      // Un elegido que no se sondeo esta pasada se RELEE antes de cotizar. La ficha vale para ordenar
      // y no para colocar: la banda que puntua son 1,5-4,5 centavos, asi que con un medio de hace un
      // minuto las dos ordenes pueden nacer fuera, sin cobrar y con el dinero igualmente inmovilizado.
      if (!candidato.fresco) {
        const refresco = await this.refrescarCandidato(candidato, nowMs, resumen);
        atadoUsd += refresco.atadoUsd;
        if (!refresco.ok) {
          resumen.mercados.push({ slug: candidato.slug, motivo: "sin_lectura_para_cotizar" });
          continue;
        }
      }

      const estado = this.estado(candidato.slug);
      const comprometidoPropio = candidato.vivas.reduce((s, o) => s + o.price * o.size, 0);
      const plan = planificarDosLados({
        mid: candidato.mid,
        tickSize: candidato.tickSize,
        capitalDisponibleUsd: Math.max(
          0,
          this.config.capitalUsd - gastadoGlobal - (atadoUsd - comprometidoPropio),
        ),
        params: candidato.params,
        vivas: candidato.vivas,
        inventario: estado.inventario,
        ultimaRecolocacionMs: estado.ultimaRecolocacionMs,
        minMsEntreRecolocaciones: this.config.minMsEntreRecolocaciones ?? MIN_MS_ENTRE_RECOLOCACIONES,
        ticksDelMedio: this.config.ticksDelMedio,
        nowMs,
      });

      atadoUsd -= await this.retirarYLiberar(plan.cancelar, candidato.slug, resumen);
      if (plan.colocar.length > 0) {
        estado.ultimaRecolocacionMs = nowMs;
      }
      const conservadas = candidato.vivas.filter((o) => !plan.cancelar.includes(o));
      const puestas: Array<{ id: string; outcome: Outcome; price: number; size: number }> = [];
      /** Solo lo COLOCADO en esta pasada: es lo unico que se puede deshacer del recuento. */
      let nuevoUsd = 0;
      let falloAlguna = false;
      for (const orden of plan.colocar) {
        const id = await this.deps.engine.colocar(candidato.market, orden);
        if (!id) {
          falloAlguna = true;
          continue;
        }
        resumen.colocadas += 1;
        const coste = orden.price * orden.size;
        resumen.comprometidoUsd += coste;
        nuevoUsd += coste;
        atadoUsd += coste;
        puestas.push({ id, outcome: orden.outcome, price: orden.price, size: orden.size });
        this.cotizados.set(candidato.slug, candidato.market);
        // Se apunta AQUI, no al verla viva en la pasada siguiente. Una orden colocada y llenada
        // entre dos pasadas no llegaria nunca a `ordenesVivas`, y su llenado —el mas rapido, o sea
        // el mas adverso— seria invisible para el detector y para el tope de gasto.
        this.tamanoConocido.set(`${candidato.slug}|${id}`, orden.size);
        this.datosOrden.set(`${candidato.slug}|${id}`, { price: orden.price, outcome: orden.outcome });
      }

      // ATOMICIDAD: dos lados o ninguno, tambien cuando el exchange rechaza uno.
      //
      // Sin esto, que la segunda orden fuera rechazada —tamano por debajo del minimo del exchange, un
      // 429, una carrera del libro— dejaba la primera VIVA y con dinero real: exactamente el estado de
      // un solo lado que costo $41,41 en 40 minutos. Y no se arregla solo, porque si el rechazo es
      // permanente la pasada siguiente vuelve a fallar igual.
      const queriamos = new Set([...conservadas, ...plan.colocar].map((o) => o.outcome));
      const tenemos = new Set([...conservadas.map((o) => o.outcome), ...puestas.map((o) => o.outcome)]);
      if (falloAlguna && queriamos.size === 2 && tenemos.size === 1) {
        const aRetirar = [...conservadas, ...puestas];
        logger.warn("Maker: el exchange rechazo un lado; se retira el otro para no quedar direccional.", {
          slug: candidato.slug,
          ladoQueQuedaba: [...tenemos][0],
          retiradas: aRetirar.length,
        });
        atadoUsd -= await this.retirarYLiberar(aRetirar, candidato.slug, resumen);
        // Se deshace SOLO lo colocado en esta pasada. Restar tambien lo conservado dejaba el recuento
        // en negativo —medido: -$24,50 con una sola orden conservada de $24,50—, porque ese dinero
        // nunca llego a sumarse aqui: `comprometidoUsd` cuenta colocaciones, no ordenes vivas.
        resumen.comprometidoUsd -= nuevoUsd;
        resumen.colocadas -= puestas.length;
      }
      resumen.mercados.push({
        slug: candidato.slug,
        motivo: plan.motivo,
        esperadoUsdDia: elegido?.esperadoUsdDia,
      });
    }

    if (faltaCapital) {
      resumen.mercados.push({
        slug:
          faltaCapital.cuantos > 1
            ? `${faltaCapital.slug} (+${faltaCapital.cuantos - 1} mas)`
            : faltaCapital.slug,
        motivo: `capital_insuficiente_necesita_${faltaCapital.costeUsd.toFixed(2)}`,
      });
    }

    if (sinFinanciar > 0) {
      resumen.mercados.push({ slug: `(+${sinFinanciar} sin financiar)`, motivo: "capital_dedicado_a_otro_mercado" });
    }


    // Las fichas caducadas se tiran: ya no sirven para ordenar, y guardarlas seria acumular una entrada
    // por cada mercado que ha pasado alguna vez por el escaner —miles al cabo de un dia— sin que
    // ninguna vuelva a leerse. Un mercado sin ficha vuelve a ser el primero en el turno de sondeo, que
    // es exactamente lo que se quiere de el.
    for (const [slug, ficha] of [...this.fichas]) {
      if (nowMs - ficha.enMs > ttlFicha) {
        this.fichas.delete(slug);
      }
    }

    // Se mide al FINAL, con las cancelaciones y colocaciones de esta pasada ya aplicadas. Medirlo al
    // principio describia un estado que dejaba de ser cierto tres lineas despues, y quien lo lee es el
    // suelo de patrimonio: equivocarse por abajo ahi para el maker en operacion normal.
    resumen.vivoUsd = Number(atadoUsd.toFixed(4));

    this.dejarConstancia(resumen, candidatos.length, nowMs);
    return resumen;
  }

  /**
   * Deja constancia de la pasada: siempre que haya movimiento, y cada `INTERVALO_LATIDO_MS` si no lo hay.
   *
   * El log solo hablaba cuando algo cambiaba. Con el maker parado en su mejor mercado —que es el
   * objetivo— eso son horas de silencio indistinguibles de las de un maker que no encuentra donde
   * entrar. Medido el 2026-08-21: ocho minutos sin una linea, y hubo que preguntarle a la API para
   * saber que estaba sano.
   *
   * El latido dice DONDE se esta cotizando y, cuando no se cotiza en ningun sitio, POR QUE: el
   * recuento de motivos de la pasada. Sin el "por que" el latido solo cambia el silencio por ruido.
   */
  private dejarConstancia(resumen: ResumenPasada, candidatos: number, nowMs: number): void {
    if (resumen.colocadas > 0 || resumen.canceladas > 0) {
      logger.info("Maker: ordenes actualizadas.", resumen);
      // El latido se reprograma: acaba de quedar constancia, y dos lineas seguidas no aportan nada.
      this.ultimoLatidoMs = nowMs;
      return;
    }

    const cotizandoEn = this.slugsConOrdenes();
    // Se cuenta desde que se quedo mudo, no desde el ultimo latido: si no, el reloj se reiniciaria
    // cada cinco minutos y nunca llegaria al cuarto de hora que dispara el aviso.
    this.sinCotizarDesdeMs = cotizandoEn.length > 0 ? undefined : (this.sinCotizarDesdeMs ?? nowMs);

    if (nowMs - this.ultimoLatidoMs < (this.config.intervaloLatidoMs ?? INTERVALO_LATIDO_MS)) {
      return;
    }
    this.ultimoLatidoMs = nowMs;

    const mudoMinutos =
      this.sinCotizarDesdeMs === undefined ? 0 : Math.round((nowMs - this.sinCotizarDesdeMs) / 60_000);
    // `porQueNo` solo si hay algo que explicar. Recien arrancado no hay ni candidatos —el escaner tarda
    // en traer el registro— y salia un `"porQueNo":{}` vacio que parece un fallo y no dice nada: con
    // `candidatos: 0` delante, la explicacion ya esta dada.
    const porQueNo = cotizandoEn.length === 0 ? recuentoDeMotivos(resumen.mercados) : {};
    const meta = {
      cotizandoEn: cotizandoEn.length,
      mercados: cotizandoEn.slice(0, 3),
      vivoUsd: resumen.vivoUsd,
      gastadoUsd: resumen.gastadoUsd,
      paresUsd: resumen.paresUsd,
      candidatos,
      ...(cotizandoEn.length === 0 ? { mudoMinutos } : {}),
      ...(Object.keys(porQueNo).length > 0 ? { porQueNo } : {}),
    };

    if (cotizandoEn.length === 0 && mudoMinutos >= MINUTOS_MUDO_PARA_AVISAR) {
      logger.warn("Maker: sin cotizar en ningun sitio.", meta);
      return;
    }
    logger.info("Maker: latido.", meta);
  }

  /**
   * Relee un candidato y le pone la ficha al dia. Devuelve los dolares atados que descubre al hacerlo.
   *
   * `ok: false` significa "aqui no se puede cotizar ahora": cerca del cierre, sin programa, sin libro o
   * sin respuesta. Quien llama decide si eso es saltarselo o rehacer el ranking sin el.
   */
  private async refrescarCandidato(
    candidato: CandidatoMercado & { market: MercadoMaker; vivas: OrdenViva[]; fresco: boolean },
    nowMs: number,
    resumen: ResumenPasada,
  ): Promise<{ ok: boolean; atadoUsd: number }> {
    const releido = await this.inspeccionar(candidato.market, nowMs);
    if (!releido || releido.cerca || !releido.params || !releido.libro) {
      return { ok: false, atadoUsd: 0 };
    }
    const { vivas, params, libro } = releido;
    this.detectarLlenados(candidato.market, vivas, resumen);
    const mid = (libro.bids[0]!.price + libro.asks[0]!.price) / 2;
    const parametros = { minSize: params.minSize, maxSpreadCents: params.maxSpreadCents };
    const rivales = this.competencia(libro, mid, parametros, vivas);
    this.fichas.set(candidato.slug, {
      poolDiaUsd: params.ratePerDay,
      qRivalBid: rivales.qRivalBid,
      qRivalAsk: rivales.qRivalAsk,
      mid,
      tickSize: Number(candidato.market.tickSize),
      params: parametros,
      enMs: nowMs,
    });
    candidato.poolDiaUsd = params.ratePerDay;
    candidato.qRivalBid = rivales.qRivalBid;
    candidato.qRivalAsk = rivales.qRivalAsk;
    candidato.mid = mid;
    candidato.params = parametros;
    candidato.vivas = vivas;
    candidato.fresco = true;
    return { ok: true, atadoUsd: vivas.reduce((suma, o) => suma + o.price * o.size, 0) };
  }

  /** Los mercados en los que creemos tener alguna orden viva. Ver `detectarLlenados` para el rastro. */
  private slugsConOrdenes(): string[] {
    const slugs = new Set<string>();
    for (const clave of this.tamanoConocido.keys()) {
      const corte = clave.lastIndexOf("|");
      if (corte > 0) {
        slugs.add(clave.slice(0, corte));
      }
    }
    return [...slugs];
  }

  /**
   * Valor garantizado de los pares completos que se tienen ahora mismo, a $1 el par.
   *
   * Se lee del estado del bucle y no del ultimo resumen a proposito: una guarda que se apoye en el
   * resumen se queda enganchada, porque el resumen de una pasada detenida trae ceros y la pasada
   * siguiente creeria que no hay patrimonio.
   */
  paresUsd(): number {
    return Number(
      [...this.estados.values()]
        .reduce((suma, e) => suma + Math.min(e.inventario.UP, e.inventario.DOWN), 0)
        .toFixed(4),
    );
  }

  /** `true` si creemos que sigue viva alguna orden nuestra ahi. Ver `detectarLlenados` para el rastro. */
  private tieneRastroDeOrdenes(slug: string): boolean {
    const prefijo = `${slug}|`;
    for (const clave of this.tamanoConocido.keys()) {
      if (clave.startsWith(prefijo)) {
        return true;
      }
    }
    return false;
  }

  /** Solo para pruebas y diagnostico: cuanto se lleva gastado y en que lado esta el inventario. */
  estadoDe(slug: string): { gastadoUsd: number; inventario: Inventario } | undefined {
    const e = this.estados.get(slug);
    return e ? { gastadoUsd: e.gastadoUsd, inventario: { ...e.inventario } } : undefined;
  }
}

/**
 * Recuento de motivos de una pasada, para que el latido quepa en una linea.
 *
 * Se le quita el importe al motivo (`capital_insuficiente_necesita_19.80` -> `capital_insuficiente_necesita`)
 * porque cambia en cada pasada y con el se convertiria en una lista en vez de un recuento.
 */
function recuentoDeMotivos(mercados: ResumenPasada["mercados"]): Record<string, number> {
  const cuenta: Record<string, number> = {};
  for (const mercado of mercados) {
    if (!mercado.motivo) {
      continue;
    }
    const clave = mercado.motivo.replace(/_[0-9.]+$/, "");
    cuenta[clave] = (cuenta[clave] ?? 0) + 1;
  }
  return cuenta;
}

/** Reexportado para que los consumidores no tengan que conocer `makerQuoting`. */
export { medioContrario };

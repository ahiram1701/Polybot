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
import type { RewardParamsReader } from "./rewardParams.js";
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
  /**
   * Intervalo minimo entre recolocaciones en el mismo mercado.
   *
   * Sin esto el ritmo medido en simulacion fue de ~1.400 recolocaciones/hora: la banda que puntua
   * (1,5 centavos) es mas estrecha que lo que se mueve el precio, asi que la orden se sale una y otra
   * vez. El coste no es perder turno en la cola —para recompensas eso no cuenta— sino los limites de
   * peticiones del exchange.
   */
  minMsEntreRecolocaciones?: number;
}

export interface ResumenPasada {
  colocadas: number;
  canceladas: number;
  comprometidoUsd: number;
  /** Dolares ya GASTADOS en llenados y todavia atados a posiciones sin resolver. */
  gastadoUsd: number;
  /** Participaciones que se llenaron desde la pasada anterior. Cada una es posicion direccional. */
  llenadas?: number;
  mercados: Array<{ slug: string; motivo?: string; esperadoUsdDia?: number }>;
}

/** 15 s: recorta el ritmo ~10 veces y sigue reaccionando dentro de una ventana de 5 minutos. */
const MIN_MS_ENTRE_RECOLOCACIONES = 15_000;

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
    let canceladas = 0;
    for (const market of markets) {
      try {
        const vivas = await this.deps.engine.ordenesVivas(market);
        canceladas += await this.cancelar(vivas.map((o) => o.id), market.slug);
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
    return canceladas;
  }

  /**
   * Cancela y ADEMAS olvida la orden.
   *
   * Sin este olvido, la orden desaparecida se contaria como llenada en la pasada siguiente: el gasto
   * acumulado se dispararia solo y el tope dejaria al maker mudo sin que nadie hubiera comprado nada.
   */
  private async cancelar(ids: string[], slug: string): Promise<number> {
    for (const id of ids) {
      this.tamanoConocido.delete(`${slug}|${id}`);
      this.datosOrden.delete(`${slug}|${id}`);
    }
    return this.deps.engine.cancelar(ids);
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
    // Los mercados que ya no estan tenian su ventana cerrada: sus posiciones resolvieron y el dinero
    // volvio, asi que su gasto deja de contar contra el tope.
    const vigentes = new Set(markets.map((m) => m.slug));
    for (const slug of [...this.estados.keys()]) {
      if (!vigentes.has(slug)) {
        this.estados.delete(slug);
      }
    }

    const resumen: ResumenPasada = {
      colocadas: 0,
      canceladas: 0,
      comprometidoUsd: 0,
      gastadoUsd: 0,
      mercados: [],
    };
    const candidatos: Array<CandidatoMercado & { market: MercadoMaker; vivas: OrdenViva[] }> = [];
    let comprometidoGlobal = 0;

    // La LECTURA de los mercados va en paralelo; la DECISION, en serie.
    //
    // Leer en serie costaba 28 segundos por pasada —tres peticiones por mercado con timeout de 2 s— y
    // bloqueaba el bucle entero hasta que el watchdog reiniciaba el proceso. Nada de esto se escribe,
    // asi que paralelizarlo es seguro; lo que si tiene que seguir en orden es repartir el capital,
    // porque cada mercado consume del mismo presupuesto que el anterior.
    const leidos = await Promise.all(
      markets.map(async (market) => {
        const vivas = await this.deps.engine.ordenesVivas(market);
        const cerca = secondsToEnd(market.endMs, nowMs) <= this.config.retirarSegundosAntesDelCierre;
        if (cerca) {
          return { market, vivas, cerca, params: undefined, libro: undefined };
        }
        const params = await this.deps.rewards.paraMercado(market.conditionId, market.slug);
        const libro = params ? await this.libroFusionado(market) : undefined;
        return { market, vivas, cerca, params, libro };
      }),
    );

    for (const { market, vivas, cerca, params, libro } of leidos) {
      this.detectarLlenados(market, vivas, resumen);

      // Cerca del cierre no se cotiza y se retira lo que haya: una orden llena aqui deja una posicion
      // que resuelve en segundos y no da tiempo a deshacerla.
      if (cerca) {
        resumen.canceladas += await this.cancelar(vivas.map((o) => o.id), market.slug);
        resumen.mercados.push({ slug: market.slug, motivo: "cerca_del_cierre" });
        continue;
      }

      if (!params) {
        resumen.canceladas += await this.cancelar(vivas.map((o) => o.id), market.slug);
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
      comprometidoGlobal += vivas.reduce((s, o) => s + o.price * o.size, 0);

      candidatos.push({
        slug: market.slug,
        poolDiaUsd: params.ratePerDay,
        qRivalBid,
        qRivalAsk,
        mid,
        tickSize: Number(market.tickSize),
        params: parametros,
        market,
        vivas,
      });
    }

    const gastadoGlobal = [...this.estados.values()].reduce((s, e) => s + e.gastadoUsd, 0);
    resumen.gastadoUsd = Number(gastadoGlobal.toFixed(4));

    // EL tope de verdad: lo comprometido en ordenes vivas MAS lo ya gastado en llenados. Contar solo
    // lo comprometido es lo que dejo que una ventana de 5 minutos gastara $85 con el tope en $12.
    //
    // `usado` crece con lo que queda inmovilizado en cada mercado YA planificado; `porPlanificar`
    // guarda lo que siguen inmovilizando los que faltan. Asi, al planificar un mercado, su propio
    // dinero comprometido NO se le descuenta: puede cancelar y reutilizarlo. Descontarselo cancelaba
    // sus ordenes y no colocaba nada — quedandose sin cotizar por falta de un capital que ya era suyo.
    let usado = gastadoGlobal;
    let porPlanificar = comprometidoGlobal;

    const elegidos = elegirMercados(candidatos, this.config.capitalUsd);
    const elegidosPorSlug = new Set(elegidos.map((e) => e.slug));
    let sinFinanciar = 0;

    for (const candidato of candidatos) {
      const elegido = elegidos.find((e) => e.slug === candidato.slug);
      // Un mercado que no entra en el presupuesto no se queda con ordenes puestas: inmovilizarian
      // dinero que otro mercado esta rindiendo mejor.
      if (!elegidosPorSlug.has(candidato.slug)) {
        resumen.canceladas += await this.cancelar(candidato.vivas.map((o) => o.id), candidato.slug);
        // Se distinguen dos situaciones que antes compartian mensaje, y esa ambiguedad me tuvo
        // persiguiendo un fantasma: si NO se financio ninguno, el problema es que el tope no da para
        // el minimo a los precios de ahora — decir "el capital se fue a otro mercado" es falso y
        // manda a mirar donde no es.
        const coste = candidato.params.minSize; // el par cuesta ~$1 por participacion
        if (elegidos.length === 0) {
          resumen.mercados.push({
            slug: candidato.slug,
            motivo: `capital_insuficiente_necesita_${coste.toFixed(2)}`,
          });
        } else {
          // Con el escaner mirando 25 mercados y capital para uno, listarlos todos escribia 24 lineas
          // identicas por pasada. Se cuentan y ya: saber CUAL de los descartados es cual no aporta
          // nada, y el ruido tapa lo que si importa.
          sinFinanciar += 1;
        }
        continue;
      }

      const estado = this.estado(candidato.slug);
      const comprometidoPropio = candidato.vivas.reduce((s, o) => s + o.price * o.size, 0);
      porPlanificar -= comprometidoPropio;
      const plan = planificarDosLados({
        mid: candidato.mid,
        tickSize: candidato.tickSize,
        capitalDisponibleUsd: Math.max(0, this.config.capitalUsd - usado - porPlanificar),
        params: candidato.params,
        vivas: candidato.vivas,
        inventario: estado.inventario,
        ultimaRecolocacionMs: estado.ultimaRecolocacionMs,
        minMsEntreRecolocaciones: this.config.minMsEntreRecolocaciones ?? MIN_MS_ENTRE_RECOLOCACIONES,
        nowMs,
      });

      resumen.canceladas += await this.cancelar(plan.cancelar.map((o) => o.id), candidato.slug);
      if (plan.colocar.length > 0) {
        estado.ultimaRecolocacionMs = nowMs;
      }
      let comprometidoTrasPlan = candidato.vivas
        .filter((o) => !plan.cancelar.includes(o))
        .reduce((s, o) => s + o.price * o.size, 0);
      for (const orden of plan.colocar) {
        const id = await this.deps.engine.colocar(candidato.market, orden);
        if (id) {
          resumen.colocadas += 1;
          const coste = orden.price * orden.size;
          resumen.comprometidoUsd += coste;
          comprometidoTrasPlan += coste;
          // Se apunta AQUI, no al verla viva en la pasada siguiente. Una orden colocada y llenada
          // entre dos pasadas no llegaria nunca a `ordenesVivas`, y su llenado —el mas rapido, o sea
          // el mas adverso— seria invisible para el detector y para el tope de gasto.
          this.tamanoConocido.set(`${candidato.slug}|${id}`, orden.size);
          this.datosOrden.set(`${candidato.slug}|${id}`, { price: orden.price, outcome: orden.outcome });
        }
      }
      usado += comprometidoTrasPlan;
      resumen.mercados.push({
        slug: candidato.slug,
        motivo: plan.motivo,
        esperadoUsdDia: elegido?.esperadoUsdDia,
      });
    }

    if (sinFinanciar > 0) {
      resumen.mercados.push({ slug: `(+${sinFinanciar} sin financiar)`, motivo: "capital_dedicado_a_otro_mercado" });
    }

    if (resumen.colocadas > 0 || resumen.canceladas > 0) {
      logger.info("Maker: ordenes actualizadas.", resumen);
    }
    return resumen;
  }

  /** Solo para pruebas y diagnostico: cuanto se lleva gastado y en que lado esta el inventario. */
  estadoDe(slug: string): { gastadoUsd: number; inventario: Inventario } | undefined {
    const e = this.estados.get(slug);
    return e ? { gastadoUsd: e.gastadoUsd, inventario: { ...e.inventario } } : undefined;
  }
}

/** Reexportado para que los consumidores no tengan que conocer `makerQuoting`. */
export { medioContrario };

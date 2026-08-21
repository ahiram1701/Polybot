/**
 * Busca EN TODO Polymarket los mercados de recompensa que caben en el capital disponible.
 *
 * Hasta ahora el maker solo miraba BTC/ETH/DOGE de 5 minutos porque era lo que el bot ya seguía, no
 * porque fueran buenos. Medido sobre el registro completo (15.000 mercados con programa activo), son de
 * los PEORES sitios posibles para un capital pequeno:
 *
 * | | cripto 5m | lo mejor que hay |
 * |---|---|---|
 * | `rewards_min_size` | 50 -> entrada ~$50 | **20 -> entrada ~$20** |
 * | `rewards_max_spread` | 1,5c | **4,5c** |
 * | duracion | 5 minutos | de un dia a meses |
 *
 * Las tres cosas importan y la segunda es la que mas: con banda de 1,5 centavos y tick de 1 centavo, una
 * orden a un tick del medio puntua `((1,5-1)/1,5)^2` = **11%** del maximo; con banda de 4,5 puntua
 * `((4,5-1)/4,5)^2` = **60%**. Cinco veces mas por exactamente la misma orden.
 *
 * Y la duracion decide el riesgo: en una ventana de 5 minutos el precio se desploma a 0 o 1 cada cinco
 * minutos, que es como el maker perdio $41,41 en 40 minutos. En un mercado que resuelve en diciembre, un
 * llenado no resuelve en segundos — da tiempo a deshacerlo.
 *
 * ## Por que en dos etapas
 *
 * Son 15.000 mercados: leer el libro de todos es imposible. Asi que primero se criba por lo que el
 * registro ya dice (bote, banda, tamano minimo, si cabe en el capital) y solo se resuelven los mejores.
 * La competencia —que es la mitad de la respuesta— la mide despues `MakerLoop` sobre esos pocos.
 */
import { logger } from "./logger.js";
import type { MercadoMaker } from "./makerMarket.js";
import { normalizar } from "./rewardParams.js";
import type { RecompensaMercado } from "./rewardParams.js";

/** Un mercado que paga, ya resuelto a lo que el maker necesita para cotizarlo. */
export interface CandidatoRecompensa {
  mercado: MercadoMaker;
  params: RecompensaMercado;
  /**
   * Lo que cuesta la cotizacion minima que califica.
   *
   * Es `minSize` dolares con muy buena aproximacion, y la razon es bonita: un par cuesta
   * `precio(UP) + precio(DOWN)`, que suma $1 por construccion. Da igual que el mercado este a 0,05 o a
   * 0,50 — **no existe una banda de precio barata**. Por eso $12 no podia calificar en ningun sitio.
   */
  costeEntradaUsd: number;
}

/** Cada cuanto se relee el registro entero. Es caro (~30 peticiones) y cambia despacio. */
const TTL_REGISTRO_MS = 10 * 60_000;

/** Tope de paginas, por si el cursor del exchange dejara de terminar. */
const MAX_PAGINAS = 60;

/** Cuantos de los mejores se resuelven a mercado completo. Cada uno cuesta una peticion. */
const A_RESOLVER = 25;

/**
 * Cada cuanto se rehace la lista de candidatos ya resueltos.
 *
 * Resolver 25 mercados son 25 peticiones, y el bucle pasa cada 3 segundos: sin esta cache serian ~500
 * peticiones por minuto solo para mirar. Cinco minutos es de sobra — los mercados que dura un dia o mas
 * no aparecen ni desaparecen mas rapido, y `MakerLoop` ya se retira solo de los que van a cerrar.
 */
const TTL_CANDIDATOS_MS = 5 * 60_000;

interface FilaRegistro {
  condition_id?: string;
  rewards_min_size?: number;
  rewards_max_spread?: number;
  total_daily_rate?: number;
  rewards_config?: unknown;
}

export class RewardMarketScanner {
  private registro: FilaRegistro[] = [];
  private leidoEnMs = 0;
  private candidatos: { capitalUsd: number; valor: CandidatoRecompensa[]; enMs: number } | undefined;
  /** Recarga en vuelo, para no lanzar treinta peticiones por cada pasada del bucle. */
  private refrescando: Promise<void> | undefined;

  constructor(
    private readonly clobHost: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /**
   * El registro que haya AHORA, y si esta caducado se pide otro por detras.
   *
   * Nunca espera. Leerlo son ~30 peticiones encadenadas para 16.000 mercados, y esperarlas dentro del
   * bucle costo una iteracion de **84 segundos** en el primer arranque: el bot entero parado mirando
   * una lista que no cambia en diez minutos. La primera vez devuelve vacio y el maker no cotiza esa
   * pasada; tres segundos despues ya hay datos.
   */
  private registroActual(): FilaRegistro[] {
    const caducado = Date.now() - this.leidoEnMs >= TTL_REGISTRO_MS;
    if (caducado && !this.refrescando) {
      this.refrescando = this.recargar()
        .catch((error: unknown) => {
          logger.warn("No se pudo releer el registro de recompensas.", {
            error: error instanceof Error ? error.message : String(error),
          });
        })
        .finally(() => {
          this.refrescando = undefined;
        });
    }
    return this.registro;
  }

  /** El registro entero, paginado. Corre SIEMPRE fuera del camino del bucle. */
  private async recargar(): Promise<void> {
    const filas: FilaRegistro[] = [];
    let cursor = "";
    for (let pagina = 0; pagina < MAX_PAGINAS; pagina += 1) {
      const url = cursor
        ? `${this.clobHost}/rewards/markets/current?next_cursor=${encodeURIComponent(cursor)}`
        : `${this.clobHost}/rewards/markets/current`;
      const respuesta = await this.fetchImpl(url);
      const cuerpo = (await respuesta.json()) as { data?: FilaRegistro[]; next_cursor?: string };
      filas.push(...(cuerpo.data ?? []));
      cursor = cuerpo.next_cursor ?? "";
      // `LTE=` es como el exchange dice "no hay mas": es "-1" en base64.
      if (!cursor || cursor === "LTE=") {
        break;
      }
    }
    this.registro = filas;
    this.leidoEnMs = Date.now();
    logger.info("Registro de recompensas leido.", { mercados: filas.length });
  }

  /**
   * Espera a que haya registro. Para el arranque y para las pruebas.
   *
   * En produccion se lanza SIN esperar: el bucle no debe quedarse mirando treinta peticiones. Quien
   * quiera la garantia de tener datos —un test, una sonda— llama a esto.
   */
  async precargar(): Promise<void> {
    this.registroActual();
    await this.refrescando;
  }

  /**
   * Los mercados que MEJOR rinden por dolar y que caben en `capitalUsd`.
   *
   * El orden es por `bote diario / coste de entrada`. NO tiene en cuenta la competencia —eso exigiria
   * leer 15.000 libros—, asi que es una CRIBA, no un veredicto: `MakerLoop` mide la competencia real
   * sobre los que salgan de aqui y puede descartarlos.
   *
   * Y es una criba MALA, cosa que conviene tener presente: medida contra el rendimiento real, su
   * correlacion de Spearman es 0,007. Sirve para tirar 13.000 mercados que no caben o no pagan, no
   * para elegir entre los que quedan. Por eso `limite` tiene que ser generoso: cuanto mas ancha sea la
   * lista que llega a medirse la competencia, mejor el elegido.
   */
  async mejores(capitalUsd: number, limite = A_RESOLVER): Promise<CandidatoRecompensa[]> {
    const cache = this.candidatos;
    if (cache && cache.capitalUsd === capitalUsd && Date.now() - cache.enMs < TTL_CANDIDATOS_MS) {
      return cache.valor;
    }
    const filas = this.registroActual();
    if (filas.length === 0) {
      return []; // aun se esta leyendo por detras: no se cotiza esta pasada y ya esta
    }

    const cribados = filas
      .map((fila) => ({ fila, params: normalizar(fila as Record<string, unknown>) }))
      .filter((c): c is { fila: FilaRegistro; params: RecompensaMercado } => {
        if (!c.params || !c.fila.condition_id) {
          return false;
        }
        // Un bote de cero no paga, y una banda de cero no puntua NUNCA: hay 74 mercados con
        // `min_size: 0` y `max_spread: 0` que parecerian gratis y no dan un centimo.
        return c.params.ratePerDay > 0 && c.params.maxSpreadCents > 0 && c.params.minSize > 0;
      })
      .map((c) => ({ ...c, costeEntradaUsd: c.params.minSize }))
      .filter((c) => c.costeEntradaUsd <= capitalUsd)
      .sort((izq, der) => der.params.ratePerDay / der.costeEntradaUsd - izq.params.ratePerDay / izq.costeEntradaUsd);

    if (cribados.length === 0) {
      logger.warn("Ningun mercado de recompensa cabe en el capital.", {
        capitalUsd,
        // El suelo real, para que el mensaje diga cuanto falta en vez de solo "no cabe".
        entradaMasBarataUsd: Math.min(
          ...filas
            .map((f) => normalizar(f as Record<string, unknown>))
            .filter((p): p is RecompensaMercado => Boolean(p && p.ratePerDay > 0 && p.maxSpreadCents > 0 && p.minSize > 0))
            .map((p) => p.minSize),
        ),
      });
      return [];
    }

    // Cuantos resolver de verdad. TODOS los que quepan en `limite`, y esto costo aprenderlo dos veces.
    //
    // Antes se resolvian los que caben en el capital mas dos —con $20, TRES de 13.109—, con el
    // argumento de que si solo se puede financiar un mercado, evaluar 25 era trabajo tirado. El
    // argumento es exactamente al reves: financiar uno es justo lo que obliga a mirar muchos, porque
    // este orden NO SIRVE para elegirlo. Medido el 2026-08-21 sobre los 60 primeros:
    //
    //  - la correlacion de Spearman entre este puesto y el rendimiento real es **0,007**: ninguna;
    //  - hay **54 mercados practicamente empatados** por bote/dolar, asi que el corte en 3 es un sorteo;
    //  - el rendimiento real va de 10,2 a 0,004 dolares al dia por dolar — un factor 2.700.
    //
    // Valor esperado del mejor de k candidatos: k=3 -> 3,64; k=10 -> 6,61; k=20 -> 7,99; k=40 -> 9,05.
    // Pasar de 3 a 20 vale **2,2x**. Lo que decide de verdad es la competencia, y esa la mide
    // `MakerLoop` sobre los que salgan de aqui.
    //
    // Lo que hacia inasumible resolver 25 era que el bucle leia el libro de TODOS en cada pasada. Ya no:
    // sondea por turnos (`sondeosPorPasada`) y ordena con la ultima ficha de cada uno.
    const aResolver = limite;

    const resueltos: CandidatoRecompensa[] = [];
    for (const c of cribados) {
      if (resueltos.length >= aResolver) {
        break;
      }
      const mercado = await this.resolver(String(c.fila.condition_id));
      if (!mercado) {
        continue;
      }
      // Sin repetir slug. TODO el estado del maker —gasto, inventario, rastro de ordenes— esta indexado
      // por slug, asi que dos mercados distintos con el mismo slug se mezclarian: el gasto de uno
      // contaria contra el otro y el inventario de uno decidiria las ordenes del otro. No se ha
      // observado en el registro, pero el coste de blindarlo es esta linea y el de no hacerlo es un
      // fallo silencioso con dinero real. Se conserva el primero, que es el mejor clasificado.
      if (resueltos.some((r) => r.mercado.slug === mercado.slug)) {
        continue;
      }
      resueltos.push({ mercado, params: c.params, costeEntradaUsd: c.costeEntradaUsd });
    }
    this.candidatos = { capitalUsd, valor: resueltos, enMs: Date.now() };
    return resueltos;
  }

  /** Del `conditionId` al mercado con sus dos tokens. Descarta lo cerrado o sin par completo. */
  private async resolver(conditionId: string): Promise<MercadoMaker | undefined> {
    try {
      const respuesta = await this.fetchImpl(`${this.clobHost}/markets/${conditionId}`);
      const m = (await respuesta.json()) as {
        market_slug?: string;
        closed?: boolean;
        active?: boolean;
        accepting_orders?: boolean;
        end_date_iso?: string;
        minimum_tick_size?: number | string;
        neg_risk?: boolean;
        tokens?: Array<{ token_id?: string; outcome?: string }>;
      };
      if (m.closed || m.active === false || m.accepting_orders === false) {
        return undefined;
      }
      const tokens = (m.tokens ?? []).filter((t) => t.token_id);
      if (tokens.length !== 2) {
        return undefined; // el maker vive de que los dos lados sumen $1; sin par no hay estrategia
      }
      const finMs = m.end_date_iso ? Date.parse(m.end_date_iso) : Number.NaN;
      const ahora = Date.now();
      // Un ano por delante = "no se cuando cierra". `secondsToEnd` solo se usa para retirarse antes del
      // cierre, y lo que no sabemos cuando acaba no esta acabando.
      const horizonteDesconocido = ahora + 365 * 24 * 3_600_000;
      return {
        slug: String(m.market_slug ?? conditionId),
        conditionId,
        // `end_date_iso` NO es la hora de cierre: es la medianoche de la fecha nominal. Medido:
        // `highest-temperature-in-los-angeles-on-august-20-2026` la daba 9 horas en el PASADO mientras
        // seguia aceptando ordenes, y uno de Alaska 57 horas. Tomarla al pie de la letra marcaba
        // `cerca_del_cierre` a los mercados que MAS pagan y el maker no cotizaba en ninguno.
        //
        // Quien manda es `accepting_orders`, que ya se comprobo arriba y se vuelve a comprobar en cada
        // refresco del escaner. Una fecha pasada significa "no se cuando cierra", no "cierra ya".
        endMs: Number.isFinite(finMs) && finMs > ahora ? finMs : horizonteDesconocido,
        tickSize: String(m.minimum_tick_size ?? "0.01"),
        negRisk: Boolean(m.neg_risk),
        outcomes: {
          UP: { tokenId: String(tokens[0]!.token_id) },
          DOWN: { tokenId: String(tokens[1]!.token_id) },
        },
      };
    } catch (error) {
      logger.warn("No se pudo resolver un mercado de recompensa.", {
        conditionId,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }
}

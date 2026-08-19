/**
 * El bucle que mantiene ordenes en reposo cobrando recompensas de liquidez.
 *
 * Cada pasada: mira que mercados pagan, cuanto compite ya en la banda, elige donde cabe el capital, y
 * deja puestas las ordenes que puntuan. No predice nada — de eso va justamente este rediseno.
 *
 * Dos guardas que no son opcionales:
 *
 *  - **El capital es compartido.** Una orden de compra inmoviliza `precio x tamano` hasta que se llena
 *    o se cancela. Sin un tope comun, tres mercados simultaneos comprometerian el mismo dinero tres
 *    veces y el exchange rechazaria las dos ultimas — o peor, las aceptaria.
 *  - **Se retira antes del cierre.** Una orden llena cerca del final deja una posicion direccional que
 *    resuelve en segundos, sin margen para deshacerla. Se deja de cotizar con antelacion configurable.
 */
import { logger } from "./logger.js";
import type { MakerEngine } from "./makerEngine.js";
import { elegirMercados, planificarMaker } from "./makerQuoting.js";
import type { CandidatoMercado, OrdenViva } from "./makerQuoting.js";
import type { OrderbookService } from "./orderbookService.js";
import type { RewardParamsReader } from "./rewardParams.js";
import { secondsToEnd } from "./time.js";
import type { MarketInfo, Outcome } from "./types.js";

export interface MakerLoopDeps {
  orderbook: Pick<OrderbookService, "getQuote">;
  rewards: Pick<RewardParamsReader, "paraMercado">;
  engine: MakerEngine;
}

export interface MakerLoopConfig {
  /** Tope duro de dolares inmovilizados a la vez, en TODOS los mercados. */
  capitalUsd: number;
  /** Segundos antes del cierre en los que se deja de cotizar y se retira todo. */
  retirarSegundosAntesDelCierre: number;
  /** Ventanas de 5 min que hay en un dia: el bote diario se prorratea entre ellas. */
  ventanasPorDia?: number;
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
  mercados: Array<{ slug: string; motivo?: string; esperadoUsd?: number }>;
}

const VENTANAS_POR_DIA = 288;

/** 15 s: recorta el ritmo ~10 veces y sigue reaccionando dentro de una ventana de 5 minutos. */
const MIN_MS_ENTRE_RECOLOCACIONES = 15_000;

export class MakerLoop {
  /** Cuando se recoloco por ultima vez en cada mercado, para no martillear al exchange. */
  private readonly ultimaRecolocacion = new Map<string, number>();

  constructor(
    private readonly deps: MakerLoopDeps,
    private readonly config: MakerLoopConfig,
  ) {}

  async runOnce(markets: MarketInfo[], nowMs: number): Promise<ResumenPasada> {
    const resumen: ResumenPasada = { colocadas: 0, canceladas: 0, comprometidoUsd: 0, mercados: [] };
    const candidatos: Array<CandidatoMercado & { market: MarketInfo; vivas: OrdenViva[] }> = [];

    for (const market of markets) {
      const restantes = secondsToEnd(market.endMs, nowMs);
      const vivas = await this.deps.engine.ordenesVivas(market);

      // Cerca del cierre no se cotiza y se retira lo que haya: una orden llena aqui deja una posicion
      // que resuelve en segundos y no da tiempo a deshacerla.
      if (restantes <= this.config.retirarSegundosAntesDelCierre) {
        resumen.canceladas += await this.deps.engine.cancelar(vivas.map((o) => o.id));
        resumen.mercados.push({ slug: market.slug, motivo: "cerca_del_cierre" });
        continue;
      }

      const params = await this.deps.rewards.paraMercado(market.conditionId, market.slug);
      if (!params) {
        resumen.canceladas += await this.deps.engine.cancelar(vivas.map((o) => o.id));
        resumen.mercados.push({ slug: market.slug, motivo: "sin_programa_de_recompensas" });
        continue;
      }

      const quote = await this.deps.orderbook.getQuote(market.outcomes.UP.tokenId, 25, 0.99);
      const mid = quote.bestAsk && quote.bestBid ? (quote.bestAsk + quote.bestBid) / 2 : undefined;
      if (mid === undefined) {
        resumen.mercados.push({ slug: market.slug, motivo: "sin_punto_medio" });
        continue;
      }

      const banda = params.maxSpreadCents / 100;
      const competencia =
        quote.rawAskLevels.filter((n) => n.price - mid <= banda).reduce((s, n) => s + n.size, 0) +
        quote.rawBidLevels.filter((n) => mid - n.price <= banda).reduce((s, n) => s + n.size, 0);

      candidatos.push({
        slug: market.slug,
        poolVentanaUsd: params.ratePerDay / (this.config.ventanasPorDia ?? VENTANAS_POR_DIA),
        competencia,
        mid,
        params: { minSize: params.minSize, maxSpreadCents: params.maxSpreadCents },
        market,
        vivas,
      });
    }

    const elegidos = elegirMercados(candidatos, this.config.capitalUsd);
    const elegidosPorSlug = new Set(elegidos.map((e) => e.slug));

    for (const candidato of candidatos) {
      const elegido = elegidos.find((e) => e.slug === candidato.slug);
      // Un mercado que no entra en el presupuesto no se queda con ordenes puestas: inmovilizarian
      // dinero que otro mercado esta rindiendo mejor.
      if (!elegidosPorSlug.has(candidato.slug)) {
        resumen.canceladas += await this.deps.engine.cancelar(candidato.vivas.map((o) => o.id));
        resumen.mercados.push({ slug: candidato.slug, motivo: "capital_dedicado_a_otro_mercado" });
        continue;
      }

      const plan = planificarMaker({
        outcome: "UP" as Outcome,
        mid: candidato.mid,
        tickSize: Number(candidato.market.tickSize),
        capitalUsd: this.config.capitalUsd,
        params: candidato.params,
        vivas: candidato.vivas,
        ultimaRecolocacionMs: this.ultimaRecolocacion.get(candidato.slug),
        minMsEntreRecolocaciones: this.config.minMsEntreRecolocaciones ?? MIN_MS_ENTRE_RECOLOCACIONES,
        nowMs,
      });

      resumen.canceladas += await this.deps.engine.cancelar(plan.cancelar.map((o) => o.id));
      if (plan.colocar.length > 0) {
        this.ultimaRecolocacion.set(candidato.slug, nowMs);
      }
      for (const orden of plan.colocar) {
        const id = await this.deps.engine.colocar(candidato.market, orden);
        if (id) {
          resumen.colocadas += 1;
          resumen.comprometidoUsd += orden.price * orden.size;
        }
      }
      resumen.mercados.push({ slug: candidato.slug, motivo: plan.motivo, esperadoUsd: elegido?.esperadoUsd });
    }

    if (resumen.colocadas > 0 || resumen.canceladas > 0) {
      logger.info("Maker: ordenes actualizadas.", resumen);
    }
    return resumen;
  }
}

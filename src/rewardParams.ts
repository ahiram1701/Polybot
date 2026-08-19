/**
 * Parametros del programa de recompensas de liquidez, leidos del exchange.
 *
 * `min_size` y `max_spread` los fija Polymarket POR MERCADO y no son estables: el objeto del mercado
 * publicaba `max_spread: 4.5` mientras el endpoint de recompensas decia `1.5` para el mismo mercado.
 * Tres centavos de diferencia son la diferencia entre cobrar y no cobrar, porque el reparto cae con el
 * cuadrado de la distancia al medio. Asi que se leen, se cachean, y no se adivinan.
 *
 * Medido el 2026-08-19: BTC 5m reparte $10.000/dia, ETH $1.666 y DOGE $833.
 */
import { logger } from "./logger.js";

export interface RecompensaMercado {
  minSize: number;
  maxSpreadCents: number;
  /** Dolares al dia que reparte ESTE mercado entre todos los que ponen liquidez. */
  ratePerDay: number;
}

const TTL_MS = 10 * 60_000;

interface Entrada {
  valor: RecompensaMercado | undefined;
  leidoEnMs: number;
}

export class RewardParamsReader {
  private readonly cache = new Map<string, Entrada>();

  constructor(
    private readonly clobHost: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /**
   * Devuelve `undefined` si el mercado no esta en el programa. Un `undefined` NO es un fallo: significa
   * "aqui no pagan", y colocar ordenes en reposo ahi seria inmovilizar dinero a cambio de nada.
   *
   * La fuente es `/rewards/markets/current`, NO el objeto del mercado. Los dos publican los mismos
   * campos y NO coinciden: para `btc-updown-5m` el mercado decia `max_spread: 4.5` y el endpoint de
   * recompensas `1.5`. Manda el segundo, que es el que reparte — y tres centavos de diferencia deciden
   * si una orden cobra o no, porque el reparto cae con el cuadrado de la distancia al medio. Ademas es
   * el unico que trae `rate_per_day`, sin el cual no se puede saber si merece la pena.
   */
  async paraMercado(conditionId: string, slug?: string): Promise<RecompensaMercado | undefined> {
    // Se cachea por FAMILIA (btc-updown-5m), no por mercado.
    //
    // Cada ventana de 5 minutos es un mercado NUEVO, y el endpoint de recompensas tarda en incluirlo:
    // devuelve `{"data":[],"count":0}` para ventanas recien creadas. Consultando por conditionId, el
    // maker veia "aqui no pagan" en casi todas las ventanas y no cotizaba nunca. La configuracion es
    // identica en todas las ventanas del mismo activo y duracion —Polymarket la identifica como
    // `btc-5m-twap-60`—, asi que una lectura buena vale para las siguientes.
    const familia = familiaDeSlug(slug) ?? conditionId;
    const cacheado = this.cache.get(familia);
    if (cacheado && Date.now() - cacheado.leidoEnMs < TTL_MS) {
      return cacheado.valor;
    }
    let valor: RecompensaMercado | undefined;
    try {
      const respuesta = await this.fetchImpl(`${this.clobHost}/rewards/markets/${conditionId}`);
      const cuerpo = (await respuesta.json()) as { data?: Array<Record<string, unknown>> };
      const fila = cuerpo?.data?.[0];
      valor = fila ? normalizar(fila) : undefined;
    } catch (error) {
      logger.warn("No se pudieron leer los parametros de recompensa.", {
        conditionId,
        error: error instanceof Error ? error.message : String(error),
      });
      // Se conserva lo ultimo bueno si lo habia: un fallo de red no es "aqui no pagan".
      return cacheado?.valor;
    }
    // Un vacio NO borra lo ultimo bueno de la familia: significa "esta ventana aun no figura", no
    // "este mercado dejo de pagar". Solo se cachea el vacio si nunca hubo nada.
    if (valor || !cacheado?.valor) {
      this.cache.set(familia, { valor, leidoEnMs: Date.now() });
    }
    return valor ?? cacheado?.valor;
  }
}

/**
 * `btc-updown-5m-1787134500` -> `btc-updown-5m`. Es la clave estable: todas las ventanas de ese activo
 * y duracion comparten configuracion de recompensas.
 */
export function familiaDeSlug(slug: string | undefined): string | undefined {
  if (!slug) {
    return undefined;
  }
  const partes = slug.split("-");
  // Se quita el epoch final si lo hay; si el formato cambia, se usa el slug entero antes que fallar.
  return /^\d+$/.test(partes[partes.length - 1] ?? "") ? partes.slice(0, -1).join("-") : slug;
}

export function normalizar(rewards: Record<string, unknown> | undefined): RecompensaMercado | undefined {
  if (!rewards) {
    return undefined;
  }
  const minSize = Number(rewards.min_size ?? rewards.rewards_min_size);
  const maxSpreadCents = Number(rewards.max_spread ?? rewards.rewards_max_spread);
  // La tasa vive en `rewards_config`, un ARRAY con una entrada por periodo de campana. Se suman las
  // vigentes: un mercado puede tener varias dotaciones solapadas (una nativa y otra patrocinada).
  const config = Array.isArray(rewards.rewards_config) ? (rewards.rewards_config as Array<Record<string, unknown>>) : [];
  const deConfig = config.reduce((suma, entrada) => suma + (Number(entrada.rate_per_day) || 0), 0);
  const ratePerDay = deConfig || Number(rewards.total_daily_rate ?? rewards.native_daily_rate ?? 0);
  if (!Number.isFinite(minSize) || minSize <= 0 || !Number.isFinite(maxSpreadCents) || maxSpreadCents <= 0) {
    return undefined;
  }
  return { minSize, maxSpreadCents, ratePerDay: Number.isFinite(ratePerDay) ? ratePerDay : 0 };
}

/**
 * Que ordenes limite hay que tener puestas para cobrar recompensas de liquidez.
 *
 * Polymarket paga por dejar ordenes EN REPOSO cerca del punto medio, se llenen o no. Es la primera
 * fuente de ingresos de este proyecto que no exige acertar la direccion: no compites contra el mercado,
 * te pagan por estar. Medido el 2026-08-19 sobre los mercados que Polybot ya sigue: BTC 5m reparte
 * $10.000/dia, ETH $1.666 y DOGE $833, con `min_size: 50` y `max_spread: 1.5` centavos.
 *
 * Este modulo es PURO a proposito: decide, no ejecuta. Asi se puede probar la politica entera —bandas,
 * tamanos, cuando recolocar— sin red, sin claves y sin arriesgar un centimo.
 */
import type { Outcome } from "./types.js";

export interface ParametrosRecompensa {
  /** Tamano minimo, en participaciones, para que una orden puntue. Por debajo, cero. */
  minSize: number;
  /** Distancia maxima al punto medio, en CENTAVOS, dentro de la cual se puntua. */
  maxSpreadCents: number;
}

export interface OrdenDeseada {
  outcome: Outcome;
  side: "BUY" | "SELL";
  price: number;
  size: number;
}

export interface OrdenViva extends OrdenDeseada {
  id: string;
}

/**
 * El reparto es CUADRATICO con la distancia al medio: `((v - s) / v)^2`. Una orden pegada al borde de
 * la banda puntua casi cero, asi que colocarla lo mas cerca posible del medio no es una preferencia,
 * es la diferencia entre cobrar y no cobrar. Se deja un tick de separacion para no cruzar el spread y
 * convertirse en taker — que es justo lo que se viene a dejar de hacer.
 */
export function precioObjetivo(mid: number, side: "BUY" | "SELL", tickSize: number): number {
  const bruto = side === "BUY" ? mid - tickSize : mid + tickSize;
  const redondeado = Math.round(bruto / tickSize) * tickSize;
  // Nunca fuera de (0,1): un precio de 0 o 1 no es una apuesta, es un error.
  return Math.min(1 - tickSize, Math.max(tickSize, Number(redondeado.toFixed(6))));
}

/** Si una orden viva sigue puntuando: dentro de la banda y con tamano suficiente. */
export function siguePuntuando(orden: OrdenViva, mid: number, params: ParametrosRecompensa): boolean {
  const distanciaCentavos = Math.abs(orden.price - mid) * 100;
  return distanciaCentavos <= params.maxSpreadCents && orden.size >= params.minSize;
}

export interface PlanMaker {
  colocar: OrdenDeseada[];
  cancelar: OrdenViva[];
  /** Por que no se coloca nada, cuando no se coloca. Para que la UI no tenga que adivinarlo. */
  motivo?: string;
}

/**
 * Plan de un lado del mercado.
 *
 * `capitalUsd` es el tope duro: una orden de compra inmoviliza `precio x tamano` hasta que se llena o
 * se cancela, asi que sin este tope dos mercados simultaneos comprometerian el mismo dinero dos veces.
 */
export function planificarMaker(args: {
  outcome: Outcome;
  mid: number | undefined;
  tickSize: number;
  capitalUsd: number;
  params: ParametrosRecompensa;
  vivas: OrdenViva[];
}): PlanMaker {
  const { outcome, mid, tickSize, capitalUsd, params, vivas } = args;
  const mias = vivas.filter((o) => o.outcome === outcome);

  if (mid === undefined || !Number.isFinite(mid) || mid <= 0 || mid >= 1) {
    // Sin punto medio no hay banda que respetar: se retira todo en vez de dejar ordenes a ciegas.
    return { colocar: [], cancelar: mias, motivo: "sin_punto_medio" };
  }

  const price = precioObjetivo(mid, "BUY", tickSize);
  const costeUsd = price * params.minSize;
  if (costeUsd > capitalUsd) {
    return {
      colocar: [],
      cancelar: mias,
      motivo: "capital_insuficiente_para_el_minimo",
    };
  }

  // Las que siguen valiendo se dejan quietas: cancelar y recolocar cuesta latencia y puede perder el
  // turno en la cola del libro, que es justo lo que da valor a una orden en reposo.
  const buenas = mias.filter((o) => siguePuntuando(o, mid, params) && o.price === price);
  const cancelar = mias.filter((o) => !buenas.includes(o));
  if (buenas.length > 0) {
    return { colocar: [], cancelar };
  }
  return {
    colocar: [{ outcome, side: "BUY", price, size: params.minSize }],
    cancelar,
  };
}

export interface CandidatoMercado {
  slug: string;
  /** Dolares que reparte este mercado en la ventana actual. */
  poolVentanaUsd: number;
  /** Participaciones ajenas ya en reposo dentro de la banda que puntua. */
  competencia: number;
  mid: number;
  params: ParametrosRecompensa;
}

export interface MercadoElegido extends CandidatoMercado {
  costeUsd: number;
  /** Recompensa esperada de la ventana, con el reparto aproximado por tamano. */
  esperadoUsd: number;
}

/**
 * A que mercados dedicar el capital, de mejor a peor, hasta agotarlo.
 *
 * Con poco capital esto NO es un detalle: una orden de 50 participaciones cuesta entre $2,50 y $47,50
 * segun el precio, asi que financiar el mercado equivocado puede dejar fuera dos que rendian mas. Se
 * ordena por recompensa esperada POR DOLAR inmovilizado, no por tamano del bote: un bote enorme con
 * mucha competencia rinde menos que uno pequeno donde no compite nadie.
 *
 * La estimacion del reparto es LINEAL por tamano y por tanto OPTIMISTA: el reparto real cae con el
 * cuadrado de la distancia al medio. Sirve para ordenar —el sesgo afecta a todos por igual— pero no
 * para prometer cuanto se cobrara.
 */
export function elegirMercados(candidatos: CandidatoMercado[], capitalUsd: number): MercadoElegido[] {
  const evaluados = candidatos
    .filter((c) => c.mid > 0 && c.mid < 1 && c.poolVentanaUsd > 0)
    .map((c) => {
      const costeUsd = c.params.minSize * c.mid;
      const cuota = c.params.minSize / (c.competencia + c.params.minSize);
      return { ...c, costeUsd, esperadoUsd: cuota * c.poolVentanaUsd };
    })
    .filter((c) => c.costeUsd > 0)
    .sort((izq, der) => der.esperadoUsd / der.costeUsd - izq.esperadoUsd / izq.costeUsd);

  const elegidos: MercadoElegido[] = [];
  let restante = capitalUsd;
  for (const c of evaluados) {
    if (c.costeUsd <= restante) {
      elegidos.push(c);
      restante -= c.costeUsd;
    }
  }
  return elegidos;
}

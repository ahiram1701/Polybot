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
 *
 * ## Por que se cotizan SIEMPRE los dos lados
 *
 * La primera version cotizaba solo UP y costo $41,41 en 40 minutos reales. Dos motivos, y los dos
 * estan en la formula oficial:
 *
 *  - **La recompensa castiga un solo lado.** Con el medio en [0,10-0,90] se cobra un TERCIO; fuera de
 *    ese rango se cobra EXACTAMENTE CERO. El 24% del dinero de aquel dia se gasto fuera del rango.
 *  - **Un solo lado es una apuesta direccional disfrazada.** Una compra en reposo solo se llena cuando
 *    el precio CAE hasta ella, asi que te llenas justo del lado que se hunde. Con los dos lados el par
 *    cuesta `(mid - tick) + (1 - mid - tick)` = poco menos de $1 y redime exactamente $1: gana un
 *    centimo pase lo que pase.
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

/** El divisor que la documentacion aplica a la liquidez de un solo lado. Hoy es 3,0 en todos los mercados. */
export const FACTOR_UN_SOLO_LADO = 3.0;

/**
 * Puntuacion oficial de una orden: `S(v, s) = ((v - s) / v)^2 * tamano`.
 *
 * Es CUADRATICA con la distancia al medio, asi que una orden pegada al borde de la banda puntua casi
 * cero. Colocarla lo mas cerca posible del medio no es una preferencia, es la diferencia entre cobrar
 * y no cobrar. Fuera de la banda o por debajo del minimo: cero.
 */
export function puntuacionRecompensa(
  size: number,
  distanciaAlMedio: number,
  params: ParametrosRecompensa,
): number {
  const v = params.maxSpreadCents / 100;
  const s = Math.abs(distanciaAlMedio);
  if (s > v || size < params.minSize || v <= 0) {
    return 0;
  }
  return ((v - s) / v) ** 2 * size;
}

/**
 * `Q_min` oficial, que es donde vive el castigo por cotizar un solo lado:
 *
 *     mid dentro de [0,10 - 0,90]:  max( min(Q_one, Q_two), max(Q_one/c, Q_two/c) )
 *     mid fuera:                    min(Q_one, Q_two)
 *
 * Fuera del rango central `min(Q, 0)` es CERO: un solo lado no cobra nada. Esa es la regla que hizo
 * que el 24% del gasto del 19 de agosto tuviera recompensa nula por definicion.
 */
export function qMinOficial(qOne: number, qTwo: number, mid: number): number {
  const c = FACTOR_UN_SOLO_LADO;
  if (mid >= 0.1 && mid <= 0.9) {
    return Math.max(Math.min(qOne, qTwo), Math.max(qOne / c, qTwo / c));
  }
  return Math.min(qOne, qTwo);
}

/**
 * El reparto es CUADRATICO con la distancia al medio. Se deja un tick de separacion para no cruzar el
 * spread y convertirse en taker — que es justo lo que se viene a dejar de hacer.
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

/** Participaciones ya COMPRADAS de cada lado en este mercado. Define hacia donde estamos expuestos. */
export interface Inventario {
  UP: number;
  DOWN: number;
}

/** El punto medio del token contrario es el complemento del propio. */
export function medioContrario(mid: number): number {
  return 1 - mid;
}

/**
 * Plan de los DOS lados del mercado.
 *
 * `capitalDisponibleUsd` ya viene neto: el llamante le ha restado lo que hay comprometido en ordenes
 * vivas Y lo que ya se gasto en llenados. Aqui solo se comprueba que quepa el par entero.
 *
 * **Nunca se inicia una posicion de un solo lado.** Si el par no cabe, no se coloca nada: media
 * cotizacion es exactamente el error que costo $41.
 *
 * El `inventario` es la guarda contra la seleccion adversa. Si ya se compraron 50 participaciones de
 * UP y ninguna de DOWN, se deja de pedir UP y solo se pide DOWN: eso COMPLETA el par (que redime $1
 * seguro) en vez de doblar la apuesta sobre el lado que se esta hundiendo. Cuesta recompensa —un lado
 * cobra un tercio— pero el riesgo direccional se comio $41 mientras las recompensas daban $2,78.
 */
export function planificarDosLados(args: {
  /** Punto medio del token UP. El de DOWN es su complemento. */
  mid: number | undefined;
  tickSize: number;
  capitalDisponibleUsd: number;
  params: ParametrosRecompensa;
  vivas: OrdenViva[];
  inventario?: Inventario;
  /** Cuando se recoloco por ultima vez en ESTE mercado. Ausente = nunca. */
  ultimaRecolocacionMs?: number;
  /** Intervalo minimo entre recolocaciones. 0 = sin limite. */
  minMsEntreRecolocaciones?: number;
  nowMs?: number;
}): PlanMaker {
  const { mid, tickSize, capitalDisponibleUsd, params, vivas } = args;
  const inventario = args.inventario ?? { UP: 0, DOWN: 0 };
  const minMsEntreRecolocaciones = args.minMsEntreRecolocaciones ?? 0;
  const nowMs = args.nowMs ?? 0;

  if (mid === undefined || !Number.isFinite(mid) || mid <= 0 || mid >= 1) {
    // Sin punto medio no hay banda que respetar: se retira todo en vez de dejar ordenes a ciegas.
    return { colocar: [], cancelar: vivas, motivo: "sin_punto_medio" };
  }

  const medios: Record<Outcome, number> = { UP: mid, DOWN: medioContrario(mid) };
  const precios: Record<Outcome, number> = {
    UP: precioObjetivo(medios.UP, "BUY", tickSize),
    DOWN: precioObjetivo(medios.DOWN, "BUY", tickSize),
  };

  // Que lados TOCA cotizar. Se salta el lado del que ya se es largo: pedir mas seria doblar sobre el
  // que cae. Con inventario equilibrado (lo normal) se piden los dos.
  const lados = (["UP", "DOWN"] as const).filter(
    (lado) => inventario[lado] <= inventario[lado === "UP" ? "DOWN" : "UP"],
  );

  // Se deja quieta mientras SIGA PUNTUANDO, y ademas no se recoloca antes de `minMsEntreRecolocaciones`.
  //
  // Las dos condiciones hacen falta y por motivos distintos.
  //
  // La primera: exigir `o.price === price` recolocaba en casi cada iteracion, porque el medio se mueve
  // un tick constantemente. La banda es la tolerancia natural.
  //
  // La segunda salio de medir, no de razonar. Con solo la primera, el ritmo seguia en ~1.400
  // recolocaciones/hora: la banda de 1,5 centavos es MAS ESTRECHA que lo que se mueve el precio en
  // estos mercados —medido: el medio pasa de 0,57 a 0,78 en segundos cerca del cierre—, asi que la
  // orden se sale de banda una y otra vez por mucho que se afine el criterio.
  //
  // Y ojo con el motivo: para RECOMPENSAS el turno en la cola no importa —se puntua por tamano y
  // distancia, no por llenarse—, asi que el coste real del churn no es perder posicion sino los
  // limites de peticiones del exchange. Por eso la solucion es un intervalo minimo y no un umbral de
  // precio mas fino.
  const puedeRecolocar =
    minMsEntreRecolocaciones <= 0 ||
    args.ultimaRecolocacionMs === undefined ||
    nowMs - args.ultimaRecolocacionMs >= minMsEntreRecolocaciones;

  // Las ordenes de un lado que ya NO toca cotizar sobran: si se es largo de UP, una compra de UP viva
  // solo puede empeorar el desequilibrio.
  const sobran = vivas.filter((o) => !lados.includes(o.outcome));
  const conservar = vivas.filter(
    (o) => siguePuntuando(o, medios[o.outcome], params) && !sobran.includes(o),
  );
  const faltan = lados.filter((lado) => !conservar.some((o) => o.outcome === lado));
  const cancelar = vivas.filter((o) => !conservar.includes(o));

  if (faltan.length === 0) {
    return { colocar: [], cancelar };
  }

  // El coste se mide sobre lo que hay que COLOCAR, no sobre el par entero: el capital de una orden que
  // ya esta en el libro ya lo descontó el llamante. Medirlo sobre los dos lados cancelaba la orden
  // buena que quedaba y dejaba el mercado sin nada.
  const costeUsd = faltan.reduce((suma, lado) => suma + precios[lado] * params.minSize, 0);
  if (costeUsd > capitalDisponibleUsd) {
    return {
      colocar: [],
      cancelar: vivas,
      motivo: `capital_insuficiente_necesita_${costeUsd.toFixed(2)}`,
    };
  }
  if (!puedeRecolocar) {
    // Todavia no toca recolocar. Se deja lo que hay —una orden fuera de banda no cobra, pero tampoco
    // cuesta— y solo se retira lo que agrava el desequilibrio: CANCELAR no consume el limite de
    // peticiones que preocupa, COLOCAR si.
    return { colocar: [], cancelar: sobran, motivo: "espera_entre_recolocaciones" };
  }

  return {
    colocar: faltan.map((lado) => ({
      outcome: lado as Outcome,
      side: "BUY" as const,
      price: precios[lado],
      size: params.minSize,
    })),
    cancelar,
  };
}

export interface CandidatoMercado {
  slug: string;
  /** Dolares que reparte este mercado en la ventana actual. */
  poolVentanaUsd: number;
  /** Puntuacion `S` ya calculada de las compras AJENAS que puntuan (lado bid del libro fusionado). */
  qRivalBid: number;
  /** Idem del lado ask, que en Polymarket son las compras del token contrario. */
  qRivalAsk: number;
  mid: number;
  tickSize: number;
  params: ParametrosRecompensa;
}

export interface MercadoElegido extends CandidatoMercado {
  costeUsd: number;
  /** Recompensa esperada de la ventana segun la formula oficial. */
  esperadoUsd: number;
}

/**
 * A que mercados dedicar el capital, de mejor a peor, hasta agotarlo.
 *
 * Con poco capital esto NO es un detalle: un par de 50 participaciones cuesta casi $50 sea cual sea el
 * precio (porque UP + DOWN ~= $1), asi que financiar el mercado equivocado deja fuera a los demas. Se
 * ordena por recompensa esperada POR DOLAR inmovilizado, no por tamano del bote: un bote enorme con
 * mucha competencia rinde menos que uno pequeno donde no compite nadie.
 *
 * ## Cuanto fiarse de `esperadoUsd`
 *
 * Aplica la formula oficial —peso cuadratico, `Q_min` y el castigo por un solo lado— pero la
 * competencia se mide con UNA foto del libro y agregando a los rivales como si fueran uno solo. Contra
 * la unica medida real que existe ($2,7795 cobrados el 2026-08-19 por 40,2 minutos, o sea $0,345 por
 * ventana) los modelos teoricos salieron 10-30 veces ALTOS. Sirve para ORDENAR mercados, que es para
 * lo unico que se usa aqui; no para prometer un ingreso.
 */
export function elegirMercados(candidatos: CandidatoMercado[], capitalUsd: number): MercadoElegido[] {
  const evaluados = candidatos
    .filter((c) => c.mid > 0 && c.mid < 1 && c.poolVentanaUsd > 0)
    .map((c) => {
      // El par cuesta casi $1 por participacion se ponga donde se ponga: es el precio de ser neutral.
      const precioUp = precioObjetivo(c.mid, "BUY", c.tickSize);
      const precioDown = precioObjetivo(medioContrario(c.mid), "BUY", c.tickSize);
      const costeUsd = (precioUp + precioDown) * c.params.minSize;

      // Nuestra puntuacion: mismo tamano en los dos lados, a un tick del medio.
      const qPropia = puntuacionRecompensa(c.params.minSize, Math.abs(c.mid - precioUp), c.params);
      const nuestro = qMinOficial(qPropia, qPropia, c.mid);
      const rivales = qMinOficial(c.qRivalBid, c.qRivalAsk, c.mid);
      const cuota = nuestro + rivales > 0 ? nuestro / (nuestro + rivales) : 0;
      return { ...c, costeUsd, esperadoUsd: cuota * c.poolVentanaUsd };
    })
    .filter((c) => c.costeUsd > 0 && c.esperadoUsd > 0)
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

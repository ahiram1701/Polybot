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
 * A cuantos ticks del punto medio se coloca. **1 es el minimo util; 0 no existe como opcion.**
 *
 * Esto se documentaba como una palanca —"0 = pegado al medio, puntua el 100% en vez del 60%"— y no lo
 * es. Barrido sobre todo el espacio de precios (2.196 medios, ticks de 0,01 y 0,001) el 2026-08-25:
 *
 * | | |
 * |---|---|
 * | medios donde `0` da un precio distinto de `1` | **1.098** de 2.196 (exactamente los que caen en un tick) |
 * | de esos, cuantos BLOQUEAN el libro | **1.098 — el 100%** |
 * | de esos, cuantos mejoran sin bloquear | **0** |
 *
 * La razon es aritmetica y no admite matices: `precioObjetivo` con separacion 0 usa `floor`, que solo
 * se aparta de `ceil - 1` cuando el medio cae JUSTO en un tick. Y ahi `p_up + p_down = 1` exacto, que
 * es el par que se cruza consigo mismo (ver la guarda en `planificarDosLados`). Cuando el medio cae
 * entre ticks —lo normal, porque el medio es `(bid+ask)/2`— los dos modos dan **el mismo precio**.
 *
 * Asi que `0` nunca gana nada: o no cambia nada, o produce un par que el exchange rechaza. La guarda
 * lo bloquea y `settings.ts` lo normaliza a 1.
 *
 * Lo que SI sigue siendo cierto de la version anterior de esta nota:
 *
 *  - **Acercar UN solo lado no sirve.** `Q_min` toma el MINIMO de los dos lados, asi que la recompensa
 *    la limita el mas debil. O se acercan los dos o no se gana nada.
 *  - **El margen de 2 centavos no es una defensa.** Contra un llenado de un solo lado se pierde mucho
 *    mas que eso; lo que protege de verdad es la guarda de inventario y el suelo de saldo.
 */
export const TICKS_DEL_MEDIO = 1;

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
 * El tick INMEDIATAMENTE anterior al medio (o posterior, si se vende).
 *
 * Se cuenta en ticks ENTEROS a proposito. La version anterior hacia `Math.round((mid - tick) / tick)`
 * y la coma flotante la traicionaba en los medios que caen a medio tick, que son la mayoria: con
 * `mid = 0,595`, `0,585 / 0,01` da `58,499999999999993`, `Math.round` baja a 58 y el precio sale a
 * 0,58 — **dos ticks del medio**. Con banda de 1,5 centavos eso es distancia 0,015, justo en el borde,
 * y el mismo error de coma flotante la empuja fuera: la orden **puntuaba CERO** con el dinero
 * igualmente inmovilizado. Un barrido sobre todo el espacio de precios lo encontro en decenas de
 * medios (0,045, 0,305, 0,395, 0,405, 0,585, 0,595, 0,605...).
 *
 * Contando en ticks enteros quedan garantizadas tres cosas a la vez:
 *
 *  - **Nunca a mas de UN tick del medio**, asi que siempre puntua mientras la banda supere al tick.
 *  - **Estrictamente por debajo del medio** (por encima si se vende), asi que no cruza el spread.
 *  - **El par cuesta estrictamente menos de $1**: si compra UP por debajo de `mid` y DOWN por debajo de
 *    `1 - mid`, la suma es menor que 1 por construccion. Y el par redime exactamente $1.
 */
export function precioObjetivo(
  mid: number,
  side: "BUY" | "SELL",
  tickSize: number,
  ticksDelMedio: number = TICKS_DEL_MEDIO,
): number {
  // `toFixed(6)` antes de redondear: sin eso, un `mid` que deberia caer justo en un tick llega como
  // 40,000000000000006 y `Math.ceil` se va un tick de mas.
  const enTicks = Number((mid / tickSize).toFixed(6));
  const separacion = Math.max(0, Math.floor(ticksDelMedio));
  const objetivo =
    side === "BUY"
      ? // Con separacion 0 se usa `floor`: el tick mas alto que NO pasa del medio, que puede ser el
        // medio mismo. Con 1 o mas, se resta esa cantidad de ticks al primero estrictamente por debajo.
        (separacion === 0 ? Math.floor(enTicks) : Math.ceil(enTicks) - separacion)
      : separacion === 0
        ? Math.ceil(enTicks)
        : Math.floor(enTicks) + separacion;
  const precio = Number((objetivo * tickSize).toFixed(6));
  // Nunca fuera de (0,1): un precio de 0 o 1 no es una apuesta, es un error.
  return Math.min(1 - tickSize, Math.max(tickSize, precio));
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

/** Un nivel del libro fusionado, ya en el espacio de precios de UP. */
export interface NivelLibro {
  price: number;
  size: number;
}

/**
 * El punto medio QUE USA POLYMARKET para repartir: el "size-cutoff-adjusted midpoint".
 *
 * La formula oficial no mide la distancia contra el medio del libro a secas. `S(v, s)` define `s` como
 * *"spread from size-cutoff-adjusted midpoint"*: el medio que queda **despues de tirar los niveles por
 * debajo del tamano minimo del programa**. Existe para que nadie fije un medio falso con polvo — cuatro
 * participaciones sueltas en el borde del libro moverian el reparto de todos los demas.
 *
 * El bucle calculaba el medio crudo, con polvo incluido, y colocaba a un tick de EL. Cuando los dos
 * medios se separan, las ordenes nacen a la distancia equivocada del unico medio que puntua: el dinero
 * queda inmovilizado igual y la puntuacion baja o se va a cero, sin que nada lo diga.
 *
 * Medido el 2026-08-25 sobre los 29 mejores mercados que caben en $22:
 *
 *  - **1 de 29 puntuaba CERO** (medios separados 11,5 centavos con banda de 4,5);
 *  - otros 4 perdian entre el 26% y el 51% de su puntuacion por desvios de 0,5 a 1,5 centavos;
 *  - entre ellos, el que el maker estaba cotizando en ese momento: `S` real 8,9 contra 12,1 creidos.
 *
 * Devuelve `undefined` si NINGUN lado tiene un nivel que llegue al minimo. Eso no es un fallo: es un
 * libro que es todo polvo, y ahi quien llama decide (el bucle cae al medio crudo, que es lo unico que
 * hay). Un `undefined` nunca debe interpretarse como "medio cero".
 */
export function medioAjustadoPorTamano(
  bids: NivelLibro[],
  asks: NivelLibro[],
  minSize: number,
): number | undefined {
  // El corte es `>=`: el minimo del programa es el tamano que YA califica, no el que hay que superar.
  const mejorBid = bids.filter((n) => n.size >= minSize).reduce<number | undefined>(
    (mejor, n) => (mejor === undefined || n.price > mejor ? n.price : mejor),
    undefined,
  );
  const mejorAsk = asks.filter((n) => n.size >= minSize).reduce<number | undefined>(
    (mejor, n) => (mejor === undefined || n.price < mejor ? n.price : mejor),
    undefined,
  );
  if (mejorBid === undefined || mejorAsk === undefined) {
    return undefined;
  }
  return (mejorBid + mejorAsk) / 2;
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
  /** A cuantos ticks del medio se coloca. Ver `TICKS_DEL_MEDIO`. */
  ticksDelMedio?: number;
  nowMs?: number;
}): PlanMaker {
  const { mid, tickSize, capitalDisponibleUsd, params, vivas } = args;
  const ticksDelMedio = args.ticksDelMedio ?? TICKS_DEL_MEDIO;
  const inventario = args.inventario ?? { UP: 0, DOWN: 0 };
  const minMsEntreRecolocaciones = args.minMsEntreRecolocaciones ?? 0;
  const nowMs = args.nowMs ?? 0;

  if (mid === undefined || !Number.isFinite(mid) || mid <= 0 || mid >= 1) {
    // Sin punto medio no hay banda que respetar: se retira todo en vez de dejar ordenes a ciegas.
    return { colocar: [], cancelar: vivas, motivo: "sin_punto_medio" };
  }

  const medios: Record<Outcome, number> = { UP: mid, DOWN: medioContrario(mid) };
  const precios: Record<Outcome, number> = {
    UP: precioObjetivo(medios.UP, "BUY", tickSize, ticksDelMedio),
    DOWN: precioObjetivo(medios.DOWN, "BUY", tickSize, ticksDelMedio),
  };

  // Dos condiciones que hay que comprobar por separado, y ninguna sobra:
  //
  //  - **El par tiene que costar ESTRICTAMENTE menos de $1.** Redime exactamente $1, asi que pagar mas
  //    es una perdida garantizada. Y pagar $1 EXACTO no es "no ganar ni perder", como decia aqui
  //    antes: es que **las dos ordenes se cruzan entre si**. Comprar UP a `p` y DOWN a `q` deja, en el
  //    libro fusionado, una compra en `p` y una venta en `1 - q`; con `p + q = 1` las dos caen en el
  //    mismo precio y el libro queda BLOQUEADO. Polymarket casa compras complementarias acuñando un
  //    par, asi que son ordenes que se comen la una a la otra — y con `postOnly` el exchange rechaza
  //    la segunda, la guarda de atomicidad retira la primera y el maker se queda mudo en bucle.
  //  - **Ningun precio puede quedar POR ENCIMA de su medio.** En los extremos del libro no existe un
  //    tick por debajo de 0,005 y el tope de precio tiene que intervenir; ese lado pegado al tope
  //    podria cruzar el spread y convertirse en taker, que es justo lo que se viene a dejar de hacer.
  // La tolerancia no es cosmetica: `0,56 + 0,44` da `1,0000000000000002` en coma flotante, y sin ella
  // el guardian rechazaba mercados perfectamente validos como si el par costara mas de $1. Un tick
  // vale 0,01 o 0,001, asi que un par sano suma como mucho `1 - 2*tick` = 0,998: 1e-9 no puede tapar
  // ni un exceso real ni un bloqueo.
  const EPS = 1e-9;
  if (precios.UP + precios.DOWN > 1 - EPS || precios.UP > medios.UP + EPS || precios.DOWN > medios.DOWN + EPS) {
    return { colocar: [], cancelar: vivas, motivo: "precio_extremo_sin_margen" };
  }

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

  // El coste es lo que se COLOCA mas lo que se CONSERVA, medido contra el presupuesto de este mercado.
  //
  // El llamante ya le devolvio a este mercado su propio dinero comprometido —puede cancelar y
  // reutilizarlo—, asi que el tope de aqui cubre las dos cosas. Contar solo lo que se coloca dejaba un
  // hueco silencioso: al recolocar UN lado, el que se queda no entraba en la cuenta. Observado en
  // produccion, no en un test — un lado conservado de $5,40 mas uno nuevo de $15,00 dieron **$20,40
  // con el tope en $20**. El exceso no esta acotado: depende de lo que valga el lado conservado.
  const valorConservado = conservar.reduce((suma, o) => suma + o.price * o.size, 0);
  const costeUsd = faltan.reduce((suma, lado) => suma + precios[lado] * params.minSize, 0) + valorConservado;
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
  /**
   * Dolares AL DIA que reparte este mercado entre todos los que ponen liquidez.
   *
   * Al dia, no por ventana: desde que el maker mira mercados de cualquier duracion —de 5 minutos a
   * meses—, prorratear entre 288 ventanas dejaba de significar nada. En unidades diarias
   * `esperadoUsdDia / costeUsd` es un rendimiento comparable entre un mercado de petroleo que dura un
   * dia y uno de cripto que dura cinco minutos.
   */
  poolDiaUsd: number;
  /** Puntuacion `S` ya calculada de las compras AJENAS que puntuan (lado bid del libro fusionado). */
  qRivalBid: number;
  /** Idem del lado ask, que en Polymarket son las compras del token contrario. */
  qRivalAsk: number;
  mid: number;
  tickSize: number;
  params: ParametrosRecompensa;
  /**
   * `true` si YA se esta cotizando aqui. Solo influye en el ORDEN, nunca en la cifra que se reporta.
   *
   * Ver `margenRelevo` en `elegirMercados`: sin esta marca no hay forma de distinguir "es mejor" de
   * "parece mejor por un pelo", y esa distincion vale 9,2 mudanzas a la hora.
   */
  esTitular?: boolean;
}

export interface MercadoElegido extends CandidatoMercado {
  costeUsd: number;
  /** Recompensa esperada AL DIA segun la formula oficial. */
  esperadoUsdDia: number;
}

/**
 * A que mercados dedicar el capital, de mejor a peor, hasta agotarlo.
 *
 * Con poco capital esto NO es un detalle: un par de 50 participaciones cuesta casi $50 sea cual sea el
 * precio (porque UP + DOWN ~= $1), asi que financiar el mercado equivocado deja fuera a los demas. Se
 * ordena por recompensa esperada POR DOLAR inmovilizado, no por tamano del bote: un bote enorme con
 * mucha competencia rinde menos que uno pequeno donde no compite nadie.
 *
 * ## Cuanto fiarse de `esperadoUsdDia`
 *
 * Aplica la formula oficial —peso cuadratico, `Q_min` y el castigo por un solo lado— pero la
 * competencia se mide con UNA foto del libro y agregando a los rivales como si fueran uno solo. Contra
 * la unica medida real que existe ($2,7795 cobrados el 2026-08-19 por 40,2 minutos, o sea $0,345 por
 * ventana) los modelos teoricos salieron 10-30 veces ALTOS. Sirve para ORDENAR mercados, que es para
 * lo unico que se usa aqui; no para prometer un ingreso.
 *
 * ## `margenRelevo`: por que el que ya cotiza juega con ventaja
 *
 * Medido sobre 21,8 h de produccion: el maker cambiaba de mercado **10,7 veces por hora**, y el 86% de
 * esas mudanzas abandonaban un mercado que seguia disponible. No era informacion nueva, era un empate
 * resuelto a cara o cruz: entre los mercados que caben en $20 hay **54 practicamente empatados** por
 * bote, y basta que la foto del libro se mueva un pelo para que cambie el ganador.
 *
 * Mudarse no es gratis —se deja de estar en el libro justo cuando la muestra del minuto puede caer—,
 * asi que un aspirante tiene que ser MEJOR, no empatar. Con `margenRelevo = 0,25` tiene que rendir un
 * 25% mas para llevarse el capital. La ventaja se aplica al ORDEN y al reparto; la cifra reportada en
 * `esperadoUsdDia` sigue siendo la estimacion honesta.
 */
/** Rendimiento por dolar con la ventaja del titular ya aplicada. Solo para ordenar. */
function rendimientoOrdenado(c: MercadoElegido, margenRelevo: number): number {
  const ventaja = c.esTitular ? 1 + margenRelevo : 1;
  return (c.esperadoUsdDia / c.costeUsd) * ventaja;
}

/**
 * El suelo de $1 AL DIA por debajo del cual Polymarket no paga nada.
 *
 * De la documentacion oficial, literal: *"The minimum reward payout is $1; amounts below this will not
 * be paid."* Se cuenta por usuario y por dia, y lo que no llega **no se acumula** para el dia
 * siguiente: se pierde.
 *
 * Es la regla que cambia la estrategia con poco capital, y el bot no la conocia. Cotizar en un mercado
 * cuyo reparto realista da $0,40 al dia no rinde $0,40: rinde **$0**, con el capital entero
 * inmovilizado y la seleccion adversa corriendo igual. Con $20 no hay margen para repartirse entre
 * varios sitios flojos: hay que concentrarse en uno que cruce el liston de sobra.
 */
export const MINIMO_PAGO_USD_DIA = 1;

export function elegirMercados(
  candidatos: CandidatoMercado[],
  capitalUsd: number,
  ticksDelMedio: number = TICKS_DEL_MEDIO,
  margenRelevo = 0,
  /**
   * Recompensa esperada minima para molestarse en inmovilizar el capital.
   *
   * Se compara contra `esperadoUsdDia`, que es una ESTIMACION y ademas optimista —contra la unica
   * medida real que existe, los modelos de este proyecto salieron altos—. Por eso el umbral util no es
   * $1 sino un multiplo suyo: pedir $1 estimado para cobrar $1 real seria creerse el modelo justo
   * donde ya se sabe que falla. Con 0 el filtro no actua, que es el comportamiento de antes.
   */
  minEsperadoUsdDia = 0,
): MercadoElegido[] {
  const evaluados = candidatos
    .filter((c) => c.mid > 0 && c.mid < 1 && c.poolDiaUsd > 0)
    .map((c) => {
      // El par cuesta casi $1 por participacion se ponga donde se ponga: es el precio de ser neutral.
      const precioUp = precioObjetivo(c.mid, "BUY", c.tickSize, ticksDelMedio);
      const precioDown = precioObjetivo(medioContrario(c.mid), "BUY", c.tickSize, ticksDelMedio);
      const costeUsd = (precioUp + precioDown) * c.params.minSize;

      // Nuestra puntuacion: mismo tamano en los dos lados, a un tick del medio.
      const qPropia = puntuacionRecompensa(c.params.minSize, Math.abs(c.mid - precioUp), c.params);
      const nuestro = qMinOficial(qPropia, qPropia, c.mid);
      const rivales = qMinOficial(c.qRivalBid, c.qRivalAsk, c.mid);
      const cuota = nuestro + rivales > 0 ? nuestro / (nuestro + rivales) : 0;
      return { ...c, costeUsd, esperadoUsdDia: cuota * c.poolDiaUsd };
    })
    // Un mercado que no puede cruzar el suelo de pago no es un mercado flojo: es uno que paga CERO.
    // Ver `MINIMO_PAGO_USD_DIA`.
    .filter((c) => c.costeUsd > 0 && c.esperadoUsdDia > 0 && c.esperadoUsdDia >= minEsperadoUsdDia)
    // El desempate va SOLO en el orden; `esperadoUsdDia` se reporta sin tocar, porque es la cifra que
    // se mira para saber si el modelo acierta y falsearla ahi seria mentirse en el sitio mas caro.
    .sort((izq, der) => rendimientoOrdenado(der, margenRelevo) - rendimientoOrdenado(izq, margenRelevo));

  const elegidos: MercadoElegido[] = [];
  let restante = capitalUsd;
  // El titular gasta su ventaja tambien AQUI, no solo en el orden: con capital para un solo mercado,
  // entrar antes en el reparto es lo unico que decide.
  for (const c of evaluados) {
    if (c.costeUsd <= restante) {
      elegidos.push(c);
      restante -= c.costeUsd;
    }
  }
  return elegidos;
}

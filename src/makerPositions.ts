import type { Inventario } from "./makerQuoting.js";

/**
 * Lo que el maker tiene comprado DE VERDAD, leido de Polymarket y no de su propia memoria.
 *
 * El maker lleva su inventario en memoria, asi que un reinicio se lo borra. Eso no es un detalle
 * cosmetico: `paresUsd()` alimenta el suelo de patrimonio, y un maker que olvida sus pares se cree mas
 * pobre de lo que es y se detiene solo. Medido el 2026-08-28: tras un reinicio de la PC el bot conto
 * $17,05 de patrimonio teniendo $23,50, y se paro por debajo de un suelo que en realidad no habia
 * cruzado.
 *
 * Y el olvido tambien empuja en la direccion PELIGROSA: `gastadoUsd` vuelve a cero, asi que el tope de
 * capital se cree entero cuando ya hay dinero fuera. Por eso se siembran las dos cosas juntas.
 *
 * ## Por que leer y no persistir
 *
 * Un fichero en disco envejece mal: si el bot esta apagado cuando una posicion resuelve y se redime, al
 * volver contaria el efectivo Y los pares, que es contar dos veces. Y de los dos errores posibles, el
 * codigo del maker ya tiene elegido cual duele: *"equivocarse por conservador cuesta dejar de cotizar
 * antes de tiempo; por optimista, arriesgar dinero que uno cree tener"*. Leer la posicion real no puede
 * envejecer.
 */
export interface PosicionAbierta {
  slug: string;
  /** Cuando acaba el mercado. El maker olvida la posicion sola al pasar esta fecha. */
  finMs: number;
  /** Dolares que costo la posicion. Cuentan contra el tope igual que un llenado de esta sesion. */
  gastadoUsd: number;
  inventario: Inventario;
}

/**
 * Cuantas posiciones se piden. El valor por defecto de la API son 100 y **se queda corto**: con 170
 * posiciones reales en la cuenta, pedir 100 dejaba fuera una de las dos patas de un par y el bot habria
 * leido una posicion direccional donde tenia un par completo. Peor que no leer nada.
 */
export const LIMITE_POSICIONES = 500;

interface FilaPosicion {
  slug?: unknown;
  outcomeIndex?: unknown;
  size?: unknown;
  avgPrice?: unknown;
  redeemable?: unknown;
  endDate?: unknown;
}

/**
 * Cuando acaba el mercado, a partir de lo que trae la API.
 *
 * `positions` devuelve la fecha PELADA —"2026-08-28"— y `Date.parse` la interpreta como las 00:00Z de
 * ese dia. O sea que durante las veinticuatro horas en que el mercado esta vivo, su "fin" ya es pasado,
 * y quien filtre por el descarta justo las posiciones abiertas. Paso: la siembra tiro las dos patas de
 * un par a las 20:06 de su propio dia y no sembro nada, sin decir una palabra.
 *
 * Ya estaba avisado en este proyecto para `end_date_iso`, que tampoco es la hora de cierre sino la
 * medianoche de la fecha nominal. Una fecha sin hora significa "acaba ESE DIA", asi que se toma el
 * final del dia y no el principio.
 */
function finDeMercadoMs(endDate: unknown): number {
  if (typeof endDate !== "string") {
    return Number.NaN;
  }
  const texto = endDate.trim();
  return Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(texto) ? `${texto}T23:59:59.999Z` : texto);
}

/**
 * Agrupa las filas de la API en posiciones por mercado. Puro: la red se queda fuera para poder probar
 * esto sin ella.
 *
 * Devuelve `undefined` —y NO una lista vacia— cuando el dato no es de fiar. La diferencia importa: una
 * lista vacia dice "no tienes nada" y el llamador se lo creeria; `undefined` dice "no se", y ahi el
 * llamador se queda con su cuenta conservadora de siempre.
 */
export function posicionesAbiertas(datos: unknown, limitePedido = LIMITE_POSICIONES): PosicionAbierta[] | undefined {
  const filas = Array.isArray(datos)
    ? datos
    : Array.isArray((datos as { data?: unknown[] } | null)?.data)
      ? ((datos as { data: unknown[] }).data)
      : undefined;
  if (!filas) {
    return undefined;
  }
  // Lista llena = probablemente truncada, y una posicion truncada es la que deja una pata sin su
  // pareja. Antes de arriesgarse a leer un par como una apuesta direccional, mejor decir "no se".
  if (filas.length >= limitePedido) {
    return undefined;
  }

  const porSlug = new Map<string, PosicionAbierta>();
  for (const fila of filas as FilaPosicion[]) {
    // Solo lo que sigue SIN RESOLVER. Una posicion ya redimible o se cobro —y entonces es efectivo, que
    // se cuenta aparte— o no vale nada. Contarla ademas como par seria contar dos veces.
    if (fila.redeemable !== false) {
      continue;
    }
    const slug = typeof fila.slug === "string" ? fila.slug : undefined;
    const size = Number(fila.size);
    const avgPrice = Number(fila.avgPrice);
    const finMs = finDeMercadoMs(fila.endDate);
    const lado = fila.outcomeIndex === 0 ? "UP" : fila.outcomeIndex === 1 ? "DOWN" : undefined;
    // Sin fecha de fin no se sabe cuando olvidarla, y una posicion que nunca se olvida deja al maker
    // mudo para siempre. Se descarta, que es el lado seguro.
    if (!slug || !lado || !Number.isFinite(size) || size <= 0 || !Number.isFinite(avgPrice) || !Number.isFinite(finMs)) {
      continue;
    }
    let entrada = porSlug.get(slug);
    if (!entrada) {
      entrada = { slug, finMs, gastadoUsd: 0, inventario: { UP: 0, DOWN: 0 } };
      porSlug.set(slug, entrada);
    }
    entrada.inventario[lado] += size;
    entrada.gastadoUsd += size * avgPrice;
  }
  return [...porSlug.values()].map((p) => ({ ...p, gastadoUsd: Number(p.gastadoUsd.toFixed(4)) }));
}

/**
 * Lee las posiciones abiertas de una cuenta. `undefined` si no se pudo saber — nunca una lista vacia
 * inventada, por el mismo motivo que arriba.
 */
export async function leerPosicionesAbiertas(args: {
  proxyAddress: string;
  fetchFn?: typeof fetch;
  host?: string;
}): Promise<PosicionAbierta[] | undefined> {
  const fetchFn = args.fetchFn ?? fetch;
  const host = args.host ?? "https://data-api.polymarket.com";
  const url = `${host}/positions?user=${args.proxyAddress}&limit=${LIMITE_POSICIONES}`;
  const respuesta = await fetchFn(url, { signal: AbortSignal.timeout(15_000) });
  if (!respuesta.ok) {
    return undefined;
  }
  return posicionesAbiertas(await respuesta.json(), LIMITE_POSICIONES);
}

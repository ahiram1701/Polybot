import type { BandProgram } from "./bandProbeProgram.js";

/**
 * Ventana de ask efectiva cuando hay un sondeo en curso.
 *
 * Los sondeos existen porque la analitica historica guarda solo el mejor precio del libro, asi que la
 * simulacion asume relleno perfecto y sale optimista justo cerca del cierre. Antes de abrir una banda
 * de verdad hay que comprobar con dinero que los llenados reales se parecen a lo prometido.
 *
 * Lo unico que el sondeo relaja es el PRECIO. El gate de EV, el guardia de spread y el de relleno
 * minimo siguen aplicandose igual. Es deliberado y conservador: como mucho hara que salgan menos
 * sondeos de los que el contrafactual predijo, nunca mas permisivos — y si aun asi entregan el neto por
 * operacion prometido, la conclusion se sostiene.
 */

/** Sondeos por mercado y dia. Acota el coste de comprobar una banda que podria no pagar. */
export const PROBE_MAX_PER_MARKET_DAY = 3;

export interface AskWindow {
  floor: number;
  cap: number;
}

/**
 * La ventana con la que hay que COTIZAR: la configurada, ensanchada hasta cubrir la banda en sondeo.
 *
 * Importa que sea esto y no solo el tope: `getQuote` recibe el tope para calcular la profundidad
 * disponible bajo el, asi que pedir la cotizacion con el tope viejo devolveria "sin liquidez" para
 * justo los precios que se quieren sondear, y el sondeo no ocurriria nunca.
 */
export function effectiveAskWindow(configured: AskWindow, program?: BandProgram): AskWindow {
  if (!program || program.status !== "probing") {
    return configured;
  }
  return {
    floor: Math.min(configured.floor, program.lo),
    cap: Math.max(configured.cap, program.hi),
  };
}

/**
 * `true` cuando esta entrada solo es posible gracias al sondeo — esto es, cae fuera de la ventana
 * configurada pero dentro de la banda en pruebas. Es lo que se cobra al presupuesto.
 */
export function isProbeEntry(ask: number, configured: AskWindow, program?: BandProgram): boolean {
  if (!program || program.status !== "probing") {
    return false;
  }
  const dentroDeLaConfigurada = ask >= configured.floor && ask <= configured.cap;
  const dentroDeLaBanda = ask >= program.lo && ask <= program.hi;
  return !dentroDeLaConfigurada && dentroDeLaBanda;
}

/**
 * Un paso hacia la banda confirmada, NUNCA la banda entera de golpe.
 *
 * Moverse despacio deja margen para que la vigilancia posterior revierta antes de que un error salga
 * caro. Abrir de una vez convierte cada equivocacion en su maximo coste posible.
 */
export function windowAfterConfirmedBand(configured: AskWindow, program: BandProgram, maxStep = 0.05): AskWindow {
  if (program.hi > configured.cap) {
    return { floor: configured.floor, cap: round2(Math.min(program.hi, configured.cap + maxStep)) };
  }
  if (program.lo < configured.floor) {
    return { floor: round2(Math.max(program.lo, configured.floor - maxStep)), cap: configured.cap };
  }
  return configured;
}

function round2(value: number): number {
  return Number(value.toFixed(2));
}

import type { AskBandSummary } from "./askBands.js";

/**
 * Ask-cap auto-tuner: derives the per-market ask ceiling from REALIZED live band performance (the same
 * table the user reads when tuning by hand). The cap becomes the upper edge of the last contiguous
 * band, from the cheapest up, whose realized win rate beats its break-even by a margin — i.e. "allow
 * asks only while paying that price has actually been profitable".
 *
 * Locks (all pre-committed):
 *  - a band only counts with >= MIN_BAND_TRADES resolved trades; the market needs >= MIN_TOTAL_TRADES;
 *  - the recommended cap is clamped to [CAP_FLOOR, CAP_CEILING];
 *  - each application moves the current cap at most MAX_STEP toward the recommendation;
 *  - callers must respect COOLDOWN_MS between applications per market (tracked by the caller).
 */

export const ASK_CAP_TUNER_LOCKS = {
  MIN_BAND_TRADES: 20,
  MIN_TOTAL_TRADES: 60,
  EDGE_MARGIN: 0.03,
  CAP_FLOOR: 0.45,
  CAP_CEILING: 0.85,
  MAX_STEP: 0.05,
  COOLDOWN_MS: 24 * 60 * 60 * 1000,
  // Tuner de ventana: limites de cordura, NO la banda operable. Quien acota de verdad es la ventana
  // BASE de configuracion, porque el tuner solo estrecha desde ella (ver `recommendAskWindow`), asi
  // que estos solo tienen que dejar pasar cualquier base razonable.
  //
  // Estuvieron en [0.20, 0.85] y eso MATO el tuner al mover la banda operable a [0.85, 0.95]: el techo
  // objetivo se recortaba a 0.85, la ventana quedaba de ancho 0 y `recommendAskWindow` devolvia
  // undefined siempre. Peor aun si el guardia de ancho no lo hubiera atrapado — habria bajado el techo
  // de 0.95 a 0.85, cortando justo la franja rentable. Un limite absoluto pensado para una banda
  // centrada en 0.50 no vale para una estrategia que vive en los extremos.
  WINDOW_MIN: 0.01,
  WINDOW_MAX: 0.99,
  // Anti auto-estrangulamiento: el ancho minimo es
  //     max(HARD, min(MIN_WINDOW_WIDTH, ancho_base * RATIO))
  // El termino absoluto manda en ventanas anchas (comportamiento de siempre) pero NUNCA puede exigir
  // mas de la mitad de la ventana aprobada. Sin ese tope, una banda cara [0.85,0.95] — 0.10 de ancho
  // total, menos que el minimo absoluto de 0.15 — rechazaba cualquier recomendacion posible: el
  // candado ya no protegia de estrangularse, simplemente apagaba el tuner.
  MIN_WINDOW_WIDTH: 0.15,
  MIN_WINDOW_WIDTH_RATIO: 0.5,
  /** Suelo duro: por estrecha que sea la base, nunca se acepta una ventana practicamente nula. */
  MIN_WINDOW_WIDTH_HARD: 0.02,
} as const;

/** Fraccion de una banda que puede quedar fuera de la ventana y aun considerarla contenida. */
const BAND_CONTAINMENT_TOLERANCE = 0.15;

export interface AskCapRecommendation {
  /** Cap the bands justify (already clamped to [floor, ceiling]). */
  targetCap: number;
  /** What to apply NOW: current cap moved at most MAX_STEP toward the target. */
  nextCap: number;
  reason: string;
}

export interface AskWindowRecommendation {
  /** Window the bands justify (already clamped). */
  targetFloor: number;
  targetCap: number;
  /** What to apply NOW: each edge moved at most MAX_STEP toward its target. */
  nextFloor: number;
  nextCap: number;
  reason: string;
}

/**
 * Full-window version: moves BOTH edges. The cap-only tuner could not exclude a losing cheap tail —
 * its only lever was tightening the ceiling, so it cut the profitable middle instead (measured
 * -$18 vs a fixed cap). Here the floor rises past leading losing bands and the cap stops at the last
 * contiguous paying band.
 */
/**
 * @param current  Ventana en vigor ahora mismo (de donde parten los pasos graduales).
 * @param baseline Ventana BASE aprobada en configuracion, que el tuner nunca toca. Los recortes se
 *   calculan siempre contra ella, no contra `current`, y por eso el tuner NO ES UN TRINQUETE: si la
 *   evidencia que justificaba un recorte desaparece, el recorte deja de proponerse y la ventana vuelve
 *   sola hacia la base. Sin esto, cada pasada recortaba desde donde habia quedado la anterior, un mal
 *   parche pasajero se volvia permanente, y al dejar de operar en la franja cortada ya nunca llegaban
 *   datos nuevos que pudieran rehabilitarla: la ventana acabaria clavada en el ancho minimo, y quiza
 *   en el minimo equivocado. Puede reabrir HASTA la base, nunca mas alla.
 */
export function recommendAskWindow(
  bands: AskBandSummary,
  current: { floor: number; cap: number },
  baseline: { floor: number; cap: number } = current,
): AskWindowRecommendation | undefined {
  const locks = ASK_CAP_TUNER_LOCKS;
  if (bands.totalTrades < locks.MIN_TOTAL_TRADES) {
    return undefined;
  }

  // Una banda solo puede ABRIR o EXTENDER la ventana si, ademas de superar su break-even por el
  // margen, GANO DINERO de verdad (netUsd > 0). Sin este candado el tuner abria la ventana hacia
  // bandas que el propio ledger mostraba perdedoras: la banda barata [0,0.45) mezcla una zona rentable
  // (~0.30-0.35) con un pozo (~0.40-0.45, 19% de aciertos contra 42.5% de break-even), y el agregado
  // podia pasar el filtro de win-rate mientras el dinero era negativo. El realizado manda.
  // SOLO ESTRECHA. La version anterior abria la ventana hacia las bandas que habian ganado, y perdia
  // $28.55 contra la config fija en replay. El motivo es la asimetria del error: una banda se elige
  // PORQUE gano, asi que las elegidas son desproporcionadamente las que tuvieron suerte, y fuera de
  // muestra revierten (maldicion del ganador). Excluir no tiene ese problema — una banda que perdio
  // dinero de verdad, con muestra, es evidencia utilizable, y equivocarse solo cuesta la ganancia casi
  // nula de una banda neutra. Es la misma asimetria que hace util al veto de realizedGuard.ts.
  const lost = (band: AskBandSummary["bands"][number]) =>
    band.trades >= locks.MIN_BAND_TRADES && band.netUsd < 0;
  const measured = (band: AskBandSummary["bands"][number]) => band.trades >= locks.MIN_BAND_TRADES;

  // Se parte de la BASE, no de la ventana actual: asi los recortes se re-justifican en cada pasada en
  // vez de acumularse. Si ya no hay evidencia, el objetivo vuelve a ser la base.
  let targetFloor = baseline.floor;
  let targetCap = baseline.cap;
  const supporting: string[] = [];
  // Solo bandas contenidas ENTERAS en la ventana. Con solapamiento parcial el neto de la banda incluye
  // operaciones que la ventana ya excluye, y el tuner le achaca al tramo de dentro perdidas de fuera:
  // medido, con suelo de ETH en 0.40 la banda [0.00,0.45] traia -$190.53 casi todos de la zona ya
  // vetada, y el recorte resultante costaba $18.31 fuera de muestra.
  //
  // La contencion se mide con tolerancia porque los bordes de banda no se alinean con los de la
  // ventana: un suelo de 0.01 deja fuera el 2% de la banda [0,0.45] (irrelevante) mientras uno de 0.40
  // deja fuera el 89% (decisivo). Se exige que la parte excluida sea marginal.
  const contained = (band: AskBandSummary["bands"][number]) => {
    const width = band.hi - band.lo;
    if (width <= 0) return false;
    const belowFloor = Math.max(0, baseline.floor - band.lo) / width;
    const aboveCap = Math.max(0, band.hi - baseline.cap) / width;
    return belowFloor <= BAND_CONTAINMENT_TOLERANCE && aboveCap <= BAND_CONTAINMENT_TOLERANCE;
  };
  const inside = bands.bands.filter(contained);

  // Desde abajo: subir el suelo mientras la banda mas barata dentro de la ventana pierda dinero. Se
  // para en la primera que NO perdio o que no tiene muestra: nunca se corta a ciegas.
  for (const band of inside) {
    if (!measured(band) || !lost(band)) break;
    targetFloor = Math.max(targetFloor, band.hi);
    supporting.push(`fuera ${band.lo.toFixed(2)}-${band.hi.toFixed(2)} ($${band.netUsd.toFixed(2)}, n=${band.trades})`);
  }
  // Desde arriba: bajar el techo con el mismo criterio.
  for (const band of [...inside].reverse()) {
    if (band.hi <= targetFloor || !measured(band) || !lost(band)) break;
    targetCap = Math.min(targetCap, band.lo);
    supporting.push(`fuera ${band.lo.toFixed(2)}-${band.hi.toFixed(2)} ($${band.netUsd.toFixed(2)}, n=${band.trades})`);
  }

  // Sin recortes justificados el objetivo ES la base. No se sale antes de tiempo: si la ventana venia
  // recortada de una decision anterior que ya no se sostiene, esto es lo que la devuelve a su sitio.
  const clampedFloor = Math.min(Math.max(targetFloor, locks.WINDOW_MIN), locks.WINDOW_MAX);
  const clampedCap = Math.min(Math.max(targetCap, locks.WINDOW_MIN), locks.WINDOW_MAX);
  // El minimo se mide contra la ventana APROBADA: "no te comas mas de la mitad de la base".
  const baselineWidth = Math.max(0, baseline.cap - baseline.floor);
  const minWidth = Math.max(
    locks.MIN_WINDOW_WIDTH_HARD,
    Math.min(locks.MIN_WINDOW_WIDTH, baselineWidth * locks.MIN_WINDOW_WIDTH_RATIO),
  );
  // Se compara redondeado a centimos porque estos precios se manejan asi: en binario 0.95 - 0.90 da
  // 0.049999999999999934, que "no llega" a un minimo de 0.05 y anulaba la recomendacion por un error
  // de representacion, no por politica.
  if (round2(clampedCap - clampedFloor) < round2(minWidth)) {
    return undefined;
  }
  if (Math.abs(clampedFloor - current.floor) < 0.005 && Math.abs(clampedCap - current.cap) < 0.005) {
    return undefined;
  }
  // El paso tampoco puede ser absoluto: 0.05 sobre una ventana de 0.10 se la come de una pasada, que
  // es justo lo contrario de "moverse despacio y poder revertir".
  const maxStep = Math.min(locks.MAX_STEP, Math.max(0.01, baselineWidth / 2));
  return {
    targetFloor: round2(clampedFloor),
    targetCap: round2(clampedCap),
    nextFloor: stepToward(current.floor, clampedFloor, maxStep),
    nextCap: stepToward(current.cap, clampedCap, maxStep),
    reason:
      supporting.length > 0
        ? `Recorte por bandas perdedoras: ${supporting.join("; ")}`
        : "Sin bandas perdedoras con muestra: se devuelve la ventana a su base configurada",
  };
}

/**
 * Cota inferior de Wilson al 95% para una proporcion. Se prefiere al intervalo normal porque no se
 * rompe con muestras pequeñas ni con tasas cercanas a 0 o 1, que es justo donde vive este problema.
 *
 * Responde a la pregunta correcta: "descontando lo que puede ser suerte, ¿que tasa de acierto puedo
 * defender?". Con 20 operaciones al 55% devuelve ~0.34; con 200 al 55%, ~0.48.
 */
export function wilsonLowerBound(winRate: number, trades: number, z = 1.96): number {
  if (trades <= 0) {
    return 0;
  }
  const p = Math.min(Math.max(winRate, 0), 1);
  const z2 = z * z;
  const denominator = 1 + z2 / trades;
  const centre = p + z2 / (2 * trades);
  const margin = z * Math.sqrt((p * (1 - p)) / trades + z2 / (4 * trades * trades));
  return Math.max(0, (centre - margin) / denominator);
}

function stepToward(from: number, to: number, maxStep: number): number {
  const delta = to - from;
  const step = Math.min(Math.abs(delta), maxStep) * Math.sign(delta);
  return round2(from + step);
}

function round2(value: number): number {
  return Number(value.toFixed(2));
}

export function recommendAskCap(bands: AskBandSummary, currentCap: number): AskCapRecommendation | undefined {
  const locks = ASK_CAP_TUNER_LOCKS;
  if (bands.totalTrades < locks.MIN_TOTAL_TRADES) {
    return undefined;
  }

  // Walk bands from the cheapest up; the cap extends while each SUFFICIENTLY SAMPLED band keeps beating
  // its break-even. Thin bands neither extend nor break the chain (no evidence either way).
  let targetCap: number = locks.CAP_FLOOR;
  const supporting: string[] = [];
  for (const band of bands.bands) {
    if (band.lo >= locks.CAP_CEILING) {
      break;
    }
    if (band.trades < locks.MIN_BAND_TRADES) {
      continue;
    }
    const edge = (band.winRate ?? 0) - (band.breakEvenRate ?? 1);
    if (edge >= locks.EDGE_MARGIN) {
      targetCap = Math.max(targetCap, Math.min(band.hi, locks.CAP_CEILING));
      supporting.push(`${band.lo.toFixed(2)}-${band.hi.toFixed(2)} edge +${(edge * 100).toFixed(0)}pp (n=${band.trades})`);
    } else if (band.lo >= targetCap) {
      // The first sufficiently-sampled band at/above the current frontier that does NOT pay stops the walk.
      break;
    }
  }

  const clampedTarget = Math.min(Math.max(targetCap, locks.CAP_FLOOR), locks.CAP_CEILING);
  if (Math.abs(clampedTarget - currentCap) < 0.005) {
    return undefined;
  }
  const step = Math.min(Math.abs(clampedTarget - currentCap), locks.MAX_STEP);
  const nextCap = Number((currentCap + Math.sign(clampedTarget - currentCap) * step).toFixed(2));
  return {
    targetCap: Number(clampedTarget.toFixed(2)),
    nextCap,
    reason:
      supporting.length > 0
        ? `Bandas rentables: ${supporting.join("; ")}`
        : `Ninguna banda con n>=${locks.MIN_BAND_TRADES} paga su break-even + ${locks.EDGE_MARGIN * 100}pp`,
  };
}

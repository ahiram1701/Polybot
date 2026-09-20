/**
 * El contrafactual del freno: que habria pasado si el cortacircuitos hubiera estado encendido.
 *
 * POR QUE ES EXACTO. Las operaciones de papel no mueven el mercado, asi que saltarse una entrada no cambia
 * el resultado de las demas: basta con no contarla, y el neto es la suma de las que quedan. Esto NO valdria
 * en live, donde una orden que no se manda si cambia el libro que ve la siguiente.
 *
 * REGLA DURA: aqui no se reimplementa el freno, se LLAMA a `evaluateDirectionalRiskHalt`, el mismo que
 * aplican el bucle y la UI. Tener dos copias de esa condicion ya hizo que el chip de riesgo anunciara un
 * halt que el bucle no estaba aplicando.
 */
import { calculateTradeFeeUsd, defaultTakerFeeRateBps } from "./fees.js";
import { calculateTradePnl, tradeClosedAtMs } from "./pnl.js";
import { evaluateDirectionalRiskHalt, type RiskLimits } from "./riskCircuitBreaker.js";
import { dayKeyInTimeZone } from "./timezone.js";
import type { TradeAttempt } from "./types.js";

export interface Regla {
  nombre: string;
  limites: RiskLimits;
  /** Tope de gasto del dia, el otro freno que ya existe. `0` = sin tope. */
  topeGastoDiarioUsd: number;
  /**
   * Parar el dia cuando lo ganado HOY llegue a esto. `0` = no parar nunca por ir ganando.
   *
   * Esto NO existe en el bot. `evaluateRiskCircuitBreaker` sabe parar cuando se pierde, nunca cuando se
   * gana, asi que aqui no hay funcion de produccion a la que llamar y esta calculado a mano — con la
   * misma disciplina que el resto: solo cuenta lo que ya habia CERRADO al decidir cada entrada.
   *
   * Un dia puede terminar en rojo aunque se pare en verde: las posiciones ya abiertas siguen su curso y
   * resuelven despues. Eso esta simulado, no idealizado.
   */
  objetivoDiarioUsd?: number;
}

/** Como acabo un dia concreto. `picoUsd` es lo mas alto que estuvo el acumulado DEL DIA. */
export interface DiaSimulado {
  dia: string;
  n: number;
  netoUsd: number;
  picoUsd: number;
  /** Paro por objetivo alcanzado. */
  paradoEnVerde: boolean;
}

export interface Resultado {
  n: number;
  saltadas: number;
  netoUsd: number;
  caidaMaxUsd: number;
  minimoUsd: number;
  comisionUsd: number;
  diasConFreno: number;
  dias: DiaSimulado[];
}

/**
 * Lo que habria pasado con esta regla, decidiendo entrada a entrada.
 *
 * El orden es el de CREACION, que es cuando el bucle decide, y el freno se evalua con lo que habia
 * cerrado en ese instante: `evaluateDirectionalRiskHalt` filtra por dia y por modo por su cuenta.
 */
export function simular(
  candidatas: readonly TradeAttempt[],
  regla: Regla,
  timeZone: string | undefined,
): Resultado {
  const ejecutadas: TradeAttempt[] = [];
  const gastoPorDia = new Map<string, number>();
  const diasConFreno = new Set<string>();
  let saltadas = 0;

  // Lo ya CERRADO en el instante de decidir, agrupado por el dia de cierre.
  //
  // Dos motivos, y el primero es de correccion. En produccion el bucle solo ve las posiciones que ya
  // resolvieron: una abierta no tiene `resolved` y el freno no la cuenta. Aqui las operaciones traen el
  // resultado puesto desde el principio, asi que pasarlas todas dejaria al freno mirar el futuro y frenar
  // por perdidas que aun no han ocurrido. El segundo es de velocidad: `evaluateDirectionalRiskHalt`
  // recorre y puntua todo lo que se le da, y pasarle el historial entero en cada decision costaba mas de
  // diez minutos de reloj. Filtrar por dia de cierre no cambia el resultado —el freno filtra igual por
  // dentro— y lo deja en segundos.
  const visiblesPorDia = new Map<string, TradeAttempt[]>();
  const pendientes: TradeAttempt[] = [];
  /** Lo ganado HOY con lo ya cerrado. Es lo que un operador humano vería en la pantalla al decidir. */
  const realizadoPorDia = new Map<string, number>();
  const diasParadosEnVerde = new Set<string>();
  const hacerVisibles = (hastaMs: number): void => {
    for (let i = pendientes.length - 1; i >= 0; i -= 1) {
      const cerradoMs = tradeClosedAtMs(pendientes[i]);
      if (cerradoMs === undefined || cerradoMs > hastaMs) continue;
      const diaCierre = dayKeyInTimeZone(cerradoMs, timeZone);
      visiblesPorDia.set(diaCierre, [...(visiblesPorDia.get(diaCierre) ?? []), pendientes[i]]);
      realizadoPorDia.set(diaCierre, (realizadoPorDia.get(diaCierre) ?? 0) + (calculateTradePnl(pendientes[i]).netUsd ?? 0));
      pendientes.splice(i, 1);
    }
  };

  for (const candidata of [...candidatas].sort((izq, der) => izq.createdAtMs - der.createdAtMs)) {
    const dia = dayKeyInTimeZone(candidata.createdAtMs, timeZone);
    hacerVisibles(candidata.createdAtMs);
    const halt = evaluateDirectionalRiskHalt({
      trades: visiblesPorDia.get(dia) ?? [],
      directionalMode: "sim",
      limits: { ...regla.limites, timeZone },
      nowMs: candidata.createdAtMs,
    });
    const gastado = gastoPorDia.get(dia) ?? 0;
    const sinHueco = regla.topeGastoDiarioUsd > 0 && gastado + candidata.amountUsd > regla.topeGastoDiarioUsd;
    // El dia ya dio lo que tenia que dar. Dos decisiones que no son obvias:
    //
    // 1. Se mira lo REALIZADO, no lo que esta en el aire: una posicion abierta todavia puede acabar en
    //    cualquier sitio, y contarla seria cerrar el dia con dinero que no esta cobrado.
    // 2. UNA VEZ ALCANZADO, EL DIA QUEDA CERRADO. No se vuelve a abrir aunque las posiciones que seguian
    //    en vuelo hundan el realizado por debajo del objetivo. Reabrir seria lo peor de los dos mundos:
    //    el dia ya ha perdido lo ganado y ademas vuelve a jugar para recuperarlo, que es exactamente la
    //    conducta que esta regla existe para impedir. Lo destapo un test, no el diseño.
    const objetivo = regla.objetivoDiarioUsd ?? 0;
    const objetivoHecho = objetivo > 0 && (diasParadosEnVerde.has(dia) || (realizadoPorDia.get(dia) ?? 0) >= objetivo);
    if (halt.tripped || sinHueco || objetivoHecho) {
      saltadas += 1;
      if (halt.tripped) diasConFreno.add(dia);
      if (objetivoHecho) diasParadosEnVerde.add(dia);
      continue;
    }
    gastoPorDia.set(dia, gastado + candidata.amountUsd);
    ejecutadas.push(candidata);
    // Aun no ha cerrado: entra en la cola y se hara visible al freno cuando su ventana resuelva.
    pendientes.push(candidata);
  }

  // La curva se recorre por CIERRE, no por creacion: el dinero se gana cuando la ventana resuelve.
  const porCierre = [...ejecutadas].sort((izq, der) => (tradeClosedAtMs(izq) ?? 0) - (tradeClosedAtMs(der) ?? 0));
  let acumulado = 0;
  let pico = 0;
  let caidaMax = 0;
  let minimo = 0;
  let comision = 0;
  // La cuenta del dia se lleva aparte: es la que decide si el dia cerro en verde, que es otra pregunta
  // distinta de la caida del acumulado de todo el periodo.
  const porDia = new Map<string, { n: number; netoUsd: number; picoUsd: number }>();
  for (const trade of porCierre) {
    const netoOp = calculateTradePnl(trade).netUsd ?? 0;
    acumulado += netoOp;
    comision += calculateTradeFeeUsd({
      shares: trade.estimatedShares,
      price: trade.bestAsk ?? 0,
      feeRateBps: defaultTakerFeeRateBps(trade.asset),
    });
    if (acumulado > pico) pico = acumulado;
    if (pico - acumulado > caidaMax) caidaMax = pico - acumulado;
    if (acumulado < minimo) minimo = acumulado;

    const dia = dayKeyInTimeZone(tradeClosedAtMs(trade) ?? trade.createdAtMs, timeZone);
    const previo = porDia.get(dia) ?? { n: 0, netoUsd: 0, picoUsd: 0 };
    const neto = previo.netoUsd + netoOp;
    porDia.set(dia, { n: previo.n + 1, netoUsd: neto, picoUsd: Math.max(previo.picoUsd, neto) });
  }

  return {
    n: ejecutadas.length,
    saltadas,
    netoUsd: acumulado,
    caidaMaxUsd: caidaMax,
    minimoUsd: minimo,
    comisionUsd: comision,
    diasConFreno: diasConFreno.size,
    dias: [...porDia.entries()]
      .sort(([izq], [der]) => izq.localeCompare(der))
      .map(([dia, v]) => ({ dia, ...v, paradoEnVerde: diasParadosEnVerde.has(dia) })),
  };
}

/** Las entradas que la regla habria SALTADO. Sirve para ver si el freno tira buenas o malas. */
export function netoDeLasSaltadas(
  candidatas: readonly TradeAttempt[],
  regla: Regla,
  timeZone: string | undefined,
): number {
  const total = candidatas.reduce((suma, trade) => suma + (calculateTradePnl(trade).netUsd ?? 0), 0);
  return total - simular(candidatas, regla, timeZone).netoUsd;
}

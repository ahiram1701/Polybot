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
}

export interface Resultado {
  n: number;
  saltadas: number;
  netoUsd: number;
  caidaMaxUsd: number;
  minimoUsd: number;
  comisionUsd: number;
  diasConFreno: number;
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
  const hacerVisibles = (hastaMs: number): void => {
    for (let i = pendientes.length - 1; i >= 0; i -= 1) {
      const cerradoMs = tradeClosedAtMs(pendientes[i]);
      if (cerradoMs === undefined || cerradoMs > hastaMs) continue;
      const diaCierre = dayKeyInTimeZone(cerradoMs, timeZone);
      visiblesPorDia.set(diaCierre, [...(visiblesPorDia.get(diaCierre) ?? []), pendientes[i]]);
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
    if (halt.tripped || sinHueco) {
      saltadas += 1;
      if (halt.tripped) diasConFreno.add(dia);
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
  for (const trade of porCierre) {
    acumulado += calculateTradePnl(trade).netUsd ?? 0;
    comision += calculateTradeFeeUsd({
      shares: trade.estimatedShares,
      price: trade.bestAsk ?? 0,
      feeRateBps: defaultTakerFeeRateBps(trade.asset),
    });
    if (acumulado > pico) pico = acumulado;
    if (pico - acumulado > caidaMax) caidaMax = pico - acumulado;
    if (acumulado < minimo) minimo = acumulado;
  }

  return {
    n: ejecutadas.length,
    saltadas,
    netoUsd: acumulado,
    caidaMaxUsd: caidaMax,
    minimoUsd: minimo,
    comisionUsd: comision,
    diasConFreno: diasConFreno.size,
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

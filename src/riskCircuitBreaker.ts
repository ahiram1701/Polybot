import { calculateTradePnl, isWinningTrade, tradeClosedAtMs } from "./pnl.js";
import { dailySpendKey, localDayRange } from "./time.js";
import type { Mode, TradeAttempt } from "./types.js";

export interface RiskLimits {
  /**
   * Tope de perdida del dia: cuando lo PERDIDO hoy llega a esto, se deja de entrar hasta mañana.
   *
   * Es el espejo del objetivo y se comporta igual que el: sobre el dia ENTERO desde el reinicio manual,
   * sin enfriamiento, y sin soltarse si lo que seguia abierto recupera el dia despues.
   *
   * Hasta el 2026-10-10 vivia dentro del bucle de re-armado, y con `cooldownHours: 2` no era un tope del
   * dia sino de cada tramo de 2 h: al re-armarse empezaba de cero y dejaba perder el tope varias veces.
   * Con el objetivo en +8 $ eso dio dias verdes de +9,32 $ de media y rojos de -11,18 $, el peor en
   * -28,53 $. Los dos limites se llamaban "diarios" y solo uno lo era.
   */
  maxDailyLossUsd?: number;
  maxConsecutiveLosses?: number;
  /**
   * Objetivo del dia: cuando lo GANADO hoy llega a esto, se deja de entrar hasta mañana.
   *
   * Es el unico limite que para por ir BIEN, y por eso se comporta distinto de los otros dos:
   *
   * - **No usa enfriamiento.** Un objetivo cumplido no se "enfria": dura hasta el corte del dia. Con
   *   enfriamiento de 2 h el dia volveria a abrirse dos horas despues, que es lo contrario de asegurar
   *   lo ganado.
   * - **No se suelta si el dia se tuerce despues.** Las posiciones que seguian abiertas al alcanzarlo
   *   pueden hundir el neto por debajo del objetivo; el dia sigue cerrado igual. Reabrir seria haber
   *   perdido lo ganado Y volver a jugar para recuperarlo, que es la conducta que esto evita.
   *
   * Esto NO sube la ganancia esperada: si cada entrada tiene ventaja, dejar de entrar quita entradas
   * buenas. Lo que compra es regularidad, y se paga en media. Medido en `cerrarEnVerde.ts`.
   */
  dailyProfitTargetUsd?: number;
  // Hours the STREAK halt lasts after tripping; it then RE-ARMS ITSELF with a clean slate (losses
  // before the re-arm moment stop counting, exactly like a manual reset). 0 = legacy behavior: halted
  // for the rest of the day. The two DAILY limits (loss cap and profit target) never use it.
  cooldownHours?: number;
  // Timezone defining the metrics day (undefined = legacy UTC cut).
  timeZone?: string;
}

export type RiskHaltReason = "daily_loss_limit" | "consecutive_losses" | "daily_profit_target";

export interface RiskHaltStatus {
  tripped: boolean;
  reason?: RiskHaltReason;
  dailyLossUsd: number;
  /** Lo realizado hoy, con signo. Positivo es ganancia: es lo que mira el objetivo diario. */
  dailyNetUsd: number;
  consecutiveLosses: number;
  /**
   * La racha en el momento en que salto el freno. `consecutiveLosses` es la racha de AHORA: si despues
   * del disparo cierra algo en verde vuelve a 0, y el aviso decia "0 perdidas seguidas" de un freno que
   * salto por 2. Solo presente cuando el freno salto por racha.
   */
  streakAtTrip?: number;
  // When a cooldown-based halt will auto-re-arm (epoch ms). Absent when not tripped or in legacy mode.
  resumeAtMs?: number;
}

/**
 * Risk circuit breaker: halts trading (not the bot/analytics) when realized losses cross a threshold.
 * With a cooldown configured, the halt lasts `cooldownHours` from the moment of the trip and then
 * re-arms automatically with a clean baseline (a fixed rest-of-day halt punished a 00:30 trip with a
 * ~23h pause but a 23:50 trip with 10 minutes — arbitrary). Metrics are scoped to the current calendar
 * day in the configured timezone (legacy UTC when unset) and are derived from the trade log (no
 * separate persisted flag — robust across restarts).
 */
export function evaluateRiskCircuitBreaker(
  trades: TradeAttempt[],
  mode: Mode,
  limits: RiskLimits,
  nowMs = Date.now(),
  haltResetAtMs = 0,
): RiskHaltStatus {
  // Rango del dia en epoch ms, calculado UNA vez. Antes se formateaba la fecha de CADA trade para
  // compararla con la de hoy: con zona horaria eso cuesta ~0,32 ms por llamada y, con 1.323 trades,
  // salian 164,7 ms por iteracion del bucle — el 16% de cada segundo, creciendo con el historial.
  // Comparar numeros es exactamente equivalente y practicamente gratis.
  const hoy = localDayRange(nowMs, limits.timeZone);
  // `tradeClosedAtMs` y no `resolved.resolvedAtMs`: una posicion vendida antes de tiempo no tiene
  // `resolved`, asi que filtrar por ese campo dejaba fuera del cortacircuitos precisamente las
  // perdidas que se acaban de realizar. Ninguna de ellas contaba ni en la perdida diaria ni en la
  // racha, que es lo contrario de lo que este freno existe para hacer.
  const resolvedToday = trades
    .filter((trade) => {
      if (trade.mode !== mode) {
        return false;
      }
      const cerradoMs = tradeClosedAtMs(trade);
      return cerradoMs !== undefined && cerradoMs >= hoy.startMs && cerradoMs < hoy.endMs;
    })
    .sort((left, right) => (tradeClosedAtMs(left) ?? 0) - (tradeClosedAtMs(right) ?? 0));

  const cooldownMs = Math.max(0, limits.cooldownHours ?? 0) * 3_600_000;

  // EL OBJETIVO DEL DIA SE MIDE APARTE, Y SOBRE EL DIA ENTERO.
  //
  // No puede colgar del bucle de abajo. Ese bucle avanza la linea base cada vez que un freno de PERDIDA
  // se re-arma, que para ellos es lo correcto —"vuelta a empezar con la cuenta a cero"— pero para el
  // objetivo es falso: haria que midiera un TROZO del dia en vez del dia.
  //
  // No es teorico. El 2026-09-21 la racha de 2 salto a las 10:10 con el dia en -12,21 $; su enfriamiento
  // movio la linea base a las 12:10; desde ahi el contador del objetivo empezo de cero, llego a +8,98 $
  // a las 18:35 y el bot anuncio "objetivo cumplido" y cerro el dia... con el dia en -3,23 $. Justo lo
  // que esta funcion existe para impedir.
  //
  // Lo unico que mueve la linea base del objetivo es un reinicio MANUAL (`haltResetAtMs`), que es lo que
  // significa "empezar a contar de nuevo".
  //
  // EL TOPE DE PERDIDA DEL DIA VIVE AQUI POR LA MISMA RAZON, desde el 2026-10-10. Dentro del bucle, cada
  // re-armado de la racha le ponia la cuenta a cero y el "tope diario" pasaba a ser un tope por tramo de
  // 2 h. Son los dos limites que hablan del DIA, y los dos se miden igual.
  //
  // Si se cruzan los dos, manda el que llego ANTES: es el motivo real de que el dia dejara de operar.
  const objetivoUsd = limits.dailyProfitTargetUsd ?? 0;
  const topePerdidaUsd = limits.maxDailyLossUsd ?? 0;
  const delDia = resolvedToday.filter((trade) => (tradeClosedAtMs(trade) ?? 0) > haltResetAtMs);
  let netoDelDia = 0;
  let diaCerrado: RiskHaltReason | undefined;
  for (const trade of delDia) {
    netoDelDia += calculateTradePnl(trade).netUsd ?? 0;
    // Recorrer el dia entero es lo que hace que no se suelte: una vez cruzado, da igual lo que haga el
    // neto despues.
    if (diaCerrado === undefined) {
      if (topePerdidaUsd > 0 && -netoDelDia >= topePerdidaUsd) {
        diaCerrado = "daily_loss_limit";
      } else if (objetivoUsd > 0 && netoDelDia >= objetivoUsd) {
        diaCerrado = "daily_profit_target";
      }
    }
  }
  // Lo que la pantalla llama "perdida hoy": la del DIA, nunca la del trozo desde el ultimo re-armado.
  const perdidaDelDia = Math.max(0, -netoDelDia);

  // Baseline: losses before a manual reset never count. With a cooldown, every STREAK trip whose cooldown
  // has already elapsed also advances the baseline (auto re-arm), possibly several times in one day.
  let baseline = haltResetAtMs;
  for (;;) {
    const evaluation = evaluarRacha(resolvedToday, limits, baseline);
    if (diaCerrado !== undefined) {
      return {
        tripped: true,
        reason: diaCerrado,
        dailyLossUsd: perdidaDelDia,
        dailyNetUsd: netoDelDia,
        consecutiveLosses: evaluation.consecutiveLosses,
      };
    }
    if (!evaluation.tripped || cooldownMs === 0) {
      return {
        tripped: evaluation.tripped,
        reason: evaluation.tripped ? "consecutive_losses" : undefined,
        dailyLossUsd: perdidaDelDia,
        dailyNetUsd: netoDelDia,
        consecutiveLosses: evaluation.consecutiveLosses,
        ...(evaluation.tripped ? { streakAtTrip: evaluation.streakAtTrip } : {}),
      };
    }
    const resumeAtMs = evaluation.trippedAtMs + cooldownMs;
    if (nowMs < resumeAtMs) {
      return {
        tripped: true,
        reason: "consecutive_losses",
        dailyLossUsd: perdidaDelDia,
        dailyNetUsd: netoDelDia,
        consecutiveLosses: evaluation.consecutiveLosses,
        streakAtTrip: evaluation.streakAtTrip,
        resumeAtMs,
      };
    }
    baseline = resumeAtMs;
  }
}

/** Margen para considerar que dos trades de la misma ventana cerraron "a la vez". */
const CIERRE_CONJUNTO_MS = 60_000;

/**
 * Agrupa los trades que cierran JUNTOS: misma ventana (`endMs`) y cierre a menos de un minuto.
 *
 * Con tres mercados de 5 min, varios trades resuelven en el mismo instante y su orden relativo es el de
 * la lista que llegue. Recorrerlos uno a uno hacia que la racha dependiera de ese orden: el 2026-10-11 a
 * las 16:55 UTC cerraron DOGE (gano) y ETH (perdio) en el mismo milisegundo; el bot los vio
 * perdida-perdida-ganancia y freno el direccional 2 h, mientras la UI, con la lista al reves, los vio
 * perdida-ganancia-perdida y decia que no habia freno. Ahora la ventana es UNA unidad: su neto decide.
 *
 * El margen y no la igualdad exacta porque en 6 de 92 ventanas reales los cierres se separaron hasta
 * ~1,2 s. Una salida anticipada cierra minutos antes del final y queda como suceso propio.
 */
function agruparCierresConjuntos(trades: TradeAttempt[]): { closedAtMs: number; netUsd: number }[] {
  const grupos: { endMs: number; firstClosedAtMs: number; closedAtMs: number; netUsd: number }[] = [];
  for (const trade of trades) {
    const closedAtMs = tradeClosedAtMs(trade) ?? 0;
    const netUsd = calculateTradePnl(trade).netUsd ?? 0;
    let grupo: (typeof grupos)[number] | undefined;
    for (let index = grupos.length - 1; index >= 0 && !grupo; index -= 1) {
      const candidato = grupos[index];
      if (candidato.endMs === trade.endMs && closedAtMs - candidato.firstClosedAtMs <= CIERRE_CONJUNTO_MS) {
        grupo = candidato;
      }
    }
    if (grupo) {
      grupo.netUsd += netUsd;
      grupo.closedAtMs = Math.max(grupo.closedAtMs, closedAtMs);
    } else {
      grupos.push({ endMs: trade.endMs, firstClosedAtMs: closedAtMs, closedAtMs, netUsd });
    }
  }
  return grupos.sort((left, right) => left.closedAtMs - right.closedAtMs);
}

function evaluarRacha(
  resolvedToday: TradeAttempt[],
  limits: RiskLimits,
  baselineMs: number,
): { tripped: boolean; trippedAtMs: number; consecutiveLosses: number; streakAtTrip: number } {
  // Solo la RACHA. Los dos limites del dia se evaluan fuera, sobre el dia entero, porque esta funcion se
  // llama con la linea base ya avanzada por los re-armados y les enseñaria solo un trozo del dia.
  const maxConsecutiveLosses = limits.maxConsecutiveLosses ?? 0;
  const counted = resolvedToday.filter((trade) => (tradeClosedAtMs(trade) ?? 0) > baselineMs);

  // Walk chronologically so we know the exact moment the streak crossed (the cooldown anchors there).
  // Cada paso es una ventana, no un trade: ver `agruparCierresConjuntos`. Un grupo de un solo trade se
  // juzga igual que antes (`isWinningTrade` es neto > 0).
  let consecutiveLosses = 0;
  let tripped = false;
  let trippedAtMs = 0;
  let streakAtTrip = 0;
  for (const grupo of agruparCierresConjuntos(counted)) {
    consecutiveLosses = grupo.netUsd > 0 ? 0 : consecutiveLosses + 1;
    if (!tripped && maxConsecutiveLosses > 0 && consecutiveLosses >= maxConsecutiveLosses) {
      tripped = true;
      trippedAtMs = grupo.closedAtMs;
      streakAtTrip = consecutiveLosses;
    }
  }

  return { tripped, trippedAtMs, consecutiveLosses, streakAtTrip };
}

/**
 * El cortacircuitos del DIRECCIONAL, tal y como lo aplica el bucle.
 *
 * Existe porque la UI y el runner lo calculaban por separado y decian cosas distintas: el runner
 * excluia los trades de arbitraje y usaba el modo del direccional (`modeFor("dir")`), mientras
 * `buildSnapshot` pasaba TODOS los trades y el modo GLOBAL. Con arbitraje en live y direccional en sim
 * —que es justo el reparto que recomienda el manual— el chip de riesgo podia anunciar un halt que el
 * bucle no estaba aplicando, o callar uno que si.
 *
 * Las dos exclusiones no son un detalle de implementacion, son la politica:
 *
 * - **Fuera el arbitraje.** Un par completo redime $1/set gane quien gane; pararlo por una racha ajena
 *   seria dejar de recoger dinero sin riesgo por un motivo que no le toca.
 * - **Su modo, no el global.** Si no, una racha de perdidas en PAPEL podria frenar dinero real; y al
 *   reves es peor todavia: unas ganancias simuladas tapando perdidas reales.
 *
 * Quien lo dibuje y quien lo aplique tienen que llamar aqui. Duplicar la condicion es como se produjo
 * la divergencia.
 */
export function evaluateDirectionalRiskHalt(args: {
  trades: TradeAttempt[];
  directionalMode: Mode;
  limits: RiskLimits;
  nowMs?: number;
  /** Marcadores de re-armado por modo (`state.getRiskHaltResetAtMs()`). */
  haltResetAtMsByMode?: Partial<Record<Mode, number>>;
}): RiskHaltStatus {
  return evaluateRiskCircuitBreaker(
    args.trades.filter((trade) => trade.kind !== "arb"),
    args.directionalMode,
    args.limits,
    args.nowMs ?? Date.now(),
    args.haltResetAtMsByMode?.[args.directionalMode] ?? 0,
  );
}

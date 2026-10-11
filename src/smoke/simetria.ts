/**
 * ¿Cuanto debe valer el tope de perdida del dia, ahora que por fin es del dia?
 *
 *   npx tsx src/smoke/simetria.ts
 *
 * EL CONTEXTO. Del 21-sep al 10-oct, con el objetivo diario en +8 $, los dias verdes cerraron en +9,32 $
 * de media con 20 operaciones, y los rojos en -11,18 $ con 57; el peor, -28,53 $. El objetivo tapaba las
 * ganancias y nada tapaba las perdidas: `maxDailyLossUsd` estaba en 0, y aunque se encendiera, vivia
 * dentro del bucle de re-armado de la racha y con enfriamiento de 2 h era un tope por tramo de 2 h, no
 * por dia. Desde el 2026-10-10 se mide sobre el dia entero, como el objetivo. Falta elegir el valor.
 *
 * LA DECISION DE CERRAR LA SIMETRIA YA ESTA TOMADA. Esto no pregunta "si", pregunta "cuanto" y "a que
 * precio". Si ningun tope mejora el peor tramo, se dice: la simetria se compra, no sale gratis.
 *
 * EL UNIVERSO: el replay del favorito con la configuracion viva sobre TODA la analitica desde el regimen
 * TWAP, sin ningun freno — son las entradas que la estrategia QUERRIA hacer. No se usa el ledger real:
 * ese ya pasó por los frenos de produccion, y volver a frenarlo cuenta dos veces lo mismo.
 *
 * LA ZONA: la del sistema. Desde el 2026-10-03 el bot corre en Windows nativo con `timezone: auto`, y
 * los dias cortan a la medianoche de esta maquina. `frenoRiesgo.ts` forzaba UTC porque entonces mandaba
 * el contenedor; aqui ya no.
 *
 * ================================  CRITERIO, ESCRITO ANTES DEL DATO  ================================
 *
 * Candidatos: la configuracion de hoy (racha 2, enfriamiento 2 h, objetivo 8 $) con el tope de perdida
 * en {0, 5, 8, 10, 12, 15, 20} $. El 0 es la referencia: lo que corre hoy.
 *
 * Unidad: el DIA. Un freno diario decide por dias, asi que los tramos son seis grupos CRONOLOGICOS de
 * dias enteros —los mismos cortes para todos los candidatos— y el bootstrap remuestrea dias.
 *
 * Regla: gana el tope con el MAYOR PEOR-TRAMO de neto. Nunca la media: la media la puede poner un solo
 * tramo afortunado. Empate a menos de 0,50 $ → el tope mas BAJO, que protege mas por el mismo precio.
 *
 * Lo que se reporta y NO elige: neto total, peor dia, dias rojos, caida maxima, y el bootstrap por dias
 * de la diferencia contra hoy. Si el elegido no mejora el peor tramo de hoy, se dice tal cual.
 */
import { simular, type Regla, type Resultado } from "../frenoSimulacion.js";
import { bootstrapCIPorBloques } from "../tradeStats.js";
import { cargarUniverso, STAKE_USD, tramoPorDia } from "./universoReplay.js";

const TRAMOS = 6;
const TOPES = [0, 5, 8, 10, 12, 15, 20];
const EMPATE_USD = 0.5;

interface Medida {
  tope: number;
  r: Resultado;
  netoPorDia: Map<string, number>;
  tramos: number[];
  peorTramo: number;
  peorDia: number;
  diasRojos: number;
}

async function main(): Promise<void> {
  // La zona sale del universo ya resuelta a un NOMBRE. Hasta el 2026-10-10 se pasaba `undefined` al
  // simulador, y alli `undefined` significa dos zonas distintas: la tabla que eligio el tope de 12 $ salio
  // de ahi (ver `simular`).
  const { efectiva, timeZone, ops, ventanas, dias: todosLosDias } = await cargarUniverso();
  const zonaVisible = timeZone;
  const tramoDe = tramoPorDia(todosLosDias, TRAMOS);

  const medidas: Medida[] = TOPES.map((tope) => {
    const regla: Regla = {
      nombre: tope === 0 ? "HOY (sin tope)" : `tope ${tope}$`,
      // La configuracion viva, para que la referencia sea lo que de verdad corre.
      limites: {
        maxConsecutiveLosses: efectiva.maxConsecutiveLosses ?? 0,
        cooldownHours: efectiva.riskHaltCooldownHours ?? 0,
        dailyProfitTargetUsd: efectiva.dailyProfitTargetUsd ?? 0,
        maxDailyLossUsd: tope,
      },
      topeGastoDiarioUsd: 0,
      // El objetivo lo aplica ya el freno de produccion; el calculo a mano del simulador, apagado.
      objetivoDiarioUsd: 0,
    };
    const r = simular(ops, regla, timeZone);
    const netoPorDia = new Map(r.dias.map((d) => [d.dia, d.netoUsd]));
    const tramos = Array.from({ length: TRAMOS }, () => 0);
    for (const [dia, neto] of netoPorDia) tramos[tramoDe.get(dia) ?? TRAMOS - 1] += neto;
    return {
      tope,
      r,
      netoPorDia,
      tramos,
      peorTramo: Math.min(...tramos),
      peorDia: Math.min(...r.dias.map((d) => d.netoUsd)),
      diasRojos: r.dias.filter((d) => d.netoUsd < 0).length,
    };
  });
  const hoy = medidas[0];

  const usd = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}`;
  console.log(`SIMETRIA — tope de perdida del dia · zona ${zonaVisible} · stake ${STAKE_USD}$`);
  console.log(
    `universo: ${ops.length} entradas del replay sobre ${ventanas} ventanas, ${todosLosDias.length} dias ` +
      `(${todosLosDias[0]} → ${todosLosDias.at(-1)})`,
  );
  console.log(
    `config viva: racha ${efectiva.maxConsecutiveLosses ?? 0}, enfriamiento ${efectiva.riskHaltCooldownHours ?? 0} h, ` +
      `objetivo ${efectiva.dailyProfitTargetUsd ?? 0}$`,
  );
  const cortes = Array.from({ length: TRAMOS }, (_, t) => todosLosDias.find((d) => tramoDe.get(d) === t));
  console.log(`tramos empiezan: ${cortes.join("  ")}\n`);

  console.log(
    "regla            neto    peor tramo   " +
      Array.from({ length: TRAMOS }, (_, i) => `  T${i + 1}  `).join("") +
      "  peor dia  rojos  caida max  saltadas",
  );
  for (const m of medidas) {
    console.log(
      [
        (m.tope === 0 ? "HOY (sin tope)" : `tope ${m.tope}$`).padEnd(14),
        usd(m.r.netoUsd).padStart(8),
        usd(m.peorTramo).padStart(10),
        "  ",
        m.tramos.map((v) => usd(v).padStart(7)).join(""),
        usd(m.peorDia).padStart(10),
        `${m.diasRojos}/${m.r.dias.length}`.padStart(7),
        m.r.caidaMaxUsd.toFixed(2).padStart(10),
        String(m.r.saltadas).padStart(9),
      ].join(" "),
    );
  }

  // LA REGLA, tal y como esta escrita arriba.
  const ordenadas = [...medidas].sort((a, b) => b.peorTramo - a.peorTramo);
  const mejor = ordenadas[0].peorTramo;
  const elegida = medidas.filter((m) => m.peorTramo >= mejor - EMPATE_USD && m.tope > 0).sort((a, b) => a.tope - b.tope)[0]
    ?? [...medidas].filter((m) => m.tope > 0).sort((a, b) => b.peorTramo - a.peorTramo)[0];

  console.log(`\nmejor peor-tramo: ${usd(mejor)} (${ordenadas[0].tope === 0 ? "HOY" : `tope ${ordenadas[0].tope}$`})`);
  console.log(`ELEGIDO por la regla: tope ${elegida.tope}$  (peor tramo ${usd(elegida.peorTramo)} frente a ${usd(hoy.peorTramo)} de hoy)`);
  console.log(
    elegida.peorTramo >= hoy.peorTramo
      ? "Mejora o iguala el peor tramo de hoy."
      : `NO mejora el peor tramo de hoy: la simetria cuesta ${usd(elegida.peorTramo - hoy.peorTramo)} en el peor tramo.`,
  );

  // Bootstrap por DIAS de la diferencia contra hoy. Cada dia es un bloque: la regla decide por dias, y
  // las operaciones de un mismo dia no son independientes (el propio freno las encadena).
  console.log("\n=== diferencia contra HOY, por dias (bootstrap por bloques = dias) ===");
  for (const m of medidas.slice(1)) {
    const deltas = todosLosDias.map((d) => (m.netoPorDia.get(d) ?? 0) - (hoy.netoPorDia.get(d) ?? 0));
    const b = bootstrapCIPorBloques(deltas, todosLosDias);
    const tramosMejor = m.tramos.filter((v, i) => v > hoy.tramos[i] + 1e-9).length;
    const tramosPeor = m.tramos.filter((v, i) => v < hoy.tramos[i] - 1e-9).length;
    console.log(
      `tope ${String(m.tope).padStart(2)}$  delta ${usd(b.meanUsd).padStart(7)}  IC95 [${usd(b.lowerUsd)}, ${usd(b.upperUsd)}]` +
        `  P(>0)=${(b.positiveShare * 100).toFixed(0).padStart(3)}%  tramos mejor/peor/igual ${tramosMejor}/${tramosPeor}/${TRAMOS - tramosMejor - tramosPeor}` +
        (m === elegida ? "  <- ELEGIDO" : ""),
    );
  }
}

await main();

/**
 * ¿Cuanto cuestan los frenos, y cuanta regularidad compran?
 *
 *   npx tsx src/smoke/costeFrenos.ts
 *
 * LA PREGUNTA. `brechaReplay.ts` encontro que la diferencia entre el replay y el papel real son los
 * frenos: segun el propio log del bot, de las entradas que el replay hace y el bot no, 347 de 349 las
 * salto un freno (296 el objetivo del dia, 51 la racha), y acertaban el 87%. Los frenos estan tirando
 * entradas que valen dinero. Eso es lo esperado —ningun freno sube la ganancia esperada si cada entrada
 * tiene ventaja—; lo que falta es el PRECIO, y lo que se compra con el.
 *
 * NO ELIGE NADA. El objetivo diario existe porque el dueño quiere cerrar cada dia en verde, y eso es una
 * preferencia, no algo que una tabla pueda decidir. Esto pone en la misma tabla el dinero y la
 * regularidad para que la decision se tome sabiendo las dos cosas.
 *
 * Mismo universo y misma zona que `simetria.ts` (ver `universoReplay.ts`), y el replay es fiel operacion a
 * operacion: en las 645 entradas que comparte con el ledger coincide en lado, etiqueta y precio.
 */
import { simular, type Regla, type Resultado } from "../frenoSimulacion.js";
import { bootstrapCIPorBloques } from "../tradeStats.js";
import { cargarUniverso, STAKE_USD, tramoPorDia } from "./universoReplay.js";

const TRAMOS = 6;

interface Fila {
  nombre: string;
  r: Resultado;
  netoPorDia: Map<string, number>;
}

async function main(): Promise<void> {
  const { efectiva, timeZone, ops, ventanas, dias } = await cargarUniverso();
  const tramoDe = tramoPorDia(dias, TRAMOS);
  const racha = efectiva.maxConsecutiveLosses ?? 0;
  const enfriamiento = efectiva.riskHaltCooldownHours ?? 0;
  const objetivo = efectiva.dailyProfitTargetUsd ?? 0;
  const tope = efectiva.maxDailyLossUsd ?? 0;

  const reglas: Regla[] = [
    { nombre: "sin frenos", limites: {}, topeGastoDiarioUsd: 0 },
    { nombre: `solo racha ${racha}`, limites: { maxConsecutiveLosses: racha, cooldownHours: enfriamiento }, topeGastoDiarioUsd: 0 },
    { nombre: `solo objetivo ${objetivo}$`, limites: { dailyProfitTargetUsd: objetivo }, topeGastoDiarioUsd: 0 },
    {
      nombre: `racha + objetivo (hasta 10-oct)`,
      limites: { maxConsecutiveLosses: racha, cooldownHours: enfriamiento, dailyProfitTargetUsd: objetivo },
      topeGastoDiarioUsd: 0,
    },
    {
      nombre: `+ tope ${tope}$ (hoy)`,
      limites: { maxConsecutiveLosses: racha, cooldownHours: enfriamiento, dailyProfitTargetUsd: objetivo, maxDailyLossUsd: tope },
      topeGastoDiarioUsd: 0,
    },
  ];

  const filas: Fila[] = reglas.map((regla) => {
    const r = simular(ops, regla, timeZone);
    return { nombre: regla.nombre, r, netoPorDia: new Map(r.dias.map((d) => [d.dia, d.netoUsd])) };
  });

  const usd = (v: number): string => `${v >= 0 ? "+" : ""}${v.toFixed(2)}`;
  console.log(`COSTE DE LOS FRENOS · zona ${timeZone} · stake ${STAKE_USD}$`);
  console.log(`universo: ${ops.length} entradas del replay sobre ${ventanas} ventanas, ${dias.length} dias (${dias[0]} → ${dias.at(-1)})\n`);
  console.log("regla                             neto   dias verdes  dia mediano  peor dia  dias <=-10  peor tramo  caida max  entradas");
  for (const f of filas) {
    // Un dia sin entradas cuenta como 0: no es verde. Asi todas las reglas se miden sobre los mismos dias.
    const netos = dias.map((d) => f.netoPorDia.get(d) ?? 0);
    const ordenados = [...netos].sort((a, b) => a - b);
    const tramos = Array.from({ length: TRAMOS }, () => 0);
    dias.forEach((d, i) => (tramos[tramoDe.get(d) ?? TRAMOS - 1] += netos[i]));
    console.log(
      [
        f.nombre.padEnd(32),
        usd(f.r.netoUsd).padStart(8),
        `${netos.filter((v) => v > 0).length}/${dias.length}`.padStart(11),
        usd(ordenados[Math.floor(ordenados.length / 2)]).padStart(12),
        usd(ordenados[0]).padStart(9),
        String(netos.filter((v) => v <= -10).length).padStart(11),
        usd(Math.min(...tramos)).padStart(11),
        f.r.caidaMaxUsd.toFixed(2).padStart(10),
        String(f.r.n).padStart(9),
      ].join(" "),
    );
  }

  // Lo que cuesta cada freno contra no tener ninguno, con la incertidumbre de verdad: por DIAS, porque
  // los frenos deciden por dias y las operaciones de un mismo dia no son independientes.
  const base = filas[0];
  console.log("\n=== contra SIN FRENOS (bootstrap por bloques = dias) ===");
  for (const f of filas.slice(1)) {
    const deltas = dias.map((d) => (f.netoPorDia.get(d) ?? 0) - (base.netoPorDia.get(d) ?? 0));
    const b = bootstrapCIPorBloques(deltas, dias);
    console.log(
      `${f.nombre.padEnd(32)} delta ${usd(b.meanUsd).padStart(8)}  IC95 [${usd(b.lowerUsd)}, ${usd(b.upperUsd)}]  ` +
        `P(>0)=${(b.positiveShare * 100).toFixed(0).padStart(3)}%`,
    );
  }
}

await main();

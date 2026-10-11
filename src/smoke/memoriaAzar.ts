/**
 * ¿Tiene memoria el azar? O sea: ¿vale una entrada distinto segun como va el dia o la racha al decidirla?
 *
 *   npx tsx src/smoke/memoriaAzar.ts
 *
 * POR QUE ES LA PREGUNTA QUE DECIDE LOS FRENOS. Ninguna regla de parar cambia lo que vale cada apuesta:
 * solo cambia cuantas se hacen. Si cada entrada tiene ventaja positiva, hacer menos es ganar menos. Un
 * freno solo "le gana al azar" si las entradas que salta son PEORES que las demas, y eso exige memoria:
 * que tras perder sea mas probable volver a perder, o que tras un buen dia lo siguiente salga peor.
 *
 * Por eso aqui se parte cada entrada segun el estado en el que se decidio —con lo ya CERRADO en ese
 * instante, igual que el freno— y se compara lo que vale cada grupo. Bootstrap por ventanas de 5 minutos,
 * porque las entradas de la misma ventana pierden juntas (ver `bootstrapCIPorBloques`).
 *
 * Medido el 2026-10-10 sobre 3.313 entradas en 38 dias: acierto ~86% en todos los estados. Las que salta
 * la racha valen +0,072 $/entrada (n=72), las que salta el objetivo +0,076 $, y las que salta un tope de
 * perdida de 12 $, +0,200 $ — las MEJORES: son las remontadas. Con eso se dejo solo la racha.
 */
import { calculateTradePnl, isWinningTrade, tradeClosedAtMs } from "../pnl.js";
import { dayKeyInTimeZone } from "../timezone.js";
import { bootstrapCIPorBloques } from "../tradeStats.js";
import { cargarUniverso } from "./universoReplay.js";

const OBJETIVO_USD = 8;
const TOPE_USD = 12;
const RACHA = 2;

interface Grupo {
  nets: number[];
  bloques: string[];
  ganadas: number;
}

async function main(): Promise<void> {
  const { ops, timeZone, dias } = await cargarUniverso();
  const porDecision = [...ops].sort((a, b) => a.createdAtMs - b.createdAtMs);
  const porCierre = [...ops].sort((a, b) => (tradeClosedAtMs(a) ?? 0) - (tradeClosedAtMs(b) ?? 0));

  const grupos = new Map<string, Grupo>();
  const anota = (clave: string, net: number, gano: boolean, bloque: string): void => {
    const g = grupos.get(clave) ?? { nets: [], bloques: [], ganadas: 0 };
    g.nets.push(net);
    g.bloques.push(bloque);
    g.ganadas += gano ? 1 : 0;
    grupos.set(clave, g);
  };

  // Se recorre por decision y se van haciendo visibles las que ya cerraron: el estado que ve cada entrada
  // es el que habria visto el bot, nunca el futuro.
  let cerradas = 0;
  let racha = 0;
  const netoDia = new Map<string, number>();
  for (const t of porDecision) {
    while (cerradas < porCierre.length && (tradeClosedAtMs(porCierre[cerradas]) ?? 0) <= t.createdAtMs) {
      const c = porCierre[cerradas];
      const dia = dayKeyInTimeZone(tradeClosedAtMs(c) ?? 0, timeZone);
      netoDia.set(dia, (netoDia.get(dia) ?? 0) + (calculateTradePnl(c).netUsd ?? 0));
      racha = isWinningTrade(c) ? 0 : racha + 1;
      cerradas += 1;
    }
    const hoy = netoDia.get(dayKeyInTimeZone(t.createdAtMs, timeZone)) ?? 0;
    const net = calculateTradePnl(t).netUsd ?? 0;
    const gano = isWinningTrade(t);
    const bloque = String(Math.floor(t.createdAtMs / 300_000));
    anota("todas", net, gano, bloque);
    anota(racha >= RACHA ? `tras ${RACHA}+ perdidas seguidas (lo que salta la racha)` : `sin racha de ${RACHA}`, net, gano, bloque);
    anota(hoy >= OBJETIVO_USD ? `dia ya en >= +${OBJETIVO_USD} $ (lo que salta el objetivo)` : `dia por debajo de +${OBJETIVO_USD} $`, net, gano, bloque);
    anota(hoy <= -TOPE_USD ? `dia ya en <= -${TOPE_USD} $ (lo que salta el tope)` : `dia por encima de -${TOPE_USD} $`, net, gano, bloque);
  }

  const usd = (v: number): string => `${v >= 0 ? "+" : ""}${v.toFixed(3)}`;
  console.log(`MEMORIA DEL AZAR · zona ${timeZone} · ${ops.length} entradas sin frenos en ${dias.length} dias\n`);
  console.log(`${"estado al decidir".padEnd(50)}     n  acierto  $/entrada   IC95 $/entrada (por ventanas)   P(>0)`);
  for (const [clave, g] of grupos) {
    const n = g.nets.length;
    const b = bootstrapCIPorBloques(g.nets, g.bloques);
    console.log(
      `${clave.padEnd(50)} ${String(n).padStart(5)}  ${((g.ganadas / n) * 100).toFixed(1).padStart(6)}%  ${usd(b.meanUsd / n).padStart(9)}   ` +
        `[${usd(b.lowerUsd / n)}, ${usd(b.upperUsd / n)}]`.padEnd(30) +
        `${(b.positiveShare * 100).toFixed(0).padStart(5)}%`,
    );
  }
}

await main();

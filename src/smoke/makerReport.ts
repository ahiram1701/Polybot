/**
 * Resumen de lo que ha hecho el maker, y aviso por Telegram.
 *
 * Lo que importa no es cuantas ordenes coloco sino **cuanto tiempo consiguio tener una puesta**: si la
 * mayoria de las ventanas se queda fuera por precio o por capital, el rendimiento real sera una
 * fraccion de cualquier estimacion. Esa cobertura es el numero que decide si merece la pena arriesgar
 * dinero de verdad, y es justo el que no se puede estimar desde fuera.
 *
 * Lee el log del proceso, que es donde el bucle deja cada pasada. No toca la red ni el bot.
 *
 * Uso: `npx tsx src/smoke/makerReport.ts [--avisar]`
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { loadConfig } from "../config.js";
import { createDynamicNotifier } from "../notifier.js";

interface Pasada {
  at: number;
  colocadas: number;
  canceladas: number;
  comprometidoUsd: number;
  mercados: Array<{ slug: string; motivo?: string; esperadoUsdDia?: number }>;
}

function leerPasadas(texto: string): Pasada[] {
  const out: Pasada[] = [];
  for (const linea of texto.split("\n")) {
    if (!linea.includes("Maker: ordenes actualizadas")) continue;
    const llave = linea.indexOf("{", linea.indexOf("actualizadas"));
    if (llave < 0) continue;
    const marca = Date.parse(linea.slice(1, linea.indexOf("]")));
    try {
      out.push({ at: Number.isFinite(marca) ? marca : 0, ...(JSON.parse(linea.slice(llave)) as Omit<Pasada, "at">) });
    } catch {
      // Una linea partida no invalida el resto del informe.
    }
  }
  return out;
}

export function resumir(pasadas: Pasada[]): string[] {
  if (pasadas.length === 0) {
    return ["Maker: ninguna pasada registrada todavia."];
  }
  const desde = pasadas[0].at;
  const hasta = pasadas[pasadas.length - 1].at;
  const horas = Math.max((hasta - desde) / 3600e3, 0.01);
  const colocadas = pasadas.reduce((s, p) => s + p.colocadas, 0);
  const canceladas = pasadas.reduce((s, p) => s + p.canceladas, 0);
  const conOrden = pasadas.filter((p) => p.comprometidoUsd > 0).length;

  // Por que NO se coloca: es lo accionable. Si domina "capital_insuficiente" el problema es el tamano;
  // si domina "cerca_del_cierre" el margen de retirada esta comiendose la ventana.
  const motivos = new Map<string, number>();
  for (const p of pasadas) {
    for (const m of p.mercados) {
      if (m.motivo) motivos.set(m.motivo, (motivos.get(m.motivo) ?? 0) + 1);
    }
  }
  const esperados = pasadas.flatMap((p) => p.mercados.map((m) => m.esperadoUsdDia ?? 0)).filter((x) => x > 0);
  const esperadoMedio = esperados.length ? esperados.reduce((a, b) => a + b, 0) / esperados.length : 0;

  const lineas = [
    `Maker en sim · ${horas.toFixed(1)} h`,
    `Pasadas: ${pasadas.length} · con orden puesta: ${conOrden} (${((100 * conOrden) / pasadas.length).toFixed(0)}%)`,
    `Colocadas: ${colocadas} · canceladas: ${canceladas}`,
    `Comprometido max: $${Math.max(...pasadas.map((p) => p.comprometidoUsd)).toFixed(2)}`,
  ];
  if (esperadoMedio > 0) {
    lineas.push(`Esperado por ventana (OPTIMISTA, reparto lineal): $${esperadoMedio.toFixed(3)}`);
  }
  lineas.push("Por que no coloca:");
  for (const [motivo, n] of [...motivos].sort((a, b) => b[1] - a[1]).slice(0, 5)) {
    lineas.push(`  ${motivo}: ${n}`);
  }
  return lineas;
}

async function main(): Promise<void> {
  const { config } = loadConfig(["--mode", "sim"]);
  let texto = "";
  for (const nombre of ["ui-console.log"]) {
    try {
      texto += await readFile(join(config.dataDir, nombre), "utf8");
    } catch {
      // Un log ausente no es un fallo: puede que el proceso escriba a otro sitio.
    }
  }
  const lineas = resumir(leerPasadas(texto));
  console.log(lineas.join("\n"));

  if (process.argv.includes("--avisar")) {
    await createDynamicNotifier(config).notify({
      key: `maker-report-${new Date().toISOString().slice(0, 13)}`,
      level: "info",
      title: "Polybot · informe del maker",
      body: lineas.join("\n"),
    });
  }
}

if (process.argv[1]?.includes("makerReport")) {
  void main();
}

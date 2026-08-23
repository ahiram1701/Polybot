/**
 * Lo que el maker COBRO de verdad, contra lo que el modelo dijo que cobraria.
 *
 * Es el unico veredicto que existe sobre si esta estrategia gana dinero. Todo lo demas —la simulacion,
 * el ensayo, los tests— valida la MECANICA: que cotiza los dos lados, que respeta el tope, que no se
 * queda direccional. Ninguno puede medir el ingreso, porque las recompensas las paga Polymarket por
 * ordenes REALES en reposo y el motor de simulacion lleva su libro en memoria.
 *
 * ## Por que hace falta
 *
 * `esperadoUsdDia` sale de la formula oficial pero mide la competencia con UNA foto del libro y agrega
 * a todos los rivales como si fueran un solo maker. Contra la unica medida real que existia
 * —$2,7795 cobrados el 2026-08-20 por la actividad del dia anterior— los modelos teoricos salieron
 * **10-30 veces altos**. Sirve para ORDENAR mercados, que es para lo que se usa. Esto mide cuanto se
 * pasa, que es lo que nadie sabe todavia.
 *
 * ## Como se calcula lo predicho
 *
 * El log dice, en cada cambio, en que mercado se cotiza y cuanto se espera de el AL DIA. Entre dos
 * cambios esa tasa se mantiene, asi que la prediccion del dia es la integral de una funcion escalonada:
 *
 *     predicho = suma( esperadoUsdDia_i * duracion_i / 24h )
 *
 * Los tramos sin cotizar cuentan CERO, y para saber cuales son se usan los latidos (`cotizandoEn: 0`).
 * Sin eso, un dia con el bot parado la mitad del tiempo predeciria el doble de lo que podia cobrar.
 *
 * ## Como se lee el cobro
 *
 * `data-api.polymarket.com/activity`, eventos `MAKER_REBATE`, importe en `usdcSize`. Se abonan sobre
 * las 00:45 UTC del dia SIGUIENTE al de la actividad —no a las 00:00 que dice la documentacion—, asi
 * que se busca en una ventana ancha de la madrugada siguiente.
 *
 * Uso: `npm run recompensa:real -- [YYYY-MM-DD]`   (por defecto, ayer en UTC)
 */
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";

import { loadConfig } from "../config.js";

const DATA_API = "https://data-api.polymarket.com/activity";

interface Tramo {
  desdeMs: number;
  hastaMs: number;
  /** Dolares al dia que el modelo esperaba de lo que estuviera cotizando en ese tramo. */
  tasaUsdDia: number;
}

interface EventoMaker {
  ms: number;
  /**
   * Tasa esperada tras este evento, o 0 si dejo de cotizar.
   *
   * `undefined` significa **no se sabe**, y no es lo mismo que cero. Los logs anteriores al
   * 2026-08-20 traen `esperadoUsd` —por VENTANA, no al dia—, y tratarlo como cero diria "no cotizaba"
   * de un dia en el que si cotizaba. Un tramo desconocido se excluye de la prediccion Y de las horas
   * cubiertas, para que el aviso de cobertura lo delate en vez de taparlo.
   */
  tasaUsdDia?: number;
}

function diaUtc(fecha: string): { inicioMs: number; finMs: number } {
  const inicioMs = Date.parse(`${fecha}T00:00:00Z`);
  if (!Number.isFinite(inicioMs)) {
    throw new Error(`Fecha no valida: "${fecha}". Se espera YYYY-MM-DD.`);
  }
  return { inicioMs, finMs: inicioMs + 24 * 3_600_000 };
}

/**
 * Recorre el log en streaming. Son 90+ MB: leerlo entero para mirar un dia seria el mismo error que
 * este proyecto ya pago dos veces.
 */
async function eventosDelDia(logPath: string, inicioMs: number, finMs: number): Promise<EventoMaker[]> {
  const eventos: EventoMaker[] = [];
  const lector = createInterface({ input: createReadStream(logPath, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const linea of lector) {
    if (!linea.includes("Maker: ")) {
      continue;
    }
    const marca = linea.slice(1, 24);
    const ms = Date.parse(marca);
    if (!Number.isFinite(ms) || ms < inicioMs || ms >= finMs) {
      continue;
    }
    const llave = linea.indexOf("{");
    if (llave < 0) {
      continue;
    }
    let cuerpo: Record<string, unknown>;
    try {
      cuerpo = JSON.parse(linea.slice(llave)) as Record<string, unknown>;
    } catch {
      continue;
    }

    if (linea.includes("ordenes actualizadas")) {
      const mercados = (cuerpo.mercados ?? []) as Array<{
        slug: string;
        motivo?: string;
        esperadoUsdDia?: number;
        esperadoUsd?: number;
      }>;
      // El mercado FINANCIADO es el que trae cifra y no trae motivo: los motivos son de los descartados.
      const financiado = mercados.find((m) => m.esperadoUsdDia !== undefined && m.motivo === undefined);
      if (financiado) {
        eventos.push({ ms, tasaUsdDia: financiado.esperadoUsdDia });
      } else if (mercados.some((m) => m.esperadoUsd !== undefined)) {
        // Formato viejo: `esperadoUsd` es por VENTANA. Convertirlo exigiria saber cuanto duraba cada
        // una, y ese dato no esta en el log. Se marca como desconocido antes que inventarlo.
        eventos.push({ ms });
      } else {
        eventos.push({ ms, tasaUsdDia: 0 });
      }
      continue;
    }
    // El latido es la unica fuente honesta de "no estoy cotizando en ningun sitio": el resumen calla
    // cuando no cambia nada, asi que sin esto un tramo parado se contaria como si siguiera cobrando.
    if (linea.includes("Maker: latido") || linea.includes("sin cotizar en ningun sitio")) {
      if (Number(cuerpo.cotizandoEn) === 0) {
        eventos.push({ ms, tasaUsdDia: 0 });
      }
    }
  }
  return eventos.sort((izq, der) => izq.ms - der.ms);
}

function tramos(eventos: EventoMaker[], finMs: number): Tramo[] {
  const salida: Tramo[] = [];
  for (const [indice, evento] of eventos.entries()) {
    if (evento.tasaUsdDia === undefined) {
      continue;
    }
    const hastaMs = eventos[indice + 1]?.ms ?? finMs;
    salida.push({ desdeMs: evento.ms, hastaMs, tasaUsdDia: evento.tasaUsdDia });
  }
  return salida;
}

async function cobrado(user: string, inicioMs: number): Promise<{ usd: number; eventos: number; cuando?: string }> {
  const respuesta = await fetch(`${DATA_API}?user=${user.toLowerCase()}&limit=500&type=MAKER_REBATE`);
  if (!respuesta.ok) {
    throw new Error(`data-api respondio ${respuesta.status}`);
  }
  const cuerpo = (await respuesta.json()) as unknown;
  const filas = (Array.isArray(cuerpo) ? cuerpo : ((cuerpo as { data?: unknown[] }).data ?? [])) as Array<{
    timestamp?: number;
    usdcSize?: number;
  }>;
  // Ventana ancha de la madrugada siguiente: el abono cae sobre las 00:45 UTC, no a las 00:00, y no
  // conviene que un retraso de una hora se lea como "no cobro nada".
  const desdeMs = inicioMs + 24 * 3_600_000;
  const hastaMs = desdeMs + 8 * 3_600_000;
  const delDia = filas.filter((f) => {
    const ms = Number(f.timestamp) * 1000;
    return Number.isFinite(ms) && ms >= desdeMs && ms < hastaMs;
  });
  return {
    usd: delDia.reduce((suma, f) => suma + (Number(f.usdcSize) || 0), 0),
    eventos: delDia.length,
    cuando: delDia[0]?.timestamp ? new Date(Number(delDia[0].timestamp) * 1000).toISOString() : undefined,
  };
}

async function main(): Promise<void> {
  const ayer = new Date(Date.now() - 24 * 3_600_000).toISOString().slice(0, 10);
  const fecha = process.argv[2] ?? ayer;
  const { inicioMs, finMs } = diaUtc(fecha);
  const { config } = loadConfig(["--mode", "sim"]);
  if (!config.funderAddress) {
    throw new Error("Hace falta POLYMARKET_FUNDER_ADDRESS para saber a quien se le pagaron las recompensas.");
  }

  const eventos = await eventosDelDia(join(config.dataDir, "ui-console.log"), inicioMs, finMs);
  const lista = tramos(eventos, finMs);
  const predichoUsd = lista.reduce(
    (suma, t) => suma + (t.tasaUsdDia * (t.hastaMs - t.desdeMs)) / (24 * 3_600_000),
    0,
  );
  const horasCotizando = lista
    .filter((t) => t.tasaUsdDia > 0)
    .reduce((suma, t) => suma + (t.hastaMs - t.desdeMs) / 3_600_000, 0);
  const horasCubiertas = lista.reduce((suma, t) => suma + (t.hastaMs - t.desdeMs) / 3_600_000, 0);

  const real = await cobrado(config.funderAddress, inicioMs);

  console.log(`\n=== Recompensas del ${fecha} (UTC) ===\n`);
  console.log(`  cobrado de verdad   : $${real.usd.toFixed(4)}   (${real.eventos} evento(s)${real.cuando ? `, ${real.cuando}` : ""})`);
  console.log(`  predicho por el bot : $${predichoUsd.toFixed(4)}`);
  console.log("");
  console.log(`  horas cotizando     : ${horasCotizando.toFixed(1)} h`);
  console.log(`  horas medibles      : ${horasCubiertas.toFixed(1)} h de 24`);
  console.log(`  pasadas con cambio  : ${lista.length}`);

  if (horasCubiertas < 20) {
    console.log(`\n  OJO: solo ${horasCubiertas.toFixed(1)} h del dia son medibles, asi que la prediccion es de esas`);
    console.log(`  horas y el cobro es del dia ENTERO: no se pueden dividir. Las horas no medibles son`);
    console.log(`  huecos del log (un reinicio) o tramos en formato viejo, donde el esperado venia por`);
    console.log(`  VENTANA y no al dia. En un hueco no se sabe si cotizaba: eso no vale cero.`);
  }
  if (real.eventos === 0) {
    console.log(`\n  Sin abono. Tres motivos posibles, y conviene no confundirlos:`);
    console.log(`   1. El maker corria en SIM. Entonces esto es lo correcto: no hubo ordenes reales en el`);
    console.log(`      libro, asi que no habia nada que recompensar por mucho que el modelo prediga.`);
    console.log(`   2. Aun no son las ~00:45 UTC del dia siguiente, que es cuando se abona.`);
    console.log(`   3. Corria en LIVE, ya paso esa hora, y de verdad no se cobro nada. Eso SI es una`);
    console.log(`      respuesta, y es la que hay que mirar.`);
    return;
  }
  if (predichoUsd > 0) {
    console.log(`\n  EL NUMERO: el modelo se paso ${(predichoUsd / real.usd).toFixed(1)}x`);
    console.log(`  (referencia previa: los modelos teoricos salian 10-30x altos)`);
  }
}

if (process.argv[1]?.includes("recompensaReal")) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}

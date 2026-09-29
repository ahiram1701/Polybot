import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * `.env.example` tiene que documentar TODA variable que el codigo lee.
 *
 * POR QUE ESTE TEST EXISTE. La desincronizacion entre lo que `config.ts` lee y lo que el ejemplo
 * documenta ya mordio dos veces: `.env` tenia `MAX_ANALYTICS_SAMPLES=10000` cuando la decision medida
 * era 5.000 —y solo se salvo porque `ui-config.json` pisa a `.env`— y `DAILY_SPEND_LIMIT_USD=50`
 * frente a los 10.000 de la config viva. Las dos se descubrieron por casualidad, leyendo otra cosa.
 *
 * Una variable que el codigo lee y el ejemplo no menciona es una variable que nadie sabe que existe:
 * no se documenta su valor medido, no se revisa al desplegar, y acaba con un valor distinto en cada
 * maquina.
 */

const RAIZ = join(import.meta.dirname, "..");

/** Las claves del esquema de entorno de `config.ts`: lineas del tipo `  NOMBRE: z.algo(...)`. */
function variablesQueElCodigoLee(): string[] {
  const fuente = readFileSync(join(RAIZ, "src/config.ts"), "utf8");
  const encontradas = fuente.matchAll(/^ {2}([A-Z][A-Z0-9_]*)\s*:/gm);
  return [...new Set([...encontradas].map((m) => m[1]))].sort();
}

/** Las que el ejemplo documenta: `NOMBRE=` al principio de linea, comentada o no. */
function variablesDocumentadas(): string[] {
  const ejemplo = readFileSync(join(RAIZ, ".env.example"), "utf8");
  const encontradas = ejemplo.matchAll(/^#?\s*([A-Z][A-Z0-9_]*)=/gm);
  return [...new Set([...encontradas].map((m) => m[1]))].sort();
}

/**
 * Variables que el codigo lee y que NO hace falta documentar, con el motivo al lado.
 *
 * Decision del 2026-09-28: se exceptuan las 18 que estaban sin documentar, y el test pasa a defender el
 * FUTURO. Eso es lo que este test compra de verdad: no limpia la deuda de hoy, pero convierte cada
 * variable nueva en una decision explicita — o se documenta en `.env.example`, o se añade aqui con su
 * motivo escrito. No hay tercera opcion silenciosa, que es como aparecieron estas dieciocho.
 *
 * Y la lista no es un cajon de sastre: el segundo test de abajo falla si una excepcion sobrevive a su
 * variable, asi que se limpia sola cuando el codigo deja de leerla.
 */
const SIN_DOCUMENTAR_A_PROPOSITO: Record<string, string> = {
  // El gate de EV, medido y APAGADO: -1,11 pp de ventaja en el periodo de juicio, 1/6 tramos positivos.
  // Documentarlo en el ejemplo seria invitar a encenderlo, y lo medido dice que no se encienda.
  AI_AUTO_TUNE_ASK_CAP: "gate de EV, apagado por medicion",
  EV_CALIBRATION: "gate de EV, apagado por medicion",
  EV_MIN_EXPECTED_ROI: "gate de EV, apagado por medicion",
  EV_MIN_HISTORY_TRADES: "gate de EV, apagado por medicion",
  EV_SAFETY_MARGIN: "gate de EV, apagado por medicion",
  EV_USE_SIMILARITY: "gate de EV, apagado por medicion",
  REQUIRE_POSITIVE_EV: "gate de EV, apagado por medicion",

  // Variantes mecanicas por mercado y lado de algo que el ejemplo ya documenta en su forma general
  // (`MAX_ASK_PRICE`, `MIN_DISTANCE_USD`). Listar las doce no añade informacion, solo ruido.
  MIN_ASK_PRICE_BTC_UP: "variante por mercado/lado de MIN_ASK_PRICE",
  MIN_ASK_PRICE_BTC_DOWN: "variante por mercado/lado de MIN_ASK_PRICE",
  MIN_ASK_PRICE_ETH_UP: "variante por mercado/lado de MIN_ASK_PRICE",
  MIN_ASK_PRICE_ETH_DOWN: "variante por mercado/lado de MIN_ASK_PRICE",
  MIN_ASK_PRICE_DOGE_UP: "variante por mercado/lado de MIN_ASK_PRICE",
  MIN_ASK_PRICE_DOGE_DOWN: "variante por mercado/lado de MIN_ASK_PRICE",
  MIN_DISTANCE_FLOOR_BTC: "suelo por mercado de MIN_DISTANCE_USD",
  MIN_DISTANCE_FLOOR_ETH: "suelo por mercado de MIN_DISTANCE_USD",
  MIN_DISTANCE_FLOOR_DOGE: "suelo por mercado de MIN_DISTANCE_USD",

  // Infraestructura: no se tocan para operar distinto, y su valor lo fija el despliegue.
  DATA_DIR: "ruta del estado, la fija el compose",
  OPENING_CAPTURE_GRACE_MS: "margen interno de captura, no es una palanca de estrategia",
};

describe(".env.example documenta lo que el codigo lee", () => {
  it("no hay variables que el codigo lea y el ejemplo no mencione", () => {
    const leidas = variablesQueElCodigoLee();
    const documentadas = new Set(variablesDocumentadas());
    const exceptuadas = new Set(Object.keys(SIN_DOCUMENTAR_A_PROPOSITO));

    const huerfanas = leidas.filter((v) => !documentadas.has(v) && !exceptuadas.has(v));

    expect(huerfanas, `Sin documentar en .env.example: ${huerfanas.join(", ")}`).toEqual([]);
  });

  it("la lista de excepciones no acumula variables que ya no existen", () => {
    // Una excepcion que sobrevive a su variable es un comentario que miente. Se borra sola al fallar.
    const leidas = new Set(variablesQueElCodigoLee());
    const muertas = Object.keys(SIN_DOCUMENTAR_A_PROPOSITO).filter((v) => !leidas.has(v));

    expect(muertas, `Excepciones sobre variables que ya no se leen: ${muertas.join(", ")}`).toEqual([]);
  });
});

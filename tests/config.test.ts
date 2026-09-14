import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";
import { dayKeyInTimeZone, resolveTimeZone } from "../src/timezone.js";

const originalDataDir = process.env.DATA_DIR;
const originalMode = process.env.MODE;
const originalMarkets = process.env.ENABLED_MARKETS;
const originalTimezone = process.env.POLYBOT_TIMEZONE;

const CLAVES_POR_LADO = ["BTC", "ETH", "DOGE"].flatMap((market) =>
  ["UP", "DOWN"].map((side) => `ENABLED_${market}_${side}`),
);
const originalesPorLado = new Map(CLAVES_POR_LADO.map((clave) => [clave, process.env[clave]]));

beforeEach(() => {
  // Vitest pone `MODE=test`, que colisiona con la variable del bot y hace que el esquema rechace todo
  // antes de llegar a `DATA_DIR`. Solo pasa bajo Vite: en produccion nadie define `MODE` asi.
  process.env.MODE = "sim";
});

afterEach(() => {
  restaurar("DATA_DIR", originalDataDir);
  restaurar("MODE", originalMode);
  restaurar("ENABLED_MARKETS", originalMarkets);
  restaurar("POLYBOT_TIMEZONE", originalTimezone);
});

function restaurar(clave: string, valor: string | undefined): void {
  if (valor === undefined) {
    delete process.env[clave];
  } else {
    process.env[clave] = valor;
  }
}

/**
 * Guardia del gemelo del fallo que ya vigila el describe "aislamiento de los tests".
 *
 * Alli se comprueba que los TESTS no escriban en el `data/` de produccion. Aqui, que PRODUCCION no
 * escriba en la raiz del repositorio — que es lo que hacia un `DATA_DIR` vacio, porque el `.default()`
 * de Zod solo cubre `undefined` y `resolve(cwd, "")` devuelve el cwd.
 */
describe("DATA_DIR", () => {
  it("sin declarar cae al default", () => {
    delete process.env.DATA_DIR;
    expect(loadConfig([]).config.dataDir).toBe(resolve(process.cwd(), "data"));
  });

  it("VACIO no resuelve a la raiz del repositorio", () => {
    process.env.DATA_DIR = "";
    const { config } = loadConfig([]);
    // Es la asercion que de verdad importa: sin el arreglo, esto era `process.cwd()` y el bot escribia
    // `state.json`, `trades.jsonl` y la analitica sueltos en el repo.
    expect(config.dataDir).not.toBe(process.cwd());
    expect(config.dataDir).toBe(resolve(process.cwd(), "data"));
  });

  it("solo espacios tampoco", () => {
    process.env.DATA_DIR = "   ";
    // Un espacio de mas al final de la linea en un `.env` produciria un directorio llamado " ".
    expect(loadConfig([]).config.dataDir).toBe(resolve(process.cwd(), "data"));
  });

  it("una ruta de verdad se respeta, y se le quitan los espacios de los bordes", () => {
    process.env.DATA_DIR = "  /tmp/polybot-datos  ";
    expect(loadConfig([]).config.dataDir).toBe("/tmp/polybot-datos");
  });

  it("una ruta relativa sigue resolviendose contra el cwd", () => {
    process.env.DATA_DIR = "otros-datos";
    expect(loadConfig([]).config.dataDir).toBe(resolve(process.cwd(), "otros-datos"));
  });
});

/**
 * `ENABLED_MARKETS` solo decide algo cuando los SEIS flags por lado estan ausentes.
 *
 * `defaultOutcomeBooleans` da prioridad a cada `ENABLED_<MERCADO>_<LADO>` y solo cae a la lista de
 * mercados cuando ese flag no existe. En el `.env` de esta maquina los seis estan en `true`, asi que
 * ahi `ENABLED_MARKETS` es inerte; en el `.env.example` van VACIOS, que es como queda una instalacion
 * nueva, y entonces es lo unico que decide.
 *
 * Por eso los tests los vacian a mano: sin eso no se estaria midiendo `ENABLED_MARKETS`, se estaria
 * midiendo el `.env` de la maquina — que es exactamente el error que hizo falsa la primera lectura
 * de este fallo.
 */
describe("ENABLED_MARKETS (con los flags por lado ausentes, como en una instalacion nueva)", () => {
  beforeEach(() => {
    for (const clave of CLAVES_POR_LADO) {
      process.env[clave] = "";
    }
  });

  afterEach(() => {
    for (const clave of CLAVES_POR_LADO) {
      restaurar(clave, originalesPorLado.get(clave));
    }
  });

  it("VACIO cae al default en vez de dejar al bot sin mercados", () => {
    process.env.ENABLED_MARKETS = "";
    // Sin el arreglo esto daba `[]`: la cadena vacia normaliza a una lista vacia, ningun lado queda
    // encendido y el bot no opera NADA — en silencio. Falla cerrado, que es el lado bueno, pero un
    // valor vacio debe significar el default declarado, no "ningun mercado".
    expect(loadConfig([]).config.enabledMarkets).toEqual(["BTC"]);
  });

  it("solo espacios tampoco deja al bot sin mercados", () => {
    process.env.ENABLED_MARKETS = "   ";
    expect(loadConfig([]).config.enabledMarkets).toEqual(["BTC"]);
  });

  it("una lista de verdad se respeta", () => {
    process.env.ENABLED_MARKETS = "BTC,ETH";
    expect(loadConfig([]).config.enabledMarkets).toEqual(["BTC", "ETH"]);
  });
});

describe("POLYBOT_TIMEZONE", () => {
  it("VACIO se guarda como auto", () => {
    process.env.POLYBOT_TIMEZONE = "";
    // Esto NO es una correccion de comportamiento: `resolveTimeZone` ya trataba "" igual que "auto"
    // (ver el test siguiente). Se normaliza para que la configuracion guardada y la pantalla digan
    // `auto` en vez de una cadena vacia que hay que ir a interpretar a otro fichero.
    expect(loadConfig([]).config.timezone).toBe("auto");
  });

  it('"" y "auto" siempre significaron lo mismo', () => {
    const instante = Date.UTC(2026, 8, 14, 3, 47);
    expect(dayKeyInTimeZone(instante, "")).toBe(dayKeyInTimeZone(instante, "auto"));
    expect(resolveTimeZone("")).toBeUndefined();
    expect(resolveTimeZone("auto")).toBeUndefined();
  });

  it("una zona de verdad se respeta", () => {
    process.env.POLYBOT_TIMEZONE = "America/Mexico_City";
    expect(loadConfig([]).config.timezone).toBe("America/Mexico_City");
  });
});

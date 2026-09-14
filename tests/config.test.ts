import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";

const originalDataDir = process.env.DATA_DIR;
const originalMode = process.env.MODE;

beforeEach(() => {
  // Vitest pone `MODE=test`, que colisiona con la variable del bot y hace que el esquema rechace todo
  // antes de llegar a `DATA_DIR`. Solo pasa bajo Vite: en produccion nadie define `MODE` asi.
  process.env.MODE = "sim";
});

afterEach(() => {
  restaurar("DATA_DIR", originalDataDir);
  restaurar("MODE", originalMode);
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

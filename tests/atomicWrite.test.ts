import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { writeFileAtomic, writeLinesAtomic } from "../src/atomicWrite.js";

const temps: string[] = [];

afterEach(async () => {
  await Promise.all(temps.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("writeFileAtomic", () => {
  it("writes and replaces the file atomically", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atomic-"));
    temps.push(dir);
    const file = join(dir, "state.json");

    await writeFileAtomic(file, "one");
    expect(await readFile(file, "utf8")).toBe("one");
    await writeFileAtomic(file, "two");
    expect(await readFile(file, "utf8")).toBe("two");
  });

  it("survives many overlapping writes to the same file without throwing ENOENT", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atomic-"));
    temps.push(dir);
    const file = join(dir, "active.json");

    // The old fixed-`.tmp` pattern threw ENOENT here: overlapping renames of a shared temp file.
    await Promise.all(Array.from({ length: 50 }, (_v, i) => writeFileAtomic(file, `payload-${i}`)));

    const contents = await readFile(file, "utf8");
    expect(contents).toMatch(/^payload-\d+$/);
    // No orphan temp files left behind on the happy path.
    const leftovers = (await readdir(dir)).filter((name) => name.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
  });

  it("creates parent directories as needed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atomic-"));
    temps.push(dir);
    const file = join(dir, "nested", "deep", "cfg.json");

    await writeFileAtomic(file, "{}");
    expect(await readFile(file, "utf8")).toBe("{}");
  });
});

/**
 * Por que existe este escritor: `writeFileAtomic` recibe un `string`, y Node no puede construir
 * cadenas de mas de 512 MB. Con eso, la poda de `analytics.jsonl` se quedo sin poder reescribir su
 * propio fichero (`Invalid string length`) y el bot estuvo 7,5 horas sin operar el 2026-09-17.
 */
describe("writeLinesAtomic", () => {
  it("escribe todas las lineas en orden y con salto final, sin dejar temporales", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atomic-"));
    temps.push(dir);
    const file = join(dir, "analytics.jsonl");
    // Mas lineas que el lote, para que el volcado ocurra en varias escrituras y no en una.
    const lineas = Array.from({ length: 450 }, (_v, i) => `linea-${i}`);

    await writeLinesAtomic(file, lineas, 100);

    expect(await readFile(file, "utf8")).toBe(`${lineas.join("\n")}\n`);
    expect((await readdir(dir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  // Lo que hace que el fichero nunca exista entero en memoria: consume un iterable perezoso.
  it("acepta un generador y lo consume entero", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atomic-"));
    temps.push(dir);
    const file = join(dir, "lineas.jsonl");
    let generadas = 0;
    function* fuente(): Generator<string> {
      for (let i = 0; i < 5; i += 1) {
        generadas += 1;
        yield `n${i}`;
      }
    }

    await writeLinesAtomic(file, fuente(), 2);

    expect(generadas).toBe(5);
    expect(await readFile(file, "utf8")).toBe("n0\nn1\nn2\nn3\nn4\n");
  });

  // La poda ENCOGE el fichero: si la escritura no reemplazara el anterior por completo, quedaria cola
  // del viejo detras y cada linea suelta se leeria como una muestra mas.
  it("reemplaza por completo un fichero mas grande", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atomic-"));
    temps.push(dir);
    const file = join(dir, "podado.jsonl");
    await writeLinesAtomic(file, Array.from({ length: 300 }, (_v, i) => `vieja-${i}`));

    await writeLinesAtomic(file, ["nueva-0", "nueva-1"]);

    expect(await readFile(file, "utf8")).toBe("nueva-0\nnueva-1\n");
  });

  it("sin lineas deja el fichero vacio, no a medias", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atomic-"));
    temps.push(dir);
    const file = join(dir, "vacio.jsonl");
    await writeLinesAtomic(file, ["algo"]);

    await writeLinesAtomic(file, []);

    expect(await readFile(file, "utf8")).toBe("");
  });

  it("crea los directorios que falten", async () => {
    const dir = await mkdtemp(join(tmpdir(), "atomic-"));
    temps.push(dir);
    const file = join(dir, "nested", "deep", "lineas.jsonl");

    await writeLinesAtomic(file, ["una"]);

    expect(await readFile(file, "utf8")).toBe("una\n");
  });
});

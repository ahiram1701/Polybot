import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { writeFileAtomic } from "../src/atomicWrite.js";

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

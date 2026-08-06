import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { writeFileAtomic } from "./atomicWrite.js";
import type { BandProgram, BandProgramStatus } from "./bandProbeProgram.js";
import { logger } from "./logger.js";
import { SUPPORTED_MARKETS } from "./markets.js";
import type { MarketSymbol } from "./types.js";

/**
 * Persistencia de los programas de sondeo.
 *
 * Tienen que sobrevivir a los reinicios o el lazo entero no vale: una prediccion registrada que se
 * pierde al reiniciar es una prediccion que nunca se contrasta, y con reinicios frecuentes el
 * autoajuste podria reabrir la misma banda una y otra vez sin llegar nunca a un veredicto.
 *
 * Tambien es el registro que hace visible lo que decidio el tuner y por que, que es lo que convierte
 * el auto-aplicado en algo auditable en vez de en una caja negra.
 */

const FILE_NAME = "band-programs.json";

export class BandProgramStore {
  private programs: BandProgram[] = [];
  private loaded = false;

  constructor(private readonly dataDir: string) {}

  private get path(): string {
    return join(this.dataDir, FILE_NAME);
  }

  async load(): Promise<BandProgram[]> {
    if (this.loaded) {
      return this.programs;
    }
    try {
      const raw = await readFile(this.path, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      this.programs = Array.isArray(parsed) ? parsed.filter(isBandProgram) : [];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        // Un fichero corrupto no puede tumbar el bot, pero tampoco puede pasar inadvertido: sin
        // programas el tuner deja de abrir bandas y eso se veria como "no propone nada", que es
        // indistinguible de "no hay nada que proponer".
        logger.warn("No se pudieron leer los programas de sondeo; se empieza de cero.", {
          path: this.path,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      this.programs = [];
    }
    this.loaded = true;
    return this.programs;
  }

  list(): readonly BandProgram[] {
    return this.programs;
  }

  async replaceAll(programs: BandProgram[]): Promise<void> {
    this.programs = programs;
    this.loaded = true;
    await writeFileAtomic(this.path, `${JSON.stringify(programs, null, 2)}\n`);
  }
}

function isBandProgram(value: unknown): value is BandProgram {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const estados: BandProgramStatus[] = ["probing", "confirmed", "rejected"];
  return (
    SUPPORTED_MARKETS.includes(record.market as MarketSymbol) &&
    typeof record.lo === "number" &&
    typeof record.hi === "number" &&
    typeof record.createdAtMs === "number" &&
    typeof record.expectedNetPerTradeUsd === "number" &&
    estados.includes(record.status as BandProgramStatus)
  );
}

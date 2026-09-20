/**
 * Las entradas del favorito tal y como ocurrieron, sacadas del ledger.
 *
 * Una sola copia de este filtro, porque cada detalle de aqui cambia la cuenta y ya paso: dos smokes
 * distintos daban 631 y 632 operaciones del mismo periodo. Lo que se filtra y por que:
 *
 * - `strategy === "favorito"` y `mode === "sim"`: el papel del favorito, no el arbitraje ni el maker.
 * - `reentry === 0`: las reentradas son otra decision, con su propio precio de entrada.
 * - con resolucion OFICIAL: `resolved.won` lo calcula el bot con el spot y discrepa ~0,8% de las veces
 *   del TWAP que Polymarket paga. El que paga es el oficial, asi que manda el oficial.
 */
import { createReadStream } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

import type { TradeAttempt } from "./types.js";

interface FilaLedger {
  trade?: TradeAttempt & { officialResolution?: { winningOutcome?: string } };
  officialResolution?: { winningOutcome?: string };
}

export async function cargarLedgerFavorito(dataDir: string): Promise<TradeAttempt[]> {
  const porId = new Map<string, TradeAttempt & { officialResolution?: { winningOutcome?: string } }>();
  const oficial = new Map<string, string>();

  const rl = createInterface({ input: createReadStream(join(dataDir, "trades.jsonl")) });
  for await (const linea of rl) {
    if (!linea.trim()) continue;
    let fila: FilaLedger;
    try {
      fila = JSON.parse(linea) as FilaLedger;
    } catch {
      continue;
    }
    if (!fila.trade?.id) continue;
    porId.set(fila.trade.id, { ...(porId.get(fila.trade.id) ?? {}), ...fila.trade });
    const ganador = fila.officialResolution?.winningOutcome ?? fila.trade.officialResolution?.winningOutcome;
    if (ganador) oficial.set(fila.trade.id, ganador);
  }

  return [...porId.values()]
    .filter((t) => t.strategy === "favorito" && t.mode === "sim" && (t.reentry ?? 0) === 0 && oficial.has(t.id))
    .map((t) => ({ ...t, resolved: { ...(t.resolved ?? {}), won: oficial.get(t.id) === t.outcome } }) as TradeAttempt);
}

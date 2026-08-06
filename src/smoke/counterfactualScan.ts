/**
 * Que ve el evaluador contrafactual sobre el historico real, y que propondria sondear.
 *
 * Prueba de fuego del diseño: debe REDESCUBRIR por si solo la banda 0,85-0,92 de BTC — la que valide
 * a mano con gateReplay y valia +$15 — sin que nadie se la haya dicho, y sin proponer disparates.
 *
 * Run: npx tsx src/smoke/counterfactualScan.ts
 */
import { loadConfig } from "../config.js";
import { evaluateBandsCounterfactually, proposeBandsToProbe } from "../counterfactualBands.js";
import { SUPPORTED_MARKETS } from "../markets.js";
import { StrategyAnalysisEngine } from "../strategyAnalysisEngine.js";
import type { MarketSymbol } from "../types.js";

const { config } = loadConfig(["--mode", "sim"]);
const engine = new StrategyAnalysisEngine(config.dataDir);

// Config VIVA, no constantes: una linea base escrita a mano es como se cuela una simulacion que evalua
// algo que nadie ejecuta.
const ENTRADA: Record<MarketSymbol, { entryWindowSeconds: number; minDistanceUsd: number }> = {
  BTC: { entryWindowSeconds: 34, minDistanceUsd: 49 },
  ETH: { entryWindowSeconds: 42, minDistanceUsd: 0.7 },
  DOGE: { entryWindowSeconds: 42, minDistanceUsd: 0.00005 },
};
const VENTANA: Record<MarketSymbol, { floor: number; cap: number }> = {
  BTC: { floor: 0.7, cap: 0.92 },
  ETH: { floor: 0.7, cap: 0.85 },
  DOGE: { floor: 0.85, cap: 0.95 },
};

for (const market of SUPPORTED_MARKETS) {
  const bands = await evaluateBandsCounterfactually(engine, market, ENTRADA[market], {
    safetyMargin: config.evSafetyMargin ?? 0.03,
    minExpectedRoi: config.evMinExpectedRoi ?? 0.01,
    stakeUsd: 5,
    rejectEdgeAbove: 0.2,
  });

  console.log(`\n===== ${market} =====  ventana en vigor [${VENTANA[market].floor}, ${VENTANA[market].cap}]`);
  console.log("  banda        |  total n/net      | dentro n/net     | FUERA n/net");
  for (const b of bands) {
    if (b.overall.trades === 0) continue;
    const f = (o: { trades: number; netUsd: number }) =>
      `${String(o.trades).padStart(4)}/$${o.netUsd.toFixed(2).padStart(8)}`;
    const fuera = b.lo < VENTANA[market].floor || b.hi > VENTANA[market].cap ? " <- fuera de la ventana" : "";
    console.log(`  ${b.lo.toFixed(2)}-${b.hi.toFixed(2)}  | ${f(b.overall)} | ${f(b.inSample)} | ${f(b.outOfSample)}${fuera}`);
  }

  const propuestas = proposeBandsToProbe(bands, VENTANA[market]);
  if (propuestas.length === 0) {
    console.log("  PROPUESTA: ninguna banda se gana el derecho a sondearse.");
  } else {
    for (const p of propuestas) {
      console.log(
        `  PROPUESTA: sondear ${p.lo.toFixed(2)}-${p.hi.toFixed(2)} — promete $${p.expectedNetPerTradeUsd.toFixed(3)}/trade. ${p.reason}`,
      );
    }
  }
}

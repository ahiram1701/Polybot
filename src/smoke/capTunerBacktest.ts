import { join } from "node:path";
import { readFile } from "node:fs/promises";

import { summarizeAskBands } from "../askBands.js";
import { recommendAskCap, recommendAskWindow } from "../askCapTuner.js";
import { loadConfig } from "../config.js";
import { calculateTradePnl } from "../pnl.js";
import { SUPPORTED_MARKETS } from "../markets.js";
import type { MarketSymbol, TradeAttempt } from "../types.js";

/**
 * Chronological replay of the ask-cap tuner rule over the REAL live ledger: every simulated 24h the
 * tuner recomputes each market's cap from the bands realized SO FAR, and a trade only counts if its
 * ask was under the simulated cap at that moment. Compared against fixed caps (0.65 deployed, 0.85
 * ceiling).
 *
 * Caveat (stated upfront): the ledger only contains trades the bot ACTUALLY made, so raising the cap
 * can only re-admit trades from eras when the cap was higher — the replay measures mostly whether the
 * rule SUBTRACTS bad trades and keeps good ones, which is exactly its job.
 *
 * Run: npx tsx src/smoke/capTunerBacktest.ts
 */

const DAY_MS = 86_400_000;

async function main(): Promise<void> {
  const { config } = loadConfig(["--mode", "sim"]);
  const state = JSON.parse(await readFile(join(config.dataDir, "state.json"), "utf8")) as {
    tradedMarkets: Record<string, TradeAttempt>;
  };
  const trades = Object.values(state.tradedMarkets)
    .filter((trade) => trade.mode === "live" && trade.resolved && typeof trade.bestAsk === "number" && trade.kind !== "arb")
    .sort((left, right) => left.createdAtMs - right.createdAtMs);
  console.log(`Trades live resueltos en el ledger: ${trades.length}\n`);

  const fixed065 = evaluate(trades, () => 0.65);
  const fixed085 = evaluate(trades, () => 0.85);

  // Tuner dinámico: recalcula cada 24h con lo visto hasta ese momento.
  const caps = new Map<MarketSymbol, number>(SUPPORTED_MARKETS.map((market) => [market, 0.65]));
  let nextTuneAtMs = trades.length > 0 ? trades[0].createdAtMs + DAY_MS : 0;
  const seen: TradeAttempt[] = [];
  const tuned = { trades: 0, wins: 0, net: 0 };
  const capHistory: string[] = [];
  for (const trade of trades) {
    while (trade.createdAtMs >= nextTuneAtMs) {
      for (const market of SUPPORTED_MARKETS) {
        const bands = summarizeAskBands(seen, "live", {}, { market });
        const reco = recommendAskCap(bands, caps.get(market)!);
        if (reco) {
          caps.set(market, reco.nextCap);
          capHistory.push(
            `${new Date(nextTuneAtMs).toISOString().slice(0, 10)} ${market}: -> ${reco.nextCap.toFixed(2)} (objetivo ${reco.targetCap.toFixed(2)})`,
          );
        }
      }
      nextTuneAtMs += DAY_MS;
    }
    seen.push(trade);
    const market = trade.asset as MarketSymbol | undefined;
    const cap = market ? caps.get(market)! : 0.65;
    if ((trade.bestAsk ?? 1) <= cap) {
      const net = calculateTradePnl(trade).netUsd ?? 0;
      tuned.trades += 1;
      tuned.net += net;
      tuned.wins += trade.resolved?.won ? 1 : 0;
    }
  }

  // AVISO DE METODO — leer antes de usar cualquier numero de este fichero para elegir una ventana.
  //
  // Esto FILTRA trades ya ejecutados por su ask. Los del historico se eligieron con una config vieja
  // (ask medio ~0.49), asi que aplicarles una ventana de 0.70-0.92 no responde "¿cuanto ganariamos
  // apuntando ahi?" sino "de los que tomamos a 0.49, ¿como les fue a los pocos que salieron caros?".
  // Eso es una muestra sesgada por seleccion, y ademas minuscula: 77 de cientos.
  //
  // Para ELEGIR ventana sirve `gateReplay.ts`, que re-deriva las señales sobre las ~20k ventanas con
  // el gate real. Sobre la misma config desplegada, gateReplay da +$143,80 donde esto da -$8,72; no se
  // contradicen, es que responden preguntas distintas. Este fichero solo sirve para lo que fue escrito:
  // comparar el TUNER contra una ventana fija sobre el mismo conjunto de trades.
  //
  // Brazo 4: la ventana FIJA que corre de verdad en produccion hoy (settings, 2026-08-06).
  //
  // Estos numeros llevaban meses sin actualizarse y el veredicto del tuner se emitia contra una
  // configuracion que nadie usaba — la linea base incluso se imprimia como "(actual)". Comparar contra
  // una base obsoleta hace que "adoptable" no signifique nada: el tuner puede ganarle a una config
  // mala y aun asi empeorar la que esta desplegada.
  const FIXED_WINDOW: Record<string, { floor: number; cap: number }> = {
    BTC: { floor: 0.7, cap: 0.92 },
    ETH: { floor: 0.7, cap: 0.85 },
    DOGE: { floor: 0.85, cap: 0.95 },
  };
  const fixedWindow = { trades: 0, wins: 0, net: 0 };
  for (const trade of trades) {
    const w = FIXED_WINDOW[trade.asset ?? "ETH"] ?? { floor: 0.01, cap: 0.65 };
    const ask = trade.bestAsk ?? 1;
    if (ask >= w.floor && ask <= w.cap) {
      fixedWindow.trades += 1;
      fixedWindow.net += calculateTradePnl(trade).netUsd ?? 0;
      fixedWindow.wins += trade.resolved?.won ? 1 : 0;
    }
  }

  // Brazo 5: tuner de VENTANA dinamico (mueve piso y techo cada 24h simuladas).
  // Arranca desde la MISMA ventana que el brazo fijo. Antes partia de {0.01, 0.65}, que era lo
  // correcto cuando el tuner construia la ventana desde cero a partir de las bandas ganadoras. El
  // tuner actual solo ESTRECHA, asi que soltarlo en 0.01 le pedia escalar hasta 0.30 de 0.05 en 0.05 y
  // medía otra cosa. La pregunta util es: dada la config buena, ¿la mejora o la estropea?
  const win = new Map<MarketSymbol, { floor: number; cap: number }>(
    SUPPORTED_MARKETS.map((m) => [m, { ...(FIXED_WINDOW[m] ?? { floor: 0.01, cap: 0.65 }) }]),
  );
  let nextWinTuneAtMs = trades.length > 0 ? trades[0].createdAtMs + DAY_MS : 0;
  const seenW: TradeAttempt[] = [];
  const tunedWindow = { trades: 0, wins: 0, net: 0 };
  let winAdjustments = 0;
  for (const trade of trades) {
    while (trade.createdAtMs >= nextWinTuneAtMs) {
      for (const market of SUPPORTED_MARKETS) {
        const reco = recommendAskWindow(summarizeAskBands(seenW, "live", {}, { market }), win.get(market)!);
        if (reco) {
          win.set(market, { floor: reco.nextFloor, cap: reco.nextCap });
          winAdjustments += 1;
        }
      }
      nextWinTuneAtMs += DAY_MS;
    }
    seenW.push(trade);
    const w = win.get((trade.asset as MarketSymbol) ?? "ETH")!;
    const ask = trade.bestAsk ?? 1;
    if (ask >= w.floor && ask <= w.cap) {
      tunedWindow.trades += 1;
      tunedWindow.net += calculateTradePnl(trade).netUsd ?? 0;
      tunedWindow.wins += trade.resolved?.won ? 1 : 0;
    }
  }

  console.log("=== Resultados (mismo ledger, distinta política de cap) ===");
  print("cap fijo 0.65 (historico)", fixed065);
  print("cap fijo 0.85 (techo) ", fixed085);
  print("tuner dinámico        ", tuned);
  print("VENTANA FIJA (actual) ", fixedWindow);
  print("tuner de VENTANA      ", tunedWindow);
  const deltaWindow = tunedWindow.net - fixedWindow.net;
  console.log(
    `
[CRITERIO] tuner de ventana vs VENTANA FIJA: ${deltaWindow >= 0 ? "+" : "-"}$${Math.abs(deltaWindow).toFixed(2)} ` +
      `(${deltaWindow >= 0 ? "ADOPTABLE" : "NO adoptar"}) | ajustes del tuner de ventana: ${winAdjustments}`,
  );
  console.log(`\nAjustes del tuner durante el replay: ${capHistory.length}`);
  for (const line of capHistory.slice(0, 15)) {
    console.log("  " + line);
  }
  if (capHistory.length > 15) {
    console.log(`  ... (+${capHistory.length - 15})`);
  }
  // El veredicto que importa es contra la ventana DESPLEGADA, no contra un cap historico: adoptar el
  // tuner significa dejarle mover la config que corre hoy.
  const delta = tuned.net - fixedWindow.net;
  console.log(`\nTuner vs cap fijo 0.65: ${delta >= 0 ? "+" : "-"}$${Math.abs(delta).toFixed(2)} (${delta >= 0 ? "NO pierde: adoptable" : "PIERDE: no adoptar"})`);
}

function evaluate(trades: TradeAttempt[], capFor: (market?: string) => number): { trades: number; wins: number; net: number } {
  const bucket = { trades: 0, wins: 0, net: 0 };
  for (const trade of trades) {
    if ((trade.bestAsk ?? 1) <= capFor(trade.asset)) {
      bucket.trades += 1;
      bucket.net += calculateTradePnl(trade).netUsd ?? 0;
      bucket.wins += trade.resolved?.won ? 1 : 0;
    }
  }
  return bucket;
}

function print(label: string, bucket: { trades: number; wins: number; net: number }): void {
  const win = bucket.trades > 0 ? `${((100 * bucket.wins) / bucket.trades).toFixed(0)}%` : "-";
  console.log(`  ${label} | trades=${String(bucket.trades).padStart(4)} win=${win.padStart(4)} net=${bucket.net >= 0 ? "+" : "-"}$${Math.abs(bucket.net).toFixed(2)}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

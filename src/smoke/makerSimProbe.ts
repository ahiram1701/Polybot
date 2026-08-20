/**
 * Sonda del maker en SIMULACION contra los libros reales.
 *
 * Existe porque el log del bot dice cuantas ordenes coloca pero no DE QUE LADO, y el lado es
 * exactamente lo que fallaba: el 2026-08-19 cotizo 169 veces y las 169 fueron compras de UP, lo que
 * costo $41,41 en 40 minutos.
 *
 * No toca la red mas que para LEER libros y parametros de recompensa: el motor es
 * `SimulationMakerEngine`, asi que no hay ordenes reales ni dinero en juego.
 *
 * Uso: `npx tsx src/smoke/makerSimProbe.ts [pasadas] [capitalUsd]`
 */
import { loadConfig } from "../config.js";
import { SimulationMakerEngine } from "../makerEngine.js";
import { MakerLoop } from "../makerLoop.js";
import { MarketWatcher } from "../marketWatcher.js";
import { OrderbookService } from "../orderbookService.js";
import { RewardParamsReader } from "../rewardParams.js";
import { secondsToEnd } from "../time.js";
import type { MarketInfo, MarketSymbol } from "../types.js";

const MERCADOS: MarketSymbol[] = ["BTC", "ETH", "DOGE"];

async function main(): Promise<void> {
  const pasadas = Number(process.argv[2] ?? 40);
  const capitalUsd = Number(process.argv[3] ?? 150);
  const { config } = loadConfig(["--mode", "sim"]);

  const watcher = new MarketWatcher(config.gammaHost);
  const orderbook = OrderbookService.create(config.clobHost);
  const rewards = new RewardParamsReader(config.clobHost);
  const engine = new SimulationMakerEngine();
  const loop = new MakerLoop(
    { orderbook, rewards, engine },
    { capitalUsd, retirarSegundosAntesDelCierre: 30, minMsEntreRecolocaciones: 15_000 },
  );

  console.log(`Sonda del maker en SIM — ${pasadas} pasadas, capital $${capitalUsd}\n`);
  let peorComprometido = 0;
  let peorGastado = 0;
  let pasadasUnLado = 0;
  let pasadasConCotizacion = 0;

  for (let i = 1; i <= pasadas; i += 1) {
    const nowMs = Date.now();
    let markets: MarketInfo[] = [];
    try {
      markets = await watcher.getCurrentMarkets(MERCADOS, nowMs);
    } catch (error) {
      console.log(`  pasada ${i}: no se pudieron leer mercados (${String(error)})`);
      await new Promise((r) => setTimeout(r, 3000));
      continue;
    }

    const resumen = await loop.runOnce(markets, nowMs);

    // Lo que de verdad importa: que lados quedan VIVOS en cada mercado.
    const porMercado: string[] = [];
    let comprometidoVivo = 0;
    for (const market of markets) {
      const vivas = await engine.ordenesVivas(market);
      if (vivas.length === 0) {
        continue;
      }
      comprometidoVivo += vivas.reduce((s, o) => s + o.price * o.size, 0);
      const lados = vivas.map((o) => `${o.outcome}@${o.price.toFixed(2)}x${o.size}`).join(" + ");
      const tieneUp = vivas.some((o) => o.outcome === "UP");
      const tieneDown = vivas.some((o) => o.outcome === "DOWN");
      const estado = loop.estadoDe(market.slug);
      const inv = estado?.inventario;
      const desequilibrado = tieneUp !== tieneDown;
      if (desequilibrado) {
        pasadasUnLado += 1;
      }
      porMercado.push(
        `${market.asset}[${secondsToEnd(market.endMs, nowMs)}s] ${lados}` +
          `${desequilibrado ? "  <-- UN SOLO LADO" : ""}` +
          `${inv && (inv.UP || inv.DOWN) ? `  inv UP:${inv.UP} DOWN:${inv.DOWN}` : ""}`,
      );
    }
    if (porMercado.length > 0) {
      pasadasConCotizacion += 1;
    }
    peorComprometido = Math.max(peorComprometido, comprometidoVivo);
    peorGastado = Math.max(peorGastado, resumen.gastadoUsd);

    const motivos = resumen.mercados
      .filter((m) => m.motivo)
      .map((m) => `${m.slug.split("-")[0]}:${m.motivo}`)
      .join(" ");
    console.log(
      `pasada ${String(i).padStart(3)}  +${resumen.colocadas} -${resumen.canceladas}  ` +
        `vivo $${comprometidoVivo.toFixed(2)}  gastado $${resumen.gastadoUsd.toFixed(2)}` +
        `${resumen.llenadas ? `  LLENADO ${resumen.llenadas}sh` : ""}`,
    );
    for (const linea of porMercado) {
      console.log(`             ${linea}`);
    }
    if (motivos) {
      console.log(`             ${motivos}`);
    }
    await new Promise((r) => setTimeout(r, 3000));
  }

  const tope = peorComprometido + peorGastado;
  console.log(`\n=== VEREDICTO ===`);
  console.log(`  pasadas con cotizacion viva : ${pasadasConCotizacion}/${pasadas}`);
  console.log(`  mercados-pasada con UN LADO : ${pasadasUnLado}   (debe ser 0 salvo por inventario)`);
  console.log(`  maximo comprometido         : $${peorComprometido.toFixed(2)}`);
  console.log(`  maximo gastado en llenados  : $${peorGastado.toFixed(2)}`);
  console.log(`  suma peor caso vs tope      : $${tope.toFixed(2)} / $${capitalUsd}  ${tope <= capitalUsd ? "OK" : "SE PASA"}`);
  await loop.retirarTodo(await watcher.getCurrentMarkets(MERCADOS, Date.now()));
}

if (process.argv[1]?.includes("makerSimProbe")) {
  void main();
}

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
 * Uso: `npx tsx src/smoke/makerSimProbe.ts [pasadas] [capitalUsd] [fuente]`
 *
 * `fuente` es `recompensas` (por defecto: busca en TODO Polymarket lo que mejor paga y cabe en el
 * capital) o `cripto5m` (BTC/ETH/DOGE, lo que se hacia antes).
 */
import { loadConfig } from "../config.js";
import { SimulationMakerEngine } from "../makerEngine.js";
import { MakerLoop } from "../makerLoop.js";
import { MarketWatcher } from "../marketWatcher.js";
import { OrderbookService } from "../orderbookService.js";
import { RewardMarketScanner } from "../rewardMarketScanner.js";
import { RewardParamsReader } from "../rewardParams.js";
import type { RecompensaMercado } from "../rewardParams.js";
import type { MercadoMaker } from "../makerMarket.js";
import { secondsToEnd } from "../time.js";
import type { MarketInfo, MarketSymbol } from "../types.js";

const MERCADOS: MarketSymbol[] = ["BTC", "ETH", "DOGE"];

async function main(): Promise<void> {
  const pasadas = Number(process.argv[2] ?? 40);
  const capitalUsd = Number(process.argv[3] ?? 20);
  const fuente = (process.argv[4] ?? "recompensas") as "recompensas" | "cripto5m";
  const { config } = loadConfig(["--mode", "sim"]);

  const watcher = new MarketWatcher(config.gammaHost);
  const orderbook = OrderbookService.create(config.clobHost);
  const scanner = new RewardMarketScanner(config.clobHost);
  // Con la fuente `recompensas` los parametros ya vienen del escaner; con `cripto5m` se leen por mercado.
  const paramsPorSlug = new Map<string, RecompensaMercado>();
  const rewards =
    fuente === "recompensas"
      ? { paraMercado: async (_id: string, slug?: string) => (slug ? paramsPorSlug.get(slug) : undefined) }
      : new RewardParamsReader(config.clobHost);
  const engine = new SimulationMakerEngine();
  const loop = new MakerLoop(
    { orderbook, rewards, engine },
    { capitalUsd, retirarSegundosAntesDelCierre: 30, minMsEntreRecolocaciones: 15_000 },
  );

  console.log(`Sonda del maker en SIM — ${pasadas} pasadas, capital $${capitalUsd}, fuente ${fuente}\n`);
  if (fuente === "recompensas") {
    // El escaner carga el registro POR DETRAS a proposito, para no bloquear el bucle del bot. Una
    // sonda si puede esperarlo: sin esto la primera llamada devuelve vacio y parece que no cabe nada.
    console.log("  leyendo el registro de recompensas (~30 peticiones)...");
    await scanner.precargar();
    const candidatos = await scanner.mejores(capitalUsd);
    console.log(`  el escaner encontro ${candidatos.length} mercados que caben en $${capitalUsd}:`);
    for (const c of candidatos.slice(0, 10)) {
      console.log(
        `    $${c.params.ratePerDay.toFixed(2)}/dia  banda ${c.params.maxSpreadCents}c  ` +
          `entrada $${c.costeEntradaUsd}  ${c.mercado.slug.slice(0, 46)}`,
      );
    }
    if (candidatos.length === 0) {
      console.log("    ninguno: el capital no llega ni al mercado mas barato");
      return;
    }
    console.log("");
  }
  let peorComprometido = 0;
  let peorGastado = 0;
  let pasadasUnLado = 0;
  let pasadasConCotizacion = 0;

  for (let i = 1; i <= pasadas; i += 1) {
    const nowMs = Date.now();
    let markets: MercadoMaker[] = [];
    try {
      if (fuente === "recompensas") {
        const candidatos = await scanner.mejores(capitalUsd);
        paramsPorSlug.clear();
        for (const c of candidatos) {
          paramsPorSlug.set(c.mercado.slug, c.params);
        }
        markets = candidatos.map((c) => c.mercado);
      } else {
        markets = await watcher.getCurrentMarkets(MERCADOS, nowMs);
      }
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
        `${market.slug.slice(0, 28)}[${secondsToEnd(market.endMs, nowMs)}s] ${lados}` +
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
  await loop.retirarTodo(
    fuente === "recompensas"
      ? (await scanner.mejores(capitalUsd)).map((c) => c.mercado)
      : await watcher.getCurrentMarkets(MERCADOS, Date.now()),
  );
}

if (process.argv[1]?.includes("makerSimProbe")) {
  void main();
}

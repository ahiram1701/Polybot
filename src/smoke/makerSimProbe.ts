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
 * Es tambien el ENSAYO de go/no-go antes de pasar el maker a live: ademas de los lados, mide lo que
 * decide cuanto se gana —cuantos candidatos llega a evaluar el modelo, cuantos libros cuesta cada
 * pasada y cuantas veces se muda de mercado— y comprueba que el peor caso no se pasa del tope.
 *
 * Uso: `npm run ensayo:maker` o `npx tsx src/smoke/makerSimProbe.ts [pasadas] [capitalUsd] [fuente]`
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
  // El libro se lee a traves de un contador: cuantas lecturas cuesta cada pasada es la mitad del
  // veredicto desde que el modelo ordena 25 candidatos. Leerlos todos son 50 peticiones cada 15 s
  // contra un pool de conexiones, y asi es como el maker se quedo medio ciego una hora entera.
  const orderbookReal = OrderbookService.create(config.clobHost);
  let librosLeidos = 0;
  const orderbook = {
    getQuote: (tokenId: string, amountUsd: number, maxAskPrice: number) => {
      librosLeidos += 1;
      return orderbookReal.getQuote(tokenId, amountUsd, maxAskPrice);
    },
  };
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
  let candidatosVistos = 0;
  const librosPorPasada: number[] = [];
  const msPorPasada: number[] = [];
  /**
   * Mudanzas de mercado. Es LA metrica del modelo de seleccion.
   *
   * Medido en produccion antes de arreglarlo: 10,7 por hora, y el 86% abandonaban un mercado que
   * seguia disponible. No era informacion nueva — era un empate entre 54 mercados casi identicos
   * resuelto a cara o cruz, y cada mudanza deja de estar en el libro justo cuando la muestra del
   * minuto puede caer.
   */
  let mudanzas = 0;
  let dondeCotizabamos: string | undefined;
  const arrancoLaSonda = Date.now();

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

    candidatosVistos = Math.max(candidatosVistos, markets.length);
    librosLeidos = 0;
    const arranque = Date.now();
    const resumen = await loop.runOnce(markets, nowMs);
    msPorPasada.push(Date.now() - arranque);
    librosPorPasada.push(librosLeidos);

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
    // Donde estamos AHORA se lee de las ordenes vivas, no del resumen: es lo unico que no puede mentir.
    const donde = porMercado.length > 0 ? [...porMercado].map((l) => l.split("[")[0]).sort().join("+") : undefined;
    if (donde !== undefined && dondeCotizabamos !== undefined && donde !== dondeCotizabamos) {
      mudanzas += 1;
    }
    if (donde !== undefined) {
      dondeCotizabamos = donde;
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
  const media = (xs: number[]) => (xs.length === 0 ? 0 : xs.reduce((s, x) => s + x, 0) / xs.length);
  const percentil = (xs: number[], q: number) =>
    xs.length === 0 ? 0 : [...xs].sort((a, b) => a - b)[Math.floor(q * (xs.length - 1))]!;
  // Por hora de reloj DE LA SONDA, no extrapolando al ritmo del bot. La sonda pasa cada ~3 s y el bot
  // cada 15: entre dos pasadas de la sonda el libro se ha movido cinco veces menos, asi que convertir
  // una cadencia en la otra da un numero inventado. Lo que se compara con el 10,7/h de produccion es
  // esta cifra cuando la sonda corre un rato largo.
  const horas = (Date.now() - arrancoLaSonda) / 3_600_000;
  const mudanzasPorHora = horas > 0 ? mudanzas / horas : 0;

  console.log(`\n=== VEREDICTO ===`);
  console.log(`  pasadas con cotizacion viva : ${pasadasConCotizacion}/${pasadas}`);
  console.log(`  mercados-pasada con UN LADO : ${pasadasUnLado}   (debe ser 0 salvo por inventario)`);
  console.log(`  maximo comprometido         : ${peorComprometido.toFixed(2)}`);
  console.log(`  maximo gastado en llenados  : ${peorGastado.toFixed(2)}`);
  console.log(`  suma peor caso vs tope      : ${tope.toFixed(2)} / ${capitalUsd}  ${tope <= capitalUsd ? "OK" : "SE PASA"}`);
  console.log(`\n  --- modelo de seleccion ---`);
  console.log(`  candidatos que evalua       : ${candidatosVistos}   (con 3 se elige por sorteo: ver ARQUITECTURA.md)`);
  console.log(
    `  libros leidos por pasada    : media ${media(librosPorPasada).toFixed(1)}  max ${Math.max(0, ...librosPorPasada)}` +
      `   (leerlos todos serian ${candidatosVistos * 2})`,
  );
  console.log(`  duracion de la pasada       : p50 ${percentil(msPorPasada, 0.5)}ms  max ${Math.max(0, ...msPorPasada)}ms`);
  console.log(
    `  mudanzas de mercado         : ${mudanzas} en ${pasadas} pasadas (${(horas * 60).toFixed(1)} min)` +
      `  ->  ${mudanzasPorHora.toFixed(1)}/hora   (produccion antes: 10,7/h, el 86% sin motivo)`,
  );
  if (horas * 60 < 20) {
    console.log(`  (esa tasa por hora vale poco con menos de 20 min de sonda: son pocas oportunidades de mudarse)`);
  }
  await loop.retirarTodo(
    fuente === "recompensas"
      ? (await scanner.mejores(capitalUsd)).map((c) => c.mercado)
      : await watcher.getCurrentMarkets(MERCADOS, Date.now()),
  );
}

if (process.argv[1]?.includes("makerSimProbe")) {
  void main();
}

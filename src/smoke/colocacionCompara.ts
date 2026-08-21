/**
 * Cuanto se gana colocando PEGADO al medio en vez de a un tick, medido sobre libros reales.
 *
 * La teoria dice que la puntuacion sube de `((v-tick)/v)^2` a 1, o sea 1,65x con banda de 4,5 centavos
 * y 9x con banda de 1,5. Pero la recompensa no es la puntuacion: es la CUOTA
 * `Q_propia / (Q_rivales + Q_propia)`, que satura. Con poca competencia ya se lleva casi todo el bote y
 * acercarse al medio no anade nada; con mucha, la ganancia se acerca a la teorica.
 *
 * Este estudio mide la diferencia REAL sobre los mercados que el escaner elige ahora mismo, para poder
 * decidir con un numero en vez de con una formula.
 *
 * **Resultado del 2026-08-20: 1,00x. Ganancia CERO.** En los tres mercados que el escaner elegia, la
 * cuota ya era del 100% del bote —no hay competencia dentro de la banda—, asi que acercarse al medio no
 * puede capturar mas de lo que ya se captura entero. El techo no es nuestra puntuacion, es el tamano
 * del bote. Por eso `TICKS_DEL_MEDIO` se queda en 1: la palanca no vale lo que cuesta (mas llenados y
 * cero margen en el par) mientras la cuota siga saturada.
 *
 * Merece la pena volver a correrlo si aparece competencia: ahi la teoria (1,65x con banda de 4,5c)
 * empieza a valer.
 *
 * Uso: `npx tsx src/smoke/colocacionCompara.ts [capitalUsd]`
 */
import { loadConfig } from "../config.js";
import { medioContrario, precioObjetivo, puntuacionRecompensa, qMinOficial } from "../makerQuoting.js";
import { OrderbookService } from "../orderbookService.js";
import { RewardMarketScanner } from "../rewardMarketScanner.js";

async function main(): Promise<void> {
  const capitalUsd = Number(process.argv[2] ?? 20);
  const { config } = loadConfig(["--mode", "sim"]);
  const orderbook = OrderbookService.create(config.clobHost);
  const scanner = new RewardMarketScanner(config.clobHost);

  console.log(`Colocacion: pegado al medio vs a un tick — capital $${capitalUsd}\n`);
  await scanner.precargar();
  const candidatos = await scanner.mejores(capitalUsd);
  if (candidatos.length === 0) {
    console.log("  el capital no llega a ningun mercado");
    return;
  }

  const filas: Array<{ slug: string; conservador: number; agresivo: number; banda: number; mid: number }> = [];
  for (const c of candidatos) {
    // Libro fusionado: las ventas de UP viven en el libro de DOWN como compras.
    const [up, down] = await Promise.all(
      [c.mercado.outcomes.UP.tokenId, c.mercado.outcomes.DOWN.tokenId].map(async (t) => {
        try {
          return await orderbook.getQuote(t, 25, 0.99);
        } catch {
          return undefined;
        }
      }),
    );
    if (!up || !down) {
      continue;
    }
    const espejo = (n: { price: number; size: number }) => ({ price: 1 - n.price, size: n.size });
    const bids = [...up.rawBidLevels, ...down.rawAskLevels.map(espejo)].sort((a, b) => b.price - a.price);
    const asks = [...up.rawAskLevels, ...down.rawBidLevels.map(espejo)].sort((a, b) => a.price - b.price);
    if (bids.length === 0 || asks.length === 0) {
      continue;
    }
    const mid = (bids[0]!.price + asks[0]!.price) / 2;
    const params = { minSize: c.params.minSize, maxSpreadCents: c.params.maxSpreadCents };
    const tick = Number(c.mercado.tickSize);
    const suma = (niveles: Array<{ price: number; size: number }>) =>
      niveles.reduce((s, n) => s + puntuacionRecompensa(n.size, n.price - mid, params), 0);
    const rivales = qMinOficial(suma(bids), suma(asks), mid);

    const cuota = (ticks: number): number => {
      const p = precioObjetivo(mid, "BUY", tick, ticks);
      const pDown = precioObjetivo(medioContrario(mid), "BUY", tick, ticks);
      const EPS = 1e-9;
      if (p + pDown > 1 + EPS || p > mid + EPS || pDown > medioContrario(mid) + EPS) {
        return 0; // ahi no se cotiza
      }
      const q = qMinOficial(
        puntuacionRecompensa(params.minSize, mid - p, params),
        puntuacionRecompensa(params.minSize, medioContrario(mid) - pDown, params),
        mid,
      );
      return q + rivales > 0 ? (q / (q + rivales)) * c.params.ratePerDay : 0;
    };

    filas.push({
      slug: c.mercado.slug.slice(0, 40),
      conservador: cuota(1),
      agresivo: cuota(0),
      banda: params.maxSpreadCents,
      mid,
    });
  }

  console.log(`${"mercado".padEnd(40)} ${"banda".padStart(6)} ${"mid".padStart(6)} ${"a 1 tick".padStart(11)} ${"pegado".padStart(11)} ${"gana".padStart(7)}`);
  for (const f of filas) {
    const factor = f.conservador > 0 ? f.agresivo / f.conservador : Number.NaN;
    console.log(
      `${f.slug.padEnd(40)} ${(f.banda + "c").padStart(6)} ${f.mid.toFixed(3).padStart(6)} ` +
        `$${f.conservador.toFixed(2).padStart(10)} $${f.agresivo.toFixed(2).padStart(10)} ` +
        `${(Number.isFinite(factor) ? factor.toFixed(2) + "x" : "—").padStart(7)}`,
    );
  }
  const c1 = filas.reduce((s, f) => s + f.conservador, 0);
  const c0 = filas.reduce((s, f) => s + f.agresivo, 0);
  console.log(`\n  suma sobre ${filas.length} candidatos:  a 1 tick $${c1.toFixed(2)}/dia  ->  pegado $${c0.toFixed(2)}/dia`);
  console.log(`  ganancia agregada: ${c1 > 0 ? (c0 / c1).toFixed(2) + "x" : "—"}`);
  console.log(`\n  Recordatorio: esto es la ESTIMACION, y contra la unica medida real que existe`);
  console.log(`  ($0,345 por ventana el 2026-08-19) los modelos teoricos salieron 10-30 veces altos.`);
  console.log(`  Sirve para comparar los dos modos entre si, no para prometer un ingreso.`);
}

if (process.argv[1]?.includes("colocacionCompara")) {
  void main();
}

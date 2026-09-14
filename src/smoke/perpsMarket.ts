import { loadConfig } from "../config.js";
import { PerpsMarketData } from "../perpsClient.js";
import { DEFAULT_PERPS_INSTRUMENTS, resolveMaxLeverage, selectPerpsInstruments } from "../perpsMarkets.js";

/**
 * Sonda de diagnostico del transporte de perps. SOLO LECTURA.
 *
 * Responde a "¿ve Polybot el mercado de perpetuos?" sin clave privada, sin sesion y sin tocar un
 * dolar. Que esto funcione sin credenciales no es casualidad, es la propiedad que se queria: mientras
 * la entrega solo observe, no existe camino tecnico a mover dinero.
 *
 *   npx tsx src/smoke/perpsMarket.ts
 */
async function main(): Promise<void> {
  const { config } = loadConfig(["--mode", "sim"]);
  const marketData = PerpsMarketData.create({
    perpsHost: config.perpsHost,
    perpsWsUrl: config.perpsWsUrl,
  });

  const catalogo = await marketData.instruments();
  if (!catalogo) {
    // "No pude leer" y "no hay nada" son cosas distintas y llevan a acciones distintas. Es el mismo
    // criterio que la guardia de saldo del binario: un fallo de lectura no es un cero.
    throw new Error("No se pudo leer el catalogo de instrumentos de perps.");
  }
  console.log(`Catalogo: ${catalogo.length} instrumentos.`);
  const porCategoria = new Map<string, number>();
  for (const instrument of catalogo) {
    porCategoria.set(instrument.category, (porCategoria.get(instrument.category) ?? 0) + 1);
  }
  console.log(
    `  por categoria: ${[...porCategoria.entries()].map(([cat, n]) => `${cat}=${n}`).join(", ")}`,
  );

  const pedidos = config.perpsInstruments?.length ? config.perpsInstruments : [...DEFAULT_PERPS_INSTRUMENTS];
  const { instruments, missing } = selectPerpsInstruments(catalogo, pedidos);
  if (missing.length > 0) {
    console.log(`  AVISO: el catalogo no trae ${missing.join(", ")}`);
  }

  for (const instrument of instruments) {
    console.log("");
    console.log(`=== ${instrument.symbol} (id ${instrument.instrumentId}, ${instrument.category}) ===`);
    console.log(
      `  palanca max del venue ${instrument.maxLeverage}x | con el tope del operador ` +
        `${resolveMaxLeverage({ instrument, notionalUsd: 100, operatorMaxLeverage: config.perpsMaxLeverage })}x`,
    );
    console.log(
      `  nocional minimo $${instrument.minNotionalUsd} | decimales precio ${instrument.priceDecimals} ` +
        `cantidad ${instrument.quantityDecimals} | funding cada ${instrument.fundingIntervalHours}h`,
    );

    const quote = await marketData.quote(instrument);
    if (!quote) {
      console.log("  sin cotizacion (el libro no se pudo leer)");
      continue;
    }
    console.log(
      `  bid ${fmt(quote.bestBid)} / ask ${fmt(quote.bestAsk)} | medio ${fmt(quote.mid)} ` +
        `| marca ${fmt(quote.markPrice)} | indice ${fmt(quote.indexPrice)}`,
    );
    const spreadBps =
      quote.bestAsk !== undefined && quote.bestBid !== undefined && quote.mid
        ? ((quote.bestAsk - quote.bestBid) / quote.mid) * 10_000
        : undefined;
    console.log(
      `  spread ${spreadBps === undefined ? "?" : spreadBps.toFixed(2)} bps | ` +
        `profundidad ask $${quote.availableAskNotionalUsd.toFixed(0)} / bid $${quote.availableBidNotionalUsd.toFixed(0)} ` +
        `| ${quote.rawAskLevels.length} niveles ask, ${quote.rawBidLevels.length} bid`,
    );
    // El funding se imprime tambien por hora: la tasa suelta no dice nada hasta que se compara con lo
    // que cuesta entrar y salir (0,04% x 2 al tramo base).
    if (quote.fundingRate !== undefined) {
      const porHora = quote.fundingRate / Math.max(1, instrument.fundingIntervalHours);
      console.log(
        `  funding ${(quote.fundingRate * 100).toFixed(4)}% por periodo (${(porHora * 100).toFixed(4)}%/h) ` +
          `| paga ${quote.fundingRate > 0 ? "el LARGO" : quote.fundingRate < 0 ? "el CORTO" : "nadie"}` +
          `${quote.nextFundingMs ? ` | siguiente en ${Math.round((quote.nextFundingMs - Date.now()) / 60000)} min` : ""}`,
      );
      console.log(
        `  ida y vuelta al tramo base cuesta 0,0800% del nocional: el funding de un periodo ` +
          `${Math.abs(quote.fundingRate) > 0.0008 ? "LO CUBRE" : "no lo cubre"}`,
      );
    }
  }
}

function fmt(value: number | undefined): string {
  return value === undefined ? "?" : value.toLocaleString("en-US", { maximumFractionDigits: 6 });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

import { SUPPORTED_MARKETS } from "./markets.js";
import type { PerpsInstrumentInfo } from "./perpsTypes.js";
import type { MarketSymbol } from "./types.js";

/**
 * Instrumentos que se siguen de fabrica.
 *
 * Son los dos para los que Polybot YA recibe un oraculo independiente por la RTDS de Chainlink. No es
 * una preferencia estetica: ese oraculo es la unica ventaja de medicion que este bot tiene en perps —
 * puede comparar el `mark` del perpetuo contra una serie que no sale del propio exchange. En un
 * instrumento sin oraculo propio (NVDA, oro) solo se puede mirar a Polymarket contra si mismo.
 */
export const DEFAULT_PERPS_INSTRUMENTS = ["BTC-USD", "ETH-USD"] as const;

/**
 * Que mercado del feed de Chainlink corresponde a cada perpetuo.
 *
 * Se declara, no se deduce del prefijo del simbolo. "BTC-USD" se parece lo bastante a "BTC" como para
 * tentar a partir por el guion, y eso acabaria emparejando cualquier simbolo nuevo con un oraculo que
 * no le corresponde — en silencio, y grabandolo en la analitica como si fuera el bueno.
 */
const ORACLE_BY_PERP_SYMBOL: Readonly<Record<string, MarketSymbol>> = {
  "BTC-USD": "BTC",
  "ETH-USD": "ETH",
  "DOGE-USD": "DOGE",
};

/** El mercado del feed que sirve de contraste para este perpetuo, si existe. */
export function oracleMarketForPerp(symbol: string): MarketSymbol | undefined {
  const market = ORACLE_BY_PERP_SYMBOL[symbol.toUpperCase()];
  return market !== undefined && SUPPORTED_MARKETS.includes(market) ? market : undefined;
}

export interface PerpsSelection {
  instruments: PerpsInstrumentInfo[];
  /** Simbolos pedidos que el catalogo no trae. Se reportan para poder verlos, no se ignoran. */
  missing: string[];
}

/**
 * Resuelve los simbolos configurados contra el catalogo del exchange.
 *
 * Un simbolo que no aparece NO se descarta en silencio: viaja en `missing` para que el bucle pueda
 * registrarlo una vez. Una config con un simbolo mal escrito se comportaria si no exactamente igual
 * que un exchange que ha dejado de listarlo, y son dos problemas muy distintos.
 */
export function selectPerpsInstruments(
  catalog: readonly PerpsInstrumentInfo[],
  wanted: readonly string[],
): PerpsSelection {
  const porSimbolo = new Map<string, PerpsInstrumentInfo>();
  for (const instrument of catalog) {
    porSimbolo.set(instrument.symbol.toUpperCase(), instrument);
  }
  const instruments: PerpsInstrumentInfo[] = [];
  const missing: string[] = [];
  for (const symbol of wanted) {
    const encontrado = porSimbolo.get(symbol.trim().toUpperCase());
    if (encontrado) {
      instruments.push(encontrado);
    } else if (symbol.trim().length > 0) {
      missing.push(symbol.trim().toUpperCase());
    }
  }
  return { instruments, missing };
}

/**
 * Apalancamiento maximo REAL para un nocional: el menor entre el tope del operador, el del
 * instrumento y el del tramo de riesgo en el que cae ese tamano.
 *
 * Los tres topes existen por motivos distintos y ninguno sustituye a los otros. El del operador acota
 * el riesgo de esta cuenta; el del instrumento y el del tramo los pone el exchange y crecen el
 * requisito de margen con el tamano. Quedarse solo con el del operador manda ordenes que el exchange
 * rechaza; quedarse solo con los del exchange deja que Polymarket decida cuanto se arriesga aqui.
 */
export function resolveMaxLeverage(args: {
  instrument: PerpsInstrumentInfo;
  notionalUsd: number;
  operatorMaxLeverage?: number;
}): number {
  let tope = args.instrument.maxLeverage;
  for (const tier of args.instrument.riskTiers) {
    if (args.notionalUsd >= tier.lowerBoundUsd) {
      tope = Math.min(tope, tier.maxLeverage);
    }
  }
  if (Number.isFinite(args.operatorMaxLeverage) && (args.operatorMaxLeverage as number) > 0) {
    tope = Math.min(tope, args.operatorMaxLeverage as number);
  }
  return Math.max(1, tope);
}

/**
 * Lo MINIMO que el maker necesita saber de un mercado.
 *
 * Existe para desacoplar el maker de `MarketInfo`, que es un tipo de cripto: su `asset` esta limitado a
 * `"BTC" | "ETH" | "DOGE"` y arrastra apertura de ventana, TWAP y demas cosas que a una orden en reposo
 * no le importan. Cobrar recompensas de liquidez no tiene nada que ver con cripto — se cobra igual en un
 * mercado del tiempo de Nueva York que en uno de petroleo—, y los mercados baratos de verdad estan
 * justo fuera de cripto: `rewards_min_size` 20 en vez de 50, y banda de 4,5 centavos en vez de 1,5.
 *
 * `MarketInfo` cumple esta forma ESTRUCTURALMENTE, asi que los mercados de cripto de 5 minutos siguen
 * sirviendo tal cual y no hubo que tocar a quien ya llamaba al maker.
 *
 * ## Sobre los nombres UP y DOWN
 *
 * Se conservan porque `Outcome` es `"UP" | "DOWN"` en todo el proyecto y renombrarlo tocaria analitica,
 * senales y configuracion. Para el maker significan simplemente **los dos tokens complementarios**: en
 * un mercado de Si/No, UP es Si y DOWN es No. Lo unico que importa es la propiedad que los une, y es la
 * que hace rentable al par: `precio(UP) + precio(DOWN) = $1`.
 */
import type { Outcome } from "./types.js";

export interface MercadoMaker {
  slug: string;
  conditionId: string;
  /** Cuando resuelve. Sirve para retirarse antes del cierre. */
  endMs: number;
  /** En texto porque es lo que espera el cliente del CLOB al firmar. */
  tickSize: string;
  negRisk: boolean;
  outcomes: Record<Outcome, { tokenId: string }>;
}

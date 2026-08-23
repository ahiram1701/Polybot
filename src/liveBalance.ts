import { createPublicClient, erc20Abi, http, type PublicClient } from "viem";
import { polygon } from "viem/chains";

import { logger } from "./logger.js";

/**
 * Saldo REAL de colateral en live, leído on-chain.
 *
 * La guardia de capital (`minBankrollForDirectionalUsd`) necesita saber cuánto dinero hay de verdad.
 * Antes era un número que el usuario declaraba a mano, con el problema evidente: si deposita y no lo
 * actualiza, la aritmética que decide si operar direccional tiene sentido corre sobre un dato viejo.
 *
 * Solo LEE (`balanceOf`); no firma nada ni mueve fondos.
 */

/**
 * Colateral del CLOB **V2** de Polymarket en Polygon: `pUSD` (Polymarket USD), 6 decimales.
 *
 * NO es USDC.e (`0x2791Bca1...`). Con la migracion a CLOB V2 (2026-04-28) Polymarket paso a su propio
 * token de colateral, y USDC.e dejo de aparecer siquiera en `@polymarket/clob-client-v2` — de ahi se
 * saco esta direccion, no de documentacion. Leer el token viejo devuelve 0 para una cuenta con fondos:
 * un cero perfectamente creible que hace pensar que la wallet esta vacia.
 *
 * Si vuelve a cambiar, el sintoma sera el mismo (saldo 0 con fondos reales). La forma de verificarlo
 * es buscar las direcciones del SDK y preguntar a cada una por `symbol()`: la unica que responde como
 * ERC20 es el colateral.
 */
export const POLYMARKET_COLLATERAL_ADDRESS = "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB" as const;

export interface BankrollReading {
  usd: number;
  atMs: number;
}

export interface BankrollSource {
  /** `undefined` = NO SE PUDO LEER. Distinto de un saldo de 0, que sí es una respuesta. */
  read(nowMs?: number): Promise<BankrollReading | undefined>;
}

/**
 * La distinción que hace segura a esta clase: **un fallo de lectura NO es un saldo de cero.**
 *
 * Devolver 0 cuando el RPC está caído haría que la guardia bloquease live por un problema de red, y
 * —peor— tratar un 0 real como "no se pudo leer" dejaría operar sin fondos. Por eso el fallo devuelve
 * `undefined` y quien llama decide (en producción: caer al valor declarado a mano).
 *
 * Cachea porque el bucle corre cada segundo y esto es una llamada de red: un saldo no cambia entre
 * iteraciones, y machacar el RPC solo añade otra fuente de timeouts al camino caliente.
 */
export class OnChainBankrollSource implements BankrollSource {
  private cached?: BankrollReading;
  private inFlight?: Promise<BankrollReading | undefined>;
  /**
   * Cuando fallo el ultimo intento. Sin esto el fallo NO se cacheaba (solo el exito), asi que el TTL
   * nunca frenaba y el bucle —que corre cada segundo— reintentaba una vez por segundo. El RPC
   * respondia 6/6 en pruebas aisladas y aun asi fallaba constantemente en produccion: lo estabamos
   * martilleando hasta que nos limitaba, y cada fallo provocaba el siguiente reintento inmediato.
   */
  private lastFailureAtMs = 0;
  private consecutiveFailures = 0;

  constructor(
    private readonly funderAddress: `0x${string}`,
    rpcUrl: string,
    private readonly ttlMs = 60_000,
    private readonly client: Pick<PublicClient, "readContract"> = createPublicClient({
      chain: polygon,
      transport: http(rpcUrl, { timeout: 8_000 }),
    }),
    private readonly collateralAddress: `0x${string}` = POLYMARKET_COLLATERAL_ADDRESS,
  ) {}

  async read(nowMs = Date.now()): Promise<BankrollReading | undefined> {
    if (this.cached && nowMs - this.cached.atMs < this.ttlMs) {
      return this.cached;
    }
    // Retroceso exponencial tras un fallo (5s, 10s, 20s... hasta 5 min). Reintentar cada segundo
    // convierte un fallo puntual en uno permanente: el RPC nos limita por exceso de peticiones y cada
    // rechazo dispara el siguiente reintento. Devolver la ultima lectura buena mientras tanto.
    if (this.consecutiveFailures > 0 && nowMs - this.lastFailureAtMs < this.failureBackoffMs()) {
      return this.cached;
    }
    // Una sola petición en vuelo: el bucle puede preguntar desde varios sitios en la misma iteración.
    this.inFlight ??= this.fetchBalance(nowMs).finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private failureBackoffMs(): number {
    return Math.min(5_000 * 2 ** (this.consecutiveFailures - 1), 300_000);
  }

  private async fetchBalance(nowMs: number): Promise<BankrollReading | undefined> {
    try {
      const raw = await this.client.readContract({
        address: this.collateralAddress,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [this.funderAddress],
      });
      // pUSD son 6 decimales. Se divide en Number y no en BigInt para no truncar los centavos.
      const usd = Number(raw) / 1e6;
      if (!Number.isFinite(usd)) {
        return undefined;
      }
      this.cached = { usd, atMs: nowMs };
      this.consecutiveFailures = 0;
      return this.cached;
    } catch (error) {
      this.consecutiveFailures += 1;
      this.lastFailureAtMs = nowMs;
      // Solo el primer fallo de cada racha: repetirlo inundaba el log sin aportar informacion nueva.
      if (this.consecutiveFailures === 1) {
        logger.warn("No se pudo leer el saldo on-chain; se usa el capital declarado a mano.", {
          error: error instanceof Error ? error.message.split("\n")[0] : String(error),
        });
      }
      // Se conserva `cached` a propósito: una lectura buena de hace un rato es mejor que nada, y el
      // TTL ya la volverá a intentar. Devolver `undefined` aquí solo significa "ahora mismo no sé".
      return this.cached;
    }
  }
}

/**
 * Cuánto puede envejecer una lectura on-chain antes de dejar de valerse por sí sola.
 *
 * El TTL de refresco es 1 min, así que 5 min son unos cinco intentos fallidos: un hipo de red no llega,
 * una caída sí. La distinción importa porque `read()` conserva la última lectura buena a propósito y
 * nadie la borra nunca — sin este tope, una lectura de hace horas seguiría dimensionando el arbitraje.
 * Si el saldo real bajó mientras tanto, eso produce exactamente la pata suelta que la guardia evita.
 */
export const BANKROLL_READING_MAX_AGE_MS = 5 * 60_000;

/**
 * Capital efectivo para la guardia: el saldo leído si se pudo leer y sigue fresco, y si no el declarado
 * a mano.
 *
 * Un 0 LEÍDO es autoritativo y bloquea — no se puede operar sin fondos, y taparlo con un valor
 * declarado obsoleto sería justo el fallo que este módulo viene a corregir.
 *
 * `nowMs` es obligatorio a propósito: es lo que obliga a cada sitio que dimensiona con dinero real a
 * decir contra qué momento compara. Un default silencioso dejaría que un llamador nuevo se saltara la
 * caducidad sin enterarse.
 */
export function resolveEffectiveBankrollUsd(
  reading: BankrollReading | undefined,
  declaredUsd: number | undefined,
  nowMs: number,
  maxAgeMs: number = BANKROLL_READING_MAX_AGE_MS,
): { usd: number; source: "onchain" | "declared" | "unknown"; staleReadingMs?: number } {
  if (reading) {
    const ageMs = nowMs - reading.atMs;
    if (ageMs <= maxAgeMs) {
      return { usd: reading.usd, source: "onchain" };
    }
    // Caducada: cae al declarado, pero se dice CUÁNTO hace que no se lee. Sin eso, la UI mostraría
    // "(declarado)" sin distinguir "nunca hubo lectura" de "el RPC lleva media hora muerto".
    if (declaredUsd !== undefined && declaredUsd > 0) {
      return { usd: declaredUsd, source: "declared", staleReadingMs: ageMs };
    }
    return { usd: 0, source: "unknown", staleReadingMs: ageMs };
  }
  if (declaredUsd !== undefined && declaredUsd > 0) {
    return { usd: declaredUsd, source: "declared" };
  }
  return { usd: 0, source: "unknown" };
}

/**
 * Si el maker tiene que retirarse: por patrimonio bajo o por no poder leer el saldo.
 *
 * Vive aparte y es pura porque es una decision sobre DINERO, y esas hay que poder probarlas sin
 * levantar medio bot.
 *
 * El patrimonio no es solo el efectivo: una orden en reposo baja el saldo del exchange sin ser una
 * perdida, y un par completo redime $1 gane quien gane. Las participaciones SUELTAS se valoran a cero
 * a proposito, que es lo que pueden llegar a valer.
 *
 * Y lo segundo, que costo verlo: una guarda de perdidas NO puede seguir con un saldo declarado. Cuando
 * la lectura on-chain caduca, `resolveEffectiveBankrollUsd` cae al valor de la configuracion; para
 * dimensionar una apuesta es razonable, para decidir si PARAR es al reves, porque el declarado es
 * optimista por naturaleza y no baja cuando el dinero se va. Medido el 2026-08-23: la configuracion
 * decia 40 con $4,13 reales en la cuenta. No saber cuanto tienes es motivo de sobra para dejar de
 * arriesgarlo.
 */
export function makerDebeRetirarse(args: {
  saldo: { usd: number; source: "onchain" | "declared" | "unknown" };
  ordenesVivasUsd: number;
  paresUsd: number;
  sueloUsd: number;
}): { retirar: boolean; motivo?: "saldo_a_ciegas" | "patrimonio_bajo"; patrimonioUsd: number } {
  const patrimonioUsd = args.saldo.usd + args.ordenesVivasUsd + args.paresUsd;
  if (args.sueloUsd <= 0) {
    return { retirar: false, patrimonioUsd };
  }
  if (args.saldo.source !== "onchain") {
    return { retirar: true, motivo: "saldo_a_ciegas", patrimonioUsd };
  }
  return patrimonioUsd < args.sueloUsd
    ? { retirar: true, motivo: "patrimonio_bajo", patrimonioUsd }
    : { retirar: false, patrimonioUsd };
}

import { createSecureClient, forkEnvironmentConfig, production } from "@polymarket/client";
import { privateKey } from "@polymarket/client/viem";

import { logger } from "./logger.js";
import type { PerpsTradingSession } from "./perpsEngine.js";
import type { BotConfig } from "./types.js";

/**
 * Cuanto vive la credencial delegada de una sesion. El SDK admite hasta una semana.
 *
 * Se pide MUCHO menos: doce horas. La credencial es una llave que puede operar la cuenta de perps sin
 * volver a pedir la firma de la wallet, y su vida util es exactamente el tiempo durante el que una
 * copia robada sirve. Doce horas cubren de sobra el ciclo de un bot supervisado que se relanza solo.
 */
export const PERPS_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

/** Margen con el que se renueva antes de caducar, para no perder una pasada por unos segundos. */
const RENEW_BEFORE_MS = 5 * 60 * 1000;

/**
 * Jurisdicciones donde Polymarket no permite operar perpetuos.
 *
 * La documentacion es explicita en lo que pide a quien construye sobre la API: *"Block order
 * submission entirely for users in any of the listed jurisdictions. Do not only display a warning."*
 * Por eso esto no es un aviso en la interfaz sino una puerta cerrada en el camino de ejecucion.
 */
export const PERPS_RESTRICTED_JURISDICTIONS = [
  "United States",
  "Canada",
  "Cuba",
  "Iran",
  "North Korea",
  "Syria",
  "Crimea",
  "Donetsk",
  "Luhansk",
] as const;

/**
 * Por que NO se puede abrir una sesion live. `undefined` = se puede.
 *
 * Devuelve el motivo en vez de un booleano a proposito: "no esta configurado", "el operador no lo ha
 * abierto" y "esta jurisdiccion no puede" llevan a acciones distintas del operador, y un `false`
 * unico las hace indistinguibles justo donde hace falta saberlo.
 */
export function perpsLiveBlockedReason(config: BotConfig): string | undefined {
  if (config.perpsAllowLive !== true) {
    return "perps_live_cerrado";
  }
  // Se DECLARA, no se adivina. Mismo criterio que `POLYBOT_SUPERVISOR`: una deteccion automatica que
  // falla en silencio produce exactamente la mentira que este campo viene a evitar — y aqui la mentira
  // seria operar derivados apalancados desde un sitio donde no se puede.
  if (config.perpsJurisdictionOk !== true) {
    return "perps_jurisdiccion_sin_declarar";
  }
  if (!config.privateKey || !config.funderAddress) {
    return "perps_sin_credenciales";
  }
  return undefined;
}

/**
 * Abre y mantiene la sesion de perps. Memoiza la promesa, igual que `LiveClobClientProvider`.
 *
 * La diferencia con el proveedor del binario es que aqui la credencial CADUCA, asi que no basta con
 * memoizar para siempre: se guarda el instante de caducidad y se reabre antes de llegar. Un proveedor
 * que solo memoizase empezaria a fallar cada orden pasada una semana, y el sintoma —"rechazo del
 * exchange"— no apuntaria a la causa.
 */
export class PerpsSessionProvider {
  private sessionPromise?: Promise<PerpsTradingSession>;
  private expiresAtMs = 0;

  constructor(
    private readonly config: BotConfig,
    private readonly now: () => number = Date.now,
  ) {}

  async getSession(): Promise<PerpsTradingSession> {
    const bloqueo = perpsLiveBlockedReason(this.config);
    if (bloqueo) {
      // Se lanza y no se devuelve un motor inerte: un motor que acepta ordenes y no las manda es la
      // peor de las dos opciones, porque el ledger apuntaria operaciones que no existen.
      throw new Error(`No se puede abrir sesion de perps en live: ${bloqueo}.`);
    }
    if (this.sessionPromise && this.now() < this.expiresAtMs - RENEW_BEFORE_MS) {
      return this.sessionPromise;
    }
    this.expiresAtMs = this.now() + PERPS_SESSION_TTL_MS;
    this.sessionPromise = this.openSession().catch((error: unknown) => {
      // Un fallo no se cachea: si se quedara pegado, un hipo de red dejaria la sesion rota hasta el
      // siguiente reinicio.
      this.sessionPromise = undefined;
      this.expiresAtMs = 0;
      throw error;
    });
    return this.sessionPromise;
  }

  private async openSession(): Promise<PerpsTradingSession> {
    const environment =
      this.config.perpsHost || this.config.perpsWsUrl
        ? forkEnvironmentConfig(
            {
              name: "polybot-perps",
              perps: {
                ...(this.config.perpsHost ? { rest: this.config.perpsHost } : {}),
                ...(this.config.perpsWsUrl ? { ws: this.config.perpsWsUrl } : {}),
              },
            },
            production,
          )
        : production;
    const client = await createSecureClient({
      environment,
      wallet: this.config.funderAddress,
      signer: privateKey(this.config.privateKey),
    });
    const session = await client.openPerpsSession({ expiresIn: PERPS_SESSION_TTL_MS, label: "polybot" });
    logger.info("Sesion de perps abierta.", { expiresInMs: PERPS_SESSION_TTL_MS });
    return session as unknown as PerpsTradingSession;
  }
}

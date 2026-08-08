import { logger } from "./logger.js";

/**
 * Agrega la salida ruidosa de dependencias que escriben directo a `console`.
 *
 * El SDK del CLOB imprime una linea por cada peticion fallida, sin control. Durante el corte de red
 * del 2026-08-08 eso produjo **250.000 lineas en 30 minutos** y dejo el log en 76 MB con 1,68 millones
 * de lineas. No es solo ruido: llena disco y consume CPU escribiendo, justo en el momento en que el
 * proceso ya esta peor. Y encima entierra las lineas que si explican lo que pasa.
 *
 * No se silencia — se cuenta. Un resumen por minuto conserva la señal ("el CLOB lleva un rato
 * fallando") y tira la repeticion, que es lo unico que no aporta.
 */

/** Prefijos que se agregan. Todo lo demas pasa intacto. */
const RUIDOSOS = ["[CLOB Client]", "[CLOB Client-v2]"];

const FLUSH_INTERVAL_MS = 60_000;

type Metodo = "log" | "warn" | "error";

interface Agregador {
  restore: () => void;
  /** Expuesto para los tests: vuelca el resumen sin esperar al temporizador. */
  flush: () => void;
}

export function installNoisyConsoleAggregator(intervalMs = FLUSH_INTERVAL_MS): Agregador {
  const originales: Record<Metodo, (...args: unknown[]) => void> = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  };
  const cuenta = new Map<string, number>();

  const flush = (): void => {
    if (cuenta.size === 0) {
      return;
    }
    const resumen = Object.fromEntries(cuenta);
    cuenta.clear();
    // Por el logger, no por console: asi hereda el formato y los destinos del resto de avisos.
    logger.warn("Errores repetidos de dependencias (agregados).", resumen);
  };

  const parche = (metodo: Metodo) => (...args: unknown[]) => {
    const primero = typeof args[0] === "string" ? args[0] : "";
    const ruidoso = RUIDOSOS.find((prefijo) => primero.startsWith(prefijo));
    if (!ruidoso) {
      originales[metodo](...args);
      return;
    }
    // La clave incluye el detalle del error para no fundir causas distintas en un solo contador: un
    // DNS caido y un ECONNRESET son problemas diferentes y conviene poder distinguirlos.
    const detalle = args.slice(1).map(resumirArgumento).join(" ").slice(0, 120);
    const clave = detalle ? `${primero} ${detalle}` : primero;
    cuenta.set(clave, (cuenta.get(clave) ?? 0) + 1);
  };

  console.log = parche("log");
  console.warn = parche("warn");
  console.error = parche("error");

  const timer = setInterval(flush, intervalMs);
  timer.unref?.();

  return {
    flush,
    restore: () => {
      clearInterval(timer);
      flush();
      console.log = originales.log;
      console.warn = originales.warn;
      console.error = originales.error;
    },
  };
}

function resumirArgumento(valor: unknown): string {
  if (typeof valor === "string") {
    return valor;
  }
  try {
    return JSON.stringify(valor) ?? "";
  } catch {
    return "";
  }
}

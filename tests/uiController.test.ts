import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";

import { BotController, ControllerError, type RunnerLike } from "../src/ui/controller.js";
import { calculatePnlSummaryByMode } from "../src/pnl.js";
import { StateStore } from "../src/stateStore.js";
import type { UiStatus } from "../src/ui/shared.js";
import type { BotConfig, Mode, TradeAttempt } from "../src/types.js";

class FakeRunner implements RunnerLike {
  stopped = false;
  async start(): Promise<void> {
    return new Promise(() => undefined);
  }
  stop(): void {
    this.stopped = true;
  }
}

// Mirrors the real bot: holds its own long-lived StateStore instance and routes resetPnl to it.
class StateAwareFakeRunner extends FakeRunner {
  readonly resetCalls: Mode[] = [];
  constructor(private readonly state: StateStore) {
    super();
  }
  async resetPnl(mode: Mode): Promise<void> {
    this.resetCalls.push(mode);
    await this.state.resetPnl(mode);
  }
}

const temps: string[] = [];

afterEach(async () => {
  await Promise.all(temps.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

/**
 * Los sondeos de banda solo avanzan si el runner sabe que existen. Antes solo se le pasaban cuando
 * habia un CAMBIO, lo que creaba un bloqueo perfecto: tras un reinicio el runner arranca vacio, asi que
 * no sondea; sin sondeos no hay veredicto; y sin veredicto no hay cambio que dispare el envio. Y no da
 * la cara — se veria como "los sondeos no hacen nada", indistinguible de "todavia no hay muestra".
 */
describe("BotController: sondeos de banda tras reiniciar", () => {
  class ProbeAwareRunner extends FakeRunner {
    programsReceived: readonly unknown[] | undefined;
    setBandPrograms(programs: readonly unknown[]): void {
      this.programsReceived = programs;
    }
  }

  it("entrega al runner los programas persistidos nada mas arrancar", async () => {
    const config = await baseConfig();
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      join(config.dataDir, "band-programs.json"),
      JSON.stringify([
        {
          market: "ETH",
          lo: 0.85,
          hi: 0.9,
          createdAtMs: 1,
          expectedNetPerTradeUsd: 0.3,
          outOfSampleTrades: 84,
          reason: "x",
          status: "probing",
        },
      ]),
      "utf8",
    );
    const runner = new ProbeAwareRunner();
    const controller = new BotController(config, {
      startPriceFeed: false,
      snapshotProvider: fixedSnapshot,
      runnerFactory: () => runner,
    });

    await controller.start("sim");
    // La carga es asincrona y deliberadamente no bloquea el arranque, asi que hay que esperarla. Se
    // sondea con plazo en vez de dormir un rato fijo: con la suite entera bajo carga, un sleep corto
    // convierte esto en un test intermitente, y un test que falla a ratos es peor que no tenerlo.
    const limite = Date.now() + 3_000;
    while (!runner.programsReceived && Date.now() < limite) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    expect(runner.programsReceived).toHaveLength(1);
    await controller.stop();
  });
});

describe("BotController", () => {
  it("starts and stops a simulation runner", async () => {
    const runner = new FakeRunner();
    const createdConfigs: BotConfig[] = [];
    const controller = new BotController(await baseConfig(), {
      startPriceFeed: false,
      snapshotProvider: fixedSnapshot,
      runnerFactory: (config) => {
        createdConfigs.push(config);
        return runner;
      },
    });

    const running = await controller.start("sim");
    expect(running.running).toBe(true);
    expect(createdConfigs[0].mode).toBe("sim");

    const stopped = await controller.stop();
    expect(stopped.running).toBe(false);
    expect(runner.stopped).toBe(true);
    controller.dispose();
  });

  it("el runner viejo no borra el estado del nuevo tras un stop seguido de start", async () => {
    // Como el bucle real: `stop()` pide parar, pero la promesa de `start()` no se resuelve hasta que
    // termina la iteracion en curso — o sea, despues de que el siguiente runner ya se registro.
    class RunnerQueTardaEnParar implements RunnerLike {
      private resolver?: () => void;
      async start(): Promise<void> {
        return new Promise<void>((resolve) => {
          this.resolver = resolve;
        });
      }
      stop(): void {
        // 25ms: lo bastante para llegar DESPUES de que el siguiente start se haya registrado, que es
        // cuando el fallo aparece. Con 0ms el `finally` se adelanta al nuevo runner y no reproduce nada.
        setTimeout(() => this.resolver?.(), 25);
      }
    }
    const creados: RunnerQueTardaEnParar[] = [];
    const controller = new BotController(await baseConfig(), {
      startPriceFeed: false,
      snapshotProvider: fixedSnapshot,
      runnerFactory: () => {
        const runner = new RunnerQueTardaEnParar();
        creados.push(runner);
        return runner;
      },
    });

    await controller.start("sim");
    await controller.stop();
    await controller.start("sim");
    // Tiempo de sobra para que el `finally` del primero llegue tarde.
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(creados.length).toBe(2);
    // Sin la guardia esto daba false: el bucle nuevo seguia corriendo pero el controlador lo daba por
    // detenido, y con `runner` a undefined el boton de parar ya no lo alcanzaba.
    expect((await controller.getStatus()).running).toBe(true);
    await controller.stop();
    controller.dispose();
  });

  it("prevents two runners from starting at once", async () => {
    const controller = new BotController(await baseConfig(), {
      startPriceFeed: false,
      snapshotProvider: fixedSnapshot,
      runnerFactory: () => new FakeRunner(),
    });

    await controller.start("sim");
    await expect(controller.start("sim")).rejects.toMatchObject({ statusCode: 409 });
    controller.dispose();
  });

  it("una estrategia en live dentro de un arranque en sim exige credenciales", async () => {
    // El usuario decidio que el ajuste baste y no haya confirmacion al arrancar, para que el watchdog
    // pueda reiniciar solo. Lo que no se salta es la clave: sin ella cada oportunidad de arbitraje
    // fallaria al ejecutar, y enterarse asi es la peor forma posible.
    const controller = new BotController(await baseConfig({ extra: { arbMode: "live" } }), {
      env: {},
      startPriceFeed: false,
      snapshotProvider: fixedSnapshot,
      runnerFactory: () => new FakeRunner(),
    });

    await expect(controller.start("sim")).rejects.toBeInstanceOf(ControllerError);
    controller.dispose();
  });

  it("con credenciales, arranca en sim con el arbitraje en live y lo dice sin confirmacion", async () => {
    const controller = new BotController(
      await baseConfig({ withSecrets: true, extra: { arbMode: "live", directionalMode: "sim" } }),
      {
        env: { POLYMARKET_SIGNATURE_TYPE: "0" },
        startPriceFeed: false,
        snapshotProvider: fixedSnapshot,
        runnerFactory: () => new FakeRunner(),
      },
    );

    const status = await controller.start("sim");
    expect(status.running).toBe(true);
    // La insignia tiene que decir la verdad: hay dinero real en juego aunque el arranque sea "sim".
    expect(status.effectiveModes).toEqual({ arb: "live", directional: "sim" });
    await controller.stop();
    controller.dispose();
  });

  it("blocks live mode without confirmation", async () => {
    const controller = new BotController(await baseConfig({ withSecrets: true }), {
      env: { POLYMARKET_SIGNATURE_TYPE: "0" },
      startPriceFeed: false,
      snapshotProvider: fixedSnapshot,
      runnerFactory: () => new FakeRunner(),
    });

    await expect(controller.start("live", false)).rejects.toBeInstanceOf(ControllerError);
    controller.dispose();
  });

  it("blocks live mode without configured secrets", async () => {
    const controller = new BotController(await baseConfig(), {
      env: {},
      startPriceFeed: false,
      snapshotProvider: fixedSnapshot,
      runnerFactory: () => new FakeRunner(),
    });

    await expect(controller.start("live", true)).rejects.toThrow(/requires private key/i);
    controller.dispose();
  });

  it("keeps the P&L reset applied while the bot is running", async () => {
    const config = await baseConfig();
    // The running bot's own state instance (loaded once, then mutated in memory like the real runner).
    const botState = new StateStore(config.dataDir);
    await botState.load();
    const slug = "btc-updown-5m-1";
    await botState.recordTradeAttempt(simTrade(slug));
    await botState.recordTradeResolution(
      slug,
      { resolvedAtMs: 10, finalPrice: 130, finalTickTimestampMs: 9, winningOutcome: "UP", won: true },
      "sim",
    );

    // Sanity: the resolved sim trade counts before any reset.
    const before = new StateStore(config.dataDir);
    await before.load();
    expect(calculatePnlSummaryByMode(before.listTrades(), before.getPnlResetAtMs()).sim.resolvedCount).toBe(1);

    const runner = new StateAwareFakeRunner(botState);
    const controller = new BotController(config, {
      startPriceFeed: false,
      snapshotProvider: fixedSnapshot,
      runnerFactory: () => runner,
    });
    await controller.start("sim");
    await controller.resetPnl("sim");

    // Simulate the bot persisting its state again AFTER the reset. With a separate state instance
    // (the old bug) this save would clobber the reset; routing through the runner's own state keeps it.
    await botState.saveOpening({
      slug,
      windowStartMs: 1,
      openingPrice: 100,
      openingTickTimestampMs: 1,
      capturedAtMs: 2,
    });

    expect(runner.resetCalls).toEqual(["sim"]);
    const after = new StateStore(config.dataDir);
    await after.load();
    expect(after.getPnlResetAtMs().sim).toBeGreaterThan(0);
    expect(calculatePnlSummaryByMode(after.listTrades(), after.getPnlResetAtMs()).sim.resolvedCount).toBe(0);
    controller.dispose();
  });
});

function simTrade(slug: string): TradeAttempt {
  return {
    id: `${slug}-trade`,
    slug,
    mode: "sim",
    outcome: "UP",
    tokenId: "token",
    amountUsd: 1,
    maxAskPrice: 0.98,
    bestAsk: 0.5,
    estimatedShares: 2,
    openingPrice: 100,
    entryPrice: 125,
    distanceUsd: 25,
    windowStartMs: 1,
    endMs: 2,
    createdAtMs: 3,
  };
}

async function baseConfig(options: { withSecrets?: boolean; extra?: Partial<BotConfig> } = {}): Promise<BotConfig> {
  const dataDir = await mkdtemp(join(tmpdir(), "polybot-ui-"));
  temps.push(dataDir);
  return {
    mode: "sim",
    confirmLive: false,
    minBtcDistanceUsd: 20,
    enabledMarkets: ["BTC"],
    minDistanceUsdByMarket: { BTC: 20, ETH: 5, DOGE: 0.0005 },
    entryWindowSeconds: 20,
    entryWindowSecondsByMarket: { BTC: 20, ETH: 20, DOGE: 20 },
    simTradeAmountUsd: 1,
    liveTradeAmountUsd: 1,
    autoMinLive: true,
    maxAskPrice: 0.98,
    dailySpendLimitUsd: 50,
    tickStaleMs: 10_000,
    pollIntervalMs: 1_000,
    openingCaptureGraceMs: 15_000,
    dataDir,
    gammaHost: "https://gamma-api.polymarket.com",
    clobHost: "https://clob.polymarket.com",
    rtdsUrl: "wss://ws-live-data.polymarket.com",
    polygonRpcUrl: "https://polygon-rpc.com",
    signatureType: 0,
    privateKey: options.withSecrets ? (`0x${"1".repeat(64)}` as `0x${string}`) : undefined,
    funderAddress: options.withSecrets ? (`0x${"2".repeat(40)}` as `0x${string}`) : undefined,
    ...options.extra,
  };
}

async function fixedSnapshot(): Promise<Partial<UiStatus>> {
  return {
    markets: [],
    dailySpendUsd: 0,
    signal: { reason: "no_market", inEntryWindow: false },
  };
}

/**
 * El piso de ask viajaba en settings pero `applySettings` no lo copiaba a la config del runner, asi
 * que este caia siempre al 0.01 por defecto: el piso NUNCA ha estado activo en produccion. Existe para
 * bloquear las entradas baratas de reversion, que el replay del ledger midio perdiendo 23 de 24 en ETH
 * por debajo de 0.30 — su ausencia deja pasar justo las peores.
 */
/**
 * Guardia GENERICA contra un fallo que ya ha ocurrido DOS veces: un ajuste existe en la UI, se guarda,
 * se muestra encendido — y el runner no se entera, porque `applySettings` no lo copia a la config con
 * la que arranca el bot. Paso con el piso de ask (nunca estuvo activo en produccion) y otra vez con el
 * arbitraje de 15m.
 *
 * Este test no comprueba un ajuste concreto: comprueba que TODOS los interruptores del esquema llegan.
 * Cualquier bandera nueva que alguien añada sin propagarla lo rompe aqui, en vez de descubrirse mirando
 * por que el bot no hace lo que la pantalla dice.
 */
describe("los interruptores de settings llegan al runner", () => {
  it("cada bandera booleana se refleja en la config aplicada", async () => {
    const { applySettings, settingsFromConfig } = await import("../src/ui/settings.js");
    const config = await baseConfig();
    const base = settingsFromConfig(config);

    const banderas = (Object.keys(base) as (keyof typeof base)[]).filter(
      (clave) => typeof base[clave] === "boolean",
    );
    expect(banderas.length).toBeGreaterThan(3);

    // Banderas que NO consume el runner, con el motivo. Cualquier otra que no propague es un fallo.
    // Añadir algo aqui tiene que ser un acto deliberado, no un descuido — que es justo lo que fallo
    // las dos veces anteriores.
    const noSonDelRunner = new Set([
      "autoStartSimOnBoot", // la lee el proceso de la UI al arrancar
      "watchdogEnabled", // la lee el watchdog de PowerShell via ui-config.json
      "aiAutoApplyLive", // las tres siguientes las consume el CONTROLADOR, no el bucle del bot
      "aiAutoTuneAskCap",
      "aiAutoProbeBands",
    ]);

    const sinPropagar: string[] = [];
    for (const clave of banderas) {
      if (noSonDelRunner.has(String(clave))) {
        continue;
      }
      const invertido = { ...base, [clave]: !base[clave] };
      const aplicado = applySettings(config, invertido) as unknown as Record<string, unknown>;
      if (aplicado[clave as string] !== !base[clave]) {
        sinPropagar.push(String(clave));
      }
    }
    expect(sinPropagar).toEqual([]);
  });

  it("cada ajuste NUMERICO tambien llega, no solo los booleanos", async () => {
    const { applySettings, settingsFromConfig } = await import("../src/ui/settings.js");
    const config = await baseConfig();
    const base = settingsFromConfig(config);

    // El guardia de arriba solo recorria booleanos. Por eso `arbMode` y los limites de riesgo podian
    // añadirse sin que nada comprobara que llegan al runner — que es EXACTAMENTE el fallo que ya se
    // cometio tres veces (piso de ask, arb15mEnabled, retencion de analitica).
    const numericas = (Object.keys(base) as (keyof typeof base)[]).filter(
      (clave) => typeof base[clave] === "number",
    );
    expect(numericas.length).toBeGreaterThan(10);

    const noSonDelRunner = new Set([
      "aiLastAppliedAtMs", // marca interna del cooldown de auto-apply, la lee el controlador
      // Los dos siguientes son espejos LEGACY: `applySettings` los deriva del mapa por mercado
      // (settings.ts:295 y :300), asi que la fuente de verdad es `...ByMarket.BTC` y escribir solo el
      // escalar no debe hacer nada. Excluidos a proposito, no por comodidad.
      "minBtcDistanceUsd",
      "entryWindowSeconds",
    ]);

    const sinPropagar: string[] = [];
    for (const clave of numericas) {
      if (noSonDelRunner.has(String(clave))) {
        continue;
      }
      // Un valor distinto y valido para cualquier rango del esquema: todos los numericos son
      // no-negativos y ninguno tiene un maximo por debajo de 1.
      const distinto = Number(base[clave]) === 1 ? 0.5 : 1;
      const aplicado = applySettings(config, { ...base, [clave]: distinto }) as unknown as Record<string, unknown>;
      if (aplicado[clave as string] !== distinto) {
        sinPropagar.push(String(clave));
      }
    }
    expect(sinPropagar).toEqual([]);
  });
});

describe("el modo de cada estrategia llega al runner", () => {
  it("arbMode y directionalMode se copian a la config aplicada", async () => {
    const { applySettings, settingsFromConfig } = await import("../src/ui/settings.js");
    const config = await baseConfig();
    const base = settingsFromConfig(config);

    // El guardia generico de arriba solo recorre booleanos, asi que estos dos ajustes —los unicos que
    // deciden si se mueve dinero real— se quedarian fuera de el. Aqui se comprueban a mano.
    const aplicado = applySettings(config, {
      ...base,
      arbMode: "live",
      directionalMode: "sim",
      makerMode: "live",
    });
    expect(aplicado.arbMode).toBe("live");
    expect(aplicado.directionalMode).toBe("sim");
    // El maker tambien: es enum, asi que el guardia generico (booleanos y numeros) no lo cubre.
    expect(aplicado.makerMode).toBe("live");
  });

  it('"heredado" no fija modo, para que mande el de arranque', async () => {
    const { applySettings, settingsFromConfig } = await import("../src/ui/settings.js");
    const config = await baseConfig();
    const base = settingsFromConfig(config);

    const aplicado = applySettings(config, { ...base, arbMode: "heredado", directionalMode: "heredado" });
    expect(aplicado.arbMode).toBeUndefined();
    expect(aplicado.directionalMode).toBeUndefined();
  });
});

describe("la ventana de ask llega entera al runner", () => {
  it("el PISO configurado no se queda por el camino", async () => {
    const { applySettings, settingsFromConfig } = await import("../src/ui/settings.js");
    const config = await baseConfig();
    const settings = {
      ...settingsFromConfig(config),
      minAskPriceByMarketOutcome: {
        BTC: { UP: 0.7, DOWN: 0.7 },
        ETH: { UP: 0.7, DOWN: 0.7 },
        DOGE: { UP: 0.85, DOWN: 0.85 },
      },
    };
    const runtime = applySettings(config, settings);
    expect(runtime.minAskPriceByMarketOutcome?.DOGE.UP).toBe(0.85);
    expect(runtime.minAskPriceByMarketOutcome?.BTC.UP).toBe(0.7);
  });
});

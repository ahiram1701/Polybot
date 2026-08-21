import { describe, expect, it } from "vitest";

import {
  medioContrario,
  planificarDosLados,
  precioObjetivo,
  puntuacionRecompensa,
} from "../src/makerQuoting.js";

/**
 * Barrido exhaustivo de las invariantes de las que depende NO PERDER DINERO.
 *
 * Los tests de al lado comprueban casos concretos elegidos por mi, que es exactamente como se me
 * escaparon los cuatro fallos que costaron $41,41. Estos recorren TODO el espacio de precios y ticks
 * que el exchange puede presentar, incluidos los extremos donde el redondeo y los topes se pelean.
 *
 * Desde que el maker elige mercados de todo Polymarket —y no tres de cripto—, los ticks y los precios
 * que ve ya no son los de siempre: hay mercados a 0,02 y a 0,98, con tick de 0,01 y de 0,001.
 */

/** Ticks que Polymarket usa de verdad. */
const TICKS = [0.01, 0.001];

/** Precios medios a barrer, con los extremos bien poblados: es donde el redondeo hace cosas raras. */
function mediosABarrer(tick: number): number[] {
  const medios: number[] = [];
  for (let p = tick; p < 1; p += tick) {
    medios.push(Number(p.toFixed(6)));
  }
  // Y medios "entre ticks", que es lo normal: el medio es (bid+ask)/2 y cae en medio tick.
  for (let p = tick / 2; p < 1; p += tick) {
    medios.push(Number(p.toFixed(6)));
  }
  return medios;
}

describe("invariantes del par, barridas sobre TODO el espacio de precios", () => {
  it("el par SIEMPRE cuesta menos de $1: es lo que hace que un par completo gane seguro", () => {
    // Es LA invariante. El par redime exactamente $1 gane quien gane, asi que pagar $1 o mas convierte
    // una operacion sin riesgo en una que no compensa —o que pierde—. Comprando los dos lados por
    // debajo de su medio, la suma es menor que 1 por construccion.
    // Se comprueba sobre el PLAN, no sobre la aritmetica del precio: en los extremos del libro no
    // existe un par con margen y lo correcto es no cotizar, cosa que solo sabe el plan.
    const infractores: string[] = [];
    let planes = 0;
    for (const tick of TICKS) {
      for (const mid of mediosABarrer(tick)) {
        const plan = planificarDosLados({
          mid,
          tickSize: tick,
          capitalDisponibleUsd: 10_000,
          params: { minSize: 20, maxSpreadCents: 4.5 },
          vivas: [],
        });
        if (plan.colocar.length === 0) {
          continue; // no cotizar es siempre seguro
        }
        planes += 1;
        const porParticipacion = plan.colocar.reduce((s, o) => s + o.price, 0);
        if (porParticipacion >= 1) {
          infractores.push(`mid=${mid} tick=${tick} -> ${porParticipacion.toFixed(4)}`);
        }
      }
    }
    expect(infractores.slice(0, 10)).toEqual([]);
    // Y que no pase por no cotizar nunca: la inmensa mayoria de los medios SI producen par.
    expect(planes).toBeGreaterThan(1000);
  });

  it("ningun precio se sale de (0,1): un precio de 0 o 1 no es una apuesta, es un error", () => {
    const malos: string[] = [];
    for (const tick of TICKS) {
      for (const mid of mediosABarrer(tick)) {
        for (const p of [precioObjetivo(mid, "BUY", tick), precioObjetivo(medioContrario(mid), "BUY", tick)]) {
          if (!(p > 0 && p < 1)) {
            malos.push(`mid=${mid} tick=${tick} -> ${p}`);
          }
        }
      }
    }
    expect(malos.slice(0, 10)).toEqual([]);
  });

  it("los precios colocados SIEMPRE puntuan: inmovilizar capital fuera de la banda es pagar por nada", () => {
    // Si la orden cae fuera de `max_spread`, cobra CERO y el dinero se queda inmovilizado igual. Con
    // tick de 0,01 y banda de 1,5c el margen es estrechisimo, asi que hay que comprobarlo, no suponerlo.
    const fuera: string[] = [];
    for (const tick of TICKS) {
      for (const maxSpreadCents of [1.5, 4.5, 5.5]) {
        const params = { minSize: 20, maxSpreadCents };
        for (const mid of mediosABarrer(tick)) {
          const up = precioObjetivo(mid, "BUY", tick);
          const down = precioObjetivo(medioContrario(mid), "BUY", tick);
          const qUp = puntuacionRecompensa(params.minSize, mid - up, params);
          const qDown = puntuacionRecompensa(params.minSize, medioContrario(mid) - down, params);
          if (qUp <= 0 || qDown <= 0) {
            fuera.push(`mid=${mid} tick=${tick} banda=${maxSpreadCents}c -> qUp=${qUp} qDown=${qDown}`);
          }
        }
      }
    }
    expect(fuera.slice(0, 10)).toEqual([]);
  });

  it("el plan completo nunca compromete mas de lo que se le da", () => {
    // El tope es la ultima linea de defensa. Se comprueba contra el plan de verdad, no contra la
    // aritmetica del precio.
    const excesos: string[] = [];
    for (const tick of TICKS) {
      for (const minSize of [20, 50, 200]) {
        const params = { minSize, maxSpreadCents: 4.5 };
        for (const mid of mediosABarrer(tick)) {
          for (const capital of [minSize * 0.5, minSize * 1.01, minSize * 3]) {
            const plan = planificarDosLados({ mid, tickSize: tick, capitalDisponibleUsd: capital, params, vivas: [] });
            const coste = plan.colocar.reduce((s, o) => s + o.price * o.size, 0);
            if (coste > capital) {
              excesos.push(`mid=${mid} tick=${tick} min=${minSize} cap=${capital} -> ${coste.toFixed(2)}`);
            }
          }
        }
      }
    }
    expect(excesos.slice(0, 10)).toEqual([]);
  });

  it("o coloca los DOS lados o no coloca ninguno: nunca uno solo desde cero", () => {
    // Media cotizacion es una apuesta direccional disfrazada, y es lo que costo $41,41 en 40 minutos.
    const sueltos: string[] = [];
    for (const tick of TICKS) {
      for (const minSize of [20, 50]) {
        const params = { minSize, maxSpreadCents: 4.5 };
        for (const mid of mediosABarrer(tick)) {
          for (const capital of [0, minSize * 0.9, minSize * 0.99, minSize * 5]) {
            const plan = planificarDosLados({ mid, tickSize: tick, capitalDisponibleUsd: capital, params, vivas: [] });
            if (plan.colocar.length === 1) {
              sueltos.push(`mid=${mid} tick=${tick} min=${minSize} cap=${capital}`);
            }
          }
        }
      }
    }
    expect(sueltos.slice(0, 10)).toEqual([]);
  });

  it("un mid imposible no produce ordenes, produce una retirada", () => {
    // Un libro roto no debe convertirse en ordenes a ciegas.
    for (const mid of [0, 1, -0.5, 1.5, Number.NaN, Number.POSITIVE_INFINITY, undefined]) {
      const plan = planificarDosLados({
        mid: mid as number | undefined,
        tickSize: 0.01,
        capitalDisponibleUsd: 1000,
        params: { minSize: 20, maxSpreadCents: 4.5 },
        vivas: [],
      });
      expect(plan.colocar).toEqual([]);
      expect(plan.motivo).toBe("sin_punto_medio");
    }
  });
});

describe("colocar PEGADO al medio no relaja ninguna invariante", () => {
  // `ticksDelMedio: 0` multiplica la puntuacion (100% en vez del 60% con banda de 4,5c) a cambio de
  // quedarse sin margen en el par y de ser el mejor precio del libro. Lo que NO puede hacer es abrir un
  // agujero: si el par llegara a costar mas de $1, cada par completo perderia dinero seguro.
  const AGRESIVO = { minSize: 20, maxSpreadCents: 4.5 };

  it("el par nunca cuesta MAS de $1, en todo el espacio de precios", () => {
    const infractores: string[] = [];
    let planes = 0;
    for (const tick of TICKS) {
      for (const mid of mediosABarrer(tick)) {
        const plan = planificarDosLados({
          mid,
          tickSize: tick,
          capitalDisponibleUsd: 10_000,
          params: AGRESIVO,
          vivas: [],
          ticksDelMedio: 0,
        });
        if (plan.colocar.length === 0) continue;
        planes += 1;
        const porParticipacion = plan.colocar.reduce((s, o) => s + o.price, 0);
        if (porParticipacion > 1) {
          infractores.push(`mid=${mid} tick=${tick} -> ${porParticipacion.toFixed(4)}`);
        }
      }
    }
    expect(infractores.slice(0, 10)).toEqual([]);
    expect(planes).toBeGreaterThan(1000);
  });

  it("ningun precio queda por ENCIMA de su medio: cruzar convierte la orden en taker", () => {
    const cruces: string[] = [];
    for (const tick of TICKS) {
      for (const mid of mediosABarrer(tick)) {
        const plan = planificarDosLados({
          mid,
          tickSize: tick,
          capitalDisponibleUsd: 10_000,
          params: AGRESIVO,
          vivas: [],
          ticksDelMedio: 0,
        });
        for (const o of plan.colocar) {
          const suMedio = o.outcome === "UP" ? mid : medioContrario(mid);
          if (o.price > suMedio + 1e-9) {
            cruces.push(`mid=${mid} tick=${tick} ${o.outcome}@${o.price} > ${suMedio}`);
          }
        }
      }
    }
    expect(cruces.slice(0, 10)).toEqual([]);
  });

  it("y puntua MAS que el modo conservador, que es para lo que existe", () => {
    // Con el medio justo en un tick, el conservador queda a 1 centavo (60% de la puntuacion con banda
    // de 4,5c) y el agresivo a cero (100%).
    const conservador = precioObjetivo(0.5, "BUY", 0.01, 1);
    const agresivo = precioObjetivo(0.5, "BUY", 0.01, 0);
    expect(conservador).toBeCloseTo(0.49, 6);
    expect(agresivo).toBeCloseTo(0.5, 6);
    const qCons = puntuacionRecompensa(20, 0.5 - conservador, AGRESIVO);
    const qAgr = puntuacionRecompensa(20, 0.5 - agresivo, AGRESIVO);
    expect(qAgr).toBeGreaterThan(qCons);
    expect(qAgr / qCons).toBeCloseTo(1 / ((4.5 - 1) / 4.5) ** 2, 2);
  });
});

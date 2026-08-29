import { describe, expect, it } from "vitest";

import {
  elegirMercados,
  medioAjustadoPorTamano,
  planificarDosLados,
  precioObjetivo,
  puntuacionRecompensa,
  qMinOficial,
  siguePuntuando,
} from "../src/makerQuoting.js";
import type { CandidatoMercado, OrdenViva } from "../src/makerQuoting.js";

const PARAMS = { minSize: 50, maxSpreadCents: 1.5 };

describe("precio objetivo de una orden en reposo", () => {
  it("se pega al medio SIN cruzar el spread", () => {
    // El reparto es cuadratico con la distancia al medio, asi que un centavo de mas cuesta mucho. Pero
    // cruzar convierte la orden en taker: pagarias 7% justo en lo que vienes a dejar de pagar.
    expect(precioObjetivo(0.5, "BUY", 0.01)).toBe(0.49);
    expect(precioObjetivo(0.5, "SELL", 0.01)).toBe(0.51);
  });

  it("nunca sale de (0,1): un precio de 0 o 1 no es una apuesta, es un error", () => {
    expect(precioObjetivo(0.005, "BUY", 0.01)).toBeGreaterThan(0);
    expect(precioObjetivo(0.995, "SELL", 0.01)).toBeLessThan(1);
  });
});

describe("cuando una orden deja de puntuar", () => {
  const orden: OrdenViva = { id: "1", outcome: "UP", side: "BUY", price: 0.49, size: 50 };

  it("dentro de la banda y con tamano suficiente, puntua", () => {
    expect(siguePuntuando(orden, 0.5, PARAMS)).toBe(true);
  });

  it("si el medio se aleja mas de la banda, deja de puntuar", () => {
    // 0,49 contra un medio de 0,53 son 4 centavos: fuera de los 1,5 que paga.
    expect(siguePuntuando(orden, 0.53, PARAMS)).toBe(false);
  });

  it("por debajo del tamano minimo NO puntua, aunque este pegada al medio", () => {
    // Es la trampa del programa: una orden pequena no cobra menos, cobra CERO.
    expect(siguePuntuando({ ...orden, size: 49 }, 0.5, PARAMS)).toBe(false);
  });
});

describe("puntuacion oficial S(v,s)", () => {
  it("cae con el CUADRADO de la distancia, no linealmente", () => {
    // A media banda queda 1/4, no 1/2. Por eso pegarse al medio no es una preferencia.
    const pegada = puntuacionRecompensa(50, 0, PARAMS);
    const aMedia = puntuacionRecompensa(50, 0.0075, PARAMS);
    expect(pegada).toBeCloseTo(50, 6);
    expect(aMedia).toBeCloseTo(50 * 0.25, 6);
  });

  it("fuera de la banda o por debajo del minimo es CERO, no 'poco'", () => {
    expect(puntuacionRecompensa(50, 0.02, PARAMS)).toBe(0);
    expect(puntuacionRecompensa(49, 0, PARAMS)).toBe(0);
  });
});

describe("Q_min oficial: el castigo por cotizar un solo lado", () => {
  it("dentro de [0,10-0,90] un solo lado cobra un TERCIO", () => {
    expect(qMinOficial(90, 0, 0.5)).toBeCloseTo(30, 6);
  });

  it("FUERA de [0,10-0,90] un solo lado cobra CERO", () => {
    // Es la regla que hizo que el 24% del gasto del 2026-08-19 tuviera recompensa nula por definicion:
    // el bot compraba a 0,01-0,09, todo por debajo del suelo de 0,10.
    expect(qMinOficial(90, 0, 0.05)).toBe(0);
    expect(qMinOficial(90, 0, 0.95)).toBe(0);
  });

  it("con los dos lados equilibrados no hay castigo en ningun rango", () => {
    expect(qMinOficial(90, 90, 0.5)).toBeCloseTo(90, 6);
    expect(qMinOficial(90, 90, 0.05)).toBeCloseTo(90, 6);
  });
});

describe("plan de ordenes: SIEMPRE los dos lados", () => {
  const base = { mid: 0.5, tickSize: 0.01, capitalDisponibleUsd: 60, params: PARAMS };

  it("desde cero coloca los DOS lados, no uno", () => {
    // El fallo que costo $41,41: cotizar solo UP es comprar direccional, porque una compra en reposo
    // solo se llena cuando el precio CAE hasta ella.
    const plan = planificarDosLados({ ...base, vivas: [] });
    expect(plan.colocar.map((o) => o.outcome).sort()).toEqual(["DOWN", "UP"]);
    expect(plan.colocar.every((o) => o.side === "BUY" && o.size === 50)).toBe(true);
  });

  it("el par cuesta poco menos de $1 por participacion: por eso redime con ganancia", () => {
    const plan = planificarDosLados({ ...base, vivas: [] });
    const coste = plan.colocar.reduce((s, o) => s + o.price * o.size, 0);
    // 50 pares a $0,98 = $49, y el par redime exactamente $50 gane quien gane.
    expect(coste).toBeCloseTo(49, 6);
    expect(coste).toBeLessThan(50);
  });

  it("si el capital solo da para UN lado, no coloca NADA", () => {
    // Media cotizacion es exactamente el error que se viene a corregir: mas vale no cotizar.
    const plan = planificarDosLados({ ...base, capitalDisponibleUsd: 30, vivas: [] });
    expect(plan.colocar).toEqual([]);
    expect(plan.motivo).toMatch(/^capital_insuficiente_necesita_49/);
  });

  it("con las dos ordenes puestas y el libro quieto, no toca nada", () => {
    const vivas: OrdenViva[] = [
      { id: "u", outcome: "UP", side: "BUY", price: 0.49, size: 50 },
      { id: "d", outcome: "DOWN", side: "BUY", price: 0.49, size: 50 },
    ];
    const plan = planificarDosLados({ ...base, vivas });
    expect(plan.colocar).toEqual([]);
    expect(plan.cancelar).toEqual([]);
  });

  it("repone SOLO el lado que falta", () => {
    const vivas: OrdenViva[] = [{ id: "u", outcome: "UP", side: "BUY", price: 0.49, size: 50 }];
    const plan = planificarDosLados({ ...base, vivas });
    expect(plan.colocar.map((o) => o.outcome)).toEqual(["DOWN"]);
    expect(plan.cancelar).toEqual([]);
  });

  it("sin punto medio retira todo en vez de dejar ordenes a ciegas", () => {
    const vivas: OrdenViva[] = [{ id: "u", outcome: "UP", side: "BUY", price: 0.49, size: 50 }];
    const plan = planificarDosLados({ ...base, mid: undefined, vivas });
    expect(plan.colocar).toEqual([]);
    expect(plan.cancelar.map((o) => o.id)).toEqual(["u"]);
    expect(plan.motivo).toBe("sin_punto_medio");
  });

  it("el precio de DOWN sale del medio COMPLEMENTARIO, no del de UP", () => {
    // Con el medio de UP en 0,56, el de DOWN es 0,44 y su compra va a 0,43. Usar 0,55 para los dos
    // seria pagar 0,55+0,55 = $1,10 por un par que redime $1: perder 10 centavos por participacion.
    const plan = planificarDosLados({ ...base, mid: 0.56, vivas: [] });
    const porLado = Object.fromEntries(plan.colocar.map((o) => [o.outcome, o.price]));
    expect(porLado.UP).toBeCloseTo(0.55, 6);
    expect(porLado.DOWN).toBeCloseTo(0.43, 6);
    expect(porLado.UP + porLado.DOWN).toBeLessThan(1);
  });
});

describe("el tope cuenta tambien el lado que se CONSERVA", () => {
  it("al recolocar un lado, no se pasa del tope sumando el que se queda", () => {
    // Caso observado en produccion el 2026-08-20, no inventado: `+1 -1 coloca $15,00` sobre un mercado
    // que tenia $19,60 vivos. El lado conservado valia $5,40 y el nuevo costaba $15,00 -> **$20,40 con
    // el tope en $20**. La comprobacion medía solo lo que se coloca contra el tope entero e ignoraba lo
    // que se queda puesto. El exceso no esta acotado: depende de lo que valga el lado conservado.
    const params = { minSize: 20, maxSpreadCents: 4.5 };
    // El medio se movio a 0,24; la compra de UP a 0,27 sigue dentro de banda (3c de 4,5c) y vale $5,40.
    const vivas: OrdenViva[] = [{ id: "u", outcome: "UP", side: "BUY", price: 0.27, size: 20 }];
    const plan = planificarDosLados({
      mid: 0.24,
      tickSize: 0.01,
      capitalDisponibleUsd: 20,
      params,
      vivas,
    });
    const conservado = vivas
      .filter((o) => !plan.cancelar.includes(o))
      .reduce((s, o) => s + o.price * o.size, 0);
    const colocado = plan.colocar.reduce((s, o) => s + o.price * o.size, 0);
    expect(conservado + colocado).toBeLessThanOrEqual(20);
  });

  it("con tope de sobra si recoloca el lado que falta", () => {
    // La correccion no puede dejar mudo al maker cuando el dinero SI da.
    const params = { minSize: 20, maxSpreadCents: 4.5 };
    const vivas: OrdenViva[] = [{ id: "u", outcome: "UP", side: "BUY", price: 0.27, size: 20 }];
    const plan = planificarDosLados({
      mid: 0.24,
      tickSize: 0.01,
      capitalDisponibleUsd: 100,
      params,
      vivas,
    });
    expect(plan.colocar.map((o) => o.outcome)).toEqual(["DOWN"]);
  });
});

describe("guarda de inventario contra la seleccion adversa", () => {
  const base = { mid: 0.5, tickSize: 0.01, capitalDisponibleUsd: 60, params: PARAMS };

  it("siendo largo de UP deja de pedir UP y solo pide DOWN", () => {
    // Completar el par redime $1 seguro; volver a pedir UP seria doblar sobre el lado que cae, que es
    // literalmente lo que hizo el 2026-08-19: 0,140 -> 0,120 -> 0,110 -> 0,090 -> 0,070 en 28 segundos.
    const plan = planificarDosLados({ ...base, vivas: [], inventario: { UP: 50, DOWN: 0 } });
    expect(plan.colocar.map((o) => o.outcome)).toEqual(["DOWN"]);
  });

  it("retira la compra viva del lado del que ya se es largo", () => {
    const vivas: OrdenViva[] = [{ id: "u", outcome: "UP", side: "BUY", price: 0.49, size: 50 }];
    const plan = planificarDosLados({ ...base, vivas, inventario: { UP: 50, DOWN: 0 } });
    expect(plan.cancelar.map((o) => o.id)).toEqual(["u"]);
    expect(plan.colocar.map((o) => o.outcome)).toEqual(["DOWN"]);
  });

  it("con el inventario emparejado vuelve a cotizar los dos lados", () => {
    const plan = planificarDosLados({ ...base, vivas: [], inventario: { UP: 50, DOWN: 50 } });
    expect(plan.colocar.map((o) => o.outcome).sort()).toEqual(["DOWN", "UP"]);
  });
});

describe("no recolocar por un tick de nada", () => {
  const base = { mid: 0.5, tickSize: 0.01, capitalDisponibleUsd: 60, params: PARAMS };

  it("mantiene las ordenes mientras sigan puntuando, aunque el medio se mueva", () => {
    const vivas: OrdenViva[] = [
      { id: "u", outcome: "UP", side: "BUY", price: 0.49, size: 50 },
      { id: "d", outcome: "DOWN", side: "BUY", price: 0.49, size: 50 },
    ];
    const plan = planificarDosLados({ ...base, mid: 0.502, vivas });
    expect(plan.colocar).toEqual([]);
    expect(plan.cancelar).toEqual([]);
  });

  it("el umbral NO puede ser mas estricto que la colocacion ideal", () => {
    // La orden ideal se pone a un tick del medio. Si el criterio para mantenerla fuera mas estricto que
    // eso, se recolocaria a un precio que al instante se considera insuficiente: churn infinito.
    const price = precioObjetivo(0.5, "BUY", 0.01);
    const vivas: OrdenViva[] = [
      { id: "u", outcome: "UP", side: "BUY", price, size: 50 },
      { id: "d", outcome: "DOWN", side: "BUY", price, size: 50 },
    ];
    const plan = planificarDosLados({ ...base, vivas });
    expect(plan.colocar).toEqual([]);
    expect(plan.cancelar).toEqual([]);
  });

  it("respeta el intervalo minimo entre recolocaciones", () => {
    const vivas: OrdenViva[] = [{ id: "u", outcome: "UP", side: "BUY", price: 0.49, size: 50 }];
    const plan = planificarDosLados({
      ...base,
      vivas,
      ultimaRecolocacionMs: 1_000,
      minMsEntreRecolocaciones: 15_000,
      nowMs: 5_000,
    });
    expect(plan.colocar).toEqual([]);
    expect(plan.motivo).toBe("espera_entre_recolocaciones");
  });
});

describe("a que mercados dedicar un capital escaso", () => {
  const base: Omit<CandidatoMercado, "slug" | "poolDiaUsd" | "qRivalBid" | "qRivalAsk"> = {
    params: PARAMS,
    mid: 0.5,
    tickSize: 0.01,
  };

  it("prefiere el mercado EQUILIBRADO cuando los dos pagan igual", () => {
    // Las dos patas cuestan lo mismo en participaciones pero no en dolares. A 0,80 la cara vale cuatro
    // veces la barata: si te llenan una sola, lo normal es acabar con la cara. A 0,50 las dos son
    // iguales y la mitad de grandes.
    //
    // Paso el 2026-08-29 en un mercado a 0,77: llenaron la pata cara entera, $15,40 de $23,50 de
    // capital en una sola direccion. En uno equilibrado habrian sido $10.
    const elegidos = elegirMercados(
      [
        { ...base, slug: "extremo", mid: 0.8, poolDiaUsd: 100, qRivalBid: 0, qRivalAsk: 0 },
        { ...base, slug: "equilibrado", mid: 0.5, poolDiaUsd: 100, qRivalBid: 0, qRivalAsk: 0 },
      ],
      1000,
    );

    expect(elegidos[0].slug).toBe("equilibrado");
    // Y la exposicion de peor caso explica por que: es lo que puedes acabar teniendo de un solo lado.
    const extremo = elegidos.find((e) => e.slug === "extremo");
    const equilibrado = elegidos.find((e) => e.slug === "equilibrado");
    expect(extremo!.exposicionPeorCasoUsd).toBeGreaterThan(equilibrado!.exposicionPeorCasoUsd);
  });

  it("ordena por rendimiento POR DOLAR, no por tamano del bote", () => {
    // BTC reparte 12 veces mas que DOGE, pero con 400 de puntuacion compitiendo en los dos lados. En
    // DOGE no compite nadie. Como el par cuesta lo mismo (~$49) en los dos, gana DOGE: se lleva el
    // bote entero. Con el reparto lineal de antes ganaba BTC — ese sesgo es justo lo que se corrige.
    const elegidos = elegirMercados(
      [
        { ...base, slug: "btc", poolDiaUsd: 34.72, qRivalBid: 400, qRivalAsk: 400 },
        { ...base, slug: "doge", poolDiaUsd: 2.89, qRivalBid: 0, qRivalAsk: 0 },
      ],
      1000,
    );
    expect(elegidos.map((e) => e.slug)).toEqual(["doge", "btc"]);
    expect(elegidos[0]!.esperadoUsdDia).toBeGreaterThan(elegidos[1]!.esperadoUsdDia);
  });

  it("un solo lado rival vale un TERCIO: la formula oficial, no una lineal", () => {
    // Mismo bote y misma puntuacion bruta; el rival de la izquierda cotiza los dos lados y el de la
    // derecha solo uno. Contra el que solo cotiza un lado se captura mas cuota.
    const [dosLados] = elegirMercados(
      [{ ...base, slug: "a", poolDiaUsd: 10, qRivalBid: 90, qRivalAsk: 90 }],
      1000,
    );
    const [unLado] = elegirMercados(
      [{ ...base, slug: "b", poolDiaUsd: 10, qRivalBid: 90, qRivalAsk: 0 }],
      1000,
    );
    expect(unLado!.esperadoUsdDia).toBeGreaterThan(dosLados!.esperadoUsdDia);
  });

  it("no compromete el mismo dolar dos veces", () => {
    const tres = ["a", "b", "c"].map((slug) => ({
      ...base,
      slug,
      poolDiaUsd: 10,
      qRivalBid: 0,
      qRivalAsk: 0,
    }));
    // Cada par cuesta ~$49, asi que con $60 solo cabe uno.
    const elegidos = elegirMercados(tres, 60);
    expect(elegidos).toHaveLength(1);
    expect(elegidos.reduce((s, e) => s + e.costeUsd, 0)).toBeLessThanOrEqual(60);
  });

  it("el par cuesta ~$50 CUALQUIERA que sea el precio: por eso $12 nunca pudo calificar", () => {
    // UP + DOWN ~= $1 por participacion, y el minimo que puntua son 50. No hay banda barata.
    for (const mid of [0.1, 0.3, 0.5, 0.7, 0.9]) {
      const [e] = elegirMercados(
        [{ ...base, mid, slug: "x", poolDiaUsd: 10, qRivalBid: 0, qRivalAsk: 0 }],
        1000,
      );
      expect(e!.costeUsd).toBeGreaterThan(48);
      expect(e!.costeUsd).toBeLessThan(50);
    }
    expect(elegirMercados([{ ...base, slug: "x", poolDiaUsd: 10, qRivalBid: 0, qRivalAsk: 0 }], 12)).toEqual([]);
  });

  it("descarta mercados sin bote: poner ordenes donde no pagan es inmovilizar dinero a cambio de nada", () => {
    expect(
      elegirMercados([{ ...base, slug: "sin-pool", poolDiaUsd: 0, qRivalBid: 0, qRivalAsk: 0 }], 1000),
    ).toEqual([]);
  });
});

describe("el medio que reparte es el AJUSTADO POR TAMANO, no el del libro entero", () => {
  // La formula oficial define `s` como "spread from size-cutoff-adjusted midpoint": el medio que queda
  // tras tirar los niveles por debajo del minimo del programa. Existe para que nadie fije un medio
  // falso con polvo. El bucle usaba el crudo y colocaba a un tick de EL.
  it("tira los niveles por debajo del minimo antes de calcular el medio", () => {
    // Polvo pegado por dentro (5 y 4 participaciones) contra los niveles que SI califican.
    const bids = [
      { price: 0.45, size: 5 },
      { price: 0.3, size: 40 },
    ];
    const asks = [
      { price: 0.55, size: 4 },
      { price: 0.7, size: 40 },
    ];
    expect(medioAjustadoPorTamano(bids, asks, 20)).toBeCloseTo(0.5, 9);
    // Con el minimo por debajo del polvo, el polvo cuenta y el medio es el crudo.
    expect(medioAjustadoPorTamano(bids, asks, 4)).toBeCloseTo((0.45 + 0.55) / 2, 9);
    // El corte es INCLUSIVO: el minimo del programa es el tamano que ya califica, no el que hay que
    // superar. Con corte en 5, el bid de 5 entra y el ask de 4 no.
    expect(medioAjustadoPorTamano(bids, asks, 5)).toBeCloseTo((0.45 + 0.7) / 2, 9);
  });

  it("el polvo puede desplazar el medio de verdad, que es justo el fallo que esto corrige", () => {
    const bids = [
      { price: 0.49, size: 5 },
      { price: 0.2, size: 40 },
    ];
    const asks = [{ price: 0.6, size: 40 }];
    const crudo = (0.49 + 0.6) / 2; // 0,545
    const ajustado = medioAjustadoPorTamano(bids, asks, 20)!; // (0,20 + 0,60) / 2 = 0,40
    expect(ajustado).toBeCloseTo(0.4, 9);
    // Casi 15 centavos de diferencia: con banda de 4,5 no existe un precio que puntue con los dos.
    expect(Math.abs(crudo - ajustado)).toBeGreaterThan(0.045);
  });

  it("sin un solo nivel que llegue al minimo devuelve undefined, que NO es un medio de cero", () => {
    const polvo = [{ price: 0.4, size: 3 }];
    expect(medioAjustadoPorTamano(polvo, [{ price: 0.6, size: 3 }], 20)).toBeUndefined();
    // Un lado si y el otro no tampoco vale: el medio necesita los dos.
    expect(medioAjustadoPorTamano([{ price: 0.4, size: 50 }], [{ price: 0.6, size: 3 }], 20)).toBeUndefined();
  });
});

describe("el suelo de pago de $1 al dia: por debajo no se cobra menos, se cobra CERO", () => {
  const base: Omit<CandidatoMercado, "slug" | "poolDiaUsd" | "qRivalBid" | "qRivalAsk"> = {
    params: PARAMS,
    mid: 0.5,
    tickSize: 0.01,
  };

  it("descarta el mercado que no puede cruzar el suelo, aunque sea el mejor disponible", () => {
    // Bote minusculo y sin competencia: se lleva el 100% de $0,40 al dia. Polymarket no paga eso —
    // y el capital queda igual de inmovilizado, con la seleccion adversa corriendo igual.
    const flojo = [{ ...base, slug: "flojo", poolDiaUsd: 0.4, qRivalBid: 0, qRivalAsk: 0 }];
    expect(elegirMercados(flojo, 1000, 1, 0, 5)).toEqual([]);
    // Sin umbral (el comportamiento de antes) si lo elegia.
    expect(elegirMercados(flojo, 1000).map((e) => e.slug)).toEqual(["flojo"]);
  });

  it("no toca a los que si lo cruzan", () => {
    const bueno = [{ ...base, slug: "bueno", poolDiaUsd: 200, qRivalBid: 0, qRivalAsk: 0 }];
    expect(elegirMercados(bueno, 1000, 1, 0, 5).map((e) => e.slug)).toEqual(["bueno"]);
  });

  it("el umbral se mide contra lo esperado DESPUES de repartir con los rivales, no contra el bote", () => {
    // Bote de $100 al dia, pero con tanta competencia que nuestra cuota deja $3: por debajo del
    // umbral aunque el bote parezca enorme. Mirar el bote es exactamente el error que cuesta dinero.
    const [conCuota] = elegirMercados(
      [{ ...base, slug: "peleado", poolDiaUsd: 100, qRivalBid: 5000, qRivalAsk: 5000 }],
      1000,
    );
    expect(conCuota!.esperadoUsdDia).toBeLessThan(5);
    expect(elegirMercados(
      [{ ...base, slug: "peleado", poolDiaUsd: 100, qRivalBid: 5000, qRivalAsk: 5000 }],
      1000, 1, 0, 5,
    )).toEqual([]);
  });
});

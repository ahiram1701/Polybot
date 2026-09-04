import { describe, expect, it } from "vitest";

import { selectFavoriteOutcome } from "../src/favoriteSelector.js";
import type { OrderbookQuote, Outcome } from "../src/types.js";

function quote(bestAsk: number | undefined): OrderbookQuote {
  return {
    tokenId: "token",
    quotedAtMs: 1_000,
    bestAsk,
    bestBid: bestAsk === undefined ? undefined : Math.max(bestAsk - 0.01, 0.01),
    availableUsdUnderCap: 50,
    availableUsdAllLevels: 200,
    estimatedSharesForAmount: bestAsk ? 5 / bestAsk : 0,
    // El selector solo mira `bestAsk`, pero se construye un OrderbookQuote completo a proposito: con
    // un `as` parcial, un campo nuevo del tipo no rompe este test y la cobertura envejece en silencio.
    rawAskLevels: bestAsk === undefined ? [] : [{ price: bestAsk, size: 100 }],
    rawBidLevels: [],
    availableBidUsdAllLevels: 0,
  };
}

function quotes(up: number | undefined, down: number | undefined): Partial<Record<Outcome, OrderbookQuote>> {
  return { UP: quote(up), DOWN: quote(down) };
}

describe("selectFavoriteOutcome", () => {
  it("elige el lado caro cuando su ask cae dentro de la banda", () => {
    const decision = selectFavoriteOutcome({ quotes: quotes(0.8, 0.22) });

    expect(decision.reason).toBe("in_band");
    expect(decision.selection).toEqual({ outcome: "UP", askPrice: 0.8, oppositeAskPrice: 0.22 });
  });

  it("elige DOWN cuando el favorito es el otro lado", () => {
    const decision = selectFavoriteOutcome({ quotes: quotes(0.21, 0.79) });

    expect(decision.reason).toBe("in_band");
    expect(decision.selection?.outcome).toBe("DOWN");
    expect(decision.selection?.askPrice).toBe(0.79);
  });

  it("descarta cuando el mercado sigue repartido y no hay favorito claro", () => {
    const decision = selectFavoriteOutcome({ quotes: quotes(0.62, 0.4) });

    expect(decision.reason).toBe("below_band");
    expect(decision.selection).toBeUndefined();
  });

  it("descarta al favorito demasiado caro: el premio se encoge mas rapido que el riesgo", () => {
    const decision = selectFavoriteOutcome({ quotes: quotes(0.91, 0.11) });

    expect(decision.reason).toBe("above_band");
    expect(decision.selection).toBeUndefined();
  });

  // La guardia que da sentido a todo lo demas: en un libro muerto el ask no es una probabilidad.
  it("rechaza un libro muerto aunque un lado cotice justo en la banda", () => {
    const decision = selectFavoriteOutcome({ quotes: quotes(0.8, 0.8) });

    expect(decision.reason).toBe("dead_book");
    expect(decision.detail.askSum).toBe(1.6);
  });

  it("exige los dos lados: sin el contrario no se puede detectar el libro muerto", () => {
    const decision = selectFavoriteOutcome({ quotes: quotes(0.8, undefined) });

    expect(decision.reason).toBe("missing_quote");
    expect(decision.selection).toBeUndefined();
  });

  it("un empate exacto no declara favorito", () => {
    const decision = selectFavoriteOutcome({ quotes: quotes(0.5, 0.5) });

    expect(decision.reason).toBe("no_favorite");
  });

  it("respeta una banda configurada distinta de la de por defecto", () => {
    const decision = selectFavoriteOutcome({ quotes: quotes(0.7, 0.32), minAsk: 0.65, maxAsk: 0.75 });

    expect(decision.reason).toBe("in_band");
    expect(decision.selection?.askPrice).toBe(0.7);
  });

  // Una banda invertida no debe abrir la puerta: sin operaciones es el fallo seguro.
  it("no deja pasar nada con la banda invertida", () => {
    const decision = selectFavoriteOutcome({ quotes: quotes(0.8, 0.21), minAsk: 0.85, maxAsk: 0.76 });

    expect(decision.selection).toBeUndefined();
  });

  // Los dos rechazan, pero no son el mismo suceso: quedarse sin asks (lo normal al cerrar la ventana)
  // no es lo mismo que un ask en 0 o >=1. Juntos, el log decia "falta el libro" enseñando un ask.
  it("un precio en el extremo NO se reporta como libro ausente", () => {
    const extremo = selectFavoriteOutcome({ quotes: quotes(1, 0.01) });

    expect(extremo.reason).toBe("extreme_price");
    expect(extremo.detail).toEqual({ upAsk: 1, downAsk: 0.01 });

    expect(selectFavoriteOutcome({ quotes: quotes(0.8, 0) }).reason).toBe("extreme_price");
  });
});

describe("tramo de maxima conviccion", () => {
  const libro = (up: number, dn: number) => ({ UP: quote(up), DOWN: quote(dn) });

  it("por encima del umbral entra, y lo marca como max_size en vez de above_band", () => {
    // 0,99 esta MUY por encima de la banda 0,79-0,90. Sin el tramo saldria `above_band` y no operaria.
    const d = selectFavoriteOutcome({ quotes: libro(0.99, 0.03), minAsk: 0.79, maxAsk: 0.9, maxSizeAsk: 0.98 });
    expect(d.reason).toBe("max_size");
    expect(d.selection?.outcome).toBe("UP");
    expect(d.selection?.askPrice).toBeCloseTo(0.99, 9);
  });

  it("el umbral es ESTRICTO: justo en el umbral no es maxima conviccion", () => {
    // 0,98 exacto no basta. Un `>=` aqui convertiria el borde de la banda en una apuesta de todo el
    // capital por un centimo de diferencia.
    const d = selectFavoriteOutcome({ quotes: libro(0.98, 0.04), minAsk: 0.79, maxAsk: 0.9, maxSizeAsk: 0.98 });
    expect(d.reason).toBe("above_band");
    expect(d.selection).toBeUndefined();
  });

  it("apagado (sin umbral) todo lo caro vuelve a salir como above_band", () => {
    const d = selectFavoriteOutcome({ quotes: libro(0.99, 0.03), minAsk: 0.79, maxAsk: 0.9 });
    expect(d.reason).toBe("above_band");
    expect(d.selection).toBeUndefined();
  });

  it("un libro MUERTO gana al tramo: un 0,99 ahi no es probabilidad", () => {
    // 0,99 + 0,30 = 1,29 > 1,15. Es la unica barrera entre este tramo y pagar el ancho de un libro
    // vacio con todo el capital, asi que tiene que comprobarse ANTES.
    const d = selectFavoriteOutcome({ quotes: libro(0.99, 0.3), minAsk: 0.79, maxAsk: 0.9, maxSizeAsk: 0.98 });
    expect(d.reason).toBe("dead_book");
    expect(d.selection).toBeUndefined();
  });

  it("la zona muerta entre la banda y el umbral sigue sin operarse", () => {
    const d = selectFavoriteOutcome({ quotes: libro(0.94, 0.08), minAsk: 0.79, maxAsk: 0.9, maxSizeAsk: 0.98 });
    expect(d.reason).toBe("above_band");
  });

  it("la banda normal no se entera de que el tramo existe", () => {
    const d = selectFavoriteOutcome({ quotes: libro(0.85, 0.16), minAsk: 0.79, maxAsk: 0.9, maxSizeAsk: 0.98 });
    expect(d.reason).toBe("in_band");
  });

  it("un umbral invalido se ignora en vez de apagar la banda", () => {
    // 1 no es un precio de participacion. Se trata como "no configurado", no como "todo es conviccion".
    const d = selectFavoriteOutcome({ quotes: libro(0.99, 0.03), minAsk: 0.79, maxAsk: 0.9, maxSizeAsk: 1 });
    expect(d.reason).toBe("above_band");
  });
});

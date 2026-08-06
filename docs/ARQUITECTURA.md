# Arquitectura de Polybot

Cómo funciona por dentro y qué invariantes hay que respetar al tocarlo. Para operarlo, ver el [MANUAL](MANUAL.md).

---

## Flujo de una iteración

El bucle corre cada `pollIntervalMs` (1s por defecto) en `BotRunner.runIteration`:

```
1. Refresco del saldo on-chain      (sin await: no debe bloquear)
2. reconcileLiveTrades              (solo live)
3. resolveCompletedTrades           (resuelve ventanas cerradas)
4. getCurrentMarkets                (3 fetch a gamma, en paralelo)
5. FASE 1 — captura, en paralelo por mercado:
      ensureOpening                 (tick de apertura del feed)
      getAnalyticsQuotes            (2 getQuote al CLOB por mercado)
      recordAnalyticsObservation    (append a analytics.jsonl)
      observeArbOpportunity
6. FASE 2 — decisión, secuencial:
      circuit breaker → buildTradeSignal → EV gate → ejecución
7. verifyOfficialResolutions        (2 fetch a gamma cada 30s)
```

Las fases 1 y 2 están separadas a propósito: capturar en paralelo mantiene los ticks frescos; decidir en serie garantiza orden determinista y un límite de gasto compartido.

## Fuentes de datos

| Fuente | Para qué | Notas |
|---|---|---|
| **Gamma** (`gamma-api.polymarket.com`) | Metadatos del mercado, slug, tokenIds, resolución oficial | Caché de 5s por slug, con fallback a caché rancia si falla |
| **CLOB** (`clob.polymarket.com`) | Libro de órdenes, ejecución | `withTimeout` de 2s que **no cancela** la petición subyacente |
| **RTDS** (`ws-live-data.polymarket.com`) | Ticks de precio de Chainlink | WebSocket persistente; no pasa por el pool HTTP |
| **Polygon RPC** | Saldo de colateral (`balanceOf`) | Solo lectura, con caché de 60s y retroceso ante fallo |

## Ficheros de estado

- **`data/state.json`** — aperturas capturadas, mercados operados, gasto diario, marcadores de reset. Escritura atómica.
- **`data/trades.jsonl`** — log append-only de operaciones y resoluciones. Es la fuente de verdad del P&L; `state.json` puede reconstruirse desde aquí.
- **`data/analytics.jsonl`** — ventanas observadas (ticks + quotes), operadas o no. ~250 MB con 20.000 muestras. **Lectura incremental**: solo se parsea la cola nueva.
- **`data/arb-opportunities.jsonl`** — oportunidades de arbitraje detectadas.

---

## Invariantes que no se deben romper

### El bucle es de un solo hilo

El trading y el análisis comparten hilo. **Cualquier trabajo CPU largo deja al bot ciego**, y el síntoma engaña: con el bucle parado, la continuación de un `fetch` no puede ejecutarse y el `AbortSignal.timeout(5s)` acaba disparando — en el log aparece `"The operation was aborted due to timeout"` contra una red perfectamente sana.

Reglas:

- Todo trabajo CPU pesado **cede por tiempo, no por conteo** (`EventLoopBudget` en `recommendationEngine.ts`, presupuesto de 15ms). Ceder cada N elementos no acota nada: el coste por elemento depende de la máquina y del tamaño del dataset.
- Nada de llamadas de red con `await` en el camino caliente si su resultado no se necesita **en esa** iteración. El refresco del saldo va sin `await` por eso.
- Medir con **sonda de latido** (`setInterval` de 50ms y mirar el retraso), no con el tiempo total.

### Puntuar SIEMPRE con `analyticsTruth`

`AnalyticsSample.winningOutcome` lo calcula el propio bot (`finalPrice >= openingPrice`) contra **su** tick de apertura. Se equivoca ~12,5% de las veces, y lo hace **correlacionado con la señal** — porque ambos salen del mismo precio de apertura mal medido.

Usar siempre `scoringOutcome()` de `src/analyticsTruth.ts`, que deduce el ganador del libro de órdenes al cierre (98,6% de acierto contra la resolución oficial). **Nunca hacer fallback** a `winningOutcome`: sus errores no son aleatorios, y reintroducirlos enseña al modelo justo el sesgo que le hace comprar barato lo que pierde.

### Toda caché con TTL necesita retroceso ante el fallo

Cachear solo el éxito hace que, tras el primer fallo, el TTL no frene nada y se reintente en cada iteración. Un servicio sano acaba limitándote y el fallo se vuelve permanente.

### Un fallo de lectura no es un cero

En cualquier guardia que decida sobre dinero, distinguir «no pude leer» de «leí cero». Bloquear porque el RPC está caído es un fallo de red disfrazado de política de riesgo; tratar un cero real como «no sé» deja operar sin fondos.

---

## Trampas conocidas

Cinco cosas que ya costaron caro. Todas comparten patrón: **un valor creíble pero falso**.

### 1. El backtest que se puntuaba a sí mismo

Con la etiqueta propia, el barrido de EV daba **+$849,78**. Con un juez independiente, **−$22,60**. La misma estrategia. Toda la calibración hecha sobre esa herramienta era humo. Ver el invariante de `analyticsTruth` arriba.

### 2. La comisión es máxima en 0,50

La comisión taker es `shares × 7% × p × (1−p)`: **máxima justo en 0,50** y casi nula en los extremos.

| ask | comisión sobre el stake |
|---|---|
| 0,35 | 4,55% |
| 0,50 | 3,50% |
| 0,85 | 1,05% |
| 0,95 | 0,35% |

La configuración operaba en 0,35–0,65 — el peor sitio posible, pagando 2,5-4,5% por operación cuando ningún edge medido llega a eso. **Al mover la banda operable, revisar todo umbral absoluto pensado para 0,50**: se rompen en silencio, sin dar error. Se encontraron cuatro (`ASK_CEILINGS` de los backtests, los candados del tuner de ventana, el ancho mínimo, y los cortes de `askBands`).

### 3. El colateral es pUSD, no USDC

Con la migración a CLOB V2 (2026-04-28) Polymarket pasó a su propio token: **`pUSD`** en `0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB`. Leer USDC.e devuelve **0 para una cuenta con fondos**.

Si el saldo vuelve a leerse 0 teniendo dinero: extraer las direcciones del SDK y preguntarle `symbol()` a cada una — la única que responde como ERC20 es el colateral.

```bash
grep -rioE "0x[a-f0-9]{40}" node_modules/@polymarket/clob-client-v2/dist/
```

> La Data API (`data-api.polymarket.com/value`) reporta solo el valor de **posiciones**, no el efectivo — puede confirmar una conclusión errónea en vez de contradecirla.

### 4. El mínimo de orden está en dólares, y aplica a cada pata

`orderMinSize` de gamma vale **5 dólares** (confirmado: el cliente CLOB documenta `amount` como *"BUY orders: $$$ Amount to buy"*). En arbitraje **cada pata es una orden independiente** y ambas deben superarlo: con precios equilibrados eso exige mucho más capital del que sugiere el neto por set. Comparar participaciones contra ese valor es un choque de unidades que produce órdenes rechazadas en silencio.

### 5. Las métricas que excluyen sus propios fallos

`recordLoopTiming` era la última línea del cuerpo de la iteración: si ésta lanzaba, **no se registraba**. Los percentiles publicados excluían por construcción justo las iteraciones lentas que morían por timeout, y salían sanos mientras el bot perdía el 11,6% del tiempo. Ahora va en un `finally` y publica también `failedPct`.

---

## Herramientas de diagnóstico

Todas en `src/smoke/`, todas de solo lectura:

| Herramienta | Responde a |
|---|---|
| `pnlAudit.ts` | ¿De dónde sale el dinero? Desglose por modo, tipo, mercado y día |
| `edgeScan.ts` | ¿Existe edge? Barrido de umbral × ventana con juez honesto |
| `askBandScan.ts` | ¿En qué banda de precio está el dinero? |
| `outOfSample.ts` | ¿El edge sobrevive un cambio de periodo? Guardia anti-sobreajuste |
| `noiseFloor.ts` | ¿A partir de qué distancia deja de ser ruido la medición? |
| `labelAudit.ts` / `officialLabelAudit.ts` | ¿Coinciden nuestras etiquetas con la realidad? |
| `openingLagAudit.ts` | ¿Cuánto se desvía el tick de apertura y qué cuesta? |
| `estimatorBacktest.ts` | ¿Qué estimador alimenta mejor el gate? Con columna fuera de muestra |
| `capTunerBacktest.ts` | ¿El tuner de ventana de ask suma o resta? |
| `arbScan.ts` | ¿Cuántas oportunidades de arbitraje hubo y de qué tamaño? |

**Regla al usarlas:** cualquier resultado espectacular es sospechoso antes que prometedor. Un edge que no sobrevive `outOfSample.ts` es ruido de barrido.

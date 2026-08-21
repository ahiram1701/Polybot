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
      freno de patas sueltas → arbitraje 5m:
          quoteArbLegs              RECOTIZA las dos patas (2 getQuote)
          detectCompleteSetArb      reevalúa; si se evaporó, NO manda nada
          executeArbLeg × 2         libro más fino primero
      circuit breaker (solo direccional) → buildTradeSignal → EV gate → ejecución
      runArb15m                     después del direccional, con la reserva ya aplicada
7. verifyOfficialResolutions        (2 fetch a gamma cada 30s)
```

Las fases 1 y 2 están separadas a propósito: capturar en paralelo mantiene los ticks frescos; decidir en serie garantiza orden determinista y un límite de gasto compartido.

## Fuentes de datos

| Fuente | Para qué | Notas |
|---|---|---|
| **Gamma** (`gamma-api.polymarket.com`) | Metadatos del mercado, slug, tokenIds, resolución oficial | Caché de 5s por slug, con fallback a caché rancia si falla |
| **CLOB** (`clob.polymarket.com`) | Libro de órdenes, ejecución | `withTimeout` de 2s que **no cancela** la petición subyacente |
| **RTDS** (`ws-live-data.polymarket.com`) | Serie **TWAP** de Chainlink (la que resuelve) y ticks spot (analítica) | WebSocket persistente; no pasa por el pool HTTP. Se suscribe **sin filtros de símbolo**: filtrarlos rompió el spot de ETH y DOGE una vez |
| **Polygon RPC** | Saldo de colateral (`balanceOf`) | Solo lectura, caché de 60s. Ante fallo conserva la última lectura buena, pero **caduca a los 5 min** (`BANKROLL_READING_MAX_AGE_MS`) y entonces cae al declarado |

## Ficheros de estado

- **`data/state.json`** — aperturas capturadas, mercados operados, gasto diario, marcadores de reset. Escritura atómica.
- **`data/trades.jsonl`** — log append-only de operaciones y resoluciones. Es la fuente de verdad del P&L; `state.json` puede reconstruirse desde aquí.
- **`data/analytics.jsonl`** — ventanas observadas (ticks + quotes + serie TWAP), operadas o no. La retención va en `maxAnalyticsSamples`, **hoy 10.000** (~160 MB). No la subas sin leer la trampa 6: a 20.000 la proyección es de **608 MB**, no de 250 MB. **Lectura incremental**: solo se parsea la cola nueva.
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

### Y una lectura vieja tampoco es una lectura

El gemelo del anterior, y se descubrió tarde. `LiveBalanceReader` conserva la última lectura buena a propósito, y `lastBankrollReading` no se borra nunca: una vez que **una** lectura funcionaba, el declarado no volvía a usarse jamás. Con el RPC caído horas, el arbitraje seguía dimensionando contra un saldo que podía ya no existir — y si había bajado, eso produce exactamente la pata suelta que la guardia evita.

Arreglado con un tope de edad: 5 minutos, o sea cinco refrescos fallidos. Un hipo de red no llega; una caída sí. `resolveEffectiveBankrollUsd` exige `nowMs` **obligatorio**, no con default: un llamador nuevo no puede saltarse la caducidad sin que el compilador lo pare.

---

## La resolución la decide el TWAP, no el spot

**Cambió el 2026-08-07** y es el hecho más importante de este documento: los mercados «Up or Down» de
cripto los resuelve Polymarket con la **serie TWAP publicada de Chainlink**
(`cryptoMarketConfig.twapLookbackSeconds` = 30 en 5m, 60 en 15m), no con el precio spot de cierre.

Dos cosas que cuestan dinero si se olvidan:

1. **`twapLookbackSeconds` es la ventana de retrolectura, no el rango.** No es «el promedio de los
   últimos 30 segundos de la ventana del mercado». Se interpretó mal dos veces.
2. **La documentación oficial dice explícitamente que no reproduzcas el valor por tu cuenta.** Por eso
   `src/twap.ts` marca sus helpers como **analítica, no decisión**: existen para medir, y no deben
   volver a colarse en el camino de resolución.

Cada operación guarda en `priceSource` con qué serie se resolvió. Cruzar ese campo contra
`officialResolution.corrected` es el único juez de si la fuente es la correcta.

## Trampas conocidas

Cosas que ya costaron caro. Todas comparten patrón: **un valor creíble pero falso**.

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

### 6. La cotización llega vieja a la orden

Los dos primeros arbitrajes en live murieron con `no orders found to match with FAK order`. Tentador
culpar al libro fino — y falso: había **$248 y $485** de profundidad frente a los ~$7-12 que hacían
falta, y el precio enviado era `mejor ask + 0.02`, no al ras.

Lo que fallaba era el hueco temporal. Las cotizaciones venían de la FASE 1 (captura) y la orden salía
en la FASE 2, con trabajo de por medio. Y **el 81% de los arbitrajes aparecen en los últimos 2 minutos
de la ventana**, que es cuando el libro converge hacia 0/1 y más se mueve: para cuando llegaba la
orden, el nivel visto podía no existir.

Dos cambios, y el segundo importa más que el primero:

1. **Recotizar** justo antes de mandar (`quoteArbLegs`), y dimensionar con lo recotizado.
2. **Reevaluar y abortar** si el arbitraje ya se esfumó, en vez de lanzar una orden contra un libro que
   ya no ofrece nada. Esto vale aunque la hipótesis de la latencia resulte falsa: no se pierde dinero
   por *no* mandar una orden sin margen. La reevaluación usa `detectCompleteSetArb`, el mismo detector
   que disparó la oportunidad, no una cuenta paralela que pueda derivar de él.

La lección general: **un rechazo del exchange sin contexto no es diagnosticable.** El mensaje dice QUÉ
falló, nunca POR QUÉ. Por eso `LiveOrderError` lleva pegados precio enviado, ask cotizado, profundidad,
importe y **edad de la cotización** (`OrderbookQuote.quotedAtMs`), y el contexto viaja con el error en
lugar de recalcularse en quien lo registra — una reconstrucción puede derivar del código real y
entonces el diagnóstico miente justo cuando más falta hace.

### 7. El autoajuste que puede ABRIR la ventana

Hay **tres** autoajustes y no son intercambiables. Dos solo pueden reducir exposición; uno puede
aumentarla:

| Switch | Qué toca | Dirección |
|---|---|---|
| `aiAutoApplyLive` | Ventana y distancia por mercado/lado | Ambas |
| `aiAutoTuneAskCap` | Techo de ask | **Solo estrecha** |
| `aiAutoProbeBands` | Prueba bandas de ask nuevas | **Puede abrir** — el único que sube el riesgo |

`aiAutoProbeBands` sondea con presupuesto acotado por mercado y día, y un programa de sondeo solo se
cierra con muestra suficiente. Es también el único de los tres sin variable de entorno: se enciende
solo desde la interfaz.

El motivo de que `aiAutoTuneAskCap` esté separado de los sondeos es que el tuner tiene una **base fija**
(`ASK_WINDOW_BASELINE_MIN`/`_MAX`) que nunca escribe: es su referencia. Unos límites mal puestos ahí
mataron el tuner una vez.

### 8. Lo que NO es configurable, y por qué

El criterio es: **se expone lo que acota dinero o riesgo; el resto se queda en código.** Exponer las
~60 constantes internas convertiría la pantalla de ajustes en ruido y no son decisiones del operador.

Tres casos que parecen ajustes y no lo son a propósito:

- **`DEPTH_PROBE_USD`** (`orderbookService.ts`). El tamaño de referencia con el que se mide la
  profundidad del libro. Si dependiera de un ajuste, las muestras viejas y las nuevas medirían cosas
  distintas y la analítica dejaría de ser comparable consigo misma.
- **`maxAskSpread`, `minSecondsToEndForEntry`, `evMaxClaimedEdge`.** Los tres bloquean caminos que el
  ledger midió como perdedores (spread ancho, últimos segundos, ventaja declarada > 0.20). Hacerlos
  editables sería dar un mando para aflojar protecciones que hoy sujetan al direccional.
- **`CRYPTO_TAKER_FEE_RATE_BPS`** (`fees.ts`). Es un hecho del exchange, no una preferencia. Si
  Polymarket lo cambia, hay que cambiarlo aquí — pero entonces cambia también todo el cálculo de EV y
  de arbitraje, y eso merece una revisión, no un campo de texto.

## La retención recicla datos, no los acumula

`data/analytics.jsonl` está acotado a `maxAnalyticsSamples` (10.000). Cuando se llena, **cada muestra
nueva borra la más vieja** — así que a partir de ese punto esperar más tiempo no acumula más historia,
la recicla. Con ~730 muestras al día son unas dos semanas de memoria, y validar una estrategia fuera de
muestra necesita más que eso.

Por eso existe `src/archiveAnalytics.ts`, que copia lo nuevo a `data/archive/analytics-archive.jsonl`,
sin tope. Tres decisiones que no son arbitrarias:

- **Lee el fichero, no la API.** Funciona con el bot parado, que es justo cuando más urge no perder lo
  que ya hay.
- **Es incremental**: solo escribe ventanas más nuevas que la última archivada. Volcar las 10.000 cada
  pasada serían 326 MB de los que el 90% ya estaría dentro.
- **Busca el corte en la cola del archivo**, no releyéndolo entero: el archivo crece sin límite por
  diseño, y releerlo completo convertiría al archivador en el problema que viene a evitar.

Usa el mismo serializador que la exportación de la UI, así que el archivo se puede reimportar con
`POST /api/analysis/samples/import` sin conversiones.

**Programado** cada 12 h con `scripts/install-analytics-archive.ps1` (tarea `PolybotArchivoAnalitica`,
mismo patrón que el watchdog: sin ventana, sin permisos de administrador). Deja rastro en
`data/archive/archive.log` para poder auditar si alguna pasada falló.

## El maker: cobrar por dar liquidez

Es el cambio de modelo de negocio del 2026-08-19, y la primera estrategia del proyecto **que no exige
acertar la dirección**. Polymarket paga por dejar órdenes límite en reposo cerca del punto medio, se
llenen o no.

### Cuánto paga, medido de verdad

**$2,7795 por 40,2 minutos** cotizando, o sea **$0,345 por ventana de 5 minutos**. Es la única cifra
real que existe, y sirve de ancla: tres modelos teóricos dieron $3.926, $2.000-6.000 y $700-1.800 al
día, todos **10-30 veces altos**. Si un cálculo de recompensa no cuadra con ese ancla, el cálculo está
mal.

Las recompensas se abonan **~00:45 UTC** —no a las 00:00 que dice la documentación oficial— como evento
`MAKER_REBATE` en `data-api.polymarket.com/activity`. No hay endpoint público de recompensas: los de
`clob.polymarket.com/rewards/user*` piden API key.

### Dónde cotizar: la entrada cuesta `min_size` dólares

Un par de dos lados cuesta `precio(UP) + precio(DOWN)` = **$1 por participación**, siempre. Da igual que
el mercado esté a 0,05 o a 0,50: **no existe una banda de precio barata**. Así que la cotización mínima
que califica cuesta `rewards_min_size` dólares, y ese número decide en qué mercados se puede jugar.

Sobre el registro completo (16.000 mercados con programa activo):

| `min_size` | mercados | entrada |
|---|---|---|
| **20** | 12.391 | **~$20** ← el suelo real |
| 30 | 806 | ~$30 |
| 50 | 1.329 | ~$50 ← BTC/ETH/DOGE de 5 min |
| 100-1000 | 332 | ~$100-1000 |

Los 74 mercados con `min_size: 0` traen `max_spread: 0`: con banda cero **ninguna** orden puntúa, así
que parecerían gratis y no pagan un céntimo. `rewardMarketScanner.ts` los descarta.

**Los mercados de cripto de 5 minutos son de los peores sitios para un capital pequeño**, y se usaban
solo porque eran los que el bot ya seguía:

| | cripto 5m | lo mejor que hay |
|---|---|---|
| entrada | ~$50 | **~$20** |
| banda que puntúa | 1,5c | **4,5c** |
| duración | 5 minutos | de un día a meses |

La banda es lo que más pesa: con tick de 1 centavo, una orden a un tick del medio puntúa
`((1,5−1)/1,5)² = 11%` del máximo con banda estrecha, y `((4,5−1)/4,5)² = 60%` con la ancha. **Cinco
veces más por exactamente la misma orden.** Y la duración decide el riesgo: en una ventana de 5 minutos
el precio se desploma a 0 o 1 cada cinco minutos.

`min_size` y la banda **se leen del mercado, no del código**: el objeto del mercado publica
`max_spread: 4.5` y el endpoint de recompensas `1.5` *para el mismo mercado*, y esos tres centavos
deciden si una orden cobra o no.

### Elegir mercado es casi todo el resultado

Medido el 2026-08-21 sobre el registro real (16.039 mercados, 13.109 de ellos con entrada ≤ $20):

| | |
|---|---|
| rendimiento real entre los 60 mejores | de **10,2** a **0,004** $/día por $ — factor 2.700 |
| mediana | 0,17 $/día por $ |
| mercados prácticamente empatados por bote/dólar | **54** |
| correlación de Spearman entre el puesto del escáner y el rendimiento real | **0,007** |

La criba por `bote / min_size` sirve para **tirar** los 13.000 que no caben o no pagan. Para **elegir**
entre los que quedan no vale nada: su correlación con el rendimiento real es cero. Lo que decide es la
competencia en la banda, y esa solo se ve leyendo el libro.

De ahí las dos reglas del modelo:

**1. Mirar a muchos.** Valor esperado del mejor de *k* candidatos evaluados:

| k | 3 | 5 | 10 | 20 | 40 |
|---|---|---|---|---|---|
| $/día por $ | 3,64 | 4,91 | 6,61 | **7,99** | 9,05 |

Pasar de 3 a 20 vale **2,2×**. Antes se resolvían `los que caben + 2` —con $20, **tres**— razonando que
si solo se financia un mercado, evaluar 25 era trabajo tirado. Es al revés: financiar uno es justo lo que
obliga a mirar muchos. En dos fotos independientes del mercado, el mejor de 3 acertó una vez y la otra
rindió **5,8× menos** que el mejor de 20 (1,62 contra 9,37).

Mirar a muchos solo es asumible si mirar es barato: `MakerLoop` **no** lee el libro de todos en cada
pasada. Sondea por turnos (`sondeosPorPasada`, 4) más los mercados donde queda alguna orden viva, y
ordena el resto con su última ficha. Un barrido completo de 25 candidatos tarda ~90 s. La ficha vale
para **ordenar**; antes de cotizar en un mercado se le relee el libro, porque con una banda de 1,5-4,5
centavos un punto medio de hace un minuto deja las dos órdenes fuera y el dinero igual de inmovilizado.

**2. No mudarse por ruido.** Sobre 21,8 h de producción el maker cambiaba de mercado **10,7 veces por
hora**, y el **86%** de esas mudanzas abandonaban un mercado que seguía disponible. Con 54 candidatos
empatados, el ganador lo decidía el temblor de la foto del libro. Ahora el que ya cotiza juega con un
`margenRelevo` del 25%: un aspirante tiene que **rendir un 25% más**, no empatar. La ventaja se aplica
al orden y al reparto; `esperadoUsdDia` se sigue reportando sin inflar.

### Tres piezas, separadas a propósito

| Módulo | Qué hace | Por qué así |
|---|---|---|
| `makerQuoting.ts` | Decide qué órdenes debería haber | **Puro**: la política entera se prueba sin red ni claves |
| `makerEngine.ts` | Coloca, lista y cancela | Dos implementaciones, sim y live |
| `rewardParams.ts` | Lee `min_size`, banda y tasa | Acierto cacheado 10 min, **vacío solo 30 s** |
| `rewardMarketScanner.ts` | Busca en TODO Polymarket lo que cabe en el capital | Criba en dos etapas: registro primero, libros después |
| `makerMarket.ts` | Lo mínimo que el maker necesita de un mercado | Desacopla de `MarketInfo`, que es un tipo de cripto |
| `makerLoop.ts` | Ata las tres y reparte el capital | Ordena por rendimiento **por dólar**, no por tamaño del bote |

### Decisiones que no son obvias

- **`postOnly` en todas las órdenes.** Si una carrera del libro fuera a cruzarlas, el exchange las
  RECHAZA en vez de ejecutarlas como taker pagando el 7%. Sin eso el motor haría lo contrario de lo
  que pretende.
- **No recolocar si el libro no se movió.** El reparto premia el tiempo en reposo; cancelar y volver a
  poner pierde el turno en la cola.
- **Colocar a un tick del centro.** El reparto cae con el **cuadrado** de la distancia al medio, así
  que un centavo de más cuesta mucho más que proporcionalmente.
- **El tamaño vivo descuenta lo ya casado.** Una orden medio llenada puede haber caído por debajo del
  mínimo y dejado de puntuar sin que nadie lo note.
- **Los dos lados o ninguno.** Cotizar un solo lado no es hacer de maker: una compra en reposo solo se
  llena cuando el precio CAE hasta ella, así que te llenas del lado que se hunde. Además la fórmula
  oficial lo castiga —un tercio dentro de [0,10-0,90] y **cero** fuera—. Con los dos lados el par
  cuesta poco menos de $1 y redime exactamente $1 gane quien gane.
- **El tope cuenta el GASTO, no solo lo comprometido.** Una orden que se llena deja de estar viva; si
  el presupuesto solo mirase lo comprometido, se liberaría y la pasada siguiente colocaría otra.
- **Guarda de inventario.** Si ya se es largo de un lado se deja de pedir ese lado y solo el contrario:
  eso COMPLETA el par en vez de doblar sobre el que cae.
- **El libro se lee de los DOS tokens.** Una venta de UP vive en el libro de DOWN como compra (comprar
  DOWN a `p` = vender UP a `1−p`). Leyendo uno solo, el lado ask sale vacío.
- **Cancelar no se da por hecho.** El exchange responde `{canceled, not_canceled}` y hay que leerlo: dar
  por cancelada una orden que sigue viva la deja **viva e invisible** —el bucle borra su rastro, deja de
  detectar su llenado y deja de contarla contra el tope—. Ante una respuesta sin detalle se asume que
  siguen vivas, porque vigilar una orden que ya no existe solo cuesta un llenado fantasma.
- **Los mercados rotan.** El escaner rehace su seleccion cada 5 minutos y los de un dia expiran; a los
  que se caen de la lista se les retiran las ordenes ANTES de olvidarlos, o quedarian vivas sin que
  nadie las mirara.
- **Un fallo en UN mercado no tumba la pasada.** Ni leyendo el libro ni leyendo las ordenes vivas: el
  `Promise.all` abortaba tambien los mercados que si respondian.
- **Suelo de saldo (`makerStopBelowUsd`).** La unica guarda que acota la PERDIDA en vez del compromiso.
  Compara saldo **mas lo inmovilizado en ordenes propias**, porque una orden en reposo baja el saldo del
  exchange sin ser una perdida y un suelo sobre el saldo desnudo saltaria en operacion normal.
- **El capital es compartido entre mercados.** Una orden de compra inmoviliza `precio × tamaño` hasta
  que se llena o se cancela; sin un tope común, tres mercados comprometerían el mismo dinero tres
  veces.
- **`makerMode` cae a `sim`, no al modo global.** Es la única estrategia que deja órdenes VIVAS en el
  libro: heredar un arranque en live sería empezar a inmovilizar dinero real sin que nadie lo pidiera.

### El riesgo real

**Que te llenen.** Entonces tienes una posición direccional que resuelve en minutos. La recompensa es
la compensación por ese riesgo, no un regalo. Por eso se retira antes del cierre: una orden llena en
los últimos segundos no da margen para deshacerla.

### Lo que NO está medido

El rendimiento. La estimación de `elegirMercados` es **lineal** y por tanto optimista —el reparto real
es cuadrático— y sirve para *ordenar* mercados, no para prometer cuánto se cobrará. Eso solo lo dice
una orden real y su pago a 24 h.

## Las tareas programadas viven en la sesión 0

`PolybotWatchdog` y `PolybotArchivoAnalitica` se registran con **`LogonType: S4U`**, que las hace correr
haya o no sesión iniciada. Antes eran `Interactive` y eso costó **45 horas de datos en 10 días**: el
2026-08-17 Windows arrancó a las 00:17 tras un apagado inesperado, nadie inició sesión, y el watchdog
no se ejecutó ni una vez hasta las 03:00.

**Consecuencia que hay que conocer:** S4U ejecuta la tarea en la **sesión 0**, y sus procesos hijo
también. Un terminal normal vive en la sesión 1 y Windows no le deja matar procesos de la 0 — así que
`Stop-Process` sobre el bot devuelve *Acceso denegado* aunque seas el mismo usuario.

Por eso existe **`POST /api/system/restart`**: el proceso ya está supervisado, así que se le pide salir
y el watchdog lo levanta con el código actual (≤5 min). Es la forma de desplegar sin administrador.
Detiene el bot antes de salir para no cortar una iteración a media escritura, y responde ANTES de
terminar — si no, quien llama ve la conexión cortada y no sabe si funcionó.

S4U y el disparador de arranque **exigen administrador** para registrarse. Los instaladores lo intentan
y, si Windows lo deniega, caen al modo de siempre con un aviso que dice qué se pierde: fallar del todo
dejaría la máquina sin ninguna tarea.

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

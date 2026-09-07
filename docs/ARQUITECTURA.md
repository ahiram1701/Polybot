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

## Dos criterios para elegir lado, y son excluyentes

El camino direccional puede elegir el lado de **dos** formas, y solo una está activa a la vez
(`selectSignalOutcome` en `botRunner.ts`):

| | Direccional (por defecto) | Favorito (`FAVORITE_STRATEGY_ENABLED`) |
|---|---|---|
| Qué mira | Distancia del oráculo respecto a la apertura | El ask que el libro ya puso más alto |
| Predice | Sí | No: copia al mercado |
| Umbral | `minDistanceUsd` | Banda de ask `[0,76 – 0,85]` |

**No son acumulativos a propósito.** Si pudieran disparar los dos, una misma ventana generaría muestras
de dos estrategias distintas y el ledger no podría atribuir el resultado a ninguna — el mismo error de
fondo que invalidó una calibración entera (trampa 1).

Tres cosas que no son obvias:

- **La banda 0,76-0,85 está dentro de la zona improductiva conocida.** Es la misma zona de favoritos
  caros de la que salió el «225 operaciones para ganar $8,68» que hoy justifica el techo de 0,70 del
  tuner. La estrategia existe porque se pidió medirla con muestras propias, no porque haya evidencia a
  favor. Viene apagada.
- **`FAVORITE_ALLOW_LIVE` es un cierre aparte de `FAVORITE_STRATEGY_ENABLED`.** Con la estrategia
  encendida y el cierre cerrado, el camino direccional **se para** en live; no vuelve al criterio
  antiguo. Un fallback silencioso pondría a operar con dinero real una estrategia distinta de la que el
  operador acaba de elegir.
- **Opera durante toda la ventana, pero con DOS techos de tiempo, no uno.** El declarado es
  `entryWindowSeconds` (120 desde 2026-09-07; ver más abajo por qué ese número decide el signo del
  resultado). El otro no se declara: `getAnalyticsQuotes` solo pedía
  los libros dentro de `ANALYTICS_WINDOW_SECONDS` (120 de 300), y el favorito ELIGE lado con esos
  libros — así que abrir la ventana declarada sin abrir el suministro dejaba la estrategia ciega,
  registrando `favorite_missing_quote` en bucle. Ahora el favorito también los pide fuera de esa
  ventana, a cadencia reducida (`FAVORITE_SCAN_INTERVAL_MS`, 3 s), con su propio contador: cotizar en
  cada iteración durante los 300 s es lo que llevó el p50 del loop de 56 ms a 281 ms.
- Por lo mismo, `getAnalyticsQuotes` cotiza aunque no haya `analyticsRecorder` montado: sin eso dejaría
  de operar en silencio.
- **Abrir la ventana estrena un régimen sin muestras.** Un ask de 0,80 a 250 s del cierre refleja
  incertidumbre real; a 15 s refleja un resultado casi decidido. Esto se sospechaba desde el principio;
  desde 2026-09-07 está medido, y resultó ser lo que más pesa de todo (siguiente apartado).
- **El autoajuste tiraría la ventana hacia abajo.** Las rejillas de `recommendationEngine` y
  `strategyAnalysisEngine` topan en 120 s, con salto máximo de 60 s por aplicación. Con
  `aiAutoApplyLive` encendido, la ventana de 300 se iría reduciendo sola. Debe seguir apagado.

### CUÁNDO entrar es lo que más pesa, y por mucho

Medido el 2026-09-07 sobre las **1.098 operaciones del ledger con resultado conocido**, agrupadas por
los segundos que le quedaban a la ventana en el momento de comprar:

| segundos al cierre | n | aciertos | equilibrio | ventaja |
|---|---|---|---|---|
| 0 – 60 | 85 | 90,6% | 84,8% | **+5,83 pp** |
| 60 – 100 | 223 | 86,1% | 84,9% | +1,21 pp |
| 100 – 140 | 367 | 85,0% | 85,1% | −0,07 pp |
| **140 – 300** | **423** | **81,1%** | **85,8%** | **−4,71 pp** (t = −2,48) |

«Equilibrio» es lo que hay que acertar para empatar tras la comisión (`ask + 7%·ask·(1−ask)`).

Monótono, y el resultado agregado **cambia de signo** al recortar la ventana: con 150 s son −5,85 $ por
cada 100 operaciones de 5 $; con 120, +2,71 $; con 100, +12,47 $.

Por qué importa tanto: con `entryWindowSeconds` en 150 el bot compraba **en cuanto el ask entraba en
banda**, es decir con 2:30 por delante para que el precio se diera la vuelta. 423 de las 1.098 entradas
caían en ese tramo. Es exactamente la diferencia entre la operativa manual —esperar a que esté
decidido— y la del bot, que se lanzaba al primer precio válido.

Tres avisos para quien mueva este número:

- **Lo sólido es el lado negativo.** Que entrar con más de 140 s sea malo tiene t = −2,48. Que entrar
  con menos de 60 sea *tan* bueno (+5,83 pp) está sugerido, no probado: ninguna fila positiva llega a
  dos errores típicos por sí sola.
- **120 cae en un bache de la serie** (140 da +1,09 pp y 100 da +2,48). La diferencia entre 140, 120 y
  100 está dentro del ruido; lo que no lo está es no pasar de 140.
- **Recortar cuesta volumen**, y el volumen es muestra: 120 s deja el 45% de las operaciones, 100 s el
  28% y 60 s el 8%. Medido en dólares por hora los tres salen parecidos, así que la elección es sobre
  cuánta varianza aguantas y cuánto tardas en acumular evidencia, no sobre cuánto ganas.

Esto también explica por qué ninguna otra palanca funcionó. Sobre más de 10.000 ventanas se probaron 13
bandas de ask, momento del precio, distancia normalizada por volatilidad (en spot y en TWAP), cuatro
umbrales de salida y el disparo por libro frente al del oráculo: **ninguna daba ventaja neta.** El
mercado está bien preciado en toda la curva de precios. La única dimensión donde aparece ventaja es el
tiempo que le queda a la ventana.

### La certeza de la ventana: entrar solo cuando ya está decidido

La estrategia no es predecir hacia dónde va, es **subirse a lo que ya va ganando cuando es casi seguro
que va a ganar**. Eso tiene una traducción exacta, y es la que aplica `readWindowCertainty`
(`src/windowCertainty.ts`):

```
z = distancia al strike / (volatilidad por segundo × raíz de los segundos que quedan)
```

El denominador es cuánto se espera que el precio se mueva en lo que queda de ventana. Así que z dice,
en una cifra, **cuántos movimientos típicos tendría que hacer el precio en contra para dar la vuelta a
esto**. Un z de 2 a quince segundos del cierre y un z de 2 a cuatro minutos son la misma certeza,
aunque la distancia en dólares no se parezca en nada.

**Por qué no bastaba la distancia que el bot ya medía.** `signal.distanceUsd` existe desde siempre y se
filtra con `minDistanceUsdByMarket` (BTC 20, ETH 0,1, DOGE 0,00003). Esos umbrales no son comparables
ni entre mercados —dependen de la escala del precio— ni entre el principio y el final de la ventana,
que es donde está toda la diferencia. Dividir por `σ·√T` es lo único que convierte un dato que ya
existía en la señal que separa las ventanas que ganan de las que no.

Medido sobre 1.484 ventanas de `data/analytics.jsonl`, aguantando hasta el cierre:

| umbral z | ops | % | aciertos | neto/op | 1ª mitad | 2ª mitad (fuera de muestra) |
|---|---|---|---|---|---|---|
| sin filtro | 1484 | 100% | 70,4% | −0,0670 | −0,1391 | +0,0051 |
| z ≥ 0,5 | 508 | 34% | 82,5% | +0,2301 | +0,1201 | +0,3481 |
| **z ≥ 1,0** | **152** | **10%** | **91,4%** | **+0,4623** | **+0,2355** | **+0,6610** |
| z ≥ 1,5 | 43 | 3% | 100,0% | +0,7372 | +0,3882 | +0,9885 |

Monótono y positivo en las **dos** mitades. Con z ≥ 1 el favorito acierta el 91,4% mientras el precio
medio del libro (0,83) solo cobra el 84,4%: **el mercado infravalora la certeza**. Y al revés, con
z < 0 —el precio ya cruzado al lado malo pero el libro todavía marcando favorito— el acierto cae al
53,4% contra un 62,0% de equilibrio. Ésas son las que sangraban.

Cuatro detalles que no son obvios:

- **El default es 1,0 y no 1,5.** El 100% de aciertos de 1,5 son 43 ventanas; 1,0 tiene 152 y sale
  positivo en ambas mitades. La cola promete más de lo que puede sostener.
- **Una lectura AUSENTE no bloquea.** Sin ticks suficientes o con σ = 0, `readWindowCertainty` devuelve
  `undefined` y la entrada sigue su camino: convertir una laguna del feed en política de riesgo es el
  mismo error que evita la guarda de bankroll con un saldo ilegible. Una lectura que sí sale y da poco
  es información, y ésa sí frena.
- **σ = 0 no es certeza infinita**, es un feed congelado. Dejarla pasar daría z infinito y convertiría
  una avería en la señal más fuerte posible.
- **Los ticks salen de muestrear `getTickAtOrBefore` hacia atrás**, que es la única lectura de historia
  que `RunnerPriceFeed` ya expone. Se deduplica por marca de tiempo: sin eso, un feed más lento que el
  paso del muestreo inventaría saltos de valor cero y hundiría la σ, que es el denominador de todo.

**El precio del filtro es el volumen: solo el 10% de las ventanas califican.**

### El tramo de máxima convicción (ask > 0,98) — APAGADO desde 2026-09-07

> **Se apagó por aritmética, no por una mala racha.** Medido sobre sus 28 operaciones:
>
> | | |
> |---|---|
> | aciertos | 96,4% (el mejor de todo el bot) |
> | ask medio | 0,989 |
> | ganancia media por acierto | **+0,066 $** |
> | pérdida media por fallo | **−5,564 $** |
> | un fallo se come | **85 aciertos** |
> | hace falta acertar | 98,94% |
> | ROI | −2,23% |
>
> A 0,99 el mercado ya se quedó todo el premio: no queda margen para equivocarse ni una vez, y te
> equivocas 4 de cada 100. Y lo peligroso no era el ROI sino el **tamaño** — apuesta una fracción del
> capital libre en UNA entrada, así que el fallo llega de golpe. Reactivarlo exigiría bajar
> `favoriteMaxSizeAsk` a donde todavía quede premio (~0,92), y eso **no está medido**.

Por encima de `favoriteMaxSizeAsk` el favorito deja de usar el importe configurado y dimensiona contra
una **fracción del capital disponible**. Seis cosas que no son obvias:

- **"Capital disponible" es el saldo REAL de la cuenta**, leído on-chain por `OnChainBankrollSource`,
  menos lo atado en posiciones abiertas (`openStakeUsd`), menos lo ya comprometido en esta iteración.
  El límite diario sigue en la fórmula, pero como tope superior, no como definición del capital.
- **La fracción (`favoriteMaxSizeFraction`, la mitad por defecto) es el freno del tramo.** "Máxima
  convicción" describe la lectura del libro, no el tamaño de la apuesta: a 0,98 el propio mercado dice
  que se equivoca una de cada cincuenta veces, y con la cuenta entera esa una no dejaba con qué seguir.
  Con media cuenta el peor caso es un mal día en vez del final del bot, y la mitad que no se juega no
  queda ociosa — la banda comprueba capital libre antes de entrar (`favorite_banda_sin_capital`), así
  que vuelve a estar disponible para las entradas normales. Se aplica **solo al término de capital**:
  el hueco diario y la profundidad del libro son topes de otras políticas, y recortarlos también sería
  aplicar dos veces la misma restricción. Con `1` se recupera el all-in original.
- **Descontar las posiciones abiertas no es un detalle, es la corrección que hace que la frase sea
  cierta.** El saldo no baja al abrir una posición: en sim nunca, y en live la lectura está cacheada 60
  s mientras la posición dura minutos. Sin ese descuento, BTC apostaba la cuenta entera y un segundo
  después ETH la volvía a apostar — tres mercados comprometiendo el triple del dinero que existe.
- **Un saldo ilegible NO significa "sin límite": significa no entrar.** La guardia de
  `minBankrollForDirectionalUsd` sí deja pasar un `unknown` a propósito, para no convertir un RPC caído
  en política de riesgo; pero eso vale para *no bloquear*, no para *dimensionar*. Sin
  `POLYMARKET_FUNDER_ADDRESS` el tramo queda inerte y lo dice (`favorite_max_size_bankroll_unknown`).
- **Se recotiza el libro con el importe final.** El quote de la fase de captura se pidió con el importe
  pequeño, y de él dependen `estimatedSharesForAmount` y `estimatedAveragePrice`. Reutilizarlo haría
  que el P&L puntuara otra operación — el mismo fallo que ya apuntó $10 donde había $0,69.
- **`autoMinLive` se salta a propósito.** Es un SUSTITUTO, no un mínimo: con él encendido
  `resolveTradeAmountUsd` devuelve `orderMinSize` pase lo que pase, así que dejarlo en el camino
  aplastaría el tamaño a $5 sin decir nada.

### La salida por stop (el primer camino de venta)

Hasta que existió esto, el bot **solo compraba**: toda posición se mantenía hasta la redención, y
`resolveCompletedTrades` ni miraba una fila antes de `endMs`. Con `favoriteExitEnabled`, si el ask del
lado que se tiene cae por debajo del suelo de la banda de compra, la posición se vende.

- **El disparo se mide sobre el ASK; la venta se cobra contra el BID.** El ask es la misma vara con la
  que se decidió entrar (la banda es de asks), y es lo único que evita que el stop salte en la
  iteración siguiente a cualquier compra: con spreads de 1,5 a 4,5 céntimos, un ask de 0,82 lleva el
  bid ya por debajo del suelo de 0,79. La consecuencia es que **la pérdida realizada es peor que la
  nominal**: se cobra el bid y se paga comisión encima.
- **El disparador que manda es la CERTEZA, no el precio del libro.** Este módulo nació midiendo el ask
  y esa versión perdía dinero en todos los umbrales probados. La certeza (`favoriteExitCertainty`, cero
  por defecto) mide el precio que **resuelve**, y ahí sí paga — sobre las 152 entradas de certeza alta:

  | | por operación | ventas |
  |---|---|---|
  | aguantar siempre | +0,4623 | 0 |
  | **vender con certeza ≤ 0** | **+0,5686** | **9 de 152** |
  | vender con certeza ≤ 0,25 | +0,5166 | 14 |
  | vender con certeza ≤ 0,50 | +0,4876 | 19 |

  Dispara el 6% de las veces, no el 28%. Los dos motivos viajan por separado al ledger
  (`certeza_perdida` y `stop_bajo_banda`) porque tienen tasas de acierto muy distintas y mezclarlos
  haría imposible saber cuál paga.
- **El umbral por ask (`favoriteExitStopAsk`) queda de RED DE SEGURIDAD**, en 0,35, para el desplome
  que la certeza no vea venir. Cuando era el disparador principal, barrido sobre las 705 ventanas
  operables de `data/analytics.jsonl`:

  | stop | salidas | a lados que ganaban | neto | vs no vender |
  |---|---|---|---|---|
  | 0,79 | 373 | 264 | −157,40 | **−105,22** |
  | 0,70 | 250 | 144 | −113,86 | −61,67 |
  | 0,60 | 191 | 87 | −79,59 | −27,41 |
  | 0,60 + 2 lecturas | 165 | 66 | −60,38 | −8,20 |

  **En ningún umbral probado vender gana a aguantar.** Lo que delata el mecanismo es que las salidas
  acertadas apenas se mueven (109 → 87 entre 0,79 y 0,60) mientras las innecesarias se desploman
  (264 → 25): los desplomes de verdad los caza cualquier umbral, y todo lo que añade un stop pegado a
  la banda son falsos positivos. Medido en vivo, 5 de 15 salidas recompraron el mismo lado 7-10
  céntimos peor. De fondo: cuando el ask está en X el valor justo del mercado *es* X, así que vender
  contra el bid pierde el ancho del libro siempre.
- **Sin umbral absoluto se deriva de `favoriteMinAsk`, nunca de `minAskPriceByMarketOutcome`.** Ese
  otro es el piso de la ventana de ask (0,01 por defecto, un antifiltro de polvo) y con él el stop no
  se dispararía jamás.
- **No exige los dos asks, al revés que el selector.** Al final de la ventana el lado ganador se queda
  sin asks, y exigirlos dejaría la posición atrapada justo mientras se derrumba. Sin el ask del
  contrario se pierde la guarda de libro muerto, así que la realidad del precio se confirma con lo
  ancho que esté el libro propio.
- **La reentrada no se decide ahí.** `considerarSalidaPorStop` solo vende; quien vuelve a elegir lado
  es `selectFavoriteOutcome` en la señal de esa misma pasada. Por eso hay veces que se sale y no se
  vuelve a entrar: justo tras un desplome el nuevo favorito suele estar por debajo de la banda, y
  quedarse en efectivo es la respuesta correcta.
- **Va en la FASE 2 y antes de `buildTradeSignal`.** Ahí los dos libros ya están capturados (no cuesta
  una llamada más), la fase es secuencial y vender es mover dinero, y ejecutando la venta primero la
  reentrada ve en la misma pasada el capital que acaba de liberarse.
- **La ronda de rebalanceo entra en la clave del ledger** (`#r1`, `#r2`…), igual que `#conviccion`, y
  se deriva contando las filas ya cerradas por venta — no de un contador en memoria, que un reinicio a
  mitad de ventana regalaría.
- **El límite diario no se reembolsa.** `dailySpendUsd` mide gasto BRUTO y un rebalanceo gasta dos
  veces de verdad. Con las reentradas sin límite, ese contador es el único techo que queda.

**La convicción exige que la banda haya operado antes esa ventana.** No es un tramo independiente: es
doblar sobre una ventana que la banda ya eligió. Sin esa entrada delante no hay nada sobre lo que
doblar, y la convicción sería una apuesta suelta de medio capital sobre un libro que nunca pasó por
la banda. Coste medido: de las ventanas donde el ask supera 0,98, el **19,2% llegan ahí sin pasar por
la banda** (el libro abre ya decidido). Esas dejan de operarse a propósito, y lo dicen
(`favorite_max_size_sin_banda`).

**Los dos tramos entran en la MISMA ventana, uno cada uno.** Antes compartían la única ranura de
`market_already_traded` y el que disparase primero dejaba al otro fuera — medido sobre 780 ventanas, la
banda ganaba la carrera el 56,3% de las veces, porque el precio pasa POR la banda camino de 0,99.

Sostenerlo exigió arreglar la identidad del ledger, y conviene saber por qué:

- `recordTradeAttempt` guardaba en `tradedMarkets` bajo la clave `modo:slug` con una **asignación, no un
  append**. Dos operaciones de la misma ventana se pisaban y la primera desaparecía sin dejar rastro.
- Ahora el **tramo entra en la CLAVE** (sufijo `#conviccion`), no en `trade.slug`. Es la diferencia con
  el apaño del arbitraje (`slug#arb`): allí el sufijo va en el slug, y por eso
  `verifyOfficialResolutions` no puede preguntarle a Gamma por él y tiene que excluirse. Aquí el slug
  se queda real y la consulta oficial funciona para los dos tramos.
- `banda` y ausente producen la **misma clave que antes**, así que las filas ya guardadas en
  `state.json` se siguen encontrando sin migrar nada.
- Resolución, reconciliación y verificación oficial firman ahora **por `trade.id`**. Buscar por slug
  devolvía siempre la primera fila: la segunda entrada se habría quedado `pending` para siempre, y eso
  envenena `openStakeUsd` — que es justo lo que impide volver a apostar capital ya comprometido.

**Y el contador por iteración cubre todo el camino direccional, no solo la convicción.** Los tres
mercados de una ventana se evalúan en la MISMA pasada, y sus operaciones no llegan al ledger hasta
ejecutarse: hasta entonces `openStakeUsd()` no las ve. Medido en producción antes de arreglarlo: tres
entradas de banda de $5 comprometieron **$15 contra una cuenta de $12,42**.

**Lo que este tramo NO tiene es evidencia.** Medido sobre 204 entradas anteriores a los 30 s: acierta
el 99,51% con un equilibrio del 99,03%, o sea +0,48% por operación. Pero la "verdad" con la que se
puntúa sale del propio libro (`resolveSampleTruth`), y está validada al 98,6% contra la resolución
oficial: **el error del etiquetado triplica la ventaja que dice medir**. Con 1 sola pérdida en 204, el
intervalo de confianza baja hasta ~97,3%, muy por debajo del equilibrio.

Y el riesgo real no es el EV, es la **ruina**: poniendo el saldo entero en cada entrada, un fallo no
borra "102 aciertos", borra la cuenta. Por eso corre en sim, `favoriteAllowLive` sigue cerrado, y el
saldo se lee con la dirección pública sin clave privada — no hay camino técnico a mover dinero real.

**Ojo con la simulación:** el saldo on-chain es una constante que las operaciones de papel no mueven,
así que **la sim no mostrará esta ruina**. No leer sus resultados como una validación.

La guardia que sostiene todo lo demás es `dead_book`: si los dos asks suman más de 1,15, el libro está
muerto y un 0,80 **no** significa «el mercado le da un 80%», significa que no hay mercado. Toda la
premisa de la estrategia es que el precio ES la probabilidad implícita, y ahí es falsa.

## Qué precio enseña cada pantalla

Tres números distintos se confundían en uno, y por eso el panel no cuadraba con polymarket.com:

| En pantalla | Qué es | De dónde sale |
| --- | --- | --- |
| **Precio (TWAP Ns)** | La serie que RESUELVE el mercado. Es lo comparable con la web. | `getLatestTwapTick(market, twapLookbackSeconds)` |
| **Spot** (pie de la tarjeta) | El oráculo al instante. Es con el que el bot mide la distancia. | `getLatestTick` |
| **Medio** (fila de cotización) | El *size-cutoff-adjusted midpoint*: lo que la web muestra como «probabilidad». | `medioAjustadoPorTamano` sobre los niveles ya cotizados |
| **Ask** | Lo que de verdad se paga. Queda 1–3 céntimos por encima del medio, siempre. | `bestAsk` |

Dos trampas que esto cierra:

- La tarjeta llamaba «Precio» al **spot** y «Apertura» al **TWAP**, así que la distancia mezclaba dos
  series sin decirlo. Sigue mezclándolas —es lo que hace el bot— pero ahora se ve.
- El *fallback* de apertura del panel usaba spot mientras el del bot usaba TWAP: cuando `state.json` no
  tenía la apertura, la pantalla enseñaba un número y el bot había operado contra otro. Los dos usan
  ahora `resolveOpeningTick` (`markets.ts`), y `priceSource` viaja hasta la pantalla.
- Un medio calculado sin el corte de tamaño lo mueve cualquiera con cuatro participaciones sueltas.
  Cuando ningún nivel llega al mínimo se cae al medio crudo y **se dice** (`midSource`).

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

Bajo Docker el mismo trabajo lo hace el servicio `polybot-archivador` de `docker-compose.yml`, que
ejecuta `dist/src/archiveAnalytics.js` en un bucle de 12 h sobre el mismo volumen `data/`. La tarea de
Windows no interviene.

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

### Dos reglas oficiales que el bot ignoraba (2026-08-25)

Salieron de leer la especificación en vez de inferirla del comportamiento, que es el error que este
proyecto ya pagó dos veces.

**1. El medio que reparte es el ajustado por tamaño.** La fórmula oficial define `s` como *"spread from
size-cutoff-adjusted midpoint"*: el punto medio que queda **después de tirar los niveles por debajo de
`min_size`**. Existe para que nadie fije un medio falso con polvo. `MakerLoop` usaba el medio crudo, con
el polvo incluido, y colocaba a un tick de él; cuando los dos medios se separan, las órdenes nacen a la
distancia equivocada del único medio que puntúa. Medido sobre los 29 mejores mercados que caben en $22:

| | |
|---|---|
| puntuaban **exactamente cero** | 1 de 29 (medios separados 11,5c con banda de 4,5) |
| perdían entre el 26% y el 51% | 4 más |
| el que el maker estaba cotizando | `S` real **8,9** contra **12,1** creídos |
| ganancia agregada al corregirlo | **+5,7%**, y hasta **+78%** en el mercado concreto |

Vive en `medioAjustadoPorTamano`. Cuando los dos medios se separan **más que la banda entera** no existe
un precio que puntúe con los dos: ahí no se cotiza (`medio_ambiguo`), porque elegir uno sería apostar a
cuál usa el exchange inmovilizando la cuenta entera a cambio de esa moneda al aire.

**2. Por debajo de $1 al día no se cobra menos: se cobra cero.** Literal de la documentación: *"The
minimum reward payout is $1; amounts below this will not be paid."* Por usuario y por día, y lo que no
llega **no se acumula**: se pierde. Con capital pequeño esto cambia la estrategia — repartirse entre
varios sitios flojos no da la suma de sus migajas, da **$0** con el capital igual de inmovilizado y la
selección adversa corriendo igual. `elegirMercados` descarta lo que no cruce el listón; el umbral es
**5x** el suelo (`MIN_ESPERADO_USD_DIA`) porque lo que se compara no es lo cobrado sino `esperadoUsdDia`,
que es una estimación y ya se sabe que sale alta.

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
- **El par cuesta ESTRICTAMENTE menos de $1, nunca $1 exacto.** No por el margen, sino porque comprar
  UP a `p` y DOWN a `q` deja en el libro fusionado una compra en `p` y una venta en `1−q`: con `p+q=1`
  las dos caen en el mismo precio y **se cruzan entre sí**. Polymarket casa compras complementarias
  acuñando un par, así que con `postOnly` el exchange rechaza la segunda, la guarda de atomicidad
  retira la primera y el maker se queda mudo en bucle. Es lo que producía `makerTicksDelMedio: 0`, que
  se documentaba como una palanca de rendimiento: barrido sobre 2.196 medios, cambia el precio en
  1.098 y **los 1.098 bloquean**; en los demás da el mismo precio que el modo normal. No es una opción
  peor, es una que no funciona — la guarda la rechaza y `settings.ts` la normaliza a 1.
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

## Quién relanza el proceso

Polybot **cuenta con que alguien lo supervise**: `POST /api/system/restart` detiene el bot y hace
`process.exit(0)` esperando que un tercero lo levante con el código nuevo. Sin supervisor, ese endpoint
apaga el bot y ya está.

Hay dos vías soportadas y no son intercambiables:

| | Windows nativo | Docker Compose |
|---|---|---|
| Supervisor | tarea `PolybotWatchdog`, cada 5 min | `restart: unless-stopped` |
| Reinicio tras `/api/system/restart` | ≤ 5 min | segundos |
| Reinicia un proceso **muerto** | sí | sí |
| Reinicia un bot **vivo pero ciego** | **sí** (sondea `/api/health`, que da 503 con el feed rancio) | **no** — Docker no reinicia contenedores `unhealthy` por sí solo |
| Archivado de analítica | tarea `PolybotArchivoAnalitica` | servicio `polybot-archivador` |
| Ajuste `watchdogEnabled` | lo lee `watchdog.ps1` | **no lo lee nadie** |

Cuál está activo **se declara, no se adivina**: `POLYBOT_SUPERVISOR` (`compose` | `windows-watchdog` |
`systemd` | `ninguno`), y el estado lo publica en `UiStatus.supervisor`. Deliberadamente no se detecta
mirando `/.dockerenv` ni similares: una detección que falla en silencio produce exactamente la mentira
que este campo viene a evitar.

De ahí salen dos consecuencias visibles:

1. **El mensaje de `/api/system/restart` nombra al supervisor real y su plazo real.** Decía siempre «el
   watchdog relanzará en ≤5 min»; bajo compose son segundos y sin supervisor no vuelve nunca. Prometer
   un relanzamiento que no llega deja al operador esperando una UI que ya no existe.
2. **El ajuste «Watchdog (auto-reinicio)» sale deshabilitado donde no aplica**, con el motivo, en vez de
   quedarse marcable y sin efecto. No se oculta: quien lo busque tiene que encontrar la explicación.

La brecha del healthcheck bajo Docker es real y está sin cerrar. Se documenta en
[`docker.md`](docker.md#la-brecha-del-healthcheck) en vez de fingir equivalencia: dar por cubierto algo
que no lo está es peor que la brecha misma.

## Las tareas programadas viven en la sesión 0

> Solo aplica a la vía **Windows nativo**. Bajo Docker no hay tareas programadas y nada de esta sección
> interviene.

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

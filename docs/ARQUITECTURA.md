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
  `entryWindowSeconds`: 50 desde 2026-09-11, antes 80 (08-sep) y 120 (07-sep). Más abajo, en "CUÁNDO
  entrar" y "La certeza de la ventana", se explica por qué este número decide el signo del resultado.
  El otro no se declara: `getAnalyticsQuotes` solo pedía
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

#### La tabla que engañó, y por qué se deja escrita

Durante cuatro días el umbral fue **1,0**, justificado por esto — medido sobre 1.484 ventanas de
`data/analytics.jsonl`, **aguantando hasta el cierre**:

| umbral z | ops | % | aciertos | neto/op | 1ª mitad | 2ª mitad |
|---|---|---|---|---|---|---|
| sin filtro | 1484 | 100% | 70,4% | −0,0670 | −0,1391 | +0,0051 |
| z ≥ 0,5 | 508 | 34% | 82,5% | +0,2301 | +0,1201 | +0,3481 |
| z ≥ 1,0 | 152 | 10% | 91,4% | +0,4623 | +0,2355 | +0,6610 |
| z ≥ 1,5 | 43 | 3% | 100,0% | +0,7372 | +0,3882 | +0,9885 |

**Ninguna de esas cifras era falsa. Medían otro universo.** «Aguantando hasta el cierre» quiere decir
sin la ventana de entrada de 120 s y sin la banda 0,79–0,90 — es decir, sobre ventanas que el bot no
opera. El error no fue el número: fue no anotar **sobre qué** se había medido, y por eso este apartado
se conserva entero en vez de sustituirse.

Se pudo detectar porque desde 2026-09-08 existe `src/favoriteReplay.ts`, que replica el camino real
del favorito —selector, ventana, certeza, spread— llamando a los módulos de producción en lugar de
reimplementarlos. Hasta entonces no había forma: todo el arsenal de backtest cuelga de
`replaySignals`, que reconstruye la señal por distancia de Chainlink, o sea el camino direccional.

#### 80 s y z ≥ 1,5 (del 8 al 11 de septiembre): la segunda tabla que engañó

Con el replay recién hecho se midió esto, eligiendo por la primera mitad cronológica y juzgando por la
segunda. Neto por operación de 5 $ en la segunda mitad:

| ventana ↓ / z → | apagado | ≥ 0,5 | ≥ 1,0 | ≥ 1,5 |
|---|---|---|---|---|
| 60 s | +0,056 | +0,058 | +0,374 | +0,489 |
| 80 s | −0,054 | −0,077 | +0,063 | **+0,417** |
| 100 s | −0,092 | −0,105 | −0,114 | +0,156 |
| 120 s | −0,082 | −0,085 | −0,138 | −0,097 |
| 140 s | −0,068 | −0,078 | −0,132 | −0,050 |

Se eligió **80 s con z ≥ 1,5**: 179 operaciones, +6,10 pp de ventaja, "t = 3,28, bootstrap positivo
el 100%". **Esas dos últimas cifras estaban infladas, y se corrigen aquí.**

- **Hacia delante perdió.** 49 entradas, 83,7% de acierto contra 88,0% de equilibrio, −13 $. El bot
  hacía exactamente lo que medía el replay: en las 38 ventanas compartidas, mismo lado, mismo ask y
  mismo segundo. No era un fallo del bot.
- **La elección premiaba la suerte.** Se escogió la casilla con más neto medio dentro de muestra, y eso
  favorece las casillas pequeñas que salieron bien. Con dos mitades hay muy poco para verlo. Con seis
  tramos cronológicos, esa config es positiva en 4 de 6 y los dos últimos son negativos.
- **Las operaciones no son independientes.** Los tres mercados cierran a la vez y pierden juntos: si
  uno pierde, otro de la misma ventana pierde el 47,5% de las veces, frente a un 13,2% sin esa
  condición (181 pares). El t y el bootstrap de operaciones sueltas cuentan esas pérdidas como
  sorteos distintos. Con bootstrap por ventanas (`bootstrapCIPorBloques`), el P5 del total cae a +5 $.
- **La lectura de "interacción" era cierta a medias.** A 80 s la certeza sí mejora el resultado. Lo
  que no se vio es que entrar más tarde consigue lo mismo sin filtro y con cuatro veces más muestra.

#### Lo que es robusto: seis tramos y bootstrap por ventanas

`npx tsx src/smoke/favoritoReplay.ts`, sobre 5.739 ventanas del régimen TWAP (7,8 días) partidas en
6 tramos cronológicos de igual número de ventanas.

**Regla de elección** (escrita también en el smoke): entre las casillas con al menos 150 operaciones y
datos en los 6 tramos, gana la de **mejor peor tramo**, y en empate la de mejor P5. Nunca el neto medio.

| config | ops/día | ventaja | neto (7,8 d) | tramos + | peor tramo | P(+) | P5 del total |
|---|---|---|---|---|---|---|---|
| 40 s, sin certeza, 0,79–0,88 | 50 | +4,85 pp | +114 $ | 6/6 | +2,59 pp | 100% | +48 $ |
| 50 s, sin certeza, 0,79–0,90 | 94 | +4,17 pp | +185 $ | 6/6 | +2,58 pp | 100% | +98 $ |
| **50 s, sin certeza, 0,79–0,88** | **84** | **+4,49 pp** | **+179 $** | **6/6** | **+2,42 pp** | **100%** | **+93 $** |
| 60 s, z ≥ 1, 0,82–0,88 | 22 | +6,40 pp | +63 $ | 6/6 | +0,09 pp | 100% | +30 $ |
| 80 s, z ≥ 1, 0,79–0,88 | 69 | +3,51 pp | +114 $ | 5/6 | −0,24 pp | 99% | +36 $ |
| 80 s, z ≥ 1,5, 0,79–0,90 (la del día 8) | 30 | +4,01 pp | +54 $ | 4/6 | −0,80 pp | 97% | +5 $ |
| 120 s, z ≥ 1, 0,79–0,90 (la vieja) | 224 | −0,32 pp | −30 $ | 3/6 | −3,87 pp | 38% | −188 $ |

Las tres primeras filas están separadas por 0,17 pp de peor tramo: eso es ruido. Entre ellas se elige
por otras dos razones. **50 s** duplica el volumen de 40 s, así que se valida hacia delante en la mitad
de tiempo y gana más dinero. **0,88** frente a 0,90: a 50 s están empatadas (0,90 añade 76 operaciones y
+5,6 $), pero el tramo de ask 0,88–0,90 pierde −1,77 pp a 80 s (n = 461), y ante un empate se prefiere
no incluirlo.

#### La config elegida el 2026-09-11: 50 s, sin certeza, 0,79–0,88, sin salidas

| | |
|---|---|
| operaciones | 656 en 7,8 días (84 al día) |
| aciertos | 88,7% |
| equilibrio | 84,2% |
| ventaja | **+4,49 pp** |
| neto | +179,11 $ a 5 $ por operación (+23,07 $/día) |
| por tramo (pp) | 3,0 · 2,4 · 4,0 · 3,5 · 4,8 · 9,5 |
| por mercado | BTC +3,65 pp (330) · ETH +5,53 pp (313) · DOGE +0,85 pp (13) |
| bootstrap por ventanas | positivo el 100%, P5 del total +93 $ |

El último tramo (+9,5 pp) es el periodo posterior al cambio del día 8, que fue especialmente bueno para
esta config. Sin él, los otros cinco siguen entre +2,4 y +4,8 pp.

**Por qué sin certeza.** A 50 s del cierre, un ask de 0,79–0,88 ya descuenta lo decidida que está la
ventana, y aun así sale barato. El filtro no mejora el peor caso y se come la muestra: a 50 s, z ≥ 1 deja
80 operaciones y no llega a competir. Encaja con lo medido en "CUÁNDO entrar": la ventaja la lleva el
tiempo. La certeza se apaga con `favoriteMinCertainty: -1000`, porque el esquema no tiene mínimo y JSON
no admite `-Infinity`. El código se queda.

**Por qué sin salidas.** Ninguna variante medida mejora a aguantar (ver "La salida por stop"). Además,
con entradas a ≤ 50 s ni siquiera podrían dispararse: hacen falta 10 s de permanencia y ≥ 45 s al
cierre.

**Aviso de honestidad.** Esta config también se eligió mirando esos mismos 7,8 días. Los tramos reducen
el riesgo de sobreajuste, pero no lo eliminan. Por eso lo que sigue se escribe antes de tener el dato.

#### Prueba hacia delante, pre-registrada

Config aplicada en `data/ui-config.json` el **2026-09-11T05:25:47Z**, con el bot parado y antes de
volver a arrancarlo. Se evalúa con:

```
npx tsx src/smoke/favoritoReplay.ts --desde 2026-09-11T05:25:47Z
```

| | |
|---|---|
| esperado | ventaja ≈ +4,5 pp, unas 84 entradas al día |
| hito | 300 entradas nuevas (≈ 3,5 días) |
| se mantiene si | ventaja > 0 **y** P(+) del bootstrap por ventanas ≥ 80% |
| se para si | ventaja < 0 **y** P(+) ≤ 20% → el favorito se apaga en sim y se documenta que no hay ventaja |
| entre medias | se sigue sin tocar nada hasta 600 entradas (≈ 7 días) y se vuelve a aplicar la misma regla |

Tres reglas para esa ventana:

- **No se busca otra casilla dentro de ella.** El modo `--desde` del smoke no corre la rejilla, a
  propósito: buscar la mejor casilla sobre el periodo de prueba lo gasta, y así se fabricó lo del día 8.
- **Si el cruce ledger ↔ replay no coincide** (lados distintos en ventanas compartidas), se explica eso
  antes de juzgar la estrategia.
- **Live sigue apagado** pase lo que pase en el hito.

**El parón del 11 al 12 de septiembre: 27 horas sin operar, y no fue la estrategia.** El bot hizo 7
entradas y se detuvo. La guarda `favorite_banda_sin_capital` descartó 168 ventanas seguidas porque la
cartera real tenía 4,47 $ y el importe es el mínimo de orden del exchange, 5 $ — `autoMinLive`
sustituye el importe configurado en los dos modos. Lo delató el cruce que exige la regla de arriba: 7
entradas en el ledger frente a 127 del replay, con las 7 compartidas idénticas (mismo lado, mismo ask,
mismo segundo). Arreglado el 2026-09-12 limitando **el descarte** a live, con el mismo criterio que ya
tenía `minBankrollForDirectionalUsd`: en sim no se gasta nada, así que frenar el papel no protege de
nada. La **reserva** intra-pasada sigue ocurriendo en los dos modos, porque la convicción dimensiona
contra ella. Tres consecuencias:

- **El hito de 300 entradas se cuenta desde que el papel vuelve a operar**, no desde el 11. Las 7
  entradas de ese arranque siguen contando como datos.
- Esas 7 dieron −12,15 pp, y **eso no es un veredicto**: con n = 7 no se decide nada. Leerlo como
  fracaso es exactamente el error que este apartado existe para evitar.
- El papel deja de predecir lo que la cuenta puede ejecutar hoy: con 4,47 $, live no colocaría ni una
  orden de 5 $. Fondear la cartera es requisito para plantearse live, no para la prueba en sim.

#### Hito de 300 entradas (2026-09-15): se sigue hasta 600, sin tocar nada

304 entradas desde el cambio (297 desde que el papel se reanudó el 2026-09-12T11:49Z). Medido con
`favoritoReplay.ts --desde 2026-09-11T05:25:47Z`:

| | ledger (verdad oficial) | replay, misma ventana |
|---|---|---|
| n | 304 | 419 |
| aciertos | 84,9% | 85,4% |
| equilibrio | 84,2% | 84,1% |
| **ventaja** | **+0,66 pp** | +1,37 pp |
| **P(+) bootstrap por ventanas** | **62%** | 78% |
| tramos positivos | 3/6 | 4/6 |
| neto a 5 $ | +11,05 $ | +34,37 $ |

**Decisión por la regla escrita antes del dato:** no cumple «se mantiene» (pide P(+) ≥ 80%) ni «se
para» (pide ventaja < 0). Cae en la banda intermedia, así que **se sigue sin tocar nada hasta 600
entradas** y se vuelve a aplicar la misma regla. La ventaja esperada era +4,5 pp y va por +0,66: con
esta muestra, indistinguible de empatar.

**El hueco de 123 ventanas entre ledger y replay era el parón, no un problema de cobertura.** La
comparación de arriba no es equivalente: el replay incluye las ~109 ventanas de las 28,8 h en que la
guarda de capital tuvo el papel parado, y el ledger no podía tener ninguna. Igualando las dos ventanas
—`--desde 2026-09-12T11:49:23Z`, desde que se reanudó— el bot entró en **289 de las 290** que el replay
da por válidas: 1 de más para el replay y 8 en las que entró el bot y el replay no (cotizaciones que la
analítica no grabó en ese segundo). Con las ventanas igualadas, las dos medidas coinciden:

| | ledger | replay |
|---|---|---|
| n | 296 | 290 |
| ventaja | +0,92 pp | +0,95 pp |
| P(+) | 66% | 67% |
| neto a 5 $ | +15,22 $ | +15,78 $ |

Misma decisión con las dos ventanas, así que el veredicto no depende de cuál se mire. De paso queda
medido que **el gate de EV sobre este periodo es claramente malo** —−3,55 pp, 2/6 tramos, P(+) 16%—,
lo que refuerza dejarlo apagado.

#### Hito de 600 entradas (2026-09-19): sigue sin estar demostrada, y la regla no lo preveía

631 entradas del ledger desde la reanudación, medidas con
`favoritoReplay.ts --desde 2026-09-12T11:49:23Z`:

| | ledger (verdad oficial) | replay, misma ventana |
|---|---|---|
| n | 631 | 616 |
| aciertos | 85,1% | 85,7% |
| equilibrio | 84,2% | 84,3% |
| **ventaja** | **+0,86 pp** | +1,46 pp |
| **P(+) bootstrap por ventanas** | **73%** | 84% |
| tramos positivos | 5/6 | 5/6 |
| peor tramo | −2,10 pp | −0,49 pp |
| neto a 5 $ | +31,92 $ | +53,85 $ |

**La regla escrita antes del dato no cubría este caso.** Decía «se mantiene si P(+) ≥ 80%», «se para si
ventaja < 0 y P(+) ≤ 20%», y «entre medias, se sigue hasta 600 y se vuelve a aplicar la misma regla».
A las 600 vuelve a caer en la banda intermedia —+0,86 pp con P(+) 73%— y **la regla ya no tenía
cláusula de salida**: no dice qué hacer cuando el hito final también queda en medio. Eso es un fallo de
quien la escribió, no del dato. Se cierra así, y queda por escrito:

- **La ventaja sigue sin estar demostrada.** Cinco veces menor que los +4,5 pp esperados, y con P(+) 73%
  el bootstrap no descarta que sea cero. Positiva en 5 de 6 tramos, pero el peor es −2,10 pp.
- **Se decide seguir en papel y añadir el freno de riesgo** (abajo), no porque la ventaja esté probada,
  sino porque el problema que se ataca es otro: la caída, no la media.
- **Live sigue apagado**, como decía la regla original pasara lo que pasara.

**El peaje de la comisión, que es el segundo motivo para no operar de más.** De las 632 operaciones que
contabiliza el ledger con su propio P&L, el bruto son 66,33 $ y la comisión 36,95 $: **la comisión se
lleva el 56% de la ganancia bruta**. A ~83 entradas al día, cada entrada de más paga peaje aunque la
ventaja por operación sea positiva.

> **Dos cuentas del mismo ledger que no coinciden, y por qué.** El smoke dice 631 entradas y +31,92 $;
> el simulador del freno dice 632 y +29,38 $. Las dos están bien. El smoke corta por **inicio de
> ventana** y el simulador por **instante de creación**, y hay exactamente una operación
> (`btc-updown-5m-1789213500`) creada 10 ms después de la reanudación cuya ventana había empezado
> antes. El neto difiere porque el smoke **revalora** todo a un importe uniforme de 5 $ con comisión
> modelada —así compara replay y ledger en la misma escala— mientras que el simulador suma el P&L que
> el ledger tiene grabado. Para dinero manda el ledger; para comparar estrategias, la revaloración.

### El freno de riesgo: encendido el 2026-09-19, con lo que se midió

**El problema.** Sobre las 632 operaciones resueltas del papel entre el 12 y el 19 de septiembre el
neto fue +29,38 $, pero la peor caída desde el pico fue **−43,45 $**: la caída es mayor que todo lo
ganado. Por días: +10,08 · +15,88 · −0,99 · −10,24 · +4,68 · +0,82 · +5,50 · +3,65 $. Un día malo borra
dos buenos.

**Dónde ocurrió esa caída, que es lo que decide si un freno puede tocarla.** Del 2026-09-17T01:45Z al
12:35Z: **10,8 horas y 44 operaciones seguidas**, dentro de un mismo día UTC. Que quepa en un día es
justo lo que hace que un freno *diario* pueda verla. Medido con la zona del portátil (CST, UTC−6) esa
caída se parte en dos días y ningún límite la alcanza — y la primera vez la medí así, con otra tabla y
otra ganadora. **El bot corre en un contenedor con TZ=UTC, así que `timezone: "auto"` resuelve a UTC**,
y el contrafactual tiene que medirse en UTC.

**Cómo se midió.** `npx tsx src/smoke/frenoRiesgo.ts`. No reimplementa el freno: llama a
`evaluateDirectionalRiskHalt`, el mismo que aplican el bucle y la UI, y solo le enseña lo que ya había
**cerrado** en el instante de decidir cada entrada — sin eso, el freno frenaría por pérdidas que
todavía no han ocurrido. El contrafactual es exacto porque las operaciones de papel no mueven el
mercado: saltarse una entrada no cambia el resultado de las demás. **En live no valdría.**

Elección con lo anterior al 2026-09-11T05:25Z (658 entradas del replay), juicio con lo posterior al
2026-09-12T11:49Z (632 entradas reales). Criterio escrito antes de mirar: entre las reglas que
conservan **≥75% del neto** en el periodo de elección, gana la de **menor caída máxima**; empate, la que
menos opera. Nunca al revés.

**Regla elegida: tres pérdidas seguidas → parado 24 h** (`maxConsecutiveLosses: 3`,
`riskHaltCooldownHours: 24`, `maxDailyLossUsd: 0`).

| | sin freno | con la regla elegida |
|---|---|---|
| **elección** — n | 658 | 602 |
| **elección** — neto | +180,45 $ | +144,80 $ (−20%) |
| **elección** — caída máxima | 25,85 $ | **25,85 $ (sin cambio)** |
| **prueba** — n | 632 | 480 (−24%) |
| **prueba** — neto | +29,38 $ | +35,97 $ (+22%) |
| **prueba** — caída máxima | 43,45 $ | **28,75 $ (−34%)** |
| **prueba** — comisión | 36,95 $ | 28,00 $ (−24%) |

**Lo que hay que leer de esa tabla, y no es lo bonito.** En el periodo con el que se eligió, la regla
**no redujo la caída ni un céntimo** y costó 36 $ de neto; ganó por el desempate, porque ninguna regla
de la rejilla movía la caída ahí. En el periodo de juicio sí la redujo un 34% y encima subió el neto.
Y el diagnóstico que lo explica: **lo que el freno tira cambia de signo**. Las 56 entradas saltadas en
elección valían **+35,65 $** (+0,64 $/op: tiró ganadoras); las 152 de prueba valían **−6,59 $**
(−0,04 $/op: tiró perdedoras). Un freno no distingue buenas de malas —**acota la cola, no crea
ventaja**— y aquí eso está medido, no supuesto.

Lo único monótono y limpio de toda la rejilla es el enfriamiento: con racha 3, la caída máxima en el
periodo de juicio fue 51,63 $ con 2 h, 39,07 $ con 4 h y 28,75 $ con 24 h. Tras tres pérdidas seguidas,
el mal rato dura horas, no minutos. `maxDailyLossUsd` se queda apagado porque sobre la racha no aportó
nada: con racha 3, ponerle 8, 10, 15 o 20 $ daba exactamente el mismo resultado.

Los topes de gasto diario (50–200 $/día) sí recortan la caída en los dos periodos —son la única palanca
con signo estable— pero recortan el neto en proporción: es apostar más pequeño con otro nombre. Fallan
el suelo del 75% en el periodo de elección, así que el criterio los descarta y **no se cambian después
de ver el dato**, que es exactamente como se fabricaron dos configuraciones sobreajustadas en este
mismo documento.

#### El freno por racha se quitó al día siguiente (2026-09-20)

Estuvo puesto unas horas y no llegó a dispararse ni una vez. Se quita porque **resolvía un problema que
no era el que había que resolver**: acotaba la caída del acumulado de todo el periodo, y lo que se pedía
era que **cada día cerrara en verde**. Son cosas distintas y yo medí la primera. `maxConsecutiveLosses`
vuelve a 0 y el enfriamiento a 2 h; lo medido arriba se queda escrito porque sigue siendo verdad sobre
la pregunta que respondía, y porque la prueba pre-registrada que llevaba no llegó a ejecutarse.

### Que cada día cierre en verde: el objetivo del día (2026-09-20)

**El problema, día a día.** Nueve días de papel, sin ninguna regla, con lo que cada día llegó a tener y
lo que cerró:

| día | entradas | llegó a | cerró |
|---|---|---|---|
| 09-12 | 58 | +5,45 $ | **−3,89 $** |
| 09-13 | 101 | +21,57 $ | +11,79 $ |
| 09-14 | 71 | +25,42 $ | +11,62 $ |
| 09-15 | 74 | +10,92 $ | **−11,14 $** |
| 09-16 | 92 | +27,72 $ | +27,72 $ |
| 09-17 | 75 | +4,06 $ | **−20,11 $** |
| 09-18 | 71 | +13,38 $ | +0,27 $ |
| 09-19 | 81 | +23,48 $ | +16,45 $ |
| 09-20 | 35 | +0,91 $ | **−9,12 $** |

**Ningún día conserva su máximo**, cuatro de nueve cierran en rojo y tres de ésos habían estado en
verde. El cortacircuitos que existía no podía hacer nada contra esto: sabe parar cuando se pierde,
nunca cuando ya se ha ganado.

**Lo que se añadió.** `dailyProfitTargetUsd` dentro de `evaluateRiskCircuitBreaker`, para que el bucle y
el chip lo vean por el mismo sitio que los otros dos límites. Dos diferencias deliberadas respecto a
ellos:

- **No usa enfriamiento.** Un objetivo cumplido dura hasta el corte del día. Con las 2 h configuradas el
  día volvería a abrirse dos horas después, que es lo contrario de asegurar lo ganado.
- **No se suelta si el día se tuerce después.** Las posiciones que seguían abiertas al alcanzarlo pueden
  hundir el neto por debajo del objetivo; el día sigue cerrado. Reabrir sería haber perdido lo ganado
  **y además** volver a jugar para recuperarlo. Esto lo destapó un test, no el diseño: la primera
  versión reabría.

Sale gratis en persistencia porque, como el resto del freno, se deduce del ledger recorriendo el día en
orden y no de una bandera guardada: sobrevive a un reinicio.

**La frontera medida** (`npx tsx src/smoke/cerrarEnVerde.ts`), elección con lo anterior al 11 de
septiembre, juicio con lo posterior al 12:

| regla | elección: días verde / neto | juicio: días verde / neto |
|---|---|---|
| sin nada | 8/9 · +180,45 $ | 5/9 · +23,59 $ |
| racha 3 (lo del día 19) | 7/9 · +144,80 $ | 5/9 · +30,18 $ |
| **objetivo 15 $** | 9/9 · +121,31 $ | **6/9 · +45,42 $** |
| objetivo 10 $ | 9/9 · +91,28 $ | 6/9 · +30,98 $ |
| objetivo 5 $ | 9/9 · +49,87 $ | 7/9 · +8,60 $ |
| objetivo 3 $ | 9/9 · +33,38 $ | 8/9 · +17,51 $ |

**Es monótona en los dos periodos**: cuanto más bajo el objetivo, más días cierran en verde y menos
dinero se hace. Elegido **15 $**, que es el único punto que en el periodo de juicio mejora a la vez los
días en verde (6/9 frente a 5/9) y el neto (+45,42 $ frente a +30,18 $), y en el de elección cuesta un
16% del neto a cambio de cerrar los nueve días en verde.

Tres cosas que esto **no** hace, y conviene que estén escritas antes de que decepcionen:

1. **No sube la ganancia esperada.** Si cada entrada tiene ventaja positiva, dejar de entrar cuando vas
   ganando quita entradas buenas. Lo que compra es regularidad y se paga en media. El criterio que se
   había pre-registrado —más días en verde **sin** ganar menos— no lo cumplió ninguna regla, y ése es el
   resultado honesto: no se puede tener las dos cosas.
2. **No garantiza cerrar en verde.** Al parar quedan posiciones abiertas que aún tienen que resolver.
3. **No salva un día que nunca sube.** El 09-20 no pasó de +0,91 $: ningún objetivo lo alcanza. Para eso
   está `MAX_DAILY_LOSS_USD`, que sigue en 0 porque el dueño no lo quiso.

#### Prueba hacia delante del objetivo, pre-registrada

Aplicado el **2026-09-20T02:55Z** con el bot parado y la imagen reconstruida (el campo es nuevo, así que
el contenedor viejo no lo conocía). Respaldo en `data/ui-config.json.bak-antes-objetivo`.

**El contador arranca en el reinicio de P&L del 2026-09-20T09:00:30Z**, no en el despliegue. Se
reiniciaron las dos marcas: `pnlResetAtMs` (la cuenta que se mira) y `riskHaltResetAtMs` (la línea base
del freno), porque sin la segunda el objetivo del primer día habría arrastrado los −5,01 $ que ya
llevaba esa mañana y «desde cero» no habría sido verdad. Ninguna de las dos borra nada: son marcadores,
y `trades.jsonl` conserva las 7.426 filas — el histórico sigue entero para volver a medir.

| | |
|---|---|
| hito | 14 días naturales desde el reinicio, para que haya al menos 14 cierres de día que observar |
| se mantiene si | cierran en verde **≥ 7 de cada 9 días** (lo medido fuera de muestra, 6/9, más un día) **y** el neto por día no cae por debajo de +2,42 $, que es lo que daba sin nada |
| se baja el objetivo si | se cierran en verde menos de 6 de cada 9 días: el objetivo de 15 $ no se alcanza lo bastante a menudo y hay que mirar 10 $ |
| se quita si | el neto por día cae por debajo de +2,42 $ **y** los días en verde no mejoran |
| no cuenta como confirmación | que suba el neto total: eso depende del régimen, no de la regla |

El contrafactual sale del replay sobre las mismas ventanas, no del ledger: el bot con objetivo no
ejecuta las entradas del resto del día, así que el ledger ya no las contiene.

Aviso por escrito: **14 días son 14 observaciones.** La diferencia entre 6/9 y 7/9 días en verde no se
va a poder distinguir del azar con esa muestra. El hito sirve para detectar un fallo grande —que el
objetivo no se alcance casi nunca, o que el neto se hunda—, no para certificar una mejora fina.

#### Disparador: cuándo el objetivo tiene que dejar de ser dólares y pasar a %

Un objetivo en dólares **no sobrevive a que la cuenta crezca**, y ésa es su única debilidad seria. Si el
importe por entrada pasa de 5 $ a 20 $, el P&L diario se multiplica por cuatro y los +15 $ se alcanzan
en la cuarta parte de las operaciones: **la regla se vuelve mucho más estricta sin que nadie lo haya
decidido**, y deja de ser la que se midió. Un objetivo en porcentaje es la versión invariante a escala
de esta misma regla: si el importe se multiplica por k, el P&L diario también, y un porcentaje mantiene
solo el comportamiento medido.

**Se cambia cuando ocurra cualquiera de estas dos cosas, y no antes:**

1. **El importe por entrada deja de ser el mínimo del exchange.** Hoy `autoMinLive` lo clava en 5 $ en
   los dos modos, así que no escala con nada y dólares y porcentaje son la misma regla con otro nombre.
2. **Hay un capital declarado o leído contra el que dividir.** Hoy no lo hay: el bot no consulta el
   saldo de la wallet y `liveBankrollUsd` es un número declarado para live que está en 0. En papel no
   existe cuenta que dividir, y ése es el motivo real de que el objetivo esté en dólares.

**Cómo se convierte, para que el cambio no sea una decisión nueva encubierta.** El objetivo equivalente
es el que conserva la misma fracción de lo que el día despliega:

```
objetivo% = objetivo$ / (entradas por día × importe por entrada)
```

Con los números de hoy —15 $, ~83 entradas al día, 5 $ por entrada— eso es **15 / 415 = 3,6%**. Al
cambiar se pone ese porcentaje, no uno redondo que «suene bien»: redondear a 5% sería subir el objetivo
un 39% sin haberlo medido.

**El denominador correcto es el capital acumulado**, no lo apostado en el día. Esto no es un detalle de
implementación, es la diferencia entre que la regla funcione o no:

- **Sobre el capital acumulado** (inicial + P&L realizado) el objetivo queda **fijo al empezar el día** y
  además crece según crece la cuenta, que es componer — el objetivo declarado del dueño.
- **Sobre lo apostado hoy** el objetivo es **móvil**: cada entrada de 5 $ sube el listón 0,20 $ mientras
  una ganadora aporta ~0,57 $. El objetivo se aleja mientras se persigue y el día no cierra limpio. Una
  regla de parada tiene que quedar fija al empezar el día.

**Lo que el cambio NO ahorra:** si el importe por entrada cambia, la frontera de `cerrarEnVerde.ts` hay
que volver a medirla igual. El porcentaje evita que la regla se endurezca a escondidas mientras tanto;
no sustituye a la medición.

### ¿Sobra volumen? Filtros de entrada medidos (2026-09-20)

El freno acota la caída pero **no toca el operar de más**: siguen entrando ~83 veces al día y la
comisión se lleva el 64% del bruto en el periodo de juicio (38,35 $ de comisión sobre 60,13 $ brutos
para un neto de +21,78 $). La pregunta que queda es si hay volumen que no paga su peaje.

`npx tsx src/smoke/filtrosEntrada.ts`. Mismo reparto: **elección** = 658 entradas del replay anteriores
al 2026-09-11T05:25Z, **juicio** = 656 entradas reales del ledger desde el 2026-09-12T11:49Z. 16
candidatos escritos antes de mirar. Criterio, también escrito antes: n ≥ 150, los 6 tramos con datos,
gana el **mayor peor-tramo** (nunca la media), desempate por neto por operación.

**Mi hipótesis de partida era falsa.** Dije que BTC era el problema: +0,12 pp en 331 operaciones en el
hito de 600. Medido con los dos periodos, el mercado **no separa nada estable**:

| | elección | juicio |
|---|---|---|
| solo BTC | +3,67 pp | −0,40 pp |
| solo ETH | +5,55 pp | +1,46 pp |
| sin BTC | +5,36 pp | +1,84 pp |
| sin ETH | +3,57 pp | −0,02 pp |

ETH mide mejor que BTC en los dos, pero los dos cambian de signo y la diferencia entre «sin BTC» y la
referencia cabe dentro del ruido. **Dejar de operar BTC no está justificado por esto.**

**Lo único que mantiene el signo en los dos periodos es la hora.**

| franja UTC | elección | juicio | qué es |
|---|---|---|---|
| 12–18 | **−1,67 pp**, P(+) 32% | **−3,44 pp**, P(+) 13% | mañana de Nueva York |
| sin 12–18 | +6,63 pp | +2,10 pp | el resto del día |
| 00–06 | +6,49 pp | +3,49 pp | madrugada asiática |

Hora a hora, el tramo **12:00–15:00 UTC mide negativo en los dos periodos** (12 h: −3,29 / −4,95;
14 h: −13,54 / −1,52; 15 h: −2,46 / −5,74), que es ~8–11 de la mañana en Nueva York. Hay un mecanismo
plausible: es cuando la cripto se mueve más, y el favorito de una ventana de cinco minutos tiene más
ocasiones de darse la vuelta. No es una hora suelta rescatada de un barrido: son cuatro horas seguidas
con el mismo signo en dos periodos independientes.

**Lo que la regla eligió, y por qué no se aplica.** El criterio pre-registrado eligió **«solo 00–06
UTC»** (peor tramo +3,08 pp en elección). Fuera de muestra gana en dinero —184 operaciones en vez de
656, neto +36,55 $ frente a +21,78 $, comisión 10,55 $ frente a 38,35 $, seis veces más neto por
operación— pero **por dentro no se sostiene**: sus horas cambian de signo entre periodos (02 h: +5,80
→ −4,16; 04 h: +15,34 → −1,25) y su peor tramo fuera de muestra es −8,55 pp. Ganó una casilla, no un
mecanismo. Con 16 candidatos sobre ~650 operaciones, la mejor de todas se ve bien por azar aunque
ninguna sirva: eso estaba escrito antes de correrlo.

**Nada de esto se aplica todavía**, por dos razones: la prueba del freno está corriendo y meter un
filtro de entradas ahora haría imposible saber cuál hizo qué; y la hipótesis de las 12–18 salió de
mirar esta tabla, así que juzgarla con esta misma tabla es el error circular de siempre.

#### Pre-registro: el filtro horario se juzga con datos que todavía no existen

Escrito el 2026-09-20, **antes** de ver ningún dato posterior:

| | |
|---|---|
| hipótesis | las entradas creadas entre las 12:00 y las 18:00 UTC tienen ventaja ≤ 0 |
| cuándo se evalúa | al cerrar el hito del freno (7 días o 400 entradas) |
| con qué | `filtrosEntrada.ts`, franja «sin 12–18 UTC» frente a la referencia, **solo con entradas nuevas** |
| se aplica si | la franja 12–18 vuelve a medir ventaja ≤ 0 **y** «sin 12–18» tiene mejor peor-tramo que la referencia |
| se descarta si | la franja 12–18 mide ventaja > 0, o mejora el peor-tramo menos que la referencia |
| no cuenta como confirmación | que el neto total suba: quitar horas sube el neto por operación casi siempre, porque quita operaciones |

Aviso que ya se puede escribir: **el periodo de juicio deja de ser limpio en cuanto el freno dispare
por primera vez.** A partir de ahí faltan entradas del ledger, y faltan por una razón que depende del
resultado de las anteriores. El smoke avisa solo cuando hay entradas posteriores al encendido
(2026-09-19T20:49Z); al primer disparo hay que cortar el periodo ahí y contar el siguiente aparte.

#### Lo que se probó y no aporta

- **Apretar `favoriteMaxAskSum`** (medido sobre 80 s y z ≥ 1,5). 1,03 / 1,05 / 1,10 / 1,15 dan las
  mismas operaciones: con esos filtros ya no queda libro muerto que filtrar.
- **Subir el techo de la banda.** El tramo de ask 0,88–0,90 mide −1,77 pp a 80 s (n = 461), y
  0,86–0,94 se va a −1,33 pp fuera de muestra.
- **Corregir z con el horizonte del TWAP**, z·√(T/(T−20)): separa peor. Da +2,83 pp en z 1,5–2 frente a
  +5,36 pp de la z de producción.
- **El gate de EV.** Sobre la config del día 8, con tramos: +2,82 pp, 4/6 y P5 −15 $, frente a +4,01 pp
  y P5 +5 $ sin él. Sobre la config elegida sube la ventaja por operación (+5,81 pp frente a +4,49), pero
  empeora lo que decide la regla: peor tramo +0,36 pp frente a +2,52 pp, P5 +82 $ frente a +93 $, y un
  tercio menos de operaciones. Sigue apagado (`requirePositiveEv: false`). El smoke imprime siempre las
  dos líneas para la config viva.

#### Detalles del filtro de certeza que no son obvios (por si se vuelve a encender)

- **Una lectura AUSENTE no bloquea.** Sin ticks suficientes o con σ = 0, `readWindowCertainty` devuelve
  `undefined` y la entrada sigue su camino. Convertir una laguna del feed en política de riesgo es el
  mismo error que evita la guarda de bankroll con un saldo ilegible. Una lectura que sí sale y da poco
  es información, y ésa sí frena.
- **σ = 0 no es certeza infinita**, es un feed congelado. Dejarla pasar daría z infinito y convertiría
  una avería en la señal más fuerte posible.
- **Los ticks salen de muestrear `getTickAtOrBefore` hacia atrás**, la única lectura de historia que
  `RunnerPriceFeed` expone. Se deduplica por marca de tiempo: sin eso, un feed más lento que el paso
  del muestreo inventaría saltos de valor cero y hundiría la σ, que es el denominador de todo.

> **Un número que se confundió al construir el replay, por si vuelve a pasar.** El suelo de la ventana
> de entrada es `DEFAULT_MIN_SECONDS_TO_END` = **10 s** (`markets.ts`), no los 45 de
> `FAVORITE_EXIT_MIN_SECONDS`, que es del stop de VENTA. Con 45 por error, el barrido se dejaba fuera
> el tramo final —justo donde la ventana ya está resuelta— y medía la estrategia sin su mejor trozo.

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

> **APAGADA desde el 2026-09-11 (`favoriteExitEnabled: false`).** Las tablas de este apartado —las 152
> entradas "aguantando hasta el cierre"— se midieron sobre el universo equivocado, el mismo error que la
> tabla vieja de la certeza, y no se sostienen. Esto es lo medido con `src/favoriteExitReplay.ts`, que
> llama a `decideFavoriteExit` de producción, y contrastado con el ledger:
>
> | | salidas | vendidas que ganaban | frente a aguantar |
> |---|---|---|---|
> | ledger real, 6–10 sep | 156 | 34% | −5,50 $ (certeza +5,49 · stop −11,00) |
> | replay, entradas 80 s z ≥ 1,5, política viva | 16 | 31% | −4,01 $ |
> | replay, solo certeza ≤ 0 | 12 | 33% | −5,33 $ |
> | replay, certeza ≤ 0,5 | 36 | 67% | −32,89 $ |
> | replay, vendiendo hasta 30 s del cierre | 22 | 32% | +3,13 $ (mejora solo el 55% de los remuestreos) |
>
> **El problema no es el umbral, es de fondo.**
>
> - Cuando la certeza cae a cero, el bid ya está en ~0,20: el libro descuenta la caída a la vez que el
>   oráculo.
> - Cada falsa alarma cuesta ~3,62 $ y cada acierto ahorra ~1,82 $, así que hay que acertar el 66,5%
>   de las salidas para empatar. Acertaba el 66,0%.
> - Esas ventanas perdieron −478,65 $ vendiendo y −474,64 $ aguantando: **la salida no creaba las
>   pérdidas, las marcaba**.
> - Con entradas a ≤ 50 s ni siquiera puede dispararse: exige 10 s de permanencia y ≥ 45 s hasta el
>   cierre.
> - El segundo exacto en que el CLOB pasa a post-only sigue sin medir. Los 45 s son una decisión de
>   diseño, y la documentación de Polymarket no lo dice.
>
> El código se conserva, y la sección de salidas del smoke lo vuelve a medir en cada corrida. Lo que
> sigue es la historia de cómo se llegó hasta aquí.

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

`data/analytics.jsonl` está acotado a `maxAnalyticsSamples` (5.000 desde el 2026-09-17, antes 10.000).
Cuando se llena, **cada muestra nueva borra la más vieja** — así que a partir de ese punto esperar más
tiempo no acumula más historia, la recicla. Con ~730 muestras al día y la muestra en ~58 KB, 5.000 son
unos 290 MB y 5,8 días, y validar una estrategia fuera de muestra necesita más que eso.

> **El tope de 10.000 era imposible de mantener, y dejó el bot 7,5 horas sin operar (2026-09-17).**
> La muestra creció de ~31 KB a ~58 KB (medido: 736 MB para 12.753 muestras), así que 10.000
> proyectaban 580 MB. La poda serializaba las muestras conservadas en **una sola cadena**, y Node no
> admite cadenas de más de 512 MB: fallaba con `Invalid string length`. Como la poda es lo único que
> puede encoger el fichero, a partir de ahí el fichero solo podía crecer, y con él el proceso: 1,3 GB
> de RSS. A las 13:14 el bot dejó de escribir analítica, trades y estado.
>
> **Es el mismo punto muerto que la lectura por tramos resolvió en agosto, por el lado de la
> escritura**: no sirve de nada poder leer un fichero que no se puede reescribir. Arreglado con
> `writeLinesAtomic` (vuelca por lotes de líneas y nunca construye el fichero entero) y bajando el
> tope, que devolvió el proceso a 207 MB de RSS.
>
> **Lo que sigue sin arreglar es lo peor: nada avisó.** La API respondía, el healthcheck estaba en
> verde y los logs seguían saliendo mientras el bot no operaba ni escribía. Lo delató el ledger, al
> mirarlo a mano. Un bot que no graba una muestra en media hora debería decirlo, y hoy no lo dice.

Por eso existe `src/archiveAnalytics.ts`, que copia lo nuevo a `data/archive/analytics-archive.jsonl`,
sin tope. Tres decisiones que no son arbitrarias:

- **Lee el fichero, no la API.** Funciona con el bot parado, que es justo cuando más urge no perder lo
  que ya hay.
- **Es incremental**: solo escribe ventanas más nuevas que la última archivada. Volcar las 10.000 cada
  pasada serían 326 MB de los que el 90% ya estaría dentro.
- **Busca el corte en la cola del archivo**, no releyéndolo entero: el archivo crece sin límite por
  diseño, y releerlo completo convertiría al archivador en el problema que viene a evitar.
- **El barrido del favorito lee las DOS fuentes** (`cargarMuestras` en `src/smoke/favoritoReplay.ts`,
  deduplicando por slug y quedándose con la del fichero vivo, que es la que puede traer la resolución
  oficial corregida). Con el tope en 5.000 el vivo cubre 5,8 días, y una ventana pre-registrada puede
  ser más larga: sin el archivo, la evaluación se quedaría sin su propio principio en cuanto la poda
  hiciera su trabajo.

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

## Perps: probado y descartado (2026-09-14 → 2026-09-18)

Se evaluaron 2.284 cubos de 5 minutos de los perpetuos BTC-USD y ETH-USD de Polymarket, solo
observando, para medir el **carry de funding**: cobrar el funding quedándose del lado que lo recibe.
La regla se pre-registró antes de tener datos (mejor peor tramo, ≥ 150 operaciones, 6 tramos,
bootstrap por bloques) y **la descartó por sus dos condiciones**: la única casilla evaluable (posiciones
de 1 h) dio −27,53 $ sobre 182 operaciones, peor tramo −10,91 $ y P(+) del 0%.

**No era carry, era estar siempre corto.** El funding fue positivo casi todo el tiempo, así que
«cobrarlo» significó estar corto en el 100% de los cubos de BTC y el 93% de ETH mientras subían un
4,6% y un 4,1%. El funding cobrado aportó ~0,001 $ por operación, frente a 0,08 $ de comisiones: a
~0,0008 %/h hacen falta ~100 h solo para pagar la ida y vuelta, cargando entretanto un riesgo de precio
cien veces mayor. En días bajistas habría salido rentable por suerte, que es lo peligroso.

Dos lecciones que valen más allá de perps:

- **Un derivado guardado junto a los datos crudos mintió.** El funding se resumía sumando cada cambio
  de la tasa, y la tasa era horaria (12× de más) y una previsión que se actualiza sin parar (~400× en
  el p90). Eso fabricó una casilla con +3,61 $ y P(+) del 99% que no existía. Lo destapó un número de
  fondo —5.729 tasas distintas en 115 h, cuando se liquida cada hora—, no el resultado. Es la trampa 1
  de este documento con otro disfraz.
- **La propia regla no podía evaluar lo que importaba.** Exigir 150 operaciones hacía imposibles las
  posiciones largas, que eran la única versión que la aritmética dejaba en pie. Una regla tiene que
  comprobar antes de fijar el umbral que las duraciones que importan pueden llegar a él.

Si alguien lo retoma: Perps es **otra plataforma** (cuenta aparte que hay que fondear, sesión propia que
caduca, **bloqueado en EE. UU. y Canadá**), y su SDK (`@polymarket/client`) estaba marcado
`@experimental`. El código completo y el análisis detallado siguen en el historial de git (commit
`f18f927`, el último con todo dentro). Los datos capturados están en
`data/archive/perps-analytics-2026-09.jsonl`, fuera de git: 2.308 cubos, los 2.284 evaluados más los
que entraron hasta que se apagó la captura. Ojo si se re-puntúan: el campo `fundingRateSum` de esas
filas está inflado y no debe leerse; el funding se calcula de los ticks.

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
| `favoritoReplay.ts` | El camino del favorito sobre las ventanas ya vistas; con `--desde`, cruce con el ledger |
| `frenoRiesgo.ts` | ¿Cuánto habría protegido el cortacircuitos, y a qué precio? |
| `cerrarEnVerde.ts` | ¿Se puede cerrar cada día en verde, y qué cuesta? Día a día y frontera de objetivos |
| `filtrosEntrada.ts` | ¿Qué parte del volumen no paga su comisión? Por mercado, tramo de banda y hora |

> **La analítica ya no cabe en memoria: 1,3 GB entre el archivo y el fichero vivo, 17.812 ventanas.**
> Cargarla entera con `readAnalyticsSamples` —que devuelve el fichero completo como array— agotó la
> memoria de la máquina de desarrollo (3,8 GB) y la dejó sin responder, WSL incluido. Para eso está
> `analyticsStream.ts`: indexa cada línea sin parsear el JSON (contar `"secondsToEnd"` da
> ticks + cotizaciones) y luego entrega las ventanas **en orden cronológico, una a una**. El replay del
> favorito tiene una entrada incremental (`crearReplayFavorito`) para consumirlas así, y
> `replayFavoriteSignals` ordena y llama ahí: la decisión sigue teniendo una sola implementación.
>
> Un detalle que costó un cuelgue y no es evidente: **un trozo sacado con una expresión regular no es
> una cadena nueva**. En V8, un `exec` de más de 12 caracteres devuelve una *sliced string* que
> mantiene viva la línea original entera, así que guardar 17.812 slugs retenía 17.812 líneas de ~76 KB
> — 1,5 GB para un índice que debería ocupar dos megas. Por eso el índice copia el slug a propósito.

**Regla al usarlas:** cualquier resultado espectacular es sospechoso antes que prometedor. Un edge que no sobrevive `outOfSample.ts` es ruido de barrido.

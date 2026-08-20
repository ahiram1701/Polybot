# Manual de uso de Polybot

Guía operativa: qué hace el bot, qué mirar cada día y cómo decidir. Para el detalle interno está [ARQUITECTURA.md](ARQUITECTURA.md); para la referencia de parámetros, el [README](../README.md).

---

## 1. Qué hace Polybot

Opera los mercados **Up or Down de 5 minutos** de Polymarket sobre BTC, ETH y DOGE. Cada ventana dura 300 segundos: el mercado abre a un precio de referencia y al cerrar paga $1 por participación al lado que acertó la dirección.

Polybot tiene **dos estrategias independientes**, y conviene no confundirlas porque su riesgo es opuesto:

| | Direccional | Arbitraje |
|---|---|---|
| Qué hace | Apuesta a un lado cuando detecta movimiento | Compra **ambos** lados cuando juntos cuestan menos de $1 |
| Riesgo | Puede perder el importe entero | **Ninguno** direccional: el par paga $1 gane quien gane |
| Frecuencia | Varias al día | ~0,7 al día |
| Beneficio | Pequeño por operación | Pequeño pero seguro |

El arbitraje solo funciona si **llenan las dos patas**. Si una llena y la otra no, deja de ser arbitraje y se convierte en una apuesta direccional desnuda — el bot lo registra honestamente como tal (`arbPairComplete: false`).

---

## 2. Arrancar y parar

**Un solo botón: «Arrancar».** El bot siempre arranca en el modo seguro; **el dinero se decide en
Ajustes**, estrategia por estrategia.

Antes había dos botones, «Sim» y «Live», de cuando el modo era global. Confundían: desde que cada
estrategia tiene su propio modo, se podía pulsar «Sim» y estar moviendo dinero real igualmente, porque
`arbMode` o `makerMode` mandan por encima del arranque.

Ahora hay un solo sitio donde se decide arriesgar dinero, y la interfaz lo avisa: **si alguna estrategia
está en LIVE, el botón se pone rojo** y su descripción lo dice antes de que lo pulses. La insignia de la
cabecera muestra qué está en juego (`arb LIVE · dir SIM`).

Para detenerlo, el mismo botón cambia a «Detener». Los ajustes solo se pueden cambiar con el bot
parado.

## 3. Leer la pantalla

### Panel de P&L

Muestra dos cifras por modo:

- **Post-reset** — desde el último reset. Es la que sirve para juzgar la configuración actual.
- **Histórica** — de por vida. No se borra nunca.

Debajo, el **desglose ARB vs DIR**. Éste es *el* número que importa mientras el capital sea pequeño: dice cuál de las dos estrategias genera el dinero. Si el arbitraje aporta y el direccional resta, ya sabes dónde estás.

> El botón de reset pide confirmación porque **es irreversible**: el marcador solo puede avanzar (se reconstruye desde el log de operaciones en cada arranque). No borra operaciones, solo deja de contarlas en la vista.

### «Por qué no opera»

La lista de motivos por los que el bot decidió no entrar, con su frecuencia. Es lo primero que hay que mirar cuando el bot lleva rato quieto. Motivos habituales:

| Motivo | Significa |
|---|---|
| `Distancia insuficiente` | El precio no se movió lo bastante. Normal. |
| `EV no supera el umbral` | Había señal, pero el precio de entrada no compensaba. |
| `Sin liquidez bajo el cap` | No hay nadie vendiendo por debajo de tu tope de ask. |
| `Historia insuficiente (EV)` | El gate aún no tiene muestras de ese setup. |
| `Capital por debajo del mínimo para direccional` | La guardia de capital está bloqueando live (ver §6). |
| `Arbitraje: patas bajo el mínimo del exchange` | La oportunidad existía pero el capital no daba para que ambas órdenes superaran $5. |
| `Arbitraje evaporado entre la cotizacion y la orden` | Se recotizó justo antes de mandar y el par ya no daba margen. **Esto es el bot protegiéndote**, no un fallo. |
| `Arbitraje: el exchange rechazo la orden` | Se mandó y el CLOB no encontró contraparte. El log lleva precio, ask, profundidad y edad de la cotización. |
| `Arbitraje: no se pudo leer el capital, no opera a ciegas` | Ni lectura on-chain válida ni capital declarado. Prefiere perder la oportunidad a dimensionar a ciegas. |
| `Arbitraje: capital ya comprometido en otro mercado` | Otro arbitraje de la misma iteración ya reservó el saldo. |
| `Arbitraje detenido por patas sueltas` | Saltó el freno. **Rearma al reiniciar el bot** (ver §6). |
| `El mercado ya no acepta ordenes taker (ultimos segundos)` | Fin de ventana; no se reintenta hasta la siguiente. |

### Chips de salud

- **Feed** — estado del feed de precios de Chainlink.
- **Loop % fallos** — porcentaje de iteraciones del bucle que murieron. **Debe estar cerca de 0.** Si sube, el bot está perdiendo ventanas de entrada.
- **Capital** — saldo real leído de la cadena. Si pone **«(declarado)»** está usando el valor de respaldo, y hay **dos causas distintas**: nunca se pudo leer, o la lectura funcionó pero **caducó** (más de 5 min sin refrescar). Pasa el ratón por encima: el aviso las distingue. Si pone **«Capital desconocido»**, el arbitraje no está operando.

### Oportunidades de arbitraje

Cuántas se detectaron, cuántas eran ejecutables y **por qué se descartaron las demás**. Con menos de una oportunidad válida al día, perder una por un motivo corregible es caro. Los dos motivos:

- **Neto por set bajo el umbral** — el margen no compensa. Se ajusta con `arbMinNetPerSet`.
- **Capital insuficiente** — hacía falta más dinero para que ambas patas superasen el mínimo. La tabla dice cuánto exactamente.

---

## 4. Los autoajustes

Hay **dos**, y hacen cosas distintas:

**Autoajuste predictivo** (`aiAutoApplyLive`). Busca en una rejilla la mejor combinación de ventana de entrada y distancia por mercado, y la aplica. Corre cada 30 minutos. Es el que mueve `minDistanceUsd` y `entryWindowSeconds` cuando ves que cambian solos.

**Autoajuste de la ventana de ask** (`aiAutoTuneAskCap`). Ajusta el rango de precios [piso, techo] en el que se opera. **Solo estrecha**, y solo pasando bandas que hayan *perdido dinero con muestra suficiente* — nunca por falta de evidencia. Esa asimetría es lo que impide que se coma oportunidades buenas.

> No es un trinquete: los recortes se recalculan contra tu ventana base en cada pasada, así que si la evidencia desaparece la ventana vuelve sola. La base (`ASK_WINDOW_BASELINE_MIN/MAX`) debe ser **ancha** — es el límite exterior, no dónde operar. Si la pones estrecha, este tuner tirará hacia ella mientras el predictivo tira hacia otro lado, y se pelean.

---

## 5. Cómo saber si va bien

No mires el P&L total: mira **el desglose y la consistencia**.

1. **¿De dónde viene el dinero?** Panel de P&L → filas ARB y DIR. Con capital pequeño, lo esperable es que el arbitraje aporte y el direccional apenas mueva la aguja.
2. **¿Está operando?** Panel «Por qué no opera». Un bot que no opera no está fallando necesariamente — puede estar filtrando bien.
3. **¿Está sano?** Chip «Loop % fallos» cerca de 0.
4. **A los pocos días**, el desglose honesto por CLI:

```bash
npx tsx src/smoke/pnlAudit.ts
```

Eso reparte el resultado por mercado, lado y día, usando el mismo cálculo que la UI. Es el número con el que decidir, no la sensación.

> **Aviso sobre las expectativas.** El edge medido fuera de muestra es de **+0,5% a 2% por operación**. Es real pero fino: necesita muchas repeticiones para expresarse y es sensible al slippage. Cualquier backtest que prometa mucho más está midiendo mal — ya pasó una vez (ver [ARQUITECTURA.md](ARQUITECTURA.md#trampas-conocidas)).

---

## 6. Riesgo: las guardas y por qué existen

### La idea de fondo

> **El direccional puede perder dinero teniendo razón. El arbitraje no puede perder si las dos patas
> llenan.** De ahí sale todo lo demás: los frenos del direccional cortan rachas de pérdidas; los del
> arbitraje existen para una sola cosa, que las dos patas lleguen a llenar.

### Qué freno aplica a qué

| Freno | Direccional | Arbitraje |
|---|---|---|
| Cortacircuitos (pérdida diaria / racha) | **Sí** | **No** — a propósito, ver abajo |
| Capital mínimo (`minBankrollForDirectionalUsd`) | **Sí**, solo en live | No |
| Límite de gasto diario | Sí | Sí |
| Colateral real leído on-chain | No aplica | **Sí** |
| Reserva por iteración | No aplica | **Sí** |
| Mínimo del exchange por pata | Sí | **Sí**, y descarta la oportunidad entera |
| Freno por patas sueltas | No aplica | **Sí** |

Cada estrategia usa **su propio modo** para todo esto: su P&L, su contador de gasto diario y su freno
de pérdidas van por separado. Una racha mala en papel no puede frenar dinero real, ni unas ganancias
simuladas tapar pérdidas reales. Ver la sección 7.

### Los frenos del direccional

**Cortacircuitos** (`maxDailyLossUsd`, `maxConsecutiveLosses`). Detiene el trading —no el bot ni la analítica— cuando la pérdida del día o la racha de pérdidas cruza el límite. Se rearma solo tras `riskHaltCooldownHours`. **Con ambos valores a 0 nunca corta.**

**Guardia de capital** (`minBankrollForDirectionalUsd`, por defecto 50). Apaga el direccional **en live** mientras el capital real esté por debajo. No es prudencia, es aritmética: el mínimo de orden de Polymarket es $5, así que con poco capital cada entrada arriesga una fracción enorme y la ruina llega antes que el edge.

Simulado con el edge **real** (83% de aciertos, ROI +4,3% por operación — una estrategia **ganadora**), a un mes:

| Capital | Prob. de quedarte sin poder operar | Capital mediano |
|---|---|---|
| $10 | **67,6%** | $4,88 |
| $20 | 35,0% | — |
| $50 | 4,8% | — |
| $100 | 0,1% | $153,90 |

Con $10 se pierde dinero **teniendo razón**. El arbitraje **no pasa por esta guardia** porque no puede arruinar: es justamente con lo que se hace crecer el capital hasta cruzar el umbral.

**Límite de gasto diario** (`dailySpendLimitUsd`). Tope bruto del día, **contado por modo**: las
operaciones de papel no consumen el presupuesto del dinero real. Si se agota, el bot deja de operar
hasta el cambio de día. Debe dar para varias operaciones **más** al menos una oportunidad de arbitraje
($10-25 cada una).

### Los frenos del arbitraje

**Por qué queda fuera del cortacircuitos.** Sus dos disparadores —pérdida del día y racha— miden riesgo
*direccional*. Un par completo redime $1 por set gane quien gane, así que pararlo tras un día malo
quitaría justo la estrategia que recupera capital sin arriesgarlo. No es un olvido: está escrito así en
el código, con su motivo.

**Colateral real, leído on-chain.** En live el tamaño no supera el saldo que el bot lee de la cadena
cada minuto. Es la guarda más importante del arbitraje: mandar una orden que no se puede pagar
convierte una posición sin riesgo en una apuesta desnuda.

Si la lectura falla, se conserva la última buena — pero **solo 5 minutos**. Pasado ese plazo se usa el
`liveBankrollUsd` que hayas declarado, y por eso ese número debe estar puesto y **algo por debajo** de
tu saldo real: es el que dimensionará si el RPC se cae. Solo si **tampoco** hay declarado el bot deja de
operar (`Arbitraje: no se pudo leer el capital, no opera a ciegas`).

**Cuánto compra: el mínimo de cuatro cosas.**

```
tamaño = min( arbMaxUsdPerOpportunity ,  hueco del límite diario ,
              colateral libre (solo live) ,  profundidad del libro )
```

**De aquí sale la trampa que más cuesta:** si añades capital y **no** subes
`arbMaxUsdPerOpportunity`, no cambia nada. El presupuesto es el techo, y el dinero nuevo se queda
parado. Los dos números tienen que subir juntos.

**Cuánto capital hace falta para una oportunidad concreta:**

```
capital necesario = $5 × (precio del par) ÷ (el lado más barato)
```

Porque un set completo necesita el **mismo número** de participaciones de los dos lados, y las dos
órdenes tienen que superar el mínimo del exchange. Ejemplo real: UP a 0,96 y DOWN a 0,02 — el par
cuesta 0,98 y ganas $0,02 por set, pero para que la pata de DOWN llegue a $5 harían falta 250 sets, o
sea **$245**. Con $17,80 esa pata sale a $0,36 y la oportunidad se descarta entera.

La consecuencia es contraintuitiva: **cuanto más barato el lado perdedor, más capital hace falta.** Y
un arbitraje aparece justo cuando un lado se encarece — la situación que lo crea es la misma que lo
hace impagable.

**Reserva por iteración.** Si dos mercados dan oportunidad a la vez, el segundo solo puede usar lo que
sobra del primero. El dinero se reserva **antes** de mandar nada, porque sale en cuanto llena la
primera pata y sigue fuera aunque la segunda falle.

**Mínimo del exchange por pata.** Las dos órdenes tienen que superar el mínimo (hoy $5). Si una no
llega, se descarta la oportunidad **entera** — media pareja no es un arbitraje. Con capital pequeño esto
descarta los pares muy desequilibrados, y verás `Arbitraje: patas bajo el mínimo del exchange`.

**Freno por patas sueltas** (`arbNakedLegHaltStreak`). Es el riesgo propio del arbitraje: si la primera
pata llena y la segunda es rechazada, queda una apuesta direccional que nadie pidió. Se registra y se
notifica como tal (`arbPairComplete: false`), y este freno corta los intentos siguientes tras N patas
sueltas seguidas.

**Rearma al reiniciar el bot, no solo.** Es deliberado: si las patas se están cayendo de forma
sistemática, seguir intentándolo cuesta dinero, y quien reinicia debería mirar antes por qué pasa.

Ponlo en **1** mientras el arbitraje en live no tenga historial contra el exchange real — con capital
pequeño, dos apuestas desnudas se lo comen entero. El precio es que un único rechazo desafortunado deja
el arbitraje parado hasta el siguiente reinicio. Bajar el tamaño no es alternativa: el mínimo por pata
obliga a posiciones de ~$11 como poco.

**Ventanas de 15 minutos** (`arb15mEnabled`). Triplica las ventanas donde puede aparecer un par barato,
con liquidez comparable a la de 5m. **Solo arbitraje**: el direccional sigue en 5m. Las guardas son las
mismas, porque son globales y no por mercado.

---

## 6 bis. El maker: cobrar por dar liquidez

Es lo único que Polybot tiene ahora encendido, y funciona al revés que todo lo anterior: **no intenta
acertar la dirección**. Polymarket paga por dejar órdenes límite en reposo cerca del punto medio, **se
llenen o no**.

### Cuánto se lleva y cuánto hace falta

Medido de verdad, no estimado: **$2,7795 por 40 minutos** cotizando, o sea unos **$0,35 por ventana de
5 minutos**. Se abonan alrededor de las **00:45 UTC** de cada día.

Lo que decide dónde puede jugar Polybot es el **tamaño mínimo** que el mercado exige. Un par de dos
lados cuesta **$1 por participación** siempre —da igual que el mercado esté a 0,05 o a 0,50—, así que:

> **La entrada mínima cuesta tantos dólares como participaciones pida el mercado.**

Un mercado con `min_size 20` necesita **$20**; uno con 50, **$50**. No hay mercados más baratos: el
suelo de todo Polymarket son $20. Con menos de eso el maker no puede cotizar en ningún sitio, y lo dirá
con el motivo `capital_insuficiente_necesita_X`.

### Los ajustes

En **Ajustes → «Maker — cobrar por dar liquidez»**:

| Ajuste | Qué hace |
|---|---|
| Interruptor | Enciende y apaga el maker |
| Modo | `sim` (papel) o `live` (dinero real). **No hereda el modo de arranque**, a diferencia de las otras estrategias |
| Capital máx inmovilizado | Tope de dólares en riesgo **a la vez**: lo comprometido en órdenes MÁS lo ya gastado en llenados, en todos los mercados juntos |
| Retirar N segundos antes del cierre | Margen para no quedarte con una posición que resuelve sin darte tiempo |
| Fuente de mercados | `recompensas` busca en **todo Polymarket** lo que mejor paga y cabe en tu capital; `cripto5m` se queda en BTC/ETH/DOGE |

**Deja la fuente en `recompensas`.** Los mercados de cripto de 5 minutos son de los peores sitios para
poco capital: piden $50 de entrada en vez de $20, y su banda que puntúa es de 1,5 céntimos en vez de
4,5 —lo que significa que la misma orden cobra **cinco veces menos**—. Además resuelven cada cinco
minutos, que es donde el precio se desploma a 0 o 1 y te llena del lado malo.

El tamaño mínimo y la banda que puntúa **los lee del propio mercado**, porque Polymarket los cambia.

### Qué esperar al mirarlo

**Siempre dos órdenes por mercado, una de cada lado.** Si ves una sola, algo va mal: media cotización
no es hacer de maker, es una apuesta direccional, y así se perdieron $41 en 40 minutos el 19 de agosto.

Entre medias las órdenes se quedan quietas a propósito: el reparto premia el **tiempo** en reposo, y en
un mercado de banda ancha la orden aguanta dentro de la banda durante horas.

En el estado (y en el chip de la web) verás `makerSummary` con lo que decidió en la última pasada y
**por qué descartó cada mercado**. Los motivos habituales:

| Motivo | Significa |
|---|---|
| `capital_dedicado_a_otro_mercado` | El presupuesto se fue a un mercado que rendía más por dólar. Normal. |
| `cerca_del_cierre` | Retirada preventiva. Normal. |
| `capital_insuficiente_para_el_minimo` | 50 participaciones a este precio no caben en tu tope. **Sube el capital o espera precios más bajos.** |
| `sin_punto_medio` | El libro no tiene los dos lados; suele pasar al final, con el resultado ya decidido. |
| `sin_programa_de_recompensas` | Ese mercado no paga. No se ponen órdenes ahí. |

### El riesgo, sin adornos

**Que te llenen.** Si tu orden se ejecuta, tienes una posición direccional que resuelve en minutos. La
recompensa es el pago por asumir ese riesgo, **no un regalo**. Con $12 comprometidos, el peor caso es
perder $12.

### Cuánto se cobra de verdad

**No lo sabemos.** El número que muestra Polybot es una estimación **optimista**: calcula el reparto de
forma lineal cuando en realidad cae con el cuadrado de la distancia al centro. Sirve para decidir qué
mercado financiar, no para prever ingresos.

Lo único que lo zanja es poner una orden real y mirar el pago a las 24 horas. Empieza por **DOGE**: el
bote más pequeño, el capital más bajo y la menor competencia.

---

## 7. Pasar a live

El orden recomendado, y el motivo de cada paso:

1. **Valida en sim.** Corre días, no horas, y mira el desglose ARB/DIR con `pnlAudit`.
2. **Crece con arbitraje primero.** Es lo único sin riesgo direccional. La guardia de capital mantiene el direccional apagado hasta $50 automáticamente.
3. **Comprueba el capital real.** El chip «Capital» debe decir el saldo leído de la cadena, no «(declarado)».
4. **Arranca live explícitamente**, con `confirmLive` — o pon solo el arbitraje en live con `arbMode`,
   que es lo que tiene sentido con capital pequeño. Ojo con la diferencia: el arranque global pide
   confirmación, el ajuste por estrategia **no**.
5. **Vigila el primer día** con el cortacircuitos puesto a un valor que de verdad pueda dispararse.

### Modo por estrategia (Ajustes → «Modo por estrategia»)

`arbMode` y `directionalMode` eligen, cada uno por su cuenta, si esa estrategia opera con dinero real o
en papel. `heredado` = usa el modo con el que arrancó el bot, que es como se comportaba antes de existir
estos ajustes.

El reparto que sugieren los números de hoy es **arbitraje en `live` y direccional en `sim`**: el
arbitraje es lo único que gana, y el direccional sigue generando muestras sin costar nada.

Van de verdad por separado. Cada estrategia tiene su propio P&L (se agrupa por el modo que estampa el
motor que la ejecutó), su propio contador de gasto diario y su propio freno de pérdidas — así una racha
mala en papel no puede parar el dinero real. El arbitraje además nunca pasa por el cortacircuitos, por
la razón de siempre: un par completo redime $1/set gane quien gane.

**Lo que hay que tener claro antes de ponerlo en `live`:** aquí el ajuste basta por sí solo, no hay
confirmación al arrancar. Eso es deliberado —permite que el watchdog reinicie sin intervención—, pero
significa que **cualquier reinicio reanuda esa estrategia con dinero real** sin que nadie lo apruebe. Lo
único que sigue siendo obligatorio es la clave privada en `.env`: sin ella el arranque falla en el acto,
en vez de fallar oportunidad a oportunidad.

En la cabecera (web y TUI) las dos estrategias aparecen por separado en cuanto sus modos difieren
(`arb LIVE · dir SIM`). Una sola insignia diría «SIM» con el arbitraje moviendo dinero real.

---

## 8. Problemas comunes

**El bot no opera nada.** Mira «Por qué no opera». Si domina `Distancia insuficiente`, el mercado está plano — normal. Si domina `Capital por debajo del mínimo`, es la guardia (§6). Si domina `Sin liquidez bajo el cap`, tu ventana de ask puede estar mal puesta.

**«Loop % fallos» alto.** El bot está perdiendo ventanas. Casi nunca es la red aunque el log diga «timeout»: revisa primero si algo está bloqueando el bucle (ver [ARQUITECTURA.md](ARQUITECTURA.md#el-bucle-es-de-un-solo-hilo)).

**El capital sale «(declarado)» y no el real.** O nunca se pudo leer la cadena, o la última lectura **caducó** (más de 5 min). El aviso del chip distingue las dos. Comprueba `POLYGON_RPC_URL`; algunos RPC públicos empezaron a exigir registro y devuelven `401`.

**El saldo sale 0 teniendo fondos.** El colateral de Polymarket es **pUSD**, no USDC. Ver [ARQUITECTURA.md](ARQUITECTURA.md#trampas-conocidas).

**Cambié un ajuste y no pasó nada.** ¿Estaba el bot parado al guardarlo? Con el bot corriendo, la API responde `409` y el cambio no se aplica.

**El arbitraje detecta oportunidades pero nunca entra.** Mira la columna «capital necesario» del panel: cada pata es una orden independiente y ambas deben superar los $5 del exchange. Con precios equilibrados eso exige bastante más capital del que sugiere el neto por set.

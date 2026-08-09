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

**Arrancar:** doble clic en `INICIAR-POLYBOT.cmd`. Abre el navegador en `http://127.0.0.1:8787` y, si `autoStartSimOnBoot` está activo, arranca solo en simulación.

**Parar el bot** (sin cerrar la interfaz): botón de stop en la UI. Necesario antes de cambiar cualquier ajuste — la API responde `409` si el bot corre.

**Modos:**
- **`sim`** — dinero de mentira, mismo código, mismos precios reales. Es donde se valida todo.
- **`live`** — dinero real. Requiere `confirmLive` y llaves en `.env`. **Nunca se arranca solo.**

> Sim usa el mismo tamaño de orden que live (`autoMinLive`) a propósito: si sim operase con importes distintos, dejaría de predecir lo que hará live.

---

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

### Chips de salud

- **Feed** — estado del feed de precios de Chainlink.
- **Loop % fallos** — porcentaje de iteraciones del bucle que murieron. **Debe estar cerca de 0.** Si sube, el bot está perdiendo ventanas de entrada.
- **Capital** — saldo real leído de la cadena. Si pone «(declarado)», es que no se pudo leer y está usando el valor de respaldo.

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

**Límite de gasto diario** (`dailySpendLimitUsd`). Tope bruto del día. Si se agota, el bot deja de operar hasta el cambio de día. Debe dar para varias operaciones **más** al menos una oportunidad de arbitraje ($10-25 cada una).

---

## 7. Pasar a live

El orden recomendado, y el motivo de cada paso:

1. **Valida en sim.** Corre días, no horas, y mira el desglose ARB/DIR con `pnlAudit`.
2. **Crece con arbitraje primero.** Es lo único sin riesgo direccional. La guardia de capital mantiene el direccional apagado hasta $50 automáticamente.
3. **Comprueba el capital real.** El chip «Capital» debe decir el saldo leído de la cadena, no «(declarado)».
4. **Arranca live explícitamente**, con `confirmLive`. Nunca ocurre solo.
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

**El capital sale «(declarado)» y no el real.** No se pudo leer la cadena. Comprueba `POLYGON_RPC_URL`; algunos RPC públicos empezaron a exigir registro y devuelven `401`.

**El saldo sale 0 teniendo fondos.** El colateral de Polymarket es **pUSD**, no USDC. Ver [ARQUITECTURA.md](ARQUITECTURA.md#trampas-conocidas).

**Cambié un ajuste y no pasó nada.** ¿Estaba el bot parado al guardarlo? Con el bot corriendo, la API responde `409` y el cambio no se aplica.

**El arbitraje detecta oportunidades pero nunca entra.** Mira la columna «capital necesario» del panel: cada pata es una orden independiente y ambas deben superar los $5 del exchange. Con precios equilibrados eso exige bastante más capital del que sugiere el neto por set.

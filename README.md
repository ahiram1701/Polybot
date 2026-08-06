# Polybot Crypto 5m

Bot TypeScript para mercados `BTC/ETH/DOGE Up or Down 5m` de Polymarket, con modo simulacion, modo live protegido e interfaz web local.

- **[Manual de uso](docs/MANUAL.md)** — como operarlo: que mirar, como decidir, problemas comunes.
- **[Arquitectura](docs/ARQUITECTURA.md)** — como funciona por dentro, invariantes y trampas conocidas.
- **[Uso por agentes IA](AGENTS.md)** — MCP, CLI y API.
- Este README es la **referencia de parametros** e instalacion.

## Requisitos

- Node.js 20 o superior.
- Conexion a internet para Gamma API, CLOB API y RTDS Chainlink de Polymarket.
- Wallet y permisos de Polymarket solo si vas a usar live.

## Instalacion

```bash
npm install
Copy-Item .env.example .env
```

Edita `.env` si quieres cambiar montos, limites o credenciales. El modo por defecto es simulacion.

## Uso Rapido Con Interfaz

La forma mas facil en Windows es doble clic:

```text
INICIAR-POLYBOT.cmd
```

Ese lanzador:

- Crea `.env` si todavia no existe.
- Instala dependencias si falta `node_modules`.
- Abre `http://127.0.0.1:8787` en el navegador.
- Inicia la UI y arranca simulacion automaticamente.
- Reinicia una instancia vieja si ya estaba abierta, para cargar cambios en `.env`.

Si quieres abrir la UI sin iniciar simulacion automaticamente:

```text
ABRIR-POLYBOT.cmd
```

Usa `ABRIR-POLYBOT.cmd` despues de editar `.env` para que la UI recargue credenciales live.

Tambien puedes usar terminal:

```bash
npm run ui
```

Abre `http://127.0.0.1:8787`.

En la UI puedes:

- Ver mercados BTC, ETH y DOGE 5m, countdown, precio Chainlink, apertura y distancia.
- Iniciar/detener simulacion con el boton `Sim`.
- Resetear estado local con el boton `Reset` cuando el bot esta detenido.
- Revisar trades, logs y parametros, incluyendo distancia y ventana de entrada por mercado.
- Ver analisis EV por estrategias y pedir lectura a Ollama Cloud.
- Guardar settings no secretos cuando el bot esta detenido.
- Ver si live esta listo sin exponer private keys.
- Ver en `Trades` si una posicion live con fill detectado termino `Gano` o `Perdio`.

La UI escucha solo en `127.0.0.1:8787`.

Para verla desde el celular por Tailscale con Polybot en tu PC Windows: doble clic en `INICIAR-POLYBOT.cmd` (con `POLYBOT_UI_HOST=0.0.0.0` en `.env`) y en el celular, con Tailscale activo, abre la direccion `http://100.x:8787` que muestra la ventana. Guia: [`docs/windows-tailscale.md`](docs/windows-tailscale.md).

## TUI (panel en terminal)

Si prefieres un panel en vivo dentro de una ventana de terminal (sin navegador), doble clic en:

```text
TUI-POLYBOT.cmd
```

Levanta el servidor en segundo plano si no estaba corriendo (sin arrancar el bot; si ya corre, **no lo
toca**) y abre la TUI conectada a `http://127.0.0.1:8787`. Cerrarla (`q` / Ctrl+C) **no** apaga el
servidor.

Pestañas: **Dashboard** (estado, P&L post-reset por modo, win rate, circuit breaker, señal por mercado
y "por qué no opera"), **Trades**, **Análisis** (EV por estrategia) y **Settings** (editable con el bot
detenido). Teclas:

- `←/→` o `Tab` o `1‑4` cambian de pestaña · `g` refresca · `q` sale.
- Dashboard: `I` inicia **sim** · `S` detiene · `B` re-arma el circuit breaker · `P` resetea P&L · `X`
  resetea estado.
- `L` inicia **live**: pide teclear la frase exacta `ARRANCAR LIVE` (mismo candado que la web). **La
  TUI nunca arranca live sola** — lo haces tú tecleando la frase.
- Settings: `↑/↓` mueve, `Enter` alterna un toggle o edita un número.

Para un vistazo puntual sin abrir la interfaz interactiva:

```bash
npm run tui -- --once
```

## Watchdog En Windows

Si el proceso de Polybot muere (falta de memoria, reinicio de Windows, cierre accidental), la UI deja de responder y el bot deja de observar el mercado hasta que alguien lo levante. `scripts/watchdog.ps1` lo revisa cada 5 minutos y lo relanza solo. Revive unicamente la UI/API: el bot queda detenido y Live siempre lo arrancas tu.

Verificar si ya esta registrado:

```powershell
Get-ScheduledTaskInfo -TaskName "PolybotWatchdog"
```

`LastTaskResult: 0` y un `NextRunTime` ~5 minutos adelante = funcionando. Si no existe la tarea, registrala con `powershell -ExecutionPolicy Bypass -File scripts\install-watchdog.ps1` (sin admin). Corre sin abrir ninguna ventana, y se puede apagar y encender desde **Settings -> "Watchdog (auto-reinicio)"** en la UI web o la TUI, sin desregistrar la tarea. La prueba end-to-end y la solucion de problemas estan en [`docs/windows-watchdog.md`](docs/windows-watchdog.md).

## Linux VPS 24/7 Con Tailscale

En un VPS nuevo, primero crea un usuario de despliegue y trabaja desde ahi. No corras Polybot como `root`:

```bash
sudo apt update
sudo apt install -y curl git ufw rsync
sudo adduser polybot
sudo usermod -aG sudo polybot
su - polybot
```

Luego copia o clona el proyecto en `/home/polybot/Polybot`, entra al directorio y prepara la app:

```bash
cd ~/Polybot
npm ci
cp .env.example .env
npm run build
npm run ui:build
npm run service:install
```

Si ya copiaste el proyecto dentro de `/root`, muevelo primero:

```bash
sudo mkdir -p /home/polybot/Polybot
sudo rsync -a --exclude node_modules /root/Polybot/Polybot/ /home/polybot/Polybot/
sudo chown -R polybot:polybot /home/polybot/Polybot
su - polybot
cd ~/Polybot
```

Si ves `Run this script as the deploy user, not as root`, el build estuvo bien, pero el servicio no se instalo. Sal de `root`, entra con el usuario `polybot` y repite `npm run service:install`.

El servicio levanta solo la UI. Live queda apagado hasta que lo inicies manualmente desde la interfaz, incluso despues de reiniciar el VPS.

Para usarlo desde iPhone, instala Tailscale en el VPS y en el iPhone, deja `POLYBOT_UI_HOST=0.0.0.0`, configura `POLYBOT_PUBLIC_URL` con la URL o IP Tailscale, y bloquea el puerto `8787` para internet publico con firewall. Guia completa: [`docs/linux-vps-tailscale.md`](docs/linux-vps-tailscale.md).

## Uso Por Agentes IA

Polybot se puede operar desde un agente IA por tres vias sobre el mismo plano de control (la API HTTP local, con el servidor corriendo):

- **MCP**: `npm run mcp` expone herramientas `polybot_*` (estado, trades, analisis, recomendaciones, start/stop, settings, etc.) por stdio.
- **CLI con salida JSON**: `npm run cli -- status`, `npm run cli -- analysis recommend`, `npm run cli -- start --mode sim`, `npm run cli -- help`.
- **HTTP directo**: spec en [`docs/openapi.yaml`](docs/openapi.yaml).

Guia completa para agentes (seguridad, flujo recomendado, config MCP, tabla de endpoints): [`AGENTS.md`](AGENTS.md). `mode: "live"` mueve dinero real y requiere `confirmLive`; con `POLYBOT_MCP_ALLOW_WRITE=false` el MCP queda en solo lectura.

## Uso Por CLI

Simulacion continua:

```bash
npm run bot -- --mode sim
```

Simulacion de una sola iteracion:

```bash
npm run bot -- --mode sim --once
```

Live:

```bash
npm run bot -- --mode live --confirm-live
```

Live exige `--confirm-live` y credenciales completas en `.env`.

UI con simulacion autoarrancada desde terminal:

```bash
npm run ui:sim
```

## Configuracion Live

Completa estos valores en `.env` solo para trading real:

```env
POLYGON_RPC_URL=https://polygon-rpc.com
POLYMARKET_PRIVATE_KEY=0x...
POLYMARKET_SIGNATURE_TYPE=0
POLYMARKET_FUNDER_ADDRESS=0x...
```

`POLYGON_RPC_URL` puede ser un endpoint propio si prefieres no depender del RPC publico. La UI no permite editar ni leer private keys. Solo detecta si existen.

## Parametros Principales

- `ENABLED_MARKETS=BTC`: mercados activos por defecto para CLI/UI nueva. Usa `BTC,ETH,DOGE` para activar los tres desde `.env`.
- `ENABLED_BTC_UP=`, `ENABLED_BTC_DOWN=` y equivalentes `ETH`/`DOGE`: overrides opcionales para activar/desactivar cada mercado/lado. Si quedan vacios usan `ENABLED_MARKETS`.
- `MIN_BTC_DISTANCE_USD=20`: distancia minima BTC entre precio actual y precio inicial.
- `MIN_ETH_DISTANCE_USD=5`: distancia minima ETH entre precio actual y precio inicial.
- `MIN_DOGE_DISTANCE_USD=0.0005`: distancia minima DOGE entre precio actual y precio inicial.
- `MIN_BTC_UP_DISTANCE_USD=`, `MIN_BTC_DOWN_DISTANCE_USD=` y equivalentes `ETH`/`DOGE`: overrides opcionales de distancia por mercado y lado. Si quedan vacios usan la distancia del mercado.
- `ENTRY_WINDOW_SECONDS=20`: ventana de entrada global usada como fallback.
- `ENTRY_WINDOW_SECONDS_BTC=`, `ENTRY_WINDOW_SECONDS_ETH=`, `ENTRY_WINDOW_SECONDS_DOGE=`: overrides opcionales de ventana por mercado. Dejalas vacias para usar `ENTRY_WINDOW_SECONDS`.
- `ENTRY_WINDOW_SECONDS_BTC_UP=`, `ENTRY_WINDOW_SECONDS_BTC_DOWN=` y equivalentes `ETH`/`DOGE`: overrides opcionales de ventana por mercado y lado.
- `SIM_TRADE_AMOUNT_USD=1`: monto usado en simulacion.
- `SIM_TRADE_AMOUNT_USD_BTC_UP=`, `SIM_TRADE_AMOUNT_USD_BTC_DOWN=` y equivalentes `ETH`/`DOGE`: overrides opcionales de monto sim por mercado y lado.
- `LIVE_TRADE_AMOUNT_USD=1`: monto deseado en live.
- `LIVE_TRADE_AMOUNT_USD_BTC_UP=`, `LIVE_TRADE_AMOUNT_USD_BTC_DOWN=` y equivalentes `ETH`/`DOGE`: overrides opcionales de monto live por mercado y lado.
- `AUTO_MIN_LIVE=true`: en live eleva el monto al minimo del mercado si hace falta.
- `MAX_ASK_PRICE=0.98`: no compra si el mejor ask supera este cap.
- `MAX_ASK_PRICE_BTC_UP=`, `MAX_ASK_PRICE_BTC_DOWN=` y equivalentes `ETH`/`DOGE`: overrides opcionales de ask cap por mercado y lado.
- `DAILY_SPEND_LIMIT_USD=50`: freno diario de gasto bruto aproximado.
- `TICK_STALE_MS=10000`: descarta ticks Chainlink viejos.
- `POLL_INTERVAL_MS=1000`: frecuencia del loop del bot.
- `OLLAMA_API_KEY=`: token opcional para pedir analisis bajo demanda a Ollama Cloud.
- `OLLAMA_HOST=https://ollama.com`: host de Ollama Cloud.
- `OLLAMA_MODEL=gpt-oss:120b`: modelo usado por el analisis bajo demanda.
- `POLYGON_RPC_URL=https://polygon.drpc.org`: RPC de Polygon. Lo usan el cliente live y la lectura del saldo de colateral.
  **Ojo:** `polygon-rpc.com` (el valor histórico) empezó a devolver `401`; con él la lectura de saldo falla siempre.
  Medido: `polygon.drpc.org` 6/6 a 122ms, `polygon-bor-rpc.publicnode.com` 6/6 a 134ms, `1rpc.io/matic` 6/6 a 390ms.
- `POLYBOT_UI_HOST=127.0.0.1`: host de la UI. En VPS con Tailscale usa `0.0.0.0` y firewall.
- `POLYBOT_UI_PORT=8787`: puerto de la UI.
- `POLYBOT_PUBLIC_URL=`: URL Tailscale que se muestra en logs y avisos Telegram.
- `TELEGRAM_BOT_TOKEN=` y `TELEGRAM_CHAT_ID=`: opcionales; activan avisos de UI lista, errores y arranques/detenciones.

### Banda de precios (ask)

La comision taker es `shares x 7% x p x (1-p)`: **maxima en 0.50** y casi nula en los extremos. Operar cerca de 0.50 paga 3.5% del importe por operacion; a 0.95, 0.35%. Ver [ARQUITECTURA.md](docs/ARQUITECTURA.md#trampas-conocidas).

- `MIN_ASK_PRICE=0.01`: piso de ask. Por debajo, la entrada es una apuesta de reversion barata.
- `MIN_ASK_PRICE_BTC_UP=`, `..._BTC_DOWN=` y equivalentes `ETH`/`DOGE`: overrides por mercado y lado.
- `MAX_ASK_PRICE_CEILING=0.85`: techo duro. Ningun autoajuste puede subir el cap por encima.
- `MAX_ASK_PRICE_ETH_UP=`, `..._DOGE_DOWN=`, etc.: overrides de cap por mercado y lado (ademas de los `BTC` ya listados).
- `ASK_WINDOW_BASELINE_MIN=0.01`, `ASK_WINDOW_BASELINE_MAX=0.7`: **ventana BASE** del autoajuste de ask. No es donde operar: es el limite exterior que ese tuner nunca puede rebasar. **Debe ser ancha** — solo estrecha desde aqui, y unicamente pasando bandas que hayan perdido dinero con muestra. Si falta, ese autoajuste no hace nada.
- `LIVE_MAX_SLIPPAGE=0.02`: cuanto puede pagar de mas una orden live sobre el mejor ask observado.

### Gate de valor esperado

- `REQUIRE_POSITIVE_EV=true`: no opera setups con EV negativo tras comisiones.
- `EV_MIN_EXPECTED_ROI=0.01`: ROI minimo exigido por operacion.
- `EV_SAFETY_MARGIN=0.03`: margen que la probabilidad estimada debe superar al break-even.
- `EV_MIN_HISTORY_TRADES=15`: operaciones historicas minimas antes de fiarse de un setup.
- `EV_USE_SIMILARITY=true`: estima la probabilidad por k-NN de setups parecidos en vez de por conteo exacto.
- `EV_CALIBRATION=false`: mapa empirico de calibracion. Medido fuera de muestra: **cuesta neto**.
- `MIN_FILL_RATIO=0.5`: fraccion minima del importe que el libro debe poder llenar.
- `MIN_DISTANCE_FLOOR_BTC=20`, `MIN_DISTANCE_FLOOR_ETH=0.1`, `MIN_DISTANCE_FLOOR_DOGE=0.00003`: suelo por mercado que ningun autoajuste puede bajar. Pensarlos en **bps**, no en USD: `bps = (usd / precio) x 10000`.

### Riesgo

- `MAX_DAILY_LOSS_USD=0`: perdida diaria que detiene el trading. **0 = desactivado.**
- `MAX_CONSECUTIVE_LOSSES=0`: racha de perdidas que lo detiene. **0 = desactivado.**
- `RISK_HALT_COOLDOWN_HOURS=2`: horas que dura el freno antes de rearmarse solo.
- `LIVE_BANKROLL_USD=0`: capital declarado a mano. **Solo se usa si falla la lectura on-chain**, que es lo que manda.
- `MIN_BANKROLL_FOR_DIRECTIONAL_USD=50`: por debajo de este capital, el direccional se apaga en live. El arbitraje no pasa por esta guardia. Ver el [MANUAL](docs/MANUAL.md#6-riesgo-las-guardas-y-por-qué-existen) para la aritmetica.

### Arbitraje de set completo

- `ARB_ENABLED=false`: compra ambos lados cuando el par cuesta menos de $1 tras comisiones. Sin riesgo direccional.
- `ARB_MAX_USD_PER_OPPORTUNITY=25`: tope por oportunidad.
- `ARB_MIN_NET_PER_SET=0.02`: beneficio neto minimo por set.

> Cada pata es una orden independiente y **ambas** deben superar el minimo del exchange ($5). Con precios equilibrados eso exige bastante mas capital del que sugiere el neto por set.

### Autoajustes

- `AI_AUTO_APPLY_LIVE=`: autoajuste predictivo (ventana y distancia por mercado). Corre cada 30 min.
- `AI_AUTO_TUNE_ASK_CAP=false`: autoajuste de la ventana de ask. Solo estrecha, y solo sobre bandas que perdieron dinero con muestra.

### Otros

- `MAX_ANALYTICS_SAMPLES=20000`: muestras que se conservan en `data/analytics.jsonl`.
- `OPENING_CAPTURE_GRACE_MS=15000`: tolerancia para aceptar el tick de apertura de una ventana.
- `POLYBOT_TIMEZONE=auto`: zona horaria del dia contable (gasto diario, cortacircuitos, fiscal).
- `DATA_DIR=data`: carpeta de estado y logs.
- `GAMMA_HOST=`, `CLOB_HOST=`, `RTDS_URL=`: endpoints de Polymarket. Cambiarlos solo para pruebas.
- Overrides por mercado y lado que existen para `ETH`/`DOGE` ademas de los `BTC` listados arriba: `ENABLED_*_UP/DOWN`, `MIN_*_UP/DOWN_DISTANCE_USD`, `ENTRY_WINDOW_SECONDS_*_UP/DOWN`, `SIM_TRADE_AMOUNT_USD_*_UP/DOWN`, `LIVE_TRADE_AMOUNT_USD_*_UP/DOWN`.

Los cambios hechos desde la UI se guardan en `data/ui-config.json` y se aplican al proximo arranque del bot.

## Smoke Test

Valida lectura real sin mandar ordenes:

```bash
npm run smoke:market
```

Esto descubre el mercado BTC actual, lee orderbooks de `UP/DOWN` y espera un tick Chainlink BTC/USD.

## Tests Y Build

```bash
npm run typecheck
npm test
npm run build
npm run ui:build
```

## Persistencia

El bot escribe:

- `data/state.json`: estado, aperturas y trades por mercado.
- `data/trades.jsonl`: auditoria append-only de trades y resoluciones.
- `data/analytics.jsonl`: muestras resueltas para analisis EV de estrategias.
- `data/ui-config.json`: settings no secretos guardados desde la UI.

`data/` esta ignorado por Git.

## Resultados De Trades

Polybot marca `Gano` o `Perdio` cuando ya paso el cierre del mercado y hay un tick Chainlink posterior al cierre.

- En simulacion, resuelve todos los trades simulados.
- En live, solo resuelve si detecta fill real.
- Primero usa la respuesta de la orden (`matched`, montos llenados, `tradeIDs` o `transactionsHashes`) como estimado rapido.
- Despues intenta reconciliar contra los trades autenticados del CLOB usando `tradeIDs` o `taker_order_id`.
- Cuando la reconciliacion CLOB existe, el P&L usa shares reales, costo real, precio promedio y fee taker estimada desde `fee_rate_bps`.
- Si una orden live FAK no llena nada, la tabla muestra `Sin fill` y no la cuenta como exposicion de P&L.
- El resultado se calcula contra el precio Chainlink de cierre usando la misma regla local del bot: `UP` si el precio final es mayor o igual que la apertura, `DOWN` si esta debajo.
- En la tabla, `Gano CLOB` / `Perdio CLOB` significa P&L reconciliado; `Gano est.` / `Perdio est.` significa que todavia usa la respuesta rapida de la orden.

Para que aparezca el resultado, deja la UI/bot corriendo hasta unos segundos despues del cierre de la ventana.

## FAK Vs FOK

El bot mantiene `FAK` por defecto. En una entrada tan tarde, FAK permite llenar parcialmente lo disponible y cancelar el resto, sin dejar ordenes vivas. `FOK` exigiria llenar todo o nada; simplifica la contabilidad, pero probablemente pierda mas entradas por falta de liquidez exacta. La reconciliacion CLOB hace que FAK sea la opcion mas practica para esta version.

## Reset

El boton `Reset` de la UI borra:

- `data/state.json`
- `data/trades.jsonl`
- aperturas, trades, resoluciones y gasto diario guardado

No borra:

- `.env`
- credenciales
- settings de la UI en `data/ui-config.json`

Si el bot esta corriendo, `Reset` primero lo detiene y despues limpia el estado local.

## Analisis

La pestana `Analisis` calcula EV historico de estrategias usando las muestras compactas de `data/analytics.jsonl`. Mientras el bot corre, Polybot guarda ticks Chainlink, quotes UP/DOWN y resultado final de los ultimos 60 segundos de cada ventana. Con esas muestras cruza mercado, lado, ventana `5..60s`, distancia minima y ask cap para estimar `EV = promedio(gano ? 1 / ask - 1 : -1)`.

La tabla muestra ranking por EV, trades simulables, win rate, cobertura de quotes y drawdown. Tambien conserva las estrategias actuales por mercado/lado como referencia.

Polybot tiene **un único autoajuste**: el **predictivo en tiempo real** (motor de recomendaciones), que se
enciende/apaga con el switch **"Autoajuste predictivo"** en `Settings`. Con él activo, un modelo estadistico local
(backtesting walk-forward + estimacion k-NN, sin LLM ni internet) evalua las muestras de Analisis cada ~60s mientras
el bot corre y **aplica automaticamente la mejor ventana y distancia** por mercado/lado cuando hay alta confianza y
dentro de las guardas.

Usa **un solo juego de umbrales para sim y live** y **sin cooldown**, de modo que **corre identico en ambos modos**:
una corrida en sim predice fielmente lo que hara en live. El autoajuste usa solo estrategias con EV positivo (ROI
fuera de muestra > 0) y confianza suficiente; si no hay datos confiables, no cambia la configuracion.

En `Settings > Avanzado` tambien existe `Autoajuste predictivo en tiempo real` (`aiAutoApplyLive`). Es un modelo estadistico local (backtesting walk-forward + estimacion de probabilidad por k-NN; no usa LLM ni internet), no un modelo de lenguaje. Cuando esta activo y el bot corre, Polybot evalua periodicamente las muestras de `Analisis` con ese motor predictivo y, solo cuando hay alta confianza dentro de las guardas, aplica automaticamente la mejor ventana y distancia por mercado al bot en ejecucion (sim o live) sin reiniciar. Respeta un cooldown interno de 30 min entre cambios y registra cada ajuste en los logs. Actívalo antes de iniciar el bot. La pestana expone tambien `GET /api/analysis/recommendations` para inspeccionar las recomendaciones sin aplicarlas. No confundir con el analisis de Ollama Cloud (abajo), que si es un LLM y solo da texto sin tocar la configuracion.

Si configuras `OLLAMA_API_KEY`, puedes enviar un prompt manual a Ollama Cloud desde la misma pestana. Polybot adjunta solo contexto agregado: P&L, trades recientes resumidos, estrategias actuales y top estrategias EV. No envia credenciales, `.env` ni respuestas crudas de ordenes.

## Regla De Entrada

- Mercados: `btc-updown-5m-{epoch}`, `eth-updown-5m-{epoch}` y `doge-updown-5m-{epoch}`.
- Precio inicial: primer tick Chainlink del simbolo (`btc/usd`, `eth/usd` o `doge/usd`) capturado al inicio de la ventana.
- Compra `UP` si `precioActual - precioInicial` supera la distancia configurada para ese mercado/lado.
- Compra `DOWN` si `precioInicial - precioActual` supera la distancia configurada para ese mercado/lado.
- Solo compra dentro de la ventana configurada para ese mercado/lado: `0 < segundosParaCierre <= ventanaDelMercadoLado`.
- Salta si el tick esta stale, no hay liquidez, `bestAsk` supera el ask cap del mercado/lado, el mercado no acepta ordenes, ya se intento ese mercado o se alcanzo el limite diario.

## Problemas Comunes

- `Live bloqueado`: faltan credenciales en `.env` o falta confirmacion live.
- `Sin apertura`: el bot arranco tarde y no capturo el tick inicial Chainlink; saltara esa ventana.
- `Tick stale`: no estan llegando ticks recientes de RTDS.
- `Puerto ocupado`: detiene el proceso que usa `8787` o arranca con `POLYBOT_UI_PORT=8788`.

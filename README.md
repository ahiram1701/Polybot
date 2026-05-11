# Polybot Crypto 5m

Bot TypeScript para mercados `BTC/ETH/DOGE Up or Down 5m` de Polymarket, con modo simulacion, modo live protegido e interfaz web local.

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
- Ver recomendaciones de IA local para distancia y ventana por mercado.
- Guardar settings no secretos cuando el bot esta detenido.
- Ver si live esta listo sin exponer private keys.
- Ver en `Trades` si una posicion live con fill detectado termino `Gano` o `Perdio`.

La UI escucha solo en `127.0.0.1:8787`.

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
- `MIN_BTC_DISTANCE_USD=20`: distancia minima BTC entre precio actual y precio inicial.
- `MIN_ETH_DISTANCE_USD=5`: distancia minima ETH entre precio actual y precio inicial.
- `MIN_DOGE_DISTANCE_USD=0.0005`: distancia minima DOGE entre precio actual y precio inicial.
- `ENTRY_WINDOW_SECONDS=20`: ventana de entrada global usada como fallback.
- `ENTRY_WINDOW_SECONDS_BTC=`, `ENTRY_WINDOW_SECONDS_ETH=`, `ENTRY_WINDOW_SECONDS_DOGE=`: overrides opcionales de ventana por mercado. Dejalas vacias para usar `ENTRY_WINDOW_SECONDS`.
- `SIM_TRADE_AMOUNT_USD=1`: monto usado en simulacion.
- `LIVE_TRADE_AMOUNT_USD=1`: monto deseado en live.
- `AUTO_MIN_LIVE=true`: en live eleva el monto al minimo del mercado si hace falta.
- `MAX_ASK_PRICE=0.98`: no compra si el mejor ask supera este cap.
- `DAILY_SPEND_LIMIT_USD=50`: freno diario de gasto bruto aproximado.
- `TICK_STALE_MS=10000`: descarta ticks Chainlink viejos.
- `POLL_INTERVAL_MS=1000`: frecuencia del loop del bot.
- `POLYGON_RPC_URL=https://polygon-rpc.com`: RPC usado por el cliente live para firmar/crear credenciales Polymarket.
- `POLYBOT_UI_HOST=127.0.0.1`: host de la UI. En VPS con Tailscale usa `0.0.0.0` y firewall.
- `POLYBOT_UI_PORT=8787`: puerto de la UI.
- `POLYBOT_PUBLIC_URL=`: URL Tailscale que se muestra en logs y avisos Telegram.
- `TELEGRAM_BOT_TOKEN=` y `TELEGRAM_CHAT_ID=`: opcionales; activan avisos de UI lista, errores, arranques/detenciones y autoajustes.

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
- `data/analytics.jsonl`: muestras resueltas para recomendaciones locales de IA.
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

## IA Local

La pestana `IA` usa un optimizador predictivo local, sin API externa. Mientras el bot corre, Polybot guarda muestras compactas por mercado durante los ultimos 60 segundos de cada ventana: ticks Chainlink, quotes UP/DOWN y resultado final. Con esas muestras evalua ventanas `5..60s` en pasos de 1 segundo y distancias precisas por mercado.

La recomendacion se puntua con validacion temporal walk-forward: cada prediccion usa solo ventanas anteriores, no el futuro de la misma muestra. Las metricas incluyen edge esperado, ROI walk-forward, limite inferior conservador, riesgo de sobreajuste, probabilidad de acierto estimada y error de calibracion.

El autoajuste live solo se permite con alta confianza: al menos 40 ventanas resueltas, 20 trades simulables, cobertura de quotes >= 80%, mejora ajustada >= 3 puntos porcentuales, edge esperado positivo, ROI walk-forward positivo, cooldown de 30 minutos, cambio de ventana <= 5s y cambio de distancia <= 15%. No autoaplica dentro de los ultimos 65 segundos de una ventana activa. El autoajuste solo toca distancia y ventana; no cambia montos, ask cap ni limites.

## Regla De Entrada

- Mercados: `btc-updown-5m-{epoch}`, `eth-updown-5m-{epoch}` y `doge-updown-5m-{epoch}`.
- Precio inicial: primer tick Chainlink del simbolo (`btc/usd`, `eth/usd` o `doge/usd`) capturado al inicio de la ventana.
- Compra `UP` si `precioActual - precioInicial` supera la distancia configurada para ese mercado.
- Compra `DOWN` si `precioInicial - precioActual` supera la distancia configurada para ese mercado.
- Solo compra dentro de la ventana configurada para ese mercado: `0 < segundosParaCierre <= ventanaDelMercado`.
- Salta si el tick esta stale, no hay liquidez, `bestAsk > MAX_ASK_PRICE`, el mercado no acepta ordenes, ya se intento ese mercado o se alcanzo el limite diario.

## Problemas Comunes

- `Live bloqueado`: faltan credenciales en `.env` o falta confirmacion live.
- `Sin apertura`: el bot arranco tarde y no capturo el tick inicial Chainlink; saltara esa ventana.
- `Tick stale`: no estan llegando ticks recientes de RTDS.
- `Puerto ocupado`: detiene el proceso que usa `8787` o arranca con `POLYBOT_UI_PORT=8788`.

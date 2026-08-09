# Polybot Crypto 5m

Bot TypeScript para mercados `BTC/ETH/DOGE Up or Down 5m` de Polymarket, con modo simulacion, modo live protegido e interfaz web local.

- **[Manual de uso](docs/MANUAL.md)** — como operarlo: que mirar, como decidir, problemas comunes.
- **[Arquitectura](docs/ARQUITECTURA.md)** — como funciona por dentro, invariantes y trampas conocidas.
- **[Uso por agentes IA](AGENTS.md)** — MCP, CLI y API.
- Este README es **instalacion y arranque**. La referencia de cada ajuste vive en la propia interfaz y en el Manual.

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

## Parametros

**La referencia vive en un solo sitio, no aqui.** Este README tuvo durante meses una tercera copia de
la lista de parametros, y fue exactamente donde se pudrio: llego a describir la regla de resolucion
vieja y a contradecirse a si mismo sobre los autoajustes en diez lineas. Una copia menos es una copia
que no puede mentir.

- **Que hace cada ajuste y como decidir su valor:** cada campo de `Settings` tiene su explicacion en
  la propia interfaz (web y TUI), y el [Manual](docs/MANUAL.md) explica los que gobiernan riesgo.
- **Los limites de riesgo, por estrategia:** [Manual, seccion 6](docs/MANUAL.md).
- **Que se puede tocar por `.env`:** [`.env.example`](.env.example), comentado.
- **La API:** [`docs/openapi.yaml`](docs/openapi.yaml) y [AGENTS.md](AGENTS.md).
- **Lo que NO es configurable y por que:** [Arquitectura](docs/ARQUITECTURA.md).

Casi todo se edita en caliente desde la interfaz con el bot detenido; `.env` solo hace falta para
credenciales, rutas y hosts.


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

Polybot marca `Gano` o `Perdio` cuando ya paso el cierre del mercado y tiene con que resolverlo.

**Desde el 2026-08-07 estos mercados los resuelve Polymarket por el TWAP publicado de Chainlink**, no
por el precio spot de cierre. Polybot consume esa serie y la usa como fuente de verdad; el spot queda
solo como respaldo cuando la serie no llego. La documentacion oficial es explicita en no reproducir el
valor por tu cuenta, asi que el bot no lo intenta.

- En simulacion, resuelve todos los trades simulados.
- En live, solo resuelve si detecta fill real.
- Primero usa la respuesta de la orden (`matched`, montos llenados, `tradeIDs` o `transactionsHashes`) como estimado rapido.
- Despues intenta reconciliar contra los trades autenticados del CLOB usando `tradeIDs` o `taker_order_id`.
- Cuando la reconciliacion CLOB existe, el P&L usa shares reales, costo real, precio promedio y fee taker estimada desde `fee_rate_bps`.
- Si una orden live FAK no llena nada, la tabla muestra `Sin fill` y no la cuenta como exposicion de P&L.
- El resultado se calcula contra el **TWAP** de cierre frente al de apertura: `UP` si el final es mayor o igual, `DOWN` si esta debajo. Cada trade guarda con que serie se resolvio (`priceSource`), para poder auditar despues si la fuente fue la correcta.
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

**Hay tres autoajustes**, no uno. Todos son estadistica local (backtesting walk-forward y estimacion
k-NN): ni LLM ni internet. Se encienden por separado en `Settings`, y el detalle de cada uno esta en el
[Manual, seccion 4](docs/MANUAL.md):

| Switch | Que cambia | Riesgo |
|---|---|---|
| `aiAutoApplyLive` — Autoajuste predictivo | Ventana y distancia por mercado/lado, en caliente | Cooldown de 30 min entre cambios |
| `aiAutoTuneAskCap` — Ventana de ask | El techo de ask. **Solo estrecha**, nunca abre | Solo puede reducir exposicion |
| `aiAutoProbeBands` — Sondeos de banda | Prueba bandas de ask nuevas. **Puede ABRIR la ventana** | El unico que puede aumentar el riesgo; presupuesto acotado por mercado y dia |

Ninguno toca nada sin confianza suficiente y sin pasar sus guardas; si no hay datos fiables, dejan la
configuracion como esta. `GET /api/analysis/recommendations` deja inspeccionar las recomendaciones sin
aplicarlas. No confundir con el analisis de Ollama Cloud (abajo), que si es un LLM y solo da texto.

Si configuras `OLLAMA_API_KEY`, puedes enviar un prompt manual a Ollama Cloud desde la misma pestana. Polybot adjunta solo contexto agregado: P&L, trades recientes resumidos, estrategias actuales y top estrategias EV. No envia credenciales, `.env` ni respuestas crudas de ordenes.

## Regla De Entrada

- Mercados: `btc-updown-5m-{epoch}`, `eth-updown-5m-{epoch}` y `doge-updown-5m-{epoch}`.
- Precio inicial: el valor **TWAP** del simbolo (`btc/usd`, `eth/usd` o `doge/usd`) al inicio de la ventana — la misma serie con la que Polymarket resuelve. El tick spot se sigue capturando, pero para analitica.
- Compra `UP` si `precioActual - precioInicial` supera la distancia configurada para ese mercado/lado.
- Compra `DOWN` si `precioInicial - precioActual` supera la distancia configurada para ese mercado/lado.
- Solo compra dentro de la ventana configurada para ese mercado/lado: `0 < segundosParaCierre <= ventanaDelMercadoLado`.
- Salta si el tick esta stale, no hay liquidez, `bestAsk` supera el ask cap del mercado/lado, el mercado no acepta ordenes, ya se intento ese mercado o se alcanzo el limite diario.

## Problemas Comunes

- `Live bloqueado`: faltan credenciales en `.env` o falta confirmacion live. Ojo: los ajustes `arbMode`
  y `directionalMode` ponen una estrategia en live **sin pedir confirmacion** — basta el ajuste, y
  cualquier reinicio la reanuda. Ver [Manual, seccion 7](docs/MANUAL.md).
- `Sin apertura`: el bot arranco tarde y no capturo el tick inicial Chainlink; saltara esa ventana.
- `Tick stale`: no estan llegando ticks recientes de RTDS.
- `Puerto ocupado`: detiene el proceso que usa `8787` o arranca con `POLYBOT_UI_PORT=8788`.

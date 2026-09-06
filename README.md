# Polybot Crypto 5m

Bot TypeScript para mercados `BTC/ETH/DOGE Up or Down 5m` de Polymarket, con modo simulacion, modo live protegido e interfaz web local.

- **[Manual de uso](docs/MANUAL.md)** — como operarlo: que mirar, como decidir, problemas comunes.
- **[Arquitectura](docs/ARQUITECTURA.md)** — como funciona por dentro, invariantes y trampas conocidas.
- **[Docker](docs/docker.md)** — el despliegue recomendado: supervisor, volumen de datos y sus trampas.
- **[Uso por agentes IA](AGENTS.md)** — MCP, CLI y API.
- Este README es **instalacion y arranque**. La referencia de cada ajuste vive en la propia interfaz y en el Manual.

## Dos formas de desplegarlo

| | **Docker** (recomendado) | **Windows nativo** |
|---|---|---|
| Supervisor | `restart: unless-stopped` | tarea programada `PolybotWatchdog` |
| Reinicio para desplegar | segundos | ≤ 5 min, y a veces exige administrador |
| Requiere | Docker Compose v2 | Node.js 20+, permisos de administrador para las tareas |
| Arranque | `docker compose up -d --build` | doble clic en `INICIAR-POLYBOT.cmd` |

Las dos vias siguen soportadas y **el bot es el mismo**: cambia quien lo supervisa y como se instala. Si
no tienes un motivo para lo contrario, usa Docker — el watchdog de Windows costo 45 horas de datos en 10
dias y mato bots sanos en 52 de 59 reinicios, y ese es justamente el problema que compose no tiene.

---

## Docker (recomendado)

Requisitos: Docker con Compose v2. En Windows, Docker Desktop con back-end WSL2, y el repo **dentro del
sistema de archivos de WSL** (`~/Polybot`), no en `/mnt/c/...`.

```bash
cp .env.example .env
docker compose up -d --build
```

La UI queda en `http://127.0.0.1:8787`, alcanzable tambien desde el navegador de Windows.

```bash
docker compose logs -f polybot
docker compose ps
docker compose down
```

Levanta dos servicios: `polybot` (la UI y el bot) y `polybot-archivador`, que archiva la analitica cada
12 h. El archivador **no es opcional si quieres validar algo**: `analytics.jsonl` esta topado a 10.000
muestras con borrado FIFO, o sea ~2 semanas, y a partir de ahi recicla en vez de acumular.

Tres cosas que conviene leer antes de dejarlo corriendo, todas en **[docs/docker.md](docs/docker.md)**:

- **Permisos de `data/`.** Si el UID no coincide, el bot *parece sano y no guarda nada*.
- **La brecha del healthcheck.** Docker no reinicia contenedores `unhealthy` por si solo, asi que un bot
  vivo pero ciego no se relanza — el watchdog de Windows si lo hacia.
- **El puerto va a loopback a proposito.** La UI no tiene autenticacion.

---

## Windows nativo

> **Esta seccion es para un checkout en el sistema de archivos de Windows** (`C:\...`), con Node
> instalado en Windows. Si tu repo vive dentro de WSL —lo normal con Docker— los lanzadores
> `INICIAR-POLYBOT.cmd`, `ABRIR-POLYBOT.cmd` y `REINICIAR-ADMIN.cmd` **no pueden funcionar**: buscan
> `node` en el PATH de Windows y llaman a shims `.cmd` de `node_modules` que no existen cuando las
> dependencias estan instaladas para Linux. Usa la seccion **Docker** y, para el panel de terminal,
> **[TUI](#tui-panel-en-terminal)** — su lanzador si esta preparado para WSL.

### Requisitos

- Node.js 20 o superior.
- Conexion a internet para Gamma API, CLOB API y RTDS Chainlink de Polymarket.
- Wallet y permisos de Polymarket solo si vas a usar live.

### Instalacion

```bash
npm install
Copy-Item .env.example .env
```

Edita `.env` si quieres cambiar montos, limites o credenciales. El modo por defecto es simulacion.

### Uso Rapido Con Interfaz

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

### Si el reinicio no surte efecto

> Nada de esto aplica bajo Docker: ahi el supervisor es compose, `docker compose up -d --build`
> despliega en segundos y no hace falta administrador. Ver [docs/docker.md](docs/docker.md).

`INICIAR-POLYBOT.cmd` mata el Polybot que ya corria y lo relanza. Pero cuando el proceso viejo lo lanzo
la tarea programada `PolybotWatchdog` —que corre "tanto si el usuario inicio sesion como si no"— ese
proceso vive en la **sesion 0**, la de servicios, y una ventana normal no puede matarlo.

Sintoma: parece que reinicio, pero sigue corriendo el codigo de antes. Se comprueba mirando si cambio
el PID que escucha en 8787:

```powershell
Get-NetTCPConnection -LocalPort 8787 -State Listen | Select-Object OwningProcess
```

Solucion: boton derecho sobre **`REINICIAR-ADMIN.cmd`** -> "Ejecutar como administrador". Solo mata el
proceso; el watchdog lo levanta solo en menos de 5 minutos, ya con el codigo nuevo. Deja constancia de
cada intento en `data/reinicio-admin.log`, salga bien o mal, para poder diagnosticarlo despues aunque
la ventana se haya cerrado.

Si ni elevado se deja matar, reiniciar el equipo lo resuelve: la tarea programada tiene disparador de
arranque y Polybot vuelve solo.

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

### Watchdog En Windows

> Bajo Docker esto **no aplica**: el supervisor es compose y el ajuste «Watchdog (auto-reinicio)» sale
> deshabilitado en la UI, con el motivo. Pero ojo con la diferencia real: `watchdog.ps1` relanzaba
> tambien un bot **vivo pero ciego** (sondeaba `/api/health`, que da 503 con el feed rancio), y Docker
> **no** reinicia contenedores `unhealthy` por si solo. Ver
> [docs/docker.md](docs/docker.md#la-brecha-del-healthcheck).

Si el proceso de Polybot muere (falta de memoria, reinicio de Windows, cierre accidental), la UI deja de responder y el bot deja de observar el mercado hasta que alguien lo levante. `scripts/watchdog.ps1` lo revisa cada 5 minutos y lo relanza solo. Revive unicamente la UI/API: el bot queda detenido y Live siempre lo arrancas tu.

Verificar si ya esta registrado:

```powershell
Get-ScheduledTaskInfo -TaskName "PolybotWatchdog"
```

`LastTaskResult: 0` y un `NextRunTime` ~5 minutos adelante = funcionando. Si no existe la tarea, registrala con `powershell -ExecutionPolicy Bypass -File scripts\install-watchdog.ps1` (sin admin). Corre sin abrir ninguna ventana, y se puede apagar y encender desde **Settings -> "Watchdog (auto-reinicio)"** en la UI web o la TUI, sin desregistrar la tarea. La prueba end-to-end y la solucion de problemas estan en [`docs/windows-watchdog.md`](docs/windows-watchdog.md).

## TUI (panel en terminal)

Un panel en vivo dentro de una ventana de terminal, sin navegador. Sirve para **los dos despliegues**:
la TUI no arranca ni supervisa nada, solo se conecta como cliente a `http://127.0.0.1:8787`. Cerrarla
(`q` / `Ctrl+C`) **no** apaga el servidor ni el bot.

### Con doble clic

```text
TUI-POLYBOT.cmd
```

Funciona con Docker + WSL y con Windows nativo: deduce de su propia ubicación en qué distro y en qué
carpeta vive el repo, comprueba si el servidor responde y, **solo si no responde**, levanta los
contenedores. Si ya hay un servidor vivo no lo toca — matarlo podría cortar un live.

### Desde una terminal

**Dónde:** una terminal tuya, interactiva. La TUI toma el teclado y pinta a pantalla completa, así que
no funciona con la entrada redirigida ni dentro de un script.

Con Docker, desde Windows Terminal o PowerShell:

```bash
wsl.exe -d ubuntu --cd /home/ahiram/Polybot -- docker compose exec polybot node dist/src/tui/index.js
```

O, si ya estás dentro de una terminal de WSL situada en el repo:

```bash
docker compose exec polybot node dist/src/tui/index.js
```

En Windows nativo, desde la carpeta del proyecto:

```bash
npm run tui
```

### Qué muestra y cómo se maneja

Pestañas: **Dashboard** (estado, P&L post-reset por modo, win rate, circuit breaker, señal por mercado
y «por qué no opera»), **Trades**, **Análisis** (EV por estrategia) y **Settings** (editable **con el bot
detenido**).

| Tecla | Dónde | Qué hace |
|---|---|---|
| `?` | siempre | Abre y cierra la ayuda con todos los atajos |
| `1`‑`4` | siempre | Salta a Dashboard / Trades / Análisis / Settings |
| `←` `→` o `Tab` | siempre | Pestaña anterior / siguiente |
| `↑` `↓` | siempre | Desplaza línea a línea · en Settings mueve la selección |
| `PgUp` `PgDn` | siempre | Desplaza una página |
| `Inicio` `Fin` | siempre | Principio / final |
| `g` | siempre | Refresca la pestaña actual |
| `Esc` | siempre | Cierra la ayuda, limpia el aviso o quita el filtro |
| `q` o `Ctrl+C` | siempre | Sale |
| `Enter` | Settings | Alterna un interruptor o edita un número |
| `/` | Settings | Filtra la lista por texto (busca en etiqueta, valor y ayuda) |
| `i` | Dashboard | Arranca en **sim** |
| `s` | Dashboard | Detiene el bot |
| `b` | Dashboard | Re-arma el circuit breaker |
| `p` | Dashboard | Resetea P&L — pide escribir `sim` o `live` |
| `x` | Dashboard | Resetea estado — pide escribir `RESET`, con backup previo |
| `L` | Dashboard | Arranca en **live** — pide escribir `ARRANCAR LIVE` |

`Esc` cancela cualquiera de esas preguntas. El estado se refresca solo cada 2 s, y si un refresco se
atrasa la cabecera lo dice («hace 41s»): un sondeo colgado deja números plausibles y quietos, que es
más difícil de detectar que una pantalla vacía.

El Dashboard es más alto que casi cualquier terminal en cuanto el maker tiene algo que decir, así que
**se desplaza**: el pie indica con `▲`/`▼` que queda contenido fuera de vista. La barra de acciones solo
lista lo que se puede hacer ahora mismo; el repertorio completo está en `?`.

`L` es la única que exige mayúscula, y encender cualquier ajuste que abra dinero real pide la misma
frase: **la TUI nunca arranca live sola**. Los números se recortan al rango del esquema antes de
enviarse, así que no se puede guardar un valor que el servidor vaya a rechazar.

Para un vistazo puntual, sin interfaz interactiva (esto sí funciona dentro de un script):

```bash
docker compose exec -T polybot node dist/src/tui/index.js --once --tab=trades
```

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

Bajo Docker, `data/` se monta desde el host (`./data:/app/data`), asi que sobrevive a
`docker compose up --build`. Si el UID del contenedor no coincide con el tuyo, el bot **parece sano y
no guarda nada**: es el fallo mas traicionero del montaje y esta explicado en
[docs/docker.md](docs/docker.md#permisos-de-data).

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

La pestana `Analisis` calcula EV historico de estrategias usando las muestras compactas de `data/analytics.jsonl`. Mientras el bot corre, Polybot guarda ticks Chainlink, quotes UP/DOWN y resultado final de los ultimos 120 segundos de cada ventana (`ANALYTICS_WINDOW_SECONDS`; mas atras el tick se submuestrea a uno cada 5s). Con esas muestras cruza mercado, lado, ventana `25..120s`, distancia minima y ask cap para estimar `EV = promedio(gano ? 1 / ask - 1 : -1)`.

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

# Polybot en Docker

Cómo desplegarlo en contenedor y qué cambia respecto al despliegue nativo de Windows. Para operarlo,
ver el [MANUAL](MANUAL.md); para entenderlo por dentro, la [ARQUITECTURA](ARQUITECTURA.md).

---

## Por qué

El despliegue anterior en Windows funcionaba, pero su supervisor costaba caro:

| | Watchdog de Windows | Docker Compose |
|---|---|---|
| Reinicio tras `/api/system/restart` | ≤ 5 min | segundos |
| Matar el proceso desde un terminal | imposible (sesión 0), requiere `REINICIAR-ADMIN.cmd` como admin | `docker compose restart` |
| Datos perdidos por no ejecutarse | **45 h en 10 días** (arranque sin sesión iniciada, 2026-08-17) | no aplica |
| Reinicios que mataron bots sanos | **52 de 59** con el log activo | no aplica |
| Instalación | tarea programada S4U, exige administrador | `docker compose up -d` |

Lo que **no** mejora está en «La brecha del healthcheck», más abajo. Conviene leerlo antes de dar por
sustituido el watchdog.

## Arranque

Requisitos: Docker con Compose v2. En Windows, Docker Desktop con back-end WSL2.

```bash
cp .env.example .env
docker compose up -d --build
```

Si clonaste el repo, `data/` ya existe (va con un `.gitkeep` justo para esto). Si copiaste los ficheros
a mano, **créalo antes del primer `up`**:

```bash
mkdir -p data
```

Docker crea el origen de un bind mount **como root** cuando no existe, y el contenedor corre como uid
1000: sin ese directorio, la primera pasada del archivador muere con `EACCES` y el síntoma es el peor
posible — el bot parece sano y no persiste nada.

La UI queda en `http://127.0.0.1:8787`. Con WSL2 y `localhostForwarding` (el comportamiento por
defecto), el navegador de Windows la alcanza en esa misma dirección aunque el contenedor viva dentro de
WSL.

```bash
docker compose logs -f polybot
docker compose ps
docker compose down
```

**Deja `POLYMARKET_PRIVATE_KEY` vacía** mientras no vayas a operar en live. Sin ella el arranque en live
falla en el acto, y es el candado más fuerte que existe. Vacía es correcto; **malformada** lanza error
incluso en modo simulación, porque `normalizePrivateKey` corre siempre.

## Dónde vive el repo

Con Docker Desktop en Windows, pon el repo **dentro del sistema de archivos de WSL** (`~/Polybot`), no
en `/mnt/c/...`. Cruzar el límite entre Windows y Linux en cada escritura cuesta mucho I/O, y `data/`
se escribe constantemente: `analytics.jsonl` recibe una muestra por ventana observada y `trades.jsonl`
es append-only.

## Permisos de `data/`

Es el fallo más traicionero del montaje, porque **el bot parece sano y no guarda nada**.

La imagen corre como el usuario `node`, UID 1000, que es el primer usuario de la mayoría de las
distribuciones de WSL. Comprueba el tuyo:

```bash
id -u; id -g
```

Si no son 1000, no hace falta reconstruir: descomenta en `docker-compose.yml` la línea
`user: "${UID:-1000}:${GID:-1000}"` y pasa los valores al levantar. `UID` suele ser una variable de solo
lectura del shell, así que lo más fiable es dárselos explícitamente:

```bash
UID=$(id -u) GID=$(id -g) docker compose up -d
```

Verificación, y no es opcional: arranca simulación, espera diez minutos y comprueba en el host que los
ficheros crecen y son tuyos.

```bash
ls -la data/
```

Si `state.json` o `analytics.jsonl` salen de `root`, el contenedor está escribiendo con otro usuario y
lo que veas en la UI no se está persistiendo como crees.

## Qué fija el contenedor, y por qué

| Variable | Valor | Motivo |
|---|---|---|
| `TZ` | `UTC` | Las recompensas se abonan **~00:45 UTC** y el límite de gasto es **por día**. Con otro huso, el contador del bot y el del exchange dejan de hablar del mismo día, y nada avisa. `POLYBOT_TIMEZONE=auto` resuelve entonces a UTC. |
| `POLYBOT_UI_HOST` | `0.0.0.0` | Escuchar solo en el `127.0.0.1` **del contenedor** haría que el puerto publicado no llevara a ningún sitio. Quien acota el acceso es la publicación del puerto, no esta variable. |
| `POLYBOT_SUPERVISOR` | `compose` | Lo lee la UI para no ofrecer el interruptor del watchdog de Windows, que aquí no lo lee nadie, y para que `/api/system/restart` diga el plazo real. |

## El puerto va a loopback a propósito

```yaml
ports:
  - "127.0.0.1:8787:8787"
```

**La UI no tiene autenticación** y expone endpoints que arrancan en live, cambian modos por estrategia y
resetean el estado. Publicar `"8787:8787"` a secas la deja escuchando en todas las interfaces de la
máquina. Para verla desde el móvil, [Tailscale](windows-tailscale.md) — nunca abriendo el puerto.

## La brecha del healthcheck

El contenedor sondea `/api/health`, que devuelve **503** cuando el feed lleva demasiado sin ticks: o
sea, distingue *«el bot está ciego»* de *«el servidor responde»*. Esa distinción existe porque un
`/api/health` que solo comprobaba que el servidor contestara dejó pasar un bot ciego sin que el watchdog
moviera un dedo.

**Pero Docker no reinicia por sí solo un contenedor `unhealthy`.** `restart: unless-stopped` actúa
cuando el proceso *muere*, no cuando enferma. Así que:

- **Cubierto**: el proceso se cae, o sale por `/api/system/restart`.
- **NO cubierto**: el proceso sigue vivo pero ciego. `docker compose ps` lo marcará `unhealthy` y nadie
  hará nada.

Esto es una pérdida real frente a `scripts/watchdog.ps1`, que sí relanzaba en ese caso. Mientras no se
cierre, la vigilancia de ese estado es manual (o por las notificaciones de Telegram, si las tienes
configuradas). Se documenta en vez de fingir equivalencia: dar por cubierto algo que no lo está es peor
que la brecha misma.

## El archivador

El servicio `polybot-archivador` corre `dist/src/archiveAnalytics.js` cada 12 h y sustituye la tarea
`PolybotArchivoAnalitica` de Windows. **No es opcional si quieres validar algo.**

`data/analytics.jsonl` está topado a `maxAnalyticsSamples` (10.000). Al llenarse, cada muestra nueva
**borra la más vieja**: a ~730 al día son unas dos semanas, y a partir de ahí esperar más tiempo no
acumula historia, la recicla. Validar una estrategia fuera de muestra necesita más que eso.

```bash
docker compose logs polybot-archivador
cat data/archive/archive.log
```

Lee el **fichero**, no la API, así que funciona con el bot parado — que es justo cuando más urge no
perder lo que ya hay.

## Desplegar un cambio

```bash
docker compose up -d --build
```

O, sin reconstruir la imagen, pidiéndole al proceso que salga para que compose lo levante:

```bash
curl -X POST http://127.0.0.1:8787/api/system/restart
```

Ese endpoint detiene el bot antes de salir, para no cortar una iteración a media escritura del estado, y
responde **antes** de terminar. Su mensaje nombra al supervisor real y su plazo real.

## La TUI

Doble clic en **`TUI-POLYBOT.cmd`**, o desde una terminal:

```bash
docker compose exec polybot node dist/src/tui/index.js
```

Necesita una terminal **interactiva**: la TUI toma el teclado y pinta a pantalla completa, así que con
la entrada redirigida se niega a abrir y lo dice. Para un vistazo dentro de un script, `--once`.

Cerrarla (`q` / Ctrl+C) no apaga el servidor.

El lanzador deduce de su propia ubicación en qué distro de WSL y en qué carpeta vive el repo, en vez de
llevar la ruta escrita a mano. Dos detalles que explican su forma:

- **cmd.exe no admite una ruta UNC como directorio actual.** Al abrirlo desde `\\wsl.localhost\...` el
  directorio de trabajo se queda en `C:\Windows`, así que el lanzador no hace `cd`: traduce la ruta a
  formato Linux y se la pasa a `wsl.exe --cd`.
- **Si el servidor ya responde, no lo toca.** Solo levanta los contenedores cuando 8787 está mudo —
  matar un servidor vivo podría cortar un live.

## Qué deja de aplicar

Con Docker como supervisor, estas piezas del despliegue nativo **no intervienen**:

- `INICIAR-POLYBOT.cmd`, `ABRIR-POLYBOT.cmd` y `REINICIAR-ADMIN.cmd`. Los tres buscan `node` en el PATH
  de **Windows** y asumen que `node_modules` trae shims `.cmd`; con el repo dentro de WSL las
  dependencias están instaladas para Linux y esos shims no existen, así que fallan. Sus equivalentes
  bajo Docker son `docker compose up -d --build`, abrir `http://127.0.0.1:8787` y
  `docker compose restart`.
  **`TUI-POLYBOT.cmd` es la excepción: se reescribió para este despliegue y sí funciona** (ver «La TUI»).
- `scripts/watchdog.ps1`, `scripts/install-watchdog.ps1` y la tarea `PolybotWatchdog`.
- `scripts/install-analytics-archive.ps1` y la tarea `PolybotArchivoAnalitica`.
- El ajuste **«Watchdog (auto-reinicio de la UI)»**: sale visible pero **deshabilitado**, con el motivo.
  No se oculta a propósito — quien lo busque debe encontrar la explicación en vez de creer que
  desapareció.

Los lanzadores y sus documentos ([`windows-watchdog.md`](windows-watchdog.md)) se conservan: siguen
siendo la vía correcta para un checkout nativo de Windows sin Docker.

## Problemas comunes

**La UI no responde en 127.0.0.1:8787.** Mira `docker compose ps`. Si el contenedor está arriba,
comprueba que `POLYBOT_UI_HOST` sea `0.0.0.0` dentro
(`docker compose exec polybot env | grep UI_HOST`): con `127.0.0.1` escucha solo dentro del contenedor
y el puerto publicado no lleva a ningún sitio.

**`data/` no crece.** Permisos del volumen, casi seguro. Ver arriba.

**El saldo sale 0 teniendo fondos.** No es cosa de Docker: el colateral de Polymarket es **pUSD**, no
USDC. Ver [ARQUITECTURA.md](ARQUITECTURA.md#trampas-conocidas).

**El bot arrancó con una estrategia en live sin que nadie lo pidiera.** Los modos por estrategia
persisten en `data/ui-config.json` y **sobreviven al reinicio sin confirmación** — es deliberado, para
que el supervisor pueda relanzar sin un humano delante, pero con compose los reinicios son más rápidos y
fiables que antes. Comprueba la cabecera: las tres estrategias deben decir SIM.

# Watchdog en Windows (auto-reinicio de Polybot)

Polybot corre como un proceso de Node (`npm run ui`). Si ese proceso muere —se quedó sin memoria,
Windows se reinició por una actualización, o lo cerraste sin querer— la UI deja de responder y el bot
deja de observar el mercado **hasta que alguien lo levante a mano**.

El watchdog resuelve eso: cada 5 minutos comprueba si la UI responde y, si no, la relanza.

> **Importante:** el watchdog solo revive la **UI/API**. El bot queda **detenido** y el modo Live
> siempre lo arrancas tú. Nunca va a ponerse a operar con dinero real por su cuenta.

## Qué hace exactamente

[`scripts/watchdog.ps1`](../scripts/watchdog.ps1):

1. Mira `watchdogEnabled` en `data/ui-config.json`. Si está en `false` (lo desmarcaste en la UI),
   termina sin hacer nada. Si el archivo no existe o está ilegible, sigue: mejor vigilar de más.
2. Pide `http://127.0.0.1:8787/api/status` (dos intentos, para no reiniciar por un hipo puntual).
3. Si responde 200 → no hace nada y termina.
4. Si no responde → mata cualquier proceso zombi que aún ocupe el puerto 8787 y relanza `npm run ui`
   con `NODE_OPTIONS=--max-old-space-size=3072` (tope de memoria: si hay una fuga, el proceso muere
   chico y rápido en vez de agotar el sistema).
5. Deja constancia en `data/watchdog.log` y la salida del proceso en `data/ui-console.log`.

Todo ocurre **sin ninguna ventana**: la tarea corre `conhost.exe --headless` y el relanzamiento usa
`CreateNoWindow`. Si ves parpadear una consola cada 5 minutos, tienes registrada la versión antigua
de la tarea; re-regístrala con el script de abajo.

## Verificar si ya está registrado

En PowerShell:

```powershell
Get-ScheduledTask -TaskName "PolybotWatchdog"
Get-ScheduledTaskInfo -TaskName "PolybotWatchdog"
```

Lo que quieres ver: `State: Ready`, un `LastRunTime` reciente y `LastTaskResult: 0` (0 = ejecutó bien).
`NextRunTime` debe estar ~5 minutos después del último.

Si responde `No matching MSFT_ScheduledTask objects found`, no está registrado: sigue el paso siguiente.

## Registrarlo (una sola vez)

PowerShell **normal, sin permisos de administrador**, desde la carpeta del proyecto:

```powershell
powershell -ExecutionPolicy Bypass -File "C:\DEV\tests\Workspace de Yarbis\Polybot\scripts\install-watchdog.ps1"
```

[`scripts/install-watchdog.ps1`](../scripts/install-watchdog.ps1) apunta la tarea a la carpeta donde
vive él mismo, así que si moviste el proyecto —o tienes varias copias— basta con ejecutar el de la
copia que de verdad usas. Es idempotente: re-ejecutarlo actualiza la tarea existente.

## Comprobar que funciona de verdad

Prueba end-to-end (mata el proceso a propósito y observa cómo revive):

```powershell
# 1) Matar el proceso que escucha en 8787
Stop-Process -Id (Get-NetTCPConnection -LocalPort 8787 -State Listen).OwningProcess -Force

# 2) Ejecutar el watchdog a mano (sin esperar los 5 min)
powershell -NoProfile -ExecutionPolicy Bypass -File "C:\DEV\tests\Workspace de Yarbis\Polybot\scripts\watchdog.ps1"

# 3) La UI debe volver en segundos
Invoke-WebRequest http://127.0.0.1:8787/api/status -UseBasicParsing | Select-Object StatusCode
```

Y revisa la bitácora:

```powershell
Get-Content "C:\DEV\tests\Workspace de Yarbis\Polybot\data\watchdog.log" -Tail 10
```

## Cómo te enteras de que actuó

Cuando Polybot arranca manda un Telegram **"UI lista"**. Si te llega uno que tú no provocaste, el
watchdog acaba de revivir el proceso. Recuerda que tras revivir el bot queda detenido: si estabas
operando en Live, hay que volver a arrancarlo manualmente.

## Apagarlo sin desregistrarlo

En **Settings** de la UI web o de la TUI hay una casilla **"Watchdog (auto-reinicio)"**. Al
desmarcarla y guardar, la tarea sigue registrada y disparándose, pero cada pasada termina de
inmediato sin tocar nada. El cambio tarda hasta 5 minutos en notarse (lo que falte para la siguiente
pasada). Como el resto de ajustes, hay que **detener el bot** para poder editarlo.

Es lo que quieres para una ventana de mantenimiento, o si vas a levantar la UI desde otra carpeta y
no quieres que el watchdog te mate el puerto 8787.

## Quitarlo

```powershell
powershell -ExecutionPolicy Bypass -File "C:\DEV\tests\Workspace de Yarbis\Polybot\scripts\install-watchdog.ps1" -Remove
```

## Solución de problemas

| Síntoma | Causa probable | Qué hacer |
|---|---|---|
| Parpadea una consola cada 5 min | Tienes registrada la tarea antigua (`powershell -WindowStyle Hidden`) | Re-registrar con `install-watchdog.ps1` |
| `LastTaskResult` distinto de 0 | La ruta del `-File` no existe (proyecto movido) | Re-registrar con `install-watchdog.ps1` desde la carpeta correcta |
| La tarea corre pero nunca revive la UI | La casilla "Watchdog" está desmarcada en Settings | Revisar `watchdogEnabled` en `data/ui-config.json` |
| La tarea corre pero la UI no revive | `npm` no está en el PATH del usuario de la tarea | Ejecutar el script a mano y leer `data/watchdog.log` |
| Revive en bucle cada 5 min | El proceso arranca y muere solo | Revisar `data/ui-console.log`; buscar el log `Iteración lenta del loop` o errores de arranque |
| No corre con la sesión bloqueada | La tarea se creó "solo si el usuario inició sesión" | Re-registrar con el comando de arriba (usa los ajustes correctos) |

# Polybot watchdog: si la UI (puerto 8787) no responde, relanza `npm run ui`.
# Pensado para correr como tarea programada cada 5 minutos. NO arranca el trading:
# el proceso nuevo inicia con el bot detenido y Live siempre lo arranca el usuario.
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$logDir = Join-Path $root "data"
$watchLog = Join-Path $logDir "watchdog.log"
$consoleLog = Join-Path $logDir "ui-console.log"

function Log($msg) {
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $msg"
    Add-Content -Path $watchLog -Value $line -Encoding utf8
}

# 0) Interruptor desde las UI (Settings -> "Watchdog"). Ausente, ilegible o a medio escribir cuenta
#    como habilitado: un JSON transitorio no debe dejarte sin watchdog.
$configPath = Join-Path $logDir "ui-config.json"
if (Test-Path $configPath) {
    try {
        $cfg = Get-Content -Path $configPath -Raw -Encoding utf8 | ConvertFrom-Json
        if ($null -ne $cfg.watchdogEnabled -and -not $cfg.watchdogEnabled) { exit 0 }
    } catch { }
}

# 1) ¿Responde la UI? Dos intentos para no reiniciar por un hipo puntual.
#    Se sondea /api/health y NO /api/status: este ultimo cotiza mercados en vivo (gamma + 2
#    getQuote por mercado), asi que con la red lenta tarda mas de 5s y el watchdog acababa
#    matando un bot sano — 4 reinicios en 2 horas, perdiendo estado en memoria cada vez.
#    /api/health no toca la red: solo confirma que el proceso atiende peticiones.
#    Y CUATRO intentos con margen ancho, no dos cortos. Medido el 2026-08-22 sobre 59 reinicios: en
#    **52 de ellos el log estaba activo en el minuto anterior**. O sea que el proceso no estaba colgado
#    ni muerto: estaba trabajando y aun asi lo matabamos. No hay una sola señal de muerte dura —ni
#    OOM, ni excepcion sin capturar— en dos semanas de log.
#
#    Lo que si correlaciona son los bloqueos del bucle de eventos: aparecen cerca del 24% de los
#    reinicios contra una tasa base del 2%, o sea **9,8 veces mas de lo esperable por azar**. Y esa
#    medida se queda corta por construccion, porque el histograma se publica cada cinco minutos y se
#    vacia al publicar: el bloqueo que provoca la muerte se pierde al morir el proceso antes.
#
#    Con dos intentos de 5 s bastaban ~5 segundos de paron para matarlo, porque una conexion RECHAZADA
#    falla al instante y no agota su timeout. Ahora hacen falta ~30 s como minimo. Un proceso muerto de
#    verdad sigue reiniciandose igual: esta tarea corre cada cinco minutos.
#
#    El coste de equivocarse no es simetrico. Matar un bot sano cuesta el estado en memoria —y con
#    dinero real, la vista de las ordenes vivas en mercados que ya no se siguen, que quedan huerfanas
#    e invisibles—. Esperar treinta segundos de mas no cuesta nada.
$alive = $false
$ultimoFallo = ""
$reloj = [System.Diagnostics.Stopwatch]::StartNew()
foreach ($attempt in 1..4) {
    try {
        $resp = Invoke-WebRequest -Uri "http://127.0.0.1:8787/api/health" -UseBasicParsing -TimeoutSec 10
        if ($resp.StatusCode -eq 200) { $alive = $true; break }
        $ultimoFallo = "HTTP $($resp.StatusCode)"
    } catch {
        $ultimoFallo = $_.Exception.Message
    }
    # No se duerme despues del ULTIMO intento: solo alargaba la tarea sin mirar nada mas.
    if ($attempt -lt 4) { Start-Sleep -Seconds 10 }
}
$reloj.Stop()
if ($alive) { exit 0 }

# Se apunta CUANTO se espero y QUE fallo. Sin esto el log decia solo "sin respuesta", que no distingue
# un proceso muerto de uno ocupado — y esa distincion es justo la que costo 59 reinicios entenderla.
Log "UI sin respuesta en 8787 tras 4 intentos en $([int]$reloj.Elapsed.TotalSeconds)s; reiniciando. Ultimo fallo: $ultimoFallo"

# 2) Limpia cualquier proceso zombi que aun tenga el puerto.
$conn = Get-NetTCPConnection -LocalPort 8787 -State Listen -ErrorAction SilentlyContinue
if ($conn) {
    try {
        Stop-Process -Id $conn.OwningProcess -Force -Confirm:$false
        Log "Proceso zombi $($conn.OwningProcess) terminado."
        Start-Sleep -Seconds 2
    } catch {
        Log "No se pudo terminar el proceso $($conn.OwningProcess): $_"
    }
}

# 3) Relanza con tope de heap: si hay una fuga, el proceso muere chico y rapido
#    (y esta misma tarea lo revive) en vez de crecer a 6GB y tumbar el sistema.
#    Se lanza con CreateNoWindow (no `Start-Process -WindowStyle Hidden`, que crea la consola y luego
#    la esconde: eso es el parpadeo). UseShellExecute=$false ademas hereda NODE_OPTIONS.
$env:NODE_OPTIONS = "--max-old-space-size=3072"
$psi = [System.Diagnostics.ProcessStartInfo]::new()
$psi.FileName = "cmd.exe"
$psi.Arguments = "/c npm run ui >> `"$consoleLog`" 2>&1"
$psi.WorkingDirectory = $root
$psi.UseShellExecute = $false
$psi.CreateNoWindow = $true
[System.Diagnostics.Process]::Start($psi) | Out-Null
Log "Relanzado npm run ui (NODE_OPTIONS=$env:NODE_OPTIONS). El bot queda detenido; Live se arranca manualmente."

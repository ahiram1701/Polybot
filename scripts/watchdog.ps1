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

# 1) ¿Responde la UI? Dos intentos para no reiniciar por un hipo puntual.
$alive = $false
foreach ($attempt in 1..2) {
    try {
        $resp = Invoke-WebRequest -Uri "http://127.0.0.1:8787/api/status" -UseBasicParsing -TimeoutSec 5
        if ($resp.StatusCode -eq 200) { $alive = $true; break }
    } catch {
        Start-Sleep -Seconds 5
    }
}
if ($alive) { exit 0 }

Log "UI sin respuesta en 8787; reiniciando."

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
$env:NODE_OPTIONS = "--max-old-space-size=3072"
Set-Location $root
Start-Process cmd -ArgumentList '/c', "npm run ui >> `"$consoleLog`" 2>&1" -WindowStyle Hidden
Log "Relanzado npm run ui (NODE_OPTIONS=$env:NODE_OPTIONS). El bot queda detenido; Live se arranca manualmente."

# Registra (o quita) la tarea programada que archiva la analitica.
# PowerShell normal, SIN permisos de administrador. Idempotente: re-ejecutarlo actualiza la tarea.
#
#   powershell -ExecutionPolicy Bypass -File scripts\install-analytics-archive.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\install-analytics-archive.ps1 -Remove
#
# Por que existe: el fichero de analitica esta acotado a 10.000 muestras. Cuando se llena, cada muestra
# nueva borra la mas vieja, asi que a partir de ahi esperar mas tiempo no acumula datos, los recicla.
# Validar una estrategia fuera de muestra necesita mas historia que esa.
param([switch]$Remove)

$ErrorActionPreference = "Stop"
$taskName = "PolybotArchivoAnalitica"

if ($Remove) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-Host "Tarea '$taskName' eliminada."
    return
}

$root = Split-Path -Parent $PSScriptRoot
$script = Join-Path $root "scripts\archive-analytics.ps1"
if (-not (Test-Path $script)) { throw "No encuentro $script" }

# conhost.exe --headless: sin ventana, ni siquiera el parpadeo de `-WindowStyle Hidden`. Mismo patron
# que el watchdog.
$action = New-ScheduledTaskAction -Execute "conhost.exe" `
    -Argument "--headless powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$script`""

# Cada 12 horas. La retencion tarda ~2 semanas en dar la vuelta al fichero, asi que dos pasadas al dia
# dejan un margen enorme; el coste de cada una son unos segundos de lectura.
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) `
    -RepetitionInterval (New-TimeSpan -Hours 12)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 30)

# S4U ("Service For User"): la tarea corre TANTO si hay sesion iniciada como si no, y sin guardar
# contrasena. Antes se registraba con el principal por defecto —`Interactive`, o sea "solo con el
# usuario dentro"—, y eso costo horas de datos: el 2026-08-17 Windows arranco a las 00:17 tras un
# apagado inesperado, nadie inicio sesion, y esta tarea NO se ejecuto ni una vez hasta las 03:00. Su
# log no tenia ni una linea de esas horas: no es que fallara, es que no llego a correr.
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType S4U -RunLevel Limited

# Ademas del intervalo, un disparador al ARRANCAR: tras un reinicio no hay que esperar a que venza la
# repeticion, que es justo el rato en que el bot esta caido y nadie mira.
$arranque = New-ScheduledTaskTrigger -AtStartup

# Se INTENTA la version fiable y, si Windows la deniega, se cae a la de siempre con un aviso claro.
# Fallar del todo sin administrador seria peor que el problema: dejaria la maquina sin ninguna tarea.
$fiable = $true
try {
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger @($trigger, $arranque) `
        -Settings $settings -Principal $principal -Force -ErrorAction Stop | Out-Null
} catch {
    $fiable = $false
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
        -Settings $settings -Force | Out-Null
}

Write-Host "Tarea '$taskName' registrada apuntando a:"
Write-Host "  $script"
Write-Host "Archivo: data\archive\analytics-archive.jsonl  ·  rastro: data\archive\archive.log"

if (-not $fiable) {
    Write-Host ""
    Write-Host "AVISO: registrada en modo 'solo con sesion iniciada'." -ForegroundColor Yellow
    Write-Host "  S4U y el disparador de arranque exigen ADMINISTRADOR, y Windows lo denego."
    Write-Host "  Consecuencia real: si el PC se reinicia y nadie inicia sesion, esta tarea NO corre."
    Write-Host "  El 2026-08-17 eso costo 6,7 h de datos, y el 13-14 de agosto otras 24 h."
    Write-Host "  Para arreglarlo: PowerShell COMO ADMINISTRADOR y volver a ejecutar este script."
}

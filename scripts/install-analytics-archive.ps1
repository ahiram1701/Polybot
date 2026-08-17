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

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null

Write-Host "Tarea '$taskName' registrada apuntando a:"
Write-Host "  $script"
Write-Host "Archivo: data\archive\analytics-archive.jsonl  ·  rastro: data\archive\archive.log"

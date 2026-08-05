# Registra (o quita) la tarea programada del watchdog de Polybot.
# PowerShell normal, SIN permisos de administrador. Idempotente: re-ejecutarlo actualiza la tarea.
#
#   powershell -ExecutionPolicy Bypass -File scripts\install-watchdog.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\install-watchdog.ps1 -Remove
#
# La tarea apunta a la carpeta donde vive ESTE script, asi que si tienes varias copias del proyecto,
# ejecuta el de la copia que realmente usas.
param([switch]$Remove)

$ErrorActionPreference = "Stop"
$taskName = "PolybotWatchdog"

if ($Remove) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-Host "Tarea '$taskName' eliminada."
    return
}

$root = Split-Path -Parent $PSScriptRoot
$script = Join-Path $root "scripts\watchdog.ps1"
if (-not (Test-Path $script)) { throw "No encuentro $script" }

# conhost.exe --headless corre powershell en una pseudoconsola: no se crea ninguna ventana, ni
# siquiera el parpadeo de un instante que deja `powershell -WindowStyle Hidden` con logon interactivo.
$action = New-ScheduledTaskAction -Execute "conhost.exe" `
    -Argument "--headless powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$script`""

# Cada 5 minutos, indefinidamente. El limite de 4 min evita que una pasada colgada bloquee la siguiente.
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
    -RepetitionInterval (New-TimeSpan -Minutes 5)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 4)

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null

Write-Host "Tarea '$taskName' registrada apuntando a:"
Write-Host "  $script"
Write-Host "Se puede apagar sin desregistrarla desde Settings -> 'Watchdog' en la UI web o la TUI."

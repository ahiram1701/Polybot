# Registra la tarea que manda el informe del maker por Telegram.
#   powershell -ExecutionPolicy Bypass -File scripts\install-maker-report.ps1 -Horas 4
#   powershell -ExecutionPolicy Bypass -File scripts\install-maker-report.ps1 -Remove
param([switch]$Remove, [int]$Horas = 4)

$ErrorActionPreference = "Stop"
$taskName = "PolybotInformeMaker"

if ($Remove) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-Host "Tarea '$taskName' eliminada."
    return
}

$root = Split-Path -Parent $PSScriptRoot
$script = Join-Path $root "scripts\maker-report.ps1"
if (-not (Test-Path $script)) { throw "No encuentro $script" }

$action = New-ScheduledTaskAction -Execute "conhost.exe" `
    -Argument "--headless powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$script`""
# Una sola vez, dentro de N horas: es un aviso puntual, no un servicio.
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddHours($Horas)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 10)

# S4U: el aviso debe llegar aunque nadie haya iniciado sesion, que es justo cuando no estas mirando.
$fiable = $true
try {
    $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType S4U -RunLevel Limited
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
        -Settings $settings -Principal $principal -Force -ErrorAction Stop | Out-Null
} catch {
    $fiable = $false
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
}

Write-Host "Tarea '$taskName' registrada: avisara dentro de $Horas h."
if (-not $fiable) {
    Write-Host "AVISO: solo correra si hay sesion iniciada (S4U exige administrador)." -ForegroundColor Yellow
}

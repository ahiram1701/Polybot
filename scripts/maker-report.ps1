# Manda por Telegram el resumen de lo que ha hecho el maker.
# Pensado para una tarea programada: el aviso llega aunque nadie tenga la sesion abierta.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$log = Join-Path $root "data\archive\maker-report.log"
Set-Location $root
$salida = & npx tsx src/smoke/makerReport.ts --avisar 2>&1 | Out-String
Add-Content -Path $log -Value "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')`n$salida" -Encoding utf8

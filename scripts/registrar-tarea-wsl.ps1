# Registra `PolybotDespiertaWSL`: despierta WSL cuando el LATIDO de Polybot se para.
#
# EJECUTAR DESDE UNA CONSOLA DE ADMINISTRADOR. Sin elevacion cae a `Interactive`, y ese modo en esta
# maquina ni siquiera ejecuta su accion (comprobado: el mismo comando funciona a mano y devuelve 0x1
# lanzado por la tarea). El unico modo que sirve es S4U, que ademas es el unico que corre sin sesion
# iniciada — y eso importa: tras un reinicio, esta maquina estuvo 9,5 horas sin que nadie entrara.
#
# EL VIGILANTE VA APARTE, en `vigila-polybot.ps1`, al lado de este fichero. Lee el latido que el bot
# escribe en el disco de Windows (`src/latido.ts`), sin red ni `wsl.exe` de por medio. Las tres
# versiones anteriores decidian por la red y todas hicieron daño; el historial esta en su cabecera.

$ErrorActionPreference = 'Stop'

$nombre = 'PolybotDespiertaWSL'
$usuario = "$env:USERDOMAIN\$env:USERNAME"
$carpeta = Join-Path $env:LOCALAPPDATA 'Polybot'
$vigilante = Join-Path $carpeta 'vigila-polybot.ps1'
$origen = Join-Path $PSScriptRoot 'vigila-polybot.ps1'

New-Item -ItemType Directory -Path $carpeta -Force | Out-Null

# La copia que corre vive FUERA del repo: el repo esta en \\wsl.localhost\..., y si la tarea tuviera
# que leerlo de ahi dependeria de que WSL este vivo — justo lo que esta tarea existe para arreglar.
if (Test-Path $origen) {
  Copy-Item $origen $vigilante -Force
  Write-Output "vigilante copiado a: $vigilante"
} elseif (Test-Path $vigilante) {
  Write-Output "aviso: no encuentro $origen; se reutiliza el vigilante ya instalado."
} else {
  Write-Output "ERROR: no hay vigilante ni en $origen ni en $vigilante."
  exit 1
}

$accion = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$vigilante`""
$cada5 = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
  -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 3650)
$alIniciarSesion = New-ScheduledTaskTrigger -AtLogOn -User $usuario
# En bateria tambien: un portatil desenchufado sigue teniendo que operar.
$ajustes = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -MultipleInstances IgnoreNew
$descripcion = 'Despierta WSL cuando el latido de Polybot se para. Decide por el fichero de latido, ' +
  'nunca por la red: las versiones que preguntaban por HTTP reiniciaban el bot cada 5 minutos.'

try {
  $principal = New-ScheduledTaskPrincipal -UserId $usuario -LogonType S4U -RunLevel Limited
  Register-ScheduledTask -TaskName $nombre -Action $accion -Trigger @($cada5, $alIniciarSesion) `
    -Settings $ajustes -Principal $principal -Description $descripcion -Force | Out-Null
  Write-Output "OK: $nombre registrada con S4U. Corre haya o no sesion iniciada."
} catch {
  Write-Output "S4U DENEGADO ($($_.Exception.Message.Trim()))."
  Write-Output "   Hace falta una consola de ADMINISTRADOR. Sin S4U la tarea no sirve en esta maquina."
  exit 1
}

# Verificar no es opcional: una version anterior parecia funcionar y estaba matando al bot.
Start-ScheduledTask -TaskName $nombre
Start-Sleep -Seconds 12
$info = Get-ScheduledTaskInfo -TaskName $nombre
Write-Output ("prueba: resultado 0x{0:X} (0x0 = ejecuto bien)" -f $info.LastTaskResult)
if ($info.LastTaskResult -ne 0) {
  Write-Output "AVISO: la tarea no ejecuto su accion. No te fies de ella hasta averiguar por que."
}

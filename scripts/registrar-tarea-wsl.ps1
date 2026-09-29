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

# UN SOLO DISPARO, AL INICIAR SESION. Sin repeticion cada 5 minutos, y esto es lo mas importante que
# aprendio este fichero.
#
# La repeticion se probo cuatro veces y tres hicieron daño, siempre igual: la tarea decidia mal, llamaba
# a `wsl.exe`, y desde la sesion 0 eso no se engancha a la distro sino que la TUMBA y la levanta. El
# 2026-09-28 quedo demostrado por atribucion, que es lo unico que valio despues de tres diagnosticos
# equivocados: reinicios cada 5 minutos clavados (02:03, 02:08, 02:13...), se desactiva la tarea a las
# 02:37:16 y el reinicio de las 02:38 no ocurre.
#
# La necesidad real es UNA: tras reiniciar Windows, WSL esta caida y hay que levantarla una vez. Un
# disparo al iniciar sesion hace exactamente eso y es incapaz de entrar en bucle.
#
# LO QUE SE PIERDE, dicho claro: si WSL se cae a media tarde, no vuelve sola hasta el proximo inicio de
# sesion. Con cuatro versiones y tres averias detras, ese precio es mejor que el otro.
$alIniciarSesion = New-ScheduledTaskTrigger -AtLogOn -User $usuario
# En bateria tambien: un portatil desenchufado sigue teniendo que operar.
$ajustes = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -MultipleInstances IgnoreNew
$descripcion = 'Despierta WSL cuando el latido de Polybot se para. Decide por el fichero de latido, ' +
  'nunca por la red: las versiones que preguntaban por HTTP reiniciaban el bot cada 5 minutos.'

try {
  $principal = New-ScheduledTaskPrincipal -UserId $usuario -LogonType S4U -RunLevel Limited
  Register-ScheduledTask -TaskName $nombre -Action $accion -Trigger $alIniciarSesion `
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

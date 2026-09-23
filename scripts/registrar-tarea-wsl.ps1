# Registra `PolybotDespiertaWSL`: la tarea que evita que Polybot se quede caido cuando WSL se para.
#
# POR QUE EXISTE. Bajo Docker, Polybot vive dentro de la distro Ubuntu de WSL. Si la distro se para
# —una actualizacion, un `wsl --shutdown`, lo que sea— se para Docker y se para el bot, y NO VUELVE
# SOLO: la distro solo arranca cuando algo la invoca. El 2026-09-23 eso costo 59 minutos, y el bot
# volvio unicamente porque alguien ejecuto un comando.
#
# `vmIdleTimeout=-1` en .wslconfig NO cubre esto: evita el apagado por inactividad, no que algo termine
# la distro explicitamente.
#
# LO QUE HACE Y LO QUE NO. Solo despierta la distro. No arranca los contenedores: systemd arranca
# `docker.service` y ellos llevan `restart: unless-stopped`, asi que vuelven solos. Hacer
# `docker compose up -d` aqui resucitaria tambien un contenedor que alguien paro a proposito.
#
# S4U CONTRA INTERACTIVE, y no es un detalle. S4U corre haya o no sesion iniciada; Interactive solo con
# la sesion iniciada. Si Windows arranca y nadie entra, la version Interactive no se ejecuta y el bot no
# vuelve — el mismo agujero que costo 45 horas de datos en 10 dias con `PolybotWatchdog`. S4U exige
# ADMINISTRADOR: ejecuta este script desde una consola elevada para conseguirlo.
#
#   powershell -ExecutionPolicy Bypass -File scripts\registrar-tarea-wsl.ps1
#
# Comprobar despues:  Get-ScheduledTaskInfo -TaskName PolybotDespiertaWSL

$ErrorActionPreference = 'Stop'

$nombre = 'PolybotDespiertaWSL'
$usuario = "$env:USERDOMAIN\$env:USERNAME"
$distro = if ($env:POLYBOT_WSL_DISTRO) { $env:POLYBOT_WSL_DISTRO } else { 'Ubuntu' }

$accion = New-ScheduledTaskAction -Execute 'wsl.exe' -Argument "-d $distro --exec /bin/true"
$cada5 = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
  -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 3650)
$alIniciarSesion = New-ScheduledTaskTrigger -AtLogOn -User $usuario
# En bateria tambien: un portatil desenchufado sigue teniendo que operar.
$ajustes = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -MultipleInstances IgnoreNew

$descripcion = "Despierta la distro $distro de WSL cada 5 min para que Docker y Polybot no se queden " +
  'caidos. No arranca los contenedores: vuelven solos por restart:unless-stopped, y asi se respeta una ' +
  'parada deliberada.'

$disparadores = @($cada5, $alIniciarSesion)

try {
  $principal = New-ScheduledTaskPrincipal -UserId $usuario -LogonType S4U -RunLevel Limited
  Register-ScheduledTask -TaskName $nombre -Action $accion -Trigger $disparadores -Settings $ajustes `
    -Principal $principal -Description $descripcion -Force | Out-Null
  Write-Output "OK: $nombre registrada con S4U. Corre haya o no sesion iniciada, en la sesion 0."
} catch {
  Write-Output "S4U denegado ($($_.Exception.Message.Trim())). Requiere administrador; se cae a Interactive."
  $principal = New-ScheduledTaskPrincipal -UserId $usuario -LogonType Interactive -RunLevel Limited
  Register-ScheduledTask -TaskName $nombre -Action $accion -Trigger $disparadores -Settings $ajustes `
    -Principal $principal -Description "$descripcion AVISO: Interactive, solo corre con la sesion iniciada." -Force | Out-Null
  Write-Output "OK: $nombre registrada como Interactive."
  Write-Output "AVISO: si Windows arranca y nadie inicia sesion, la tarea NO se ejecuta y Polybot no vuelve."
  Write-Output "       Para cerrar ese agujero, repite este script desde una consola de administrador."
}

# Registra `PolybotDespiertaWSL`: levanta Polybot SOLO si no responde.
#
# EJECUTAR DESDE UNA CONSOLA DE ADMINISTRADOR. Sin elevacion cae a `Interactive`, y ese modo aqui ni
# siquiera ejecuta su accion (comprobado el 2026-09-23: el mismo comando funciona a mano y devuelve
# error 0x1 lanzado por la tarea). El unico modo que funciona es S4U, y S4U exige administrador.
#
# POR QUE COMPRUEBA ANTES DE TOCAR. La primera version llamaba a `wsl.exe` cada 5 minutos pasara lo que
# pasara, y ESO FUE EL PROBLEMA: `wsl.exe` lanzado desde la sesion 0 no se engancha a la distro que ya
# corre, la TUMBA y la vuelve a levantar. Medido: 120 arranques del bot en las 10 horas siguientes a un
# reinicio de Windows, uno cada cinco minutos clavado al intervalo de la tarea. La proteccion estaba
# matando lo que protegia, y con ventanas de cinco minutos eso significa no completar casi ninguna.
#
# Con la comprobacion delante, en el caso normal la tarea NO invoca `wsl.exe`, asi que no puede molestar
# a nadie. Solo lo invoca cuando Polybot ya no responde, que es cuando reiniciar la distro no rompe nada
# porque ya esta todo roto.
#
# LO QUE NO HACE: no arranca contenedores. Si la distro vive y el bot esta parado a mano, aqui no se
# toca nada — `restart: unless-stopped` existe para respetar esa decision.

$ErrorActionPreference = 'Stop'

$nombre = 'PolybotDespiertaWSL'
$usuario = "$env:USERDOMAIN\$env:USERNAME"
$distro = if ($env:POLYBOT_WSL_DISTRO) { $env:POLYBOT_WSL_DISTRO } else { 'Ubuntu' }
$carpeta = Join-Path $env:LOCALAPPDATA 'Polybot'
$vigilante = Join-Path $carpeta 'vigila-polybot.ps1'

New-Item -ItemType Directory -Path $carpeta -Force | Out-Null

# El vigilante se escribe aqui mismo para que este script sea autocontenido: la copia que se usa de
# verdad vive fuera del repo (el repo esta en \\wsl.localhost\..., y elevar desde una ruta de red no
# siempre enseña el dialogo de UAC).
$cuerpo = @'
$registro = Join-Path $env:LOCALAPPDATA 'Polybot\vigilante.log'
$distro = if ($env:POLYBOT_WSL_DISTRO) { $env:POLYBOT_WSL_DISTRO } else { 'Ubuntu' }
try {
  Invoke-WebRequest -Uri 'http://127.0.0.1:8787/api/status' -TimeoutSec 10 -UseBasicParsing | Out-Null
  # Polybot responde: no se toca NADA. Ni un wsl.exe, que es lo que tumbaba la distro.
  exit 0
} catch {
  $sello = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
  Add-Content -Path $registro -Value "$sello Polybot no responde. Despertando $distro." -Encoding UTF8
  & wsl.exe -d $distro --exec /bin/true
  Add-Content -Path $registro -Value "$sello wsl.exe salio con codigo $LASTEXITCODE." -Encoding UTF8
  exit 0
}
'@
Set-Content -Path $vigilante -Value $cuerpo -Encoding UTF8
Write-Output "vigilante escrito en: $vigilante"

$accion = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$vigilante`""
$cada5 = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
  -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 3650)
$alIniciarSesion = New-ScheduledTaskTrigger -AtLogOn -User $usuario
# En bateria tambien: un portatil desenchufado sigue teniendo que operar.
$ajustes = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -MultipleInstances IgnoreNew
$descripcion = 'Levanta Polybot solo si no responde. No llama a wsl.exe cuando el bot esta vivo: ' +
  'hacerlo reiniciaba la distro y mataba al bot cada 5 minutos (120 veces en 10 h, 2026-09-23).'

try {
  $principal = New-ScheduledTaskPrincipal -UserId $usuario -LogonType S4U -RunLevel Limited
  Register-ScheduledTask -TaskName $nombre -Action $accion -Trigger @($cada5, $alIniciarSesion) `
    -Settings $ajustes -Principal $principal -Description $descripcion -Force | Out-Null
  Write-Output "OK: $nombre registrada con S4U. Corre haya o no sesion iniciada."
} catch {
  Write-Output "S4U DENEGADO ($($_.Exception.Message.Trim()))."
  Write-Output "   Hace falta una consola de ADMINISTRADOR. Sin S4U esta tarea no sirve:"
  Write-Output "   el modo Interactive no ejecuta su accion en esta maquina."
  exit 1
}

# Verificar no es opcional: la version anterior parecia funcionar y estaba matando al bot.
Start-ScheduledTask -TaskName $nombre
Start-Sleep -Seconds 12
$info = Get-ScheduledTaskInfo -TaskName $nombre
Write-Output ("prueba: resultado 0x{0:X} (0x0 = ejecuto bien)" -f $info.LastTaskResult)
if ($info.LastTaskResult -ne 0) {
  Write-Output "AVISO: la tarea no ejecuto su accion. Avisa antes de fiarte de ella."
}

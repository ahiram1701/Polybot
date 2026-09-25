# Vigilante de Polybot v4: decide por el LATIDO, no por la red.
#
# HISTORIAL, porque las tres versiones anteriores hicieron daño:
#
#  v1 (23 sep): llamaba a wsl.exe cada 5 min pasara lo que pasara. Desde la sesion 0, wsl.exe no se
#      engancha a la distro que ya corre: la tumba y la levanta. 120 arranques del bot en 10 horas.
#
#  v2 (23 sep): miraba http://127.0.0.1:8787 antes de tocar. Esa pregunta mezcla "el bot vive" con
#      "el reenvio de localhost de WSL a Windows funciona". El 24 se rompio lo segundo -HTTP 200
#      DENTRO de la distro, nada desde Windows- y volvio a reiniciar el bot cada 5 min, 12 horas.
#
#  v3 (24 sep): intento distinguirlo mirando si el puerto seguia en ESCUCHA. Lo tumbo su propio test:
#      al parar el contenedor el puerto tambien desaparece, asi que "sin puerto" no significa
#      "WSL caido". Nunca llego a produccion.
#
# v4: el bot escribe una marca de tiempo cada 30 s en un fichero del disco de Windows (src/latido.ts).
# Este script lee ESE fichero. No hay red por medio ni wsl.exe por medio: si la marca esta fresca, la
# pila vive, se rompa lo que se rompa en el camino de la red.
#
# Y los frenos se quedan, porque esto ya ha fallado tres veces: dos confirmaciones seguidas antes de
# actuar y como mucho un despertar cada 30 minutos.

$carpeta  = Join-Path $env:LOCALAPPDATA 'Polybot'
$registro = Join-Path $carpeta 'vigilante.log'
$latido   = Join-Path $carpeta 'latido.txt'
$ultimo   = Join-Path $carpeta 'ultimo-despertar.txt'
$fallos   = Join-Path $carpeta 'fallos-seguidos.txt'
$distro   = if ($env:POLYBOT_WSL_DISTRO) { $env:POLYBOT_WSL_DISTRO } else { 'Ubuntu' }
# El bot late cada 30 s. Cuatro minutos tolera un arranque lento o un disco ocupado sin falsos avisos.
$toleranciaMin = 4

function Anota([string]$texto) {
  Add-Content -Path $registro -Value ((Get-Date).ToString('yyyy-MM-dd HH:mm:ss') + " $texto") -Encoding UTF8
}

function OlvidaFallos {
  if (Test-Path $fallos) { [System.IO.File]::Delete($fallos) }
}

# Sin fichero de latido no se actua NUNCA. Puede ser que el bot aun no lo escriba (version vieja), y
# actuar a ciegas es justo como empezaron los tres desastres anteriores.
if (-not (Test-Path $latido)) {
  Anota "No hay fichero de latido: no se actua. Revisa que el contenedor monte el volumen del latido."
  exit 0
}

$edadMin = 99999
try {
  $texto = (Get-Content $latido -Raw).Trim()
  $marca = [datetime]::Parse($texto, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind)
  $edadMin = ((Get-Date).ToUniversalTime() - $marca.ToUniversalTime()).TotalMinutes
} catch {
  # Contenido ilegible (una escritura a medias): la fecha del fichero sirve igual.
  $edadMin = ((Get-Date) - (Get-Item $latido).LastWriteTime).TotalMinutes
}

if ($edadMin -lt $toleranciaMin) {
  # Late: la pila vive. No se toca NADA, pase lo que pase con la red.
  OlvidaFallos
  exit 0
}

$n = 0
if (Test-Path $fallos) { $n = [int](Get-Content $fallos -Raw).Trim() }
$n = $n + 1
Set-Content -Path $fallos -Value $n -Encoding UTF8
if ($n -lt 2) {
  Anota ("Latido con {0:N0} min de antiguedad ({1} de 2). Se espera a confirmar." -f $edadMin, $n)
  exit 0
}

if (Test-Path $ultimo) {
  $hace = (Get-Date) - [datetime](Get-Content $ultimo -Raw).Trim()
  if ($hace.TotalMinutes -lt 30) {
    Anota ("Latido parado, pero ya se desperto hace {0:N0} min: se espera." -f $hace.TotalMinutes)
    exit 0
  }
}

Anota ("Latido parado hace {0:N0} min. Despertando {1}." -f $edadMin, $distro)
Set-Content -Path $ultimo -Value (Get-Date).ToString('o') -Encoding UTF8
OlvidaFallos
& wsl.exe -d $distro --exec /bin/true
Anota "wsl.exe salio con codigo $LASTEXITCODE."
exit 0

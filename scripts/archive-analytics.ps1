# Archiva las muestras de analitica antes de que la retencion las borre.
#
# Lo lanza la tarea programada 'PolybotArchivoAnalitica'. No necesita que el bot este corriendo: lee
# el fichero directamente, y precisamente cuando el bot esta caido es cuando mas urge no perder datos.
#
# Deja rastro en data\archive\archive.log para poder auditar si alguna pasada fallo.
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$log = Join-Path $root "data\archive\archive.log"
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $log) | Out-Null

function Escribir($mensaje) {
    $linea = "{0}  {1}" -f (Get-Date).ToString("yyyy-MM-ddTHH:mm:ssK"), $mensaje
    Add-Content -Path $log -Value $linea -Encoding utf8
}

try {
    Push-Location $root
    # `npx tsx` y no el binario compilado: el proyecto se ejecuta desde fuente y asi no hay que
    # acordarse de recompilar para que el archivado siga al dia.
    # SIN `2>&1`. En PowerShell 5.1, redirigir la stderr de un ejecutable nativo envuelve cada linea en
    # un ErrorRecord; con `$ErrorActionPreference = "Stop"` eso es un error TERMINANTE, asi que
    # cualquier aviso suelto de npm abortaba la pasada y el log guardaba
    # `EXCEPCION: <primera linea del stack>` en vez del fallo real. Asi se perdio el diagnostico del
    # 2026-08-25 (`node:buffer:891`), que era el tope de 512 MB del lector de analitica.
    #
    # Quien manda es el codigo de salida. Y el logger del proyecto escribe TODO por stdout, asi que
    # `$salida` conserva el mensaje de error util sin necesidad de capturar la stderr.
    $salida = & npx tsx src/archiveAnalytics.ts
    $codigo = $LASTEXITCODE
    Pop-Location

    if ($codigo -ne 0) {
        Escribir "FALLO (codigo $codigo): $salida"
        exit 1
    }
    # La linea del logger ya trae cuantas muestras nuevas se archivaron.
    Escribir ($salida | Select-Object -Last 1)
} catch {
    Escribir "EXCEPCION: $_"
    exit 1
}

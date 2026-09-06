@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
title Polybot TUI

rem ---------------------------------------------------------------------------------------------
rem Abre la TUI de Polybot con doble clic, con el despliegue de DOCKER + WSL.
rem
rem La version anterior de este fichero asumia Windows nativo: buscaba `node` en el PATH de Windows y
rem llamaba a `node_modules\.bin\tsx.cmd`. Desde que el repo vive dentro de WSL y el bot corre en
rem contenedores, las dos cosas son falsas — las dependencias estan instaladas para Linux y no existe
rem ningun shim `.cmd`. El doble clic fallaba y el README lo seguia prometiendo.
rem
rem Dos detalles que explican por que esto no hace un `cd` normal:
rem
rem 1. cmd.exe NO puede usar una ruta UNC como directorio actual, y este fichero vive en
rem    \\wsl.localhost\<distro>\... Al abrirlo, el directorio de trabajo se queda en C:\Windows y
rem    cualquier ruta relativa apunta a otro sitio. Por eso la ruta se traduce a formato Linux y se le
rem    pasa a wsl.exe con --cd, en vez de intentar movernos aqui.
rem 2. La distro y la ruta se deducen de la ubicacion de ESTE fichero, no se escriben a mano: asi el
rem    lanzador sigue funcionando si el repo se clona en otra carpeta o en otra distro.
rem ---------------------------------------------------------------------------------------------

set "HERE=%~dp0"
if "!HERE:~-1!"=="\" set "HERE=!HERE:~0,-1!"

set "REST="
if /i "!HERE:~0,16!"=="\\wsl.localhost\" set "REST=!HERE:~16!"
if not defined REST if /i "!HERE:~0,7!"=="\\wsl$\" set "REST=!HERE:~7!"
if not defined REST goto no_wsl

for /f "tokens=1,* delims=\" %%a in ("!REST!") do (
  set "DISTRO=%%a"
  set "SUBDIR=%%b"
)
set "REPO=/!SUBDIR:\=/!"

echo Polybot TUI
echo   distro : !DISTRO!
echo   repo   : !REPO!
echo.

where wsl.exe >nul 2>nul
if errorlevel 1 (
  echo [ERROR] No se encontro wsl.exe. Este lanzador necesita WSL.
  goto fin
)

rem ---- El servidor: si ya responde NO se toca (matarlo cortaria un live) -------------------------
call :servidor_vivo
if not errorlevel 1 goto abrir

echo Servidor no detectado en 127.0.0.1:8787. Levantando los contenedores...
wsl.exe -d !DISTRO! --cd "!REPO!" -- docker compose up -d
if errorlevel 1 (
  echo [ERROR] `docker compose up -d` fallo. Revisa que Docker Desktop este corriendo.
  goto fin
)

echo Esperando a que el servidor responda...
rem `ping` y no `timeout`: timeout se rinde con "No es compatible la redireccion de entradas" en cuanto
rem stdin no es una consola, que es justo lo que pasa al lanzarlo desde un script o una tuberia.
for /l %%i in (1,1,40) do (
  call :servidor_vivo
  if not errorlevel 1 goto abrir
  ping -n 2 127.0.0.1 >nul
)
echo [ERROR] El servidor no respondio a tiempo.
echo         Mira los logs con:  wsl -d !DISTRO! --cd "!REPO!" -- docker compose logs --tail=50 polybot
goto fin

rem ---- Abrir la TUI ------------------------------------------------------------------------------
rem Se ejecuta DENTRO del contenedor a proposito: asi no depende de que el WSL del host tenga
rem node_modules instalados. La TUI es solo un cliente HTTP; cerrarla no apaga nada.
:abrir
wsl.exe -d !DISTRO! --cd "!REPO!" -- docker compose exec polybot node dist/src/tui/index.js
set "CODIGO=!errorlevel!"
echo.
echo ==================================================
echo  La TUI se cerro (codigo !CODIGO!).
echo  Si no viste el panel, copia el texto de arriba.
echo ==================================================
goto fin

rem ---- Ruta no soportada --------------------------------------------------------------------------
:no_wsl
echo [ERROR] Este lanzador espera que el repo viva dentro de WSL
echo         (\\wsl.localhost\^<distro^>\... o \\wsl$\^<distro^>\...).
echo.
echo         Lo encontro en: !HERE!
echo.
echo         Si tu instalacion es Windows nativo, abre la TUI con:
echo             npm run tui
echo         desde una terminal situada en la carpeta del proyecto.
goto fin

rem ---- Subrutina: 0 = el servidor responde ---------------------------------------------------------
rem La barra vertical va SIN `^` delante: ya esta dentro de comillas, asi que cmd no la ve como tuberia
rem y el `^` llegaria a PowerShell como un caracter mas, rompiendo el comando. Sintoma: el servidor
rem siempre parecia caido y el lanzador levantaba contenedores que ya estaban corriendo.
:servidor_vivo
powershell -NoProfile -Command "try { Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:8787/api/status' -TimeoutSec 2 | Out-Null; exit 0 } catch { exit 1 }" >nul 2>nul
exit /b !errorlevel!

:fin
echo.
pause
endlocal

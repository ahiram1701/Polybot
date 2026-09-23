@echo off
setlocal
REM `pushd` y no `cd /d`: la carpeta del proyecto puede estar en una ruta UNC (\wsl.localhost...) y
REM cmd no admite UNC como directorio de trabajo. `pushd` le asigna una letra temporal y si funciona.
pushd "%~dp0"

REM Deja la tarea PolybotDespiertaWSL en modo S4U, que es el que funciona SIN sesion iniciada.
REM
REM POR QUE HACE FALTA. Bajo Docker, Polybot vive dentro de WSL. Si la distro se para, se para el bot
REM y NO VUELVE SOLO. La tarea la despierta cada 5 minutos, pero registrada como "Interactive" solo
REM corre con la sesion iniciada: si Windows arranca y nadie entra, no se ejecuta. Registrarla como
REM S4U cierra ese agujero y eso exige administrador.
REM
REM A DIFERENCIA de REINICIAR-ADMIN.cmd, este se eleva SOLO: doble clic y aceptar el aviso de UAC.

echo.
echo Vigilante de WSL para Polybot
echo =============================
echo.

net session >nul 2>&1
if not errorlevel 1 goto :elevado

echo [..] Pidiendo permisos de administrador...
echo      Va a salir el aviso de Windows: pulsa SI.
echo.
powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs" 2>nul
if errorlevel 1 (
  echo [ERROR] No se pudo elevar. Si pulsaste NO, vuelve a abrir este archivo.
  pause
)
exit /b 0

:elevado
echo [ok] Ventana elevada.
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\registrar-tarea-wsl.ps1"
echo.
echo Comprobacion:
powershell -NoProfile -Command "$t = Get-ScheduledTask -TaskName 'PolybotDespiertaWSL' -ErrorAction SilentlyContinue; if ($t) { 'tarea: ' + $t.State + ' | modo: ' + $t.Principal.LogonType } else { 'NO EXISTE' }"
echo.
echo Si dice "modo: S4U", ya esta: Polybot vuelve solo aunque nadie inicie sesion.
echo.
pause
exit /b 0

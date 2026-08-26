@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

REM Reinicia el proceso de Polybot cuando vive en la SESION 0 y no se deja matar desde una sesion
REM interactiva normal. Pasa cuando lo lanzo la tarea programada PolybotWatchdog, que corre "tanto si
REM el usuario inicio sesion como si no": sus hijos van a la sesion de servicios, no a la tuya.
REM
REM Solo MATA. No relanza: el watchdog corre cada 5 minutos, ve el 8787 muerto y lo levanta solo, ya
REM con el codigo nuevo. Asi este script no tiene que dejar una consola abierta sujetando el proceso.
REM
REM Deja rastro en data\reinicio-admin.log SIEMPRE, salga bien o mal, para poder diagnosticarlo
REM despues aunque la ventana se haya cerrado.

set "LOG=%~dp0data\reinicio-admin.log"
set "SELLO=%date% %time%"

echo.
echo Reinicio administrativo de Polybot
echo ==================================
echo.

net session >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Esta ventana NO tiene permisos de administrador.
  echo.
  echo Cierra esta ventana, haz BOTON DERECHO sobre REINICIAR-ADMIN.cmd y elige
  echo "Ejecutar como administrador". Tiene que salir el aviso de UAC: si no sale,
  echo es que no se elevo y no va a funcionar.
  echo.
  >>"%LOG%" echo %SELLO% FALLO: sin elevacion
  pause
  exit /b 1
)
echo [ok] Ventana elevada.

call :puerto8787
if not defined PID_UI (
  echo [ok] Nadie escucha en el 8787: no hay nada que matar.
  echo      El watchdog lo levantara en menos de 5 minutos.
  >>"%LOG%" echo %SELLO% OK: 8787 ya estaba libre
  pause
  exit /b 0
)

echo [..] Proceso que ocupa el 8787: %PID_UI%
taskkill /PID %PID_UI% /F /T
timeout /t 3 /nobreak >nul

set "PID_ANTES=%PID_UI%"
call :puerto8787
if defined PID_UI (
  echo.
  echo [ERROR] El proceso %PID_UI% SIGUE escuchando en el 8787.
  echo         Ni elevado se deja matar. Lo que queda es reiniciar el equipo: la
  echo         tarea programada tiene disparador de arranque y Polybot vuelve solo.
  >>"%LOG%" echo %SELLO% FALLO: %PID_ANTES% sobrevivio al taskkill elevado
  pause
  exit /b 1
)

echo.
echo [ok] Terminado. El puerto 8787 esta libre.
echo      El watchdog lo levantara en menos de 5 minutos, ya con el codigo nuevo.
echo      Puedes cerrar esta ventana.
>>"%LOG%" echo %SELLO% OK: %PID_ANTES% terminado
pause
exit /b 0

REM Deja en PID_UI el PID que escucha en 8787, o sin definir si no hay ninguno.
:puerto8787
set PID_UI=
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":8787" ^| findstr "LISTENING"') do set PID_UI=%%a
goto :eof

@echo off
cd /d "%~dp0"

REM Deja las tareas programadas de Polybot en modo S4U, el unico que corre SIN sesion iniciada.
REM
REM POR QUE HACE FALTA. `install-watchdog.ps1` intenta S4U y, si Windows se lo deniega por falta de
REM permisos, CAE A `Interactive` con un aviso en vez de fallar. Interactive solo se ejecuta mientras
REM tu sesion este abierta: si Windows arranca y nadie entra, el vigilante no corre y el bot no vuelve.
REM Ese agujero costo 6,7 h de datos el 17 de agosto y otras 24 h el 13-14, cuantificado por el propio
REM instalador. Registrar la tarea desde una ventana elevada es lo que permite pedir S4U de verdad.
REM
REM Se eleva solo: doble clic y aceptar el aviso de Windows. No hay que hacer boton derecho.
REM
REM Las rutas van por `%~dp0` y no escritas a mano: este fichero vive en el repositorio, asi que mover
REM o clonar el proyecto no lo rompe. La primera version estaba en el Escritorio con "C:\Polybot"
REM dentro, que era mentira en cuanto alguien moviera la carpeta.
REM
REM Guardar SIEMPRE con saltos de linea CRLF: con LF, cmd.exe se cierra sin decir nada. De eso se
REM encarga `*.cmd text eol=crlf` en `.gitattributes`, VERIFICADO en un clone y no supuesto: en el
REM checkout de WSL esa regla no convertia, en el de Windows si. Si algun dia este fichero aparece con
REM LF, el arreglo es `*.cmd -text` (guardar los bytes tal cual en vez de convertirlos).

title Tareas de Polybot (nativo)
echo.
echo  Tareas de Polybot - pasar a S4U
echo  ===============================
echo.

net session >nul 2>&1
if errorlevel 1 (
  echo  Pidiendo permisos de administrador: pulsa SI en el aviso de Windows.
  echo.
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b 0
)

echo  [ok] Ventana elevada.
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install-watchdog.ps1"
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install-analytics-archive.ps1"
echo.
echo  ----------------------------------------------------------
powershell -NoProfile -Command "Get-ScheduledTask -TaskName 'PolybotWatchdog','PolybotArchivoAnalitica' | Select-Object TaskName, @{n='Modo';e={$_.Principal.LogonType}}, State | Format-Table -AutoSize | Out-String"
echo  ----------------------------------------------------------
echo.
echo  Si las dos dicen S4U, ya esta: Polybot vuelve solo aunque nadie inicie sesion.
echo  Si dicen Interactive, algo bloqueo la elevacion: avisame.
echo.
pause

@echo off
setlocal
cd /d "%~dp0"

echo.
echo Iniciando Polybot en modo simulacion...
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js no esta instalado o no esta en PATH.
  echo Instala Node.js 20 o superior y vuelve a abrir este archivo.
  pause
  exit /b 1
)

if not exist ".env" (
  echo Creando .env desde .env.example...
  copy ".env.example" ".env" >nul
)

if not exist ".mcp.json" (
  echo Activando config MCP para agentes IA (.mcp.json)...
  copy ".mcp.json.example" ".mcp.json" >nul
)

if not exist "node_modules" (
  echo Instalando dependencias. Esto puede tardar unos minutos la primera vez...
  call npm install
  if errorlevel 1 (
    echo.
    echo No se pudieron instalar las dependencias.
    pause
    exit /b 1
  )
)

call :puerto8787
if not defined EXISTING_PID goto arrancar

echo Reiniciando Polybot para cargar cambios nuevos...
REM El fallo de taskkill NO se silencia. Cuando el proceso viejo lo lanzo la tarea programada, vive en
REM la SESION 0 (la de servicios) y no se deja matar desde una sesion interactiva sin elevar. Antes
REM esto era `>nul 2>nul` y el script seguia adelante: npm no podia coger el 8787, y desde fuera
REM parecia que el reinicio habia funcionado cuando seguia corriendo el codigo viejo.
taskkill /PID %EXISTING_PID% /F
timeout /t 3 /nobreak >nul

call :puerto8787
if not defined EXISTING_PID goto arrancar

echo.
echo ================================================
echo   NO SE PUDO PARAR EL POLYBOT QUE YA CORRIA
echo ================================================
echo.
echo El proceso %EXISTING_PID% sigue ocupando el puerto 8787.
echo Lo normal es que lo lanzara la tarea programada PolybotWatchdog, que corre
echo en la sesion 0 y no se deja matar desde aqui sin permisos de administrador.
echo.
echo Que hacer: cierra esta ventana y abre este mismo archivo con boton derecho
echo y "Ejecutar como administrador".
echo.
echo NO se arranca nada. Arrancar ahora dejaria el codigo viejo corriendo y
echo pareceria que los cambios estan aplicados cuando no lo estan.
echo.
pause
exit /b 1

:arrancar

start "Polybot Browser Opener" cmd /c "timeout /t 5 /nobreak >nul & start "" http://127.0.0.1:8787"

set "TSIP=100.99.240.111"
for /f "tokens=*" %%a in ('tailscale ip -4 2^>nul') do set "TSIP=%%a"

echo Abriendo en esta PC: http://127.0.0.1:8787
echo.
echo ================================================
echo   EN TU CELULAR (con Tailscale activo) abre:
echo       http://%TSIP%:8787
echo ================================================
echo.
echo La simulacion arrancara automaticamente. Para detener todo, cierra esta ventana o usa Ctrl+C.
echo.

call npm run ui:sim
pause
exit /b 0

REM Deja en EXISTING_PID el PID que escucha en 8787, o sin definir si no hay ninguno.
:puerto8787
set EXISTING_PID=
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":8787" ^| findstr "LISTENING"') do set EXISTING_PID=%%a
goto :eof

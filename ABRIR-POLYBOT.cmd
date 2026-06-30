@echo off
setlocal
cd /d "%~dp0"

echo.
echo Abriendo Polybot sin autoarrancar el bot...
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js no esta instalado o no esta en PATH.
  pause
  exit /b 1
)

if not exist ".env" (
  copy ".env.example" ".env" >nul
)

if not exist ".mcp.json" (
  copy ".mcp.json.example" ".mcp.json" >nul
)

if not exist "node_modules" (
  call npm install
  if errorlevel 1 (
    pause
    exit /b 1
  )
)

set EXISTING_PID=
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":8787" ^| findstr "LISTENING"') do set EXISTING_PID=%%a
if defined EXISTING_PID (
  echo Reiniciando Polybot para cargar cambios nuevos...
  taskkill /PID %EXISTING_PID% /F >nul 2>nul
  timeout /t 2 /nobreak >nul
)

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

call npm run ui
pause

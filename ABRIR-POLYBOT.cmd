@echo off
setlocal
cd /d "%~dp0"

set POLYBOT_UI_HOST=0.0.0.0
set MODE=sim

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js no esta instalado o no esta en PATH.
  pause
  exit /b 1
)

if not exist ".env" (
  copy ".env.example" ".env" >nul
)

if not exist "node_modules" (
  call npm install
  if errorlevel 1 (
    pause
    exit /b 1
  )
)

if not exist "dist\src\index.js" (
  call npm run build
  if errorlevel 1 (
    echo ERROR al compilar TypeScript.
    pause
    exit /b 1
  )
)

:: Matar procesos previos en puerto 8788
set EXISTING_PID=
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":8788" ^| findstr "LISTENING"') do set EXISTING_PID=%%a
if defined EXISTING_PID (
  taskkill /PID %EXISTING_PID% /F >nul 2>nul
  timeout /t 2 /nobreak >nul
)

:: Matar PIDs huerfanos del bot que hayan quedado
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":8999" ^| findstr "LISTENING"') do (
  taskkill /PID %%a /F >nul 2>nul
)

:: Arrancar el bot en modo sim, minimizado sin ventana
start "Polybot Bot" /MIN node dist/src/index.js --mode=%MODE% > bot_output.log 2>&1

:: Arrancar la UI en modo sim, minimizado sin ventana
start "Polybot UI" /MIN cmd /c "npx tsx src/ui/index.ts --auto-start=%MODE% > ui_output.log 2>&1"

:: Cerrar esta ventana cmd silenciosamente
exit
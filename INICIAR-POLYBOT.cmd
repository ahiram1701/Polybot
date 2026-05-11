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

set EXISTING_PID=
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":8787" ^| findstr "LISTENING"') do set EXISTING_PID=%%a
if defined EXISTING_PID (
  echo Reiniciando Polybot para cargar cambios nuevos...
  taskkill /PID %EXISTING_PID% /F >nul 2>nul
  timeout /t 2 /nobreak >nul
)

start "Polybot Browser Opener" cmd /c "timeout /t 5 /nobreak >nul & start "" http://127.0.0.1:8787"

echo Abriendo http://127.0.0.1:8787
echo La simulacion arrancara automaticamente. Para detener todo, cierra esta ventana o usa Ctrl+C.
echo.

call npm run ui:sim
pause

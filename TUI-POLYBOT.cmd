@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title Polybot TUI

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js no esta instalado o no esta en PATH.
  echo Instala Node.js 20 o superior y vuelve a abrir este archivo.
  pause
  exit /b 1
)

if not exist ".env" copy ".env.example" ".env" >nul
if not exist ".mcp.json" copy ".mcp.json.example" ".mcp.json" >nul

if not exist "node_modules" (
  echo Instalando dependencias. Esto puede tardar unos minutos la primera vez...
  call npm install
  if errorlevel 1 (
    echo No se pudieron instalar las dependencias.
    pause
    exit /b 1
  )
)

rem Ya hay un servidor escuchando en 8787? Si es asi NO lo tocamos (matarlo cortaria un live).
set SERVER_UP=
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":8787" ^| findstr "LISTENING"') do set SERVER_UP=1
if defined SERVER_UP goto run

echo Servidor no detectado. Levantandolo en segundo plano sin arrancar el bot...
start "Polybot Server" /min cmd /c "set NODE_OPTIONS=--max-old-space-size=3072&& npm run ui >> data\ui-console.log 2>&1"
echo Esperando a que el servidor responda...
powershell -NoProfile -Command "for($i=0;$i -lt 30;$i++){try{Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:8787/api/status' -TimeoutSec 2 | Out-Null; exit 0}catch{Start-Sleep -Seconds 1}}; exit 1"
if errorlevel 1 (
  echo El servidor no respondio a tiempo. Revisa data\ui-console.log
  pause
  exit /b 1
)
echo Servidor listo.

:run
rem Lanzar directamente con tsx (sin npm) para conservar la terminal interactiva.
call "node_modules\.bin\tsx.cmd" src\tui\index.ts
echo.
echo ==================================================
echo  La TUI se cerro (codigo %errorlevel%).
echo  Si no viste el panel, copia el texto de arriba.
echo ==================================================
pause

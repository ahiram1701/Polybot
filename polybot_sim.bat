@echo off
title Polybot SIM con UI
cd /d "C:\DEV\tests\Workspace de Yarbis\Polybot"
echo [%DATE% %TIME%] Arrancando Polybot modo SIM con UI (Express + bot integrado)...
npx tsx src/ui/index.ts --auto-start=sim
echo [%DATE% %TIME%] Polybot termino. Revisa la ventana por errores.
pause
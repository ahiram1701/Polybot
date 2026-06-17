@echo off
set NODE_ENV=production
set POLYBOT_MODE=sim
set POLYBOT_SIM_AUTOSTART=true
start /B /MIN "" "node" "dist\src\index.js"
# launch_sim.ps1 - Lanza Polybot modo sim CON UI/API via tsx
$workDir = "C:\DEV\tests\Workspace de Yarbis\Polybot"

Write-Output "[$(Get-Date -Format 'yyyy-MM-ddTHH:mm:ssK')] Lanzando Polybot modo sim con UI (Express + bot integrado)..."
$proc = Start-Process -FilePath "npx.cmd" -ArgumentList "tsx src/ui/index.ts --auto-start=sim" -WorkingDirectory $workDir -WindowStyle Hidden -PassThru
Write-Output "[$(Get-Date -Format 'yyyy-MM-ddTHH:mm:ssK')] Polybot lanzado PID: $($proc.Id)"
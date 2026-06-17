# PolyBot Analytics Analyzer
$ErrorActionPreference = 'Stop'
Write-Host "Cargando analytics.jsonl..."
$lines = Get-Content 'C:\DEV\tests\Polybot\data\analytics.jsonl'
Write-Host "Total lineas: $($lines.Count)"

# Parsear todas
$samples = @()
foreach ($line in $lines) {
    $obj = $line | ConvertFrom-Json
    if ($obj.type -eq 'analytics_sample') {
        $samples += $obj.sample
    }
}
$total = $samples.Count

Write-Host "`n=========================================="
Write-Host "  ANALISIS ESTADISTICO POLYBOT - RESUMEN"
Write-Host "=========================================="
Write-Host "Total samples analizados: $total"
Write-Host ""

# --- POR MERCADO ---
$markets = $samples | Group-Object { $_.market }
Write-Host "--- DISTRIBUCION POR MERCADO ---"
foreach ($m in $markets) {
    Write-Host "  $($m.Name): $($m.Count) muestras ($([math]::Round($m.Count/$total*100,1))%)"
}

# --- SENIALES ---
$withSignal = $samples | Where-Object { $_.signal -and $_.signal.direction }
$withResolution = $samples | Where-Object { $_.winningOutcome -and $_.winningOutcome -ne '' }
$signalResolved = $withSignal | Where-Object { $_.winningOutcome -and $_.winningOutcome -ne '' }

Write-Host "`n--- RESUMEN GENERAL ---"
Write-Host "Muestras con senial generada: $($withSignal.Count)"
Write-Host "Muestras con resolucion (cierre): $($withResolution.Count)"
Write-Host "Seniales con resolucion: $($signalResolved.Count)"

# --- WIN RATE REAL (senal vs resultado) ---
$correct = 0; $incorrect = 0
foreach ($s in $signalResolved) {
    $dir = $s.signal.direction
    $win = $s.winningOutcome
    if ($dir -eq $win) { $correct++ } else { $incorrect++ }
}
$totalResolvedSignals = $correct + $incorrect
if ($totalResolvedSignals -gt 0) {
    $wr = [math]::Round($correct / $totalResolvedSignals * 100, 1)
    Write-Host "`n--- WIN RATE (senal acertada) ---"
    Write-Host "  Aciertos: $correct / $totalResolvedSignals = $wr%"
    Write-Host "  Errores: $incorrect"
}

# --- WIN RATE POR MERCADO ---
Write-Host "`n--- WIN RATE POR MERCADO ---"
foreach ($m in $markets) {
    $tag = $m.Name
    $marketSignals = $m.Group | Where-Object { $_.signal -and $_.signal.direction -and $_.winningOutcome }
    $mCorrect = 0; $mTotal = 0
    foreach ($s in $marketSignals) {
        $mTotal++
        if ($s.signal.direction -eq $s.winningOutcome) { $mCorrect++ }
    }
    if ($mTotal -gt 0) {
        Write-Host "  $tag: $mCorrect/$mTotal = $([math]::Round($mCorrect/$mTotal*100,1))%"
    } else {
        Write-Host "  $tag: sin seniales con resolucion"
    }
}

# --- DISTANCIA USD AL MOMENTO DE SENIAL ---
$distances = @()
foreach ($s in $withSignal) {
    if ($s.signal.distanceUsd) { $distances += [math]::Abs($s.signal.distanceUsd) }
}
if ($distances.Count -gt 0) {
    $avgD = [math]::Round(($distances | Measure-Object -Average).Average, 2)
    $minD = [math]::Round(($distances | Measure-Object -Minimum).Minimum, 2)
    $maxD = [math]::Round(($distances | Measure-Object -Maximum).Maximum, 2)
    $medD = [math]::Round(($distances | Sort-Object)[[math]::Floor($distances.Count/2)], 2)
    Write-Host "`n--- DISTANCIA MINIMA USD (abs) ---"
    Write-Host "  Promedio: $avgD"
    Write-Host "  Mediana:  $medD"
    Write-Host "  Min: $minD | Max: $maxD"
}

# --- ENTRY WINDOW ---
$windows = @()
foreach ($s in $withSignal) {
    if ($s.signal.entryWindowSeconds) { $windows += $s.signal.entryWindowSeconds }
}
if ($windows.Count -gt 0) {
    $avgW = [math]::Round(($windows | Measure-Object -Average).Average, 1)
    $minW = ($windows | Measure-Object -Minimum).Minimum
    $maxW = ($windows | Measure-Object -Maximum).Maximum
    Write-Host "`n--- ENTRY WINDOW (segundos antes del cierre) ---"
    Write-Host "  Promedio: $avgW s"
    Write-Host "  Rango: $minW - $maxW s"
}

# --- DIRECCION DE SENIALES ---
$upCount = ($withSignal | Where-Object { $_.signal.direction -eq 'UP' }).Count
$downCount = ($withSignal | Where-Object { $_.signal.direction -eq 'DOWN' }).Count
Write-Host "`n--- DIRECCION DE SENIALES ---"
Write-Host "  UP: $upCount ($([math]::Round($upCount/$withSignal.Count*100,1))%)"
Write-Host "  DOWN: $downCount ($([math]::Round($downCount/$withSignal.Count*100,1))%)"

# --- SEÑALES GANADORAS POR DIRECCION ---
$upResolved = $withSignal | Where-Object { $_.signal.direction -eq 'UP' -and $_.winningOutcome }
$downResolved = $withSignal | Where-Object { $_.signal.direction -eq 'DOWN' -and $_.winningOutcome }
$upWin = ($upResolved | Where-Object { $_.signal.direction -eq $_.winningOutcome }).Count
$downWin = ($downResolved | Where-Object { $_.signal.direction -eq $_.winningOutcome }).Count
Write-Host "`n--- WIN RATE POR DIRECCION ---"
if ($upResolved.Count -gt 0) { Write-Host "  UP: $upWin/$($upResolved.Count) = $([math]::Round($upWin/$upResolved.Count*100,1))%" }
if ($downResolved.Count -gt 0) { Write-Host "  DOWN: $downWin/$($downResolved.Count) = $([math]::Round($downWin/$downResolved.Count*100,1))%" }

# --- FEE ESTIMADO (700 bps taker) ---
$feeRate = 0.07
Write-Host "`n--- IMPACTO DE FEES (700bps = 7% taker) ---"
Write-Host "  Fee por trade: $($feeRate*100)%"
Write-Host "  Sin fees: $wr% win rate"
$adjustedWR = $correct / $totalResolvedSignals * (1 - $feeRate) * 100
$adjustedWR = [math]::Round($adjustedWR, 1)
Write-Host "  Win rate ajustado por fee: $adjustedWR%"
Write-Host "  (Cada trade ganador paga ~$([math]::Round($feeRate*100,1))% al CLOB)"
Write-Host "  ROI estimado por cada $100: $((($correct/$totalResolvedSignals)*(1-$feeRate) - (1-$correct/$totalResolvedSignals))*100) USD"

# --- MAX ASK PRICE ---
$askPrices = @()
foreach ($s in $withSignal) {
    if ($s.signal.maxAskPrice) { $askPrices += $s.signal.maxAskPrice }
}
if ($askPrices.Count -gt 0) {
    $avgAsk = [math]::Round(($askPrices | Measure-Object -Average).Average, 4)
    $medAsk = [math]::Round(($askPrices | Sort-Object)[[math]::Floor($askPrices.Count/2)], 4)
    Write-Host "`n--- MAX ASK PRICE ---"
    Write-Host "  Promedio: $avgAsk"
    Write-Host "  Mediana:  $medAsk"
}

Write-Host "`n=========================================="
Write-Host "  ANALISIS COMPLETO"
Write-Host "=========================================="

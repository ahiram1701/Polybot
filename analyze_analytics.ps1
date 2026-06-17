$records = Get-Content 'C:\DEV\tests\Polybot\data\analytics.jsonl' | ForEach-Object { $_ | ConvertFrom-Json }
$samples = $records | Where-Object { $_.type -eq 'analytics_sample' }
$total = $samples.Count

Write-Host "=== ANALYTICS OVERVIEW ==="
Write-Host "Total registros: $total"

# Registros con trade ejecutado (tienen signal)
$withSignal = $samples | Where-Object { $_.sample.signal -and $_.sample.signal.direction }
Write-Host "Registros con trade ejecutado: $($withSignal.Count)"

# Registros con resolucion
$resolved = $samples | Where-Object { $_.sample.winningOutcome -eq 'UP' -or $_.sample.winningOutcome -eq 'DOWN' }
Write-Host "Registros con resolucion: $($resolved.Count)"

# Distribucion por mercado
$markets = $samples | Group-Object { $_.sample.market }
Write-Host "`n=== POR MERCADO ==="
foreach ($m in $markets) { Write-Host "$($m.Name): $($m.Count) muestras" }

# WIN RATE: seniales que acertaron
$withBoth = $withSignal | Where-Object { $_.sample.winningOutcome -eq 'UP' -or $_.sample.winningOutcome -eq 'DOWN' }
$correct = 0
$incorrect = 0
foreach ($s in $withBoth) {
    if ($s.sample.signal.direction -eq $s.sample.winningOutcome) { $correct++ } else { $incorrect++ }
}
$totalBoth = $withBoth.Count
$wr = if ($totalBoth -gt 0) { [math]::Round(($correct / $totalBoth) * 100, 1) } else { 0 }
Write-Host "`n=== WIN RATE GLOBAL (senal vs resolucion) ==="
Write-Host "Aciertos: $correct / $totalBoth = $wr%"

# WIN RATE POR MERCADO
Write-Host "`n=== WIN RATE POR MERCADO ==="
$marketGroups = $withBoth | Group-Object { $_.sample.market }
foreach ($mg in $marketGroups) {
    $totalM = $mg.Count
    $wonM = ($mg.Group | Where-Object { $_.sample.signal.direction -eq $_.sample.winningOutcome }).Count
    $wrM = if ($totalM -gt 0) { [math]::Round(($wonM / $totalM) * 100, 1) } else { 0 }
    Write-Host "$($mg.Name): $wonM/$totalM = $wrM%"
}

# Distancia USD al momento de senial
$distances = @()
foreach ($s in $withSignal) {
    if ($s.sample.signal.distanceUsd) { $distances += [math]::Abs($s.sample.signal.distanceUsd) }
}
if ($distances.Count -gt 0) {
    $avgD = [math]::Round(($distances | Measure-Object -Average).Average, 2)
    $minD = [math]::Round(($distances | Measure-Object -Minimum).Minimum, 2)
    $maxD = [math]::Round(($distances | Measure-Object -Maximum).Maximum, 2)
    Write-Host "`n=== DISTANCIA USD AL MOMENTO DE SENIAL ==="
    Write-Host "Promedio: $avgD | Min: $minD | Max: $maxD"
}

# EntryWindow
$windows = @()
foreach ($s in $withSignal) {
    if ($s.sample.signal.entryWindowSeconds) { $windows += $s.sample.signal.entryWindowSeconds }
}
if ($windows.Count -gt 0) {
    $avgW = [math]::Round(($windows | Measure-Object -Average).Average, 1)
    $minW = ($windows | Measure-Object -Minimum).Minimum
    $maxW = ($windows | Measure-Object -Maximum).Maximum
    Write-Host "`n=== ENTRY WINDOW (segundos) ==="
    Write-Host "Promedio: $avgW | Min: $minW | Max: $maxW"
}

# Direccion de seniales
$up = $withSignal | Where-Object { $_.sample.signal.direction -eq 'UP' }
$down = $withSignal | Where-Object { $_.sample.signal.direction -eq 'DOWN' }
Write-Host "`n=== DIRECCION DE SENIALES ==="
Write-Host "UP: $($up.Count) | DOWN: $($down.Count)"

# WIN RATE por direccion
$upCorrect = ($up | Where-Object { $_.sample.winningOutcome -eq 'UP' }).Count
$upTotal = ($up | Where-Object { $_.sample.winningOutcome -eq 'UP' -or $_.sample.winningOutcome -eq 'DOWN' }).Count
$downCorrect = ($down | Where-Object { $_.sample.winningOutcome -eq 'DOWN' }).Count
$downTotal = ($down | Where-Object { $_.sample.winningOutcome -eq 'UP' -or $_.sample.winningOutcome -eq 'DOWN' }).Count
$wrUp = if ($upTotal -gt 0) { [math]::Round(($upCorrect / $upTotal) * 100, 1) } else { 0 }
$wrDown = if ($downTotal -gt 0) { [math]::Round(($downCorrect / $downTotal) * 100, 1) } else { 0 }
Write-Host "UP WR: $upCorrect/$upTotal = $wrUp% | DOWN WR: $downCorrect/$downTotal = $wrDown%"

# Fechas
$dates = $samples | ForEach-Object { [DateTime]$_.at }
$minDate = ($dates | Measure-Object -Minimum).Minimum.ToString("yyyy-MM-dd HH:mm")
$maxDate = ($dates | Measure-Object -Maximum).Maximum.ToString("yyyy-MM-dd HH:mm")
Write-Host "`n=== PERIODO DE DATOS ==="
Write-Host "Desde: $minDate UTC | Hasta: $maxDate UTC"

# Precio promedio de apertura
$openPrices = @()
foreach ($s in $samples) {
    if ($s.sample.openingPrice) { $openPrices += $s.sample.openingPrice }
}
if ($openPrices.Count -gt 0) {
    $avgOpen = [math]::Round(($openPrices | Measure-Object -Average).Average, 2)
    Write-Host "`nPrecio apertura promedio: $$avgOpen"
}

# Resumen rapido
Write-Host "`n`n=== RESUMEN EJECUTIVO ==="
Write-Host "Muestras: $total | Trades ejecutados: $($withSignal.Count) | Resueltos: $($resolved.Count)"
if ($totalBoth -gt 0) { Write-Host "Win Rate Global: $wr% ($correct/$totalBoth)" }
Write-Host "Señales UP: $($up.Count) | DOWN: $($down.Count)"
if ($distances.Count -gt 0) { Write-Host "Distancia promedio: ${avgD} USD" }
if ($windows.Count -gt 0) { Write-Host "EntryWindow promedio: ${avgW}s" }

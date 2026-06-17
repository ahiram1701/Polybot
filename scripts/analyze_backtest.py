#!/usr/bin/env python3
"""Analiza analytics.jsonl para backtesting: win rate, distancias, ROI, fees."""
import json
import sys
from pathlib import Path
from collections import defaultdict

DATA = Path(r"C:\DEV\tests\Polybot\data\analytics.jsonl")
FEE_TAKER_BPS = 700  # 7% taker fee
FEE_TAKER = FEE_TAKER_BPS / 10000  # 0.07
INVESTMENT_PER_TRADE = 10.0  # supuesto $10 por trade para calcular ROI con fees

records = []
with open(DATA) as f:
    for line in f:
        line = line.strip()
        if line:
            records.append(json.loads(line))

samples = [r for r in records if r.get("type") == "analytics_sample"]
print(f"Total registros: {len(records)}")
print(f"Muestras analytics: {len(samples)}")

# Resueltos y con señal
with_signal = [s for s in samples if s.get("sample", {}).get("signal")]
resolved = [s for s in samples if s.get("sample", {}).get("winningOutcome")]
with_both = [s for s in with_signal if s["sample"].get("winningOutcome")]

print(f"\n--- VISIÓN GENERAL ---")
print(f"Con señal ejecutada: {len(with_signal)}")
print(f"Con resolución (outcome conocido): {len(resolved)}")
print(f"Señales con resolución: {len(with_both)}")

# Período
dates = [s["at"] for s in samples]
print(f"\nPeríodo de datos: {min(dates)[:19]} → {max(dates)[:19]}")

# Por mercado
by_market = defaultdict(list)
for s in samples:
    m = s["sample"].get("market", "unknown")
    by_market[m].append(s)

print(f"\n--- POR MERCADO ---")
for m, items in sorted(by_market.items()):
    print(f"  {m}: {len(items)} muestras")

# Win rate real de señales ejecutadas
print(f"\n--- SEÑALES VS RESULTADOS (WIN RATE REAL) ---")
correct = 0
for s in with_both:
    dir_ = s["sample"]["signal"].get("direction")
    win = s["sample"]["winningOutcome"]
    if dir_ == win:
        correct += 1

total_sig = len(with_both)
if total_sig > 0:
    wr_pct = correct / total_sig * 100
    print(f"  Aciertos: {correct}/{total_sig} = {wr_pct:.1f}%")
else:
    print("  No hay señales con resolución")

# Win rate por mercado
print(f"\n--- WIN RATE POR MERCADO ---")
for m, items in sorted(by_market.items()):
    sig_wins = [s for s in items if s.get("sample", {}).get("signal") and s["sample"].get("winningOutcome")]
    if not sig_wins:
        continue
    wins = sum(1 for s in sig_wins if s["sample"]["signal"].get("direction") == s["sample"]["winningOutcome"])
    print(f"  {m}: {wins}/{len(sig_wins)} = {wins/len(sig_wins)*100:.1f}%")

# Direcciones
up = [s for s in with_signal if s["sample"]["signal"].get("direction") == "UP"]
down = [s for s in with_signal if s["sample"]["signal"].get("direction") == "DOWN"]
print(f"\n--- DIRECCIÓN ---")
print(f"  UP: {len(up)} | DOWN: {len(down)}")

# Distancia en el momento de señal
dists = [abs(s["sample"]["signal"].get("distanceUsd", 0)) for s in with_signal if s["sample"]["signal"].get("distanceUsd") is not None]
if dists:
    print(f"\n--- DISTANCIA USD AL MOMENTO DE SEÑAL ---")
    print(f"  Promedio: ${sum(dists)/len(dists):.2f}")
    print(f"  Mediana: ${sorted(dists)[len(dists)//2]:.2f}")
    print(f"  Min: ${min(dists):.2f} | Max: ${max(dists):.2f}")
    print(f"  P25: ${sorted(dists)[int(len(dists)*0.25)]:.2f} | P75: ${sorted(dists)[int(len(dists)*0.75)]:.2f}")

# Entry window
windows = [s["sample"]["signal"].get("entryWindowSeconds", 0) for s in with_signal if s["sample"]["signal"].get("entryWindowSeconds")]
if windows:
    print(f"\n--- ENTRY WINDOW (segundos) ---")
    print(f"  Promedio: {sum(windows)/len(windows):.1f}s")
    print(f"  Min: {min(windows)}s | Max: {max(windows)}s")

# Distancia mínima configurada
min_dists = [s["sample"]["signal"].get("minDistanceUsd", 0) for s in with_signal if s["sample"]["signal"].get("minDistanceUsd")]
if min_dists:
    print(f"\n--- MIN DISTANCE USD CONFIG ---")
    print(f"  Promedio: ${sum(min_dists)/len(min_dists):.2f}")
    print(f"  Min: ${min(min_dists):.2f} | Max: ${max(min_dists):.2f}")

# ROI con fees (simulación: inviertes $10 por trade, fee 7% taker)
print(f"\n--- ROI SIMULADO (supuesto ${INVESTMENT_PER_TRADE}/trade, fee {FEE_TAKER_BPS}bps) ---")
if total_sig > 0 and dists:
    # Ganancia neta estimada
    gross_per_trade = INVESTMENT_PER_TRADE  # asumiendo que compras 1 contrato
    fee_cost = gross_per_trade * FEE_TAKER
    net_per_trade = gross_per_trade - fee_cost
    won_trades = correct
    lost_trades = total_sig - correct
    # En Polymarket si aciertas ~ganas ~$0.7-1 por $1 invertido (odds variables)
    # Simplificamos: si ganas, ganas net_investment - fee; si pierdes, pierdes investment
    # Con ganancia estimada de 1:1 en odds (improbable, pero para estimar)
    # Normalmente el payout es ~0.5-0.98 por dólar según orderbook
    # Tomamos payout promedio conservador de 0.85 (ganas 85c por $1 invertido)
    PAYOUT_AVG = 0.85
    total_invested = total_sig * INVESTMENT_PER_TRADE
    total_fees = total_sig * fee_cost
    gross_wins = won_trades * INVESTMENT_PER_TRADE * PAYOUT_AVG
    total_losses = lost_trades * INVESTMENT_PER_TRADE
    net_pnl = gross_wins - total_losses - total_fees
    roi_pct = (net_pnl / total_invested) * 100 if total_invested > 0 else 0
    print(f"  Total invertido: ${total_invested:.2f}")
    print(f"  Total fees ({FEE_TAKER_BPS}bps): ${total_fees:.2f}")
    print(f"  Ganancias brutas (payout {PAYOUT_AVG:.0%}): ${gross_wins:.2f}")
    print(f"  Pérdidas: ${total_losses:.2f}")
    print(f"  PnL neto: ${net_pnl:.2f}")
    print(f"  ROI: {roi_pct:+.2f}%")
    print(f"  ROI ajustado por fees: {roi_pct:+.2f}%")

# Análisis de profundidad de orderbook
ob_ticks = sum(1 for s in samples if s["sample"].get("orderbookTicks"))
spreads = []
for s in samples:
    ticks = s["sample"].get("orderbookTicks", [])
    for t in ticks:
        up_ask = t.get("upBestAsk")
        up_bid = t.get("upBestBid")
        if up_ask and up_bid:
            spreads.append((up_ask - up_bid) * 100)  # como porcentaje

if spreads:
    print(f"\n--- SPREAD PROMEDIO UP ---")
    print(f"  Promedio: {sum(spreads)/len(spreads):.1f}%")
    print(f"  Mediana: {sorted(spreads)[len(spreads)//2]:.1f}%")

# Resumen de señales exitosas
print(f"\n--- DISTRIBUCIÓN DE GANANCIAS/PÉRDIDAS ---")
print(f"  Trades ganados: {correct}")
print(f"  Trades perdidos: {total_sig - correct}")
if correct > 0:
    avg_payout = PAYOUT_AVG * INVESTMENT_PER_TRADE
    print(f"  Ganancia promedio estimada por trade ganado: ${avg_payout:.2f}")
    print(f"  Pérdida promedio por trade perdido: ${INVESTMENT_PER_TRADE:.2f}")

# Recomendaciones
print(f"\n{'='*60}")
print("RECOMENDACIONES BASADAS EN BACKTESTING")
print("="*60)
if total_sig >= 50 and wr_pct >= 55:
    print("✅ Win rate suficiente para pasar a live con capital pequeño ($10-25/trade)")
elif total_sig >= 50:
    print("⚠️  Win rate bajo. Ajustar minDistanceUsd o entryWindow antes de live")
else:
    print("⚠️  Pocas señales con resolución para conclusión estadística robusta")

print(f"\n📊 Estadísticas: {total_sig} trades analizados | {wr_pct:.1f}% win rate")
print(f"📈 ROI estimado: {roi_pct:+.2f}% (fee {FEE_TAKER_BPS}bps, payout {PAYOUT_AVG:.0%})")
print(f"💡 Siguiente paso: probar arranque en modo simulación para verificar integridad del bot")

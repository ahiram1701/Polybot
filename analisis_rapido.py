import json
from collections import defaultdict

records = []
with open('data/analytics.jsonl', 'r') as f:
    for line in f:
        line = line.strip()
        if line:
            records.append(json.loads(line))

print(f'Total registros: {len(records)}', flush=True)

markets = {}
for r in records:
    m = r['sample']['market']
    markets[m] = markets.get(m, 0) + 1

print('\n=== DISTRIBUCIÓN POR MERCADO ===', flush=True)
for m, c in sorted(markets.items(), key=lambda x: -x[1]):
    print(f'{m}: {c} muestras ({c/len(records)*100:.1f}%)', flush=True)

market_movements = defaultdict(list)

for r in records:
    s = r['sample']
    m = s['market']
    ticks = s.get('ticks', [])
    if ticks:
        max_dist = max(abs(t['distanceUsd']) for t in ticks)
        market_movements[m].append(max_dist)

print('\n=== MOVIMIENTO MÁXIMO ABSOLUTO POR VENTANA ===', flush=True)
for m in sorted(market_movements.keys()):
    vals = market_movements[m]
    vals_sorted = sorted(vals)
    avg = sum(vals) / len(vals)
    p50 = vals_sorted[len(vals)//2]
    p90 = vals_sorted[int(len(vals)*0.9)]
    p95 = vals_sorted[int(len(vals)*0.95)]
    p99 = vals_sorted[int(len(vals)*0.99)]
    print(f'{m}:', flush=True)
    print(f'  Prom=${avg:.2f} | Mediana=${p50:.2f} | P90=${p90:.2f} | P95=${p95:.2f} | P99=${p99:.2f}', flush=True)
    print(f'  Max=${max(vals):.2f} | Min=${min(vals):.2f}', flush=True)

print('\n=== WIN RATE SIMULADO POR UMBRAL ===', flush=True)

btc = [r for r in records if r['sample']['market'] == 'BTC']
eth = [r for r in records if r['sample']['market'] == 'ETH']
doge = [r for r in records if r['sample']['market'] == 'DOGE']

for label, recs in [('BTC', btc), ('ETH', eth), ('DOGE', doge)]:
    if label == 'BTC':
        thresholds = [5, 8, 10, 12, 15, 20, 25, 30, 40]
    elif label == 'ETH':
        thresholds = [1, 2, 3, 4, 5, 7, 10]
    else:
        thresholds = [0.0001, 0.0002, 0.0003, 0.0005, 0.001, 0.002]
    
    print(f'\n--- {label} ---', flush=True)
    print(f'Threshold  | Señales | Wins | WinRate | Cobertura', flush=True)
    for th in thresholds:
        signals = 0
        wins = 0
        for r in recs:
            s = r['sample']
            ticks = s.get('ticks', [])
            if not ticks: continue
            wo = s.get('winningOutcome')
            if not wo: continue
            st = None
            for t in ticks:
                if abs(t['distanceUsd']) >= th:
                    st = t
                    break
            if st:
                signals += 1
                direction = 'UP' if st['distanceUsd'] > 0 else 'DOWN'
                if direction == wo: wins += 1
        wr = (wins/signals*100) if signals > 0 else 0
        cov = signals/len(recs)*100
        print(f'  ${th:<8} | {signals:>7} | {wins:>4} | {wr:>6.1f}% | {cov:>5.0f}%', flush=True)
        if signals == 0 and th != thresholds[0]:
            break

print('\n=== DIRECCIÓN NATURAL DEL MERCADO (resultados reales) ===', flush=True)
for label, recs in [('BTC', btc), ('ETH', eth), ('DOGE', doge)]:
    up = sum(1 for r in recs if r['sample'].get('winningOutcome') == 'UP')
    down = sum(1 for r in recs if r['sample'].get('winningOutcome') == 'DOWN')
    total = len(recs)
    print(f'{label}: UP={up} ({up/total*100:.1f}%) | DOWN={down} ({down/total*100:.1f}%) | Total={total}', flush=True)

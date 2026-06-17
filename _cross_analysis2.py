import json
from collections import defaultdict

samples = []
with open('data/analytics.jsonl', 'r', encoding='utf-8') as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        d = json.loads(line)
        samples.append(d['sample'])

# Analisis de distancias reales del primer tick
print('=== DISTRIBUCION DE DISTANCIAS PRIMER TICK (BTC) ===')
btc_dists = []
for s in samples:
    if s['market'] == 'BTC' and s['ticks']:
        ft = s['ticks'][0]
        dist = abs(ft['price'] - s['openingPrice'])
        btc_dists.append(dist)

btc_dists.sort()
n = len(btc_dists)
print(f'Total BTC samples con ticks: {n}')
print(f'Min: {min(btc_dists):.2f}')
print(f'Max: {max(btc_dists):.2f}')
print(f'Avg: {sum(btc_dists)/n:.2f}')
print(f'Mediana: {btc_dists[n//2]:.2f}')
print(f'P10: {btc_dists[int(n*0.1)]:.2f}')
print(f'P25: {btc_dists[int(n*0.25)]:.2f}')
print(f'P75: {btc_dists[int(n*0.75)]:.2f}')
print(f'P90: {btc_dists[int(n*0.9)]:.2f}')
print(f'P95: {btc_dists[int(n*0.95)]:.2f}')
print(f'P99: {btc_dists[int(n*0.99)]:.2f}')

# Cuantas veces el primer tick esta a distancia >= 5?
gt5 = sum(1 for d in btc_dists if d >= 5)
print(f'Dist >= 5: {gt5} ({gt5/n*100:.1f}%)')
gt10 = sum(1 for d in btc_dists if d >= 10)
print(f'Dist >= 10: {gt10} ({gt10/n*100:.1f}%)')
gt50 = sum(1 for d in btc_dists if d >= 50)
print(f'Dist >= 50: {gt50} ({gt50/n*100:.1f}%)')
gt100 = sum(1 for d in btc_dists if d >= 100)
print(f'Dist >= 100: {gt100} ({gt100/n*100:.1f}%)')

# Para DOGE y ETH
for m in ['DOGE', 'ETH']:
    print(f'\n=== DISTRIBUCION DE DISTANCIAS PRIMER TICK ({m}) ===')
    dists = []
    for s in samples:
        if s['market'] == m and s['ticks']:
            ft = s['ticks'][0]
            dist = abs(ft['price'] - s['openingPrice'])
            dists.append(dist)
    dists.sort()
    n2 = len(dists)
    print(f'Total {m} samples con ticks: {n2}')
    print(f'Min: {min(dists):.6f}')
    print(f'Max: {max(dists):.6f}')
    print(f'Avg: {sum(dists)/n2:.6f}')
    print(f'Mediana: {dists[n2//2]:.6f}')
    print(f'P10: {dists[int(n2*0.1)]:.6f}')
    print(f'P25: {dists[int(n2*0.25)]:.6f}')
    print(f'P75: {dists[int(n2*0.75)]:.6f}')
    print(f'P90: {dists[int(n2*0.9)]:.6f}')
    print(f'P95: {dists[int(n2*0.95)]:.6f}')
    print(f'P99: {dists[int(n2*0.99)]:.6f}')

print('\nEND')

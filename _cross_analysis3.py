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

# Cuantas oportunidades se pierden con dist=5 en BTC?
# Una oportunidad = el primer tick esta a <= dist del opening
# Si el bot requiere que el primer tick este DENTRO de dist para considerar entry,
# entonces con dist=5 solo entraria en el ~6.7% de los casos (los que tienen dist < 5)

print('=== OPORTUNIDADES PERDIDAS CON dist=5 (BTC) ===')
btc = [s for s in samples if s['market'] == 'BTC' and s['ticks']]
total = len(btc)
within5 = sum(1 for s in btc if abs(s['ticks'][0]['price'] - s['openingPrice']) < 5)
print(f'Total BTC samples: {total}')
print(f'Primer tick dentro de $5 del open: {within5} ({within5/total*100:.1f}%)')
print(f'Primer tick FUERA de $5: {total-within5} ({(total-within5)/total*100:.1f}%)')
print(f'-> Con dist=5 SOLO entrarias en {within5/total*100:.1f}% de las oportunidades')

# Y con dist=10?
within10 = sum(1 for s in btc if abs(s['ticks'][0]['price'] - s['openingPrice']) < 10)
print(f'\nCon dist=10: {within10} ({within10/total*100:.1f}%)')
within20 = sum(1 for s in btc if abs(s['ticks'][0]['price'] - s['openingPrice']) < 20)
print(f'Con dist=20: {within20} ({within20/total*100:.1f}%)')
within30 = sum(1 for s in btc if abs(s['ticks'][0]['price'] - s['openingPrice']) < 30)
print(f'Con dist=30: {within30} ({within30/total*100:.1f}%)')
within40 = sum(1 for s in btc if abs(s['ticks'][0]['price'] - s['openingPrice']) < 40)
print(f'Con dist=40: {within40} ({within40/total*100:.1f}%)')
within50 = sum(1 for s in btc if abs(s['ticks'][0]['price'] - s['openingPrice']) < 50)
print(f'Con dist=50: {within50} ({within50/total*100:.1f}%)')

# Y si el primer tick esta a <= dist, cual es el winrate?
print('\n=== WINRATE POR RANGO DE DISTANCIA (BTC) ===')
for threshold in [5, 10, 20, 30, 40, 50, 100]:
    subset = [s for s in btc if abs(s['ticks'][0]['price'] - s['openingPrice']) < threshold]
    wins = sum(1 for s in subset if s['winningOutcome'] == 'UP')
    print(f'Dist < {threshold}: {len(subset)} samples, winrate={wins/len(subset)*100:.1f}%')

# Y fuera de esos rangos?
for threshold in [5, 10, 20, 30, 40, 50, 100]:
    subset = [s for s in btc if abs(s['ticks'][0]['price'] - s['openingPrice']) >= threshold]
    if subset:
        wins = sum(1 for s in subset if s['winningOutcome'] == 'UP')
        print(f'Dist >= {threshold}: {len(subset)} samples, winrate={wins/len(subset)*100:.1f}%')

print('\nEND')

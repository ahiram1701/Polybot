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

print(f'TOTAL_SAMPLES:{len(samples)}')

# 1. Outcome distribution por mercado
stats = defaultdict(lambda: {'total': 0, 'up': 0, 'down': 0})
for s in samples:
    m = s['market']
    stats[m]['total'] += 1
    if s['winningOutcome'] == 'UP':
        stats[m]['up'] += 1
    else:
        stats[m]['down'] += 1

print('=== OUTCOME_DISTRIBUTION ===')
for m in sorted(stats.keys()):
    st = stats[m]
    print(f'{m}: total={st["total"]}, UP={st["up"]}({st["up"]/st["total"]*100:.1f}%), DOWN={st["down"]}({st["down"]/st["total"]*100:.1f}%)')

# 2. Rango de precios
print('=== PRICE_RANGES ===')
for m in sorted(stats.keys()):
    prices = [s['openingPrice'] for s in samples if s['market'] == m]
    print(f'{m}: min={min(prices):.4f}, max={max(prices):.4f}, avg={sum(prices)/len(prices):.4f}')

# 3. Distancia promedio del primer tick
print('=== FIRST_TICK_DISTANCE_SAMPLE ===')
count = 0
for s in samples:
    if s['ticks'] and count < 20:
        ft = s['ticks'][0]
        dist = abs(ft['price'] - s['openingPrice'])
        print(f'{s["market"]} {s["winningOutcome"]}: open={s["openingPrice"]:.4f}, first_tick={ft["price"]:.4f}, dist={dist:.4f}, secs_to_end={ft["secondsToEnd"]}')
        count += 1

# 4. Ticks promedio por mercado
print('=== AVG_TICKS_QUOTES ===')
for m in sorted(stats.keys()):
    m_samples = [s for s in samples if s['market'] == m]
    avg_ticks = sum(len(s['ticks']) for s in m_samples) / len(m_samples)
    avg_quotes = sum(len(s['quotes']) for s in m_samples) / len(m_samples)
    print(f'{m}: avg_ticks={avg_ticks:.1f}, avg_quotes={avg_quotes:.1f}')

print('END')

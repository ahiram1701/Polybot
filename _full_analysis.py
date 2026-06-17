import json, os, sys

total = 0
min_ms = float('inf')
max_ms = 0
dist = {}
runs = {}

with open('data/analytics.jsonl', 'r', encoding='utf-8') as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        total += 1
        d = json.loads(line)
        s = d['sample']
        ws = s['windowStartMs']
        if ws < min_ms:
            min_ms = ws
        if ws > max_ms:
            max_ms = ws
        k = s['market'] + '_' + s['winningOutcome']
        if k not in dist:
            dist[k] = {'c': 0, 'ticks': 0, 'quotes': 0}
        dist[k]['c'] += 1
        dist[k]['ticks'] += len(s['ticks'])
        dist[k]['quotes'] += len(s['quotes'])
        from datetime import datetime
        hour = datetime.fromtimestamp(ws / 1000).strftime('%Y-%m-%dT%H')
        if hour not in runs:
            runs[hour] = {'c': 0, 'markets': {}}
        runs[hour]['c'] += 1
        if k not in runs[hour]['markets']:
            runs[hour]['markets'][k] = 0
        runs[hour]['markets'][k] += 1

lines = []
lines.append(f'TOTAL_MUESTRAS:{total}')
lines.append(f'DESDE:{datetime.fromtimestamp(min_ms / 1000).isoformat()}')
lines.append(f'HASTA:{datetime.fromtimestamp(max_ms / 1000).isoformat()}')
lines.append('=== DISTRIBUCION GLOBAL ===')
for k in sorted(dist.keys()):
    d = dist[k]
    lines.append(f'{k}: {d["c"]} periodos, {d["ticks"]} ticks, {d["quotes"]} quotes')
lines.append('=== MUESTRAS POR HORA ===')
for k in sorted(runs.keys()):
    r = runs[k]
    m = ' '.join([f'{mk}:{r["markets"][mk]}' for mk in sorted(r['markets'].keys())])
    lines.append(f'{k}Z: {r["c"]} {{{m}}}')
lines.append('END')

with open('_full_analysis_result.txt', 'w', encoding='utf-8') as of:
    of.write('\n'.join(lines))
print('OK')
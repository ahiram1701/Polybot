import json
from datetime import datetime, timezone

with open(r'C:\DEV\tests\Workspace de Yarbis\Polybot\trades_dump.json') as f:
    d = json.load(f)
trades = d['trades']
print(f'Total trades: {len(trades)}')

ts_ms = [t['createdAtMs'] for t in trades]
earliest = datetime.fromtimestamp(min(ts_ms)/1000, tz=timezone.utc)
latest = datetime.fromtimestamp(max(ts_ms)/1000, tz=timezone.utc)
print(f'Rango: {earliest.strftime("%Y-%m-%d %H:%M UTC")} -> {latest.strftime("%Y-%m-%d %H:%M UTC")}')

assets = set(t['asset'] for t in trades)
print(f'Assets: {assets}')

won = sum(1 for t in trades if t['resolved']['won'])
lost = sum(1 for t in trades if t['resolved'] and not t['resolved']['won'])
pending = sum(1 for t in trades if not t.get('resolved'))
print(f'Won: {won}, Lost: {lost}, Pending: {pending}')
if won+lost > 0:
    print(f'WR: {won/(won+lost)*100:.1f}%')

# Post-último reset: 14 Jun ~04:43 MX = 1781433780000
reset_ms = 1781433780000
post_reset = [t for t in trades if t['createdAtMs'] >= reset_ms]
print(f'\nPost-reset (desde 14 Jun ~04:43 MX): {len(post_reset)} trades')
won_pr = sum(1 for t in post_reset if t['resolved']['won'])
lost_pr = sum(1 for t in post_reset if t['resolved'] and not t['resolved']['won'])
pending_pr = sum(1 for t in post_reset if not t.get('resolved'))
print(f'  Won: {won_pr}, Lost: {lost_pr}, Pending: {pending_pr}')
if won_pr+lost_pr > 0:
    print(f'  WR post-reset: {won_pr/(won_pr+lost_pr)*100:.1f}%')

# maxAskPrice distribution
old_max = sum(1 for t in trades if t.get('maxAskPrice', 0) <= 0.6)
new_max = sum(1 for t in trades if t.get('maxAskPrice', 0) >= 0.75)
print(f'\nmaxAskPrice <= 0.6: {old_max}')
print(f'maxAskPrice >= 0.75: {new_max}')

# Trades de hoy (15 Jun 2026 MX = UTC-6)
hoy_inicio_ms = int(datetime(2026, 6, 15, 0, 0, 0, tzinfo=timezone.utc).timestamp() * 1000) + 6*3600*1000  # UTC-6
hoy = [t for t in trades if t['createdAtMs'] >= hoy_inicio_ms]
print(f'\nTrades de HOY 15 Jun: {len(hoy)} trades')
won_hoy = sum(1 for t in hoy if t['resolved']['won'])
lost_hoy = sum(1 for t in hoy if t['resolved'] and not t['resolved']['won'])
print(f'  Won: {won_hoy}, Lost: {lost_hoy}')
if won_hoy+lost_hoy > 0:
    print(f'  WR hoy: {won_hoy/(won_hoy+lost_hoy)*100:.1f}%')
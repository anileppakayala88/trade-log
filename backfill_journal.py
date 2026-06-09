"""Backfill docs/journal.jsonl from existing docs/trades.json data."""
import json
from datetime import datetime

POINT_VALUES = {"MNQ1!": 2, "MGC1!": 10, "MES1!": 5, "NQ1!": 20, "ES1!": 50}

with open('docs/trades.json', encoding='utf-8') as f:
    data = json.load(f)

closed_trades = data['closedTrades']   # newest-first
logs = data['logs']                    # newest-first

# Sort logs oldest-first
logs_sorted = sorted(logs, key=lambda l: l['time'])

# Deduplicate: TradingView fires each webhook twice within ~10 seconds.
# Keep the one that succeeded (has result, no error). If both failed keep first.
deduped = []
for log in logs_sorted:
    if not deduped:
        deduped.append(log)
        continue
    prev = deduped[-1]
    pp, p = prev['payload'], log['payload']
    dt = (datetime.fromisoformat(log['time'].replace('Z', '+00:00')) -
          datetime.fromisoformat(prev['time'].replace('Z', '+00:00'))).total_seconds()
    is_dup = (
        pp.get('ticker') == p.get('ticker') and
        pp.get('action') == p.get('action') and
        pp.get('price') == p.get('price') and
        dt < 15
    )
    if is_dup:
        if log.get('result') and not log.get('error'):
            deduped[-1] = log
        continue
    deduped.append(log)

def ts(s):
    return datetime.fromisoformat(s.replace('Z', '+00:00'))

journal_lines = []

for log in deduped:
    p        = log['payload']
    action   = p.get('action')
    ticker   = p.get('ticker')
    strategy = log.get('strategy')
    result   = log.get('result') or ''
    error    = log.get('error')

    if error:
        continue

    if action in ('buy', 'sell'):
        trade_id = None
        for trade in closed_trades:
            if trade['ticker'] == ticker:
                if abs((ts(trade['entryTime']) - ts(log['time'])).total_seconds()) < 5:
                    trade_id = trade['id']
                    break

        journal_lines.append(json.dumps({
            'signal_id':    trade_id,
            'timestamp':    log['time'],
            'message_type': 'new_signal',
            'source':       'TradingView',
            'strategy':     strategy,
            'instrument':   ticker,
            'direction':    action.upper(),
            'order_type':   'market',
            'entry':        p.get('price'),
            'qty':          p.get('qty', 1),
            'sl':           p.get('sl'),
            'tp':           [v for v in [p.get('tp1'), p.get('tp2'), p.get('tp3')] if v is not None],
            'tp_qty':       [v for v in [p.get('tp1_qty'), p.get('tp2_qty'), p.get('tp3_qty')] if v is not None],
            'parse_status': 'parsed',
        }))

    elif action == 'exit' and 'closed trade' in result:
        trade_id = pnl = result_str = entry_price = None
        for trade in closed_trades:
            if trade['ticker'] == ticker:
                if abs((ts(trade['closeTime']) - ts(log['time'])).total_seconds()) < 5:
                    trade_id    = trade['id']
                    pnl         = trade['pnl']
                    result_str  = trade['result']
                    entry_price = trade['entryPrice']
                    break

        exit_price  = p.get('price')
        pv          = POINT_VALUES.get(ticker, 1)
        qty         = p.get('qty')
        if entry_price is not None and exit_price is not None:
            raw_pts = exit_price - entry_price  # positive = price went up
            # direction-adjusted: BUY profits when price rises, SELL profits when price falls
            direction = 'buy'
            for trade in closed_trades:
                if trade.get('id') == trade_id:
                    direction = trade.get('direction', 'buy')
                    break
            points = raw_pts if direction == 'buy' else -raw_pts
            points = round(points, 4)
        else:
            points = None

        journal_lines.append(json.dumps({
            'signal_id':    trade_id,
            'timestamp':    log['time'],
            'message_type': 'trade_update',
            'source':       'TradingView',
            'strategy':     strategy,
            'instrument':   ticker,
            'update_type':  'exit',
            'entry_price':  entry_price,
            'exit_price':   exit_price,
            'exit_qty':     qty,
            'points':       points,
            'point_value':  pv,
            'pnl':          pnl,
            'result':       result_str,
        }))

with open('docs/journal.jsonl', 'w', encoding='utf-8') as f:
    f.write('\n'.join(journal_lines) + '\n')

print(f"Written {len(journal_lines)} journal entries to docs/journal.jsonl")

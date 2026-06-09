import json

rows = []
with open('docs/journal.jsonl', encoding='utf-8') as f:
    for line in f:
        line = line.strip()
        if line:
            rows.append(json.loads(line))

rows.sort(key=lambda r: r['timestamp'])
data_js = json.dumps(rows, ensure_ascii=False)

html = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Trade Log Journal</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Segoe UI',system-ui,sans-serif;background:#0d1117;color:#c9d1d9;min-height:100vh}

header{background:#161b22;border-bottom:1px solid #21262d;padding:14px 24px;display:flex;align-items:center;gap:16px;flex-wrap:wrap}
h1{font-size:1.1rem;font-weight:600;color:#e6edf3}
.pill{font-size:.72rem;padding:2px 9px;border-radius:20px;background:#21262d;color:#8b949e;font-weight:600}

.summary{display:flex;gap:0;background:#161b22;border-bottom:2px solid #21262d;overflow-x:auto}
.stat{display:flex;flex-direction:column;align-items:center;padding:10px 22px;gap:2px;border-right:1px solid #21262d}
.stat:last-child{border-right:none}
.stat-val{font-size:1.4rem;font-weight:700}
.stat-lbl{font-size:.62rem;color:#6e7681;text-transform:uppercase;letter-spacing:.06em;white-space:nowrap}

.controls{background:#0d1117;border-bottom:1px solid #21262d;padding:9px 20px;display:flex;gap:12px;flex-wrap:wrap;align-items:center}
select,input[type=text]{background:#161b22;border:1px solid #30363d;color:#c9d1d9;padding:5px 9px;border-radius:6px;font-size:.78rem;outline:none}
select:focus,input:focus{border-color:#388bfd}
.ctrl-lbl{font-size:.7rem;color:#6e7681}
.ctrl-g{display:flex;align-items:center;gap:5px}
#count{margin-left:auto;font-size:.73rem;color:#6e7681}

.wrap{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:.78rem}
thead th{background:#161b22;color:#6e7681;font-weight:500;font-size:.67rem;text-transform:uppercase;letter-spacing:.06em;padding:8px 11px;text-align:left;border-bottom:2px solid #21262d;white-space:nowrap;position:sticky;top:0;z-index:2}
tbody td{padding:7px 11px;border-bottom:1px solid #161b22;vertical-align:top}
tbody tr:hover td{background:#161b22}
.gs td{border-top:2px solid #21262d}

/* badges */
.b{display:inline-block;padding:1px 7px;border-radius:4px;font-size:.67rem;font-weight:700;white-space:nowrap}
.b-entry{background:#12261e;color:#3fb950;border:1px solid #238636}
.b-exit{background:#0d1f3c;color:#388bfd;border:1px solid #1f6feb}
.b-BUY{background:#12261e;color:#3fb950}
.b-SELL{background:#2d1117;color:#f85149}
.b-parsed{background:#12261e;color:#3fb950}

/* result colours */
.win{color:#3fb950;font-weight:600}
.loss{color:#f85149;font-weight:600}

/* misc */
.strat{color:#a371f7;font-size:.72rem}
.ts{color:#6e7681;font-size:.71rem;white-space:nowrap}
.mono{font-family:monospace;font-size:.76rem}
.tp-c{font-family:monospace;font-size:.72rem;color:#8b949e}
.sid{font-family:monospace;font-size:.64rem;color:#444;cursor:default}
.dim{color:#333}
.pnl-pos{color:#3fb950;font-family:monospace;font-weight:700}
.pnl-neg{color:#f85149;font-family:monospace;font-weight:700}
.pts-pos{color:#3fb950;font-family:monospace}
.pts-neg{color:#f85149;font-family:monospace}
</style>
</head>
<body>

<header>
  <h1>Trade Log Journal</h1>
  <span class="pill" id="hdr-total"></span>
  <span style="font-size:.75rem;color:#6e7681">TradingView → Vercel → GitHub</span>
</header>

<div class="summary" id="summary"></div>

<div class="controls">
  <div class="ctrl-g"><span class="ctrl-lbl">Type</span>
    <select id="f-type">
      <option value="">All</option>
      <option value="new_signal">Entry</option>
      <option value="trade_update">Exit</option>
    </select></div>
  <div class="ctrl-g"><span class="ctrl-lbl">Direction</span>
    <select id="f-dir">
      <option value="">Any</option>
      <option value="BUY">BUY</option>
      <option value="SELL">SELL</option>
    </select></div>
  <div class="ctrl-g"><span class="ctrl-lbl">Result</span>
    <select id="f-result">
      <option value="">Any</option>
      <option value="win">Win</option>
      <option value="loss">Loss</option>
    </select></div>
  <div class="ctrl-g"><span class="ctrl-lbl">Instrument</span>
    <input type="text" id="f-inst" placeholder="MNQ1!…" style="width:90px"></div>
  <div class="ctrl-g"><span class="ctrl-lbl">Strategy</span>
    <input type="text" id="f-strat" placeholder="Xizni…" style="width:90px"></div>
  <span id="count"></span>
</div>

<div class="wrap">
<table>
  <thead><tr>
    <th>#</th>
    <th>Time (UTC)</th>
    <th>Type</th>
    <th>Strategy</th>
    <th>Instrument</th>
    <th>Dir</th>
    <th>Entry px</th>
    <th>Exit px</th>
    <th>SL</th>
    <th>TP1 / TP2 / TP3</th>
    <th>Qty</th>
    <th>Points</th>
    <th>Pt val</th>
    <th>P&amp;L $</th>
    <th>Result</th>
    <th>Signal ID</th>
  </tr></thead>
  <tbody id="tbody"></tbody>
</table>
</div>

<script>
const DATA = """ + data_js + """;
const rows = DATA.sort((a,b)=>a.timestamp<b.timestamp?-1:1);

const exits    = rows.filter(r=>r.message_type==='trade_update');
const nSig     = rows.filter(r=>r.message_type==='new_signal').length;
const wins     = exits.filter(r=>r.result==='win').length;
const losses   = exits.filter(r=>r.result==='loss').length;
const totalPnl = exits.reduce((s,r)=>s+(r.pnl??0),0);
const totalPts = exits.reduce((s,r)=>s+(r.points??0),0);

document.getElementById('hdr-total').textContent = rows.length+' entries';
document.getElementById('summary').innerHTML = [
  ['Trades',    nSig,                                         '#e6edf3'],
  ['Wins',      wins,                                         '#3fb950'],
  ['Losses',    losses,                                       '#f85149'],
  ['Win rate',  nSig>0?(100*wins/nSig).toFixed(0)+'%':'—',   '#e6edf3'],
  ['Total pts', (totalPts>=0?'+':'')+totalPts.toFixed(2),     totalPts>=0?'#3fb950':'#f85149'],
  ['Total P&L', '$'+(totalPnl>=0?'+':'')+totalPnl.toFixed(2),totalPnl>=0?'#3fb950':'#f85149'],
].map(([l,v,c])=>`<div class="stat"><div class="stat-val" style="color:${c}">${v}</div><div class="stat-lbl">${l}</div></div>`).join('');

['f-type','f-dir','f-result','f-inst','f-strat'].forEach(id=>
  document.getElementById(id).addEventListener('input', render));

function render(){
  const fTy  = document.getElementById('f-type').value;
  const fDir = document.getElementById('f-dir').value;
  const fRes = document.getElementById('f-result').value;
  const fIn  = document.getElementById('f-inst').value.toUpperCase();
  const fSt  = document.getElementById('f-strat').value.toUpperCase();

  const filtered = rows.filter(r=>{
    if(fTy  && r.message_type!==fTy) return false;
    if(fDir && r.direction!==fDir) return false;
    if(fRes && r.result!==fRes) return false;
    if(fIn  && !(r.instrument||'').includes(fIn)) return false;
    if(fSt  && !(r.strategy||'').toUpperCase().includes(fSt)) return false;
    return true;
  });

  document.getElementById('count').textContent = filtered.length+' of '+rows.length;
  const tbody = document.getElementById('tbody');
  tbody.innerHTML = '';
  let prevSid = undefined;

  filtered.forEach((r,i)=>{
    const isSig = r.message_type==='new_signal';
    const tr = document.createElement('tr');
    if(r.signal_id!==prevSid) tr.className='gs';
    prevSid = r.signal_id;

    const ts  = r.timestamp.replace('T',' ').replace(/\\.000Z|Z|\\+.*/,'').slice(0,16);
    const tp  = Array.isArray(r.tp)&&r.tp.length ? r.tp.join(' / ') : '—';
    const sid = r.signal_id
      ? `<span class="sid" title="${r.signal_id}">${r.signal_id.slice(0,14)}…</span>`
      : '<span class="dim">—</span>';

    const entryPx = r.entry!=null ? r.entry : (r.entry_price!=null ? r.entry_price : '—');
    const exitPx  = r.exit_price!=null ? r.exit_price : '—';
    const qty     = r.qty ?? r.exit_qty ?? '—';

    const ptsCell = r.points!=null
      ? `<span class="${r.points>=0?'pts-pos':'pts-neg'}">${r.points>=0?'+':''}${r.points.toFixed(2)}</span>`
      : '<span class="dim">—</span>';

    const pnlCell = r.pnl!=null
      ? `<span class="${r.pnl>=0?'pnl-pos':'pnl-neg'}">${r.pnl>=0?'+$':'−$'}${Math.abs(r.pnl).toFixed(2)}</span>`
      : '<span class="dim">—</span>';

    const resCell = r.result
      ? `<span class="${r.result}">${r.result}</span>`
      : '<span class="dim">—</span>';

    tr.innerHTML = `
      <td style="color:#555;font-size:.69rem">${i+1}</td>
      <td class="ts">${ts}</td>
      <td>${isSig?'<span class="b b-entry">entry</span>':'<span class="b b-exit">exit</span>'}</td>
      <td class="strat">${r.strategy||'<span class="dim">—</span>'}</td>
      <td style="font-weight:${isSig?600:400};color:${isSig?'#e6edf3':'#8b949e'}">${r.instrument||'—'}</td>
      <td>${r.direction?`<span class="b b-${r.direction}">${r.direction}</span>`:'<span class="dim">—</span>'}</td>
      <td class="mono">${entryPx}</td>
      <td class="mono">${exitPx}</td>
      <td class="mono">${r.sl!=null?r.sl:'—'}</td>
      <td class="tp-c">${tp}</td>
      <td style="color:#8b949e;font-size:.75rem">${qty}</td>
      <td>${ptsCell}</td>
      <td style="color:#6e7681;font-size:.72rem">${r.point_value!=null?'$'+r.point_value+'/pt':'—'}</td>
      <td>${pnlCell}</td>
      <td>${resCell}</td>
      <td>${sid}</td>`;
    tbody.appendChild(tr);
  });
}
render();
</script>
</body>
</html>"""

with open('docs/journal_viewer.html', 'w', encoding='utf-8') as f:
    f.write(html)
print(f"Viewer written — {len(rows)} entries")

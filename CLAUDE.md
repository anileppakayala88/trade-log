# CLAUDE.md — Trade Log Project

## What this project does

Receives TradingView webhook alerts and records trades in a JSON file, displayed as a live dashboard on GitHub Pages.

**Flow:** TradingView alert → POST to Vercel webhook → GitHub API writes `trades.json` → GitHub Pages reads and renders the table.

---

## Repo structure

```
trade-log/
├── api/
│   └── webhook.js       ← Vercel serverless function (Node.js)
├── public/
│   ├── index.html       ← GitHub Pages dashboard (vanilla HTML/CSS/JS)
│   └── trades.json      ← live trade data, auto-updated by webhook
├── vercel.json          ← Vercel routing config
├── CLAUDE.md
└── README.md
```

---

## Payload contracts

### Entry
```json
{"ticker":"MNQ1!","action":"buy","price":25258.75,"qty":5,"sl":25203.75,"tp1":25280.75,"tp1_qty":1,"tp2":25302.75,"tp2_qty":0,"tp3":25313.75,"tp3_qty":4}
```
- `action` is `"buy"` or `"sell"`
- `sl`, `tp1`/`tp2`/`tp3` and their `_qty` fields are all included at entry time

### TP exit (partial or full)
```json
{"ticker":"MNQ1!","action":"exit","tp":"TP1","qty":1,"price":25280.75}
```
- `tp` is `"TP1"`, `"TP2"`, or `"TP3"`
- Multiple exit payloads arrive per trade (one per TP level hit)
- Trade closes automatically when cumulative exit qty equals entry qty

### SL hit
```json
{"ticker":"MNQ1!","action":"sl","price":25203.75}
```
- Any unfilled qty at SL time is settled at `price` (or `slPrice` from entry if `price` omitted)

---

## trades.json schema

```json
{
  "openTrades": {
    "MNQ1!": {
      "id": "MNQ1!-1714000000000",
      "ticker": "MNQ1!",
      "direction": "buy",
      "entryTime": "2024-04-25T14:00:00.000Z",
      "entryPrice": 25258.75,
      "qty": 5,
      "slPrice": 25203.75,
      "targets": {
        "tp1": 25280.75, "tp1_qty": 1,
        "tp2": 25302.75, "tp2_qty": 0,
        "tp3": 25313.75, "tp3_qty": 4
      },
      "exits": [
        { "tp": "TP1", "price": 25280.75, "qty": 1, "time": "2024-04-25T14:05:00.000Z" }
      ],
      "status": "open"
    }
  },
  "closedTrades": [
    {
      "id": "MNQ1!-1713900000000",
      "ticker": "MNQ1!",
      "direction": "buy",
      "entryTime": "...",
      "closeTime": "...",
      "entryPrice": 25258.75,
      "qty": 5,
      "slPrice": 25203.75,
      "exits": [...],
      "slHit": false,
      "pnl": 237.50,
      "result": "win",
      "status": "closed"
    }
  ]
}
```

`closedTrades` is newest-first (unshift on close).

---

## P&L calculation

Located in `calcPnl()` in `api/webhook.js`.

- **Point value:** `$2 per point per contract` (MNQ hardcoded — update for other instruments)
- Formula per exit: `(exitPrice - entryPrice) × qty × pointValue` for longs; reversed for shorts
- Any qty not covered by TP exits is settled at `slPrice`
- Result is `"win"` if `pnl >= 0`, otherwise `"loss"`

---

## Environment variables (Vercel)

| Variable | Description |
|---|---|
| `GITHUB_TOKEN` | Fine-grained PAT with Contents read/write on this repo |
| `GITHUB_REPO` | e.g. `youruser/trade-log` |
| `GITHUB_BRANCH` | default `main` |
| `WEBHOOK_SECRET` | Optional. If set, requests must include `x-webhook-secret` header |

---

## Key behaviours and edge cases

- **One open trade per ticker at a time.** A new entry payload for a ticker that already has an open trade will overwrite it. If you need concurrent trades on the same instrument, the `openTrades` key needs to change from `ticker` to `id`.
- **Partial fills accumulate.** Exit payloads are pushed onto `trade.exits[]`. The trade only closes when `sum(exits[].qty) >= trade.qty`.
- **tp2_qty: 0 is valid.** TP2 with zero qty means that level is skipped — no exit payload will arrive for it and that's fine.
- **SL closes immediately.** A `sl` payload closes the trade regardless of how many partials have already filled.
- **trades.json is read-modify-write via GitHub Contents API.** The `sha` from the GET must be included in the PUT, otherwise GitHub rejects the write with a 409.
- **Dashboard polls every 30 seconds.** It appends `?t=Date.now()` to bust CDN cache on `trades.json`.

---

## Deployment

### Vercel
- Runtime: Node.js (no `package.json` needed for this project)
- Route `/webhook` → `api/webhook.js` (defined in `vercel.json`)
- Static files in `/public` are served at root

### GitHub Pages
- Source: `main` branch, `/public` folder
- `index.html` fetches `trades.json` from the same origin — no CORS issues
- Enable in repo Settings → Pages

---

## How to extend

**Add a new instrument with a different point value:**
In `webhook.js`, replace the hardcoded `POINT_VALUE` constant with a lookup:
```js
const POINT_VALUES = { 'MNQ1!': 2, 'MES1!': 5, 'NQ1!': 20 };
const POINT_VALUE = POINT_VALUES[ticker] || 1;
```

**Add more columns to the dashboard (e.g. session, setup tag):**
Include extra fields in the TradingView payload, pass them through in the entry object in `webhook.js`, and add the `<th>` / `<td>` to the table in `index.html`.

**Support multiple open trades on the same ticker:**
Change the `openTrades` key from `ticker` to `id` in `webhook.js`. Update the exit/SL handlers to find the trade by ticker scan instead of direct key lookup.

**Reset all trades:**
Manually edit `trades.json` in the repo back to `{ "openTrades": {}, "closedTrades": [] }`.

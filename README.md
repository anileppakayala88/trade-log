# Trade Log — TradingView → Vercel → GitHub Pages + Telegram

Receives TradingView webhook alerts, records trades in a JSON file, sends Telegram notifications with chart screenshots, and displays everything on a live dashboard.

**Live webhook:** https://trade-log-ruddy.vercel.app/webhook  
**Dashboard:** https://anileppakayala88.github.io/trade-log

---

## Architecture

```
TradingView Alert (webhook POST)
        ↓
Vercel API Route (/api/webhook.js)
├── Validates WEBHOOK_SECRET header (if set)
├── Parses action: entry / exit (partial fill) / sl
├── Updates docs/trades.json via GitHub Contents API
├── Appends to docs/journal.jsonl via GitHub Contents API
├── Fetches chart screenshot (direct image URL or ScreenshotOne)
├── Uploads screenshot → docs/screenshots/<ticker>-<ts>.jpg
└── Sends photo + caption to Telegram (routed by strategy)
        ↓
GitHub Pages dashboard polls trades.json every 30s
```

---

## Repo Structure

```
trade-log/
├── api/
│   └── webhook.js          ← Vercel serverless function (Node.js ESM)
├── docs/
│   ├── trades.json         ← live trade data (auto-updated by webhook)
│   ├── journal.jsonl       ← append-only newline-delimited trade journal
│   └── screenshots/        ← chart screenshots uploaded per trade
├── public/
│   └── index.html          ← GitHub Pages dashboard
├── vercel.json             ← Vercel routing config
└── README.md
```

---

## Supported Instruments & Point Values

| Ticker  | Point Value       |
|---------|-------------------|
| MNQ1!   | $2 / point / lot  |
| MGC1!   | $10 / point / lot |
| MES1!   | $5 / point / lot  |
| NQ1!    | $20 / point / lot |
| ES1!    | $50 / point / lot |

To add a new instrument, edit the `POINT_VALUES` map at the top of `api/webhook.js`.

---

## Active Strategies

| Strategy  | Instrument | Telegram Channel  | Webhook URL                          |
|-----------|------------|-------------------|--------------------------------------|
| QT-AMDX   | MNQ        | QT-AMDX Trades    | `/webhook?strategy=QT-AMDX`          |
| ASH-Sweep | MNQ        | QT-AMDX Trades    | `/webhook?strategy=ash-sweep`        |

---

## Environment Variables (Vercel)

| Variable                  | Description                                                  |
|---------------------------|--------------------------------------------------------------|
| `GITHUB_TOKEN`            | Fine-grained PAT with Contents Read/Write on this repo       |
| `GITHUB_REPO`             | `anileppakayala88/trade-log`                                 |
| `GITHUB_BRANCH`           | `main`                                                       |
| `WEBHOOK_SECRET`          | Optional — requests must include `x-webhook-secret` header   |
| `TELEGRAM_BOT_TOKEN`      | Bot token from BotFather                                     |
| `TELEGRAM_CHANNEL_ID`     | MT5-routing channel chat_id (raw JSON signals)               |
| `SCREENSHOTONE_KEY`       | Access key from screenshotone.com                            |
| `TELEGRAM_CHAT_QT_AMDX`  | Telegram chat_id for QT-AMDX strategy                       |
| `TELEGRAM_CHAT_ASH_SWEEP` | Telegram chat_id for ASH-Sweep strategy                     |
| `TELEGRAM_CHAT_DEFAULT`   | Optional fallback chat_id if no strategy match               |

---

## TradingView Alert Setup

### Webhook URL

```
https://trade-log-ruddy.vercel.app/webhook?strategy=QT-AMDX
```

Add `?strategy=<name>` to route Telegram notifications to the correct channel. The strategy name is normalised to lowercase with hyphens (`QT-AMDX` → `qt-amdx`).

If you set `WEBHOOK_SECRET`, add a custom header in the TradingView alert:

```
x-webhook-secret: your_secret_here
```

### Entry payload

```json
{
  "ticker":   "{{ticker}}",
  "action":   "buy",
  "price":    {{close}},
  "qty":      5,
  "sl":       21400.00,
  "tp1":      21500.00,
  "tp1_qty":  1,
  "tp2":      21550.00,
  "tp2_qty":  0,
  "tp3":      21600.00,
  "tp3_qty":  4,
  "chart_url": "{{imageurl}}"
}
```

Use `"action": "sell"` for short entries.

### Exit / TP payload

```json
{
  "ticker":  "{{ticker}}",
  "action":  "exit",
  "tp":      "TP1",
  "qty":     1,
  "price":   {{close}},
  "chart_url": "{{imageurl}}"
}
```

`tp` can be `"TP1"`, `"TP2"`, or `"TP3"`. Send one alert per TP level. The trade closes automatically when cumulative exit qty equals entry qty.

### SL payload

```json
{
  "ticker":  "{{ticker}}",
  "action":  "sl",
  "price":   {{close}},
  "chart_url": "{{imageurl}}"
}
```

SL closes the trade immediately regardless of how many partials have already filled. Any remaining qty is settled at `price`.

### Screenshot note

Use `"chart_url": "{{imageurl}}"` in all alert payloads. TradingView injects a direct S3 image URL (e.g. `https://s3.tradingview.com/snapshots/...png`) that can be fetched without authentication. Chart page URLs (`/chart/XXXX/`) return 403 to headless browsers and will not work.

---

## Payload Reference

### Full entry fields

| Field      | Type   | Required | Description                              |
|------------|--------|----------|------------------------------------------|
| `ticker`   | string | yes      | Instrument symbol e.g. `MNQ1!`           |
| `action`   | string | yes      | `"buy"` or `"sell"`                      |
| `price`    | number | yes      | Entry price                              |
| `qty`      | number | no       | Number of contracts (default: 1)         |
| `sl`       | number | no       | Stop loss price                          |
| `tp1`      | number | no       | Take profit 1 price                      |
| `tp1_qty`  | number | no       | Contracts to exit at TP1                 |
| `tp2`      | number | no       | Take profit 2 price                      |
| `tp2_qty`  | number | no       | Contracts to exit at TP2 (0 = skip)      |
| `tp3`      | number | no       | Take profit 3 price                      |
| `tp3_qty`  | number | no       | Contracts to exit at TP3                 |
| `chart_url`| string | no       | Direct image URL for screenshot          |

### Full exit fields

| Field       | Type   | Required | Description                         |
|-------------|--------|----------|-------------------------------------|
| `ticker`    | string | yes      | Must match an open trade            |
| `action`    | string | yes      | `"exit"`                            |
| `price`     | number | yes      | Exit price                          |
| `qty`       | number | no       | Contracts exited (default: 1)       |
| `tp`        | string | no       | `"TP1"`, `"TP2"`, or `"TP3"`        |
| `chart_url` | string | no       | Direct image URL for screenshot     |

### Full SL fields

| Field       | Type   | Required | Description                         |
|-------------|--------|----------|-------------------------------------|
| `ticker`    | string | yes      | Must match an open trade            |
| `action`    | string | yes      | `"sl"`                              |
| `price`     | number | no       | SL hit price (falls back to entry slPrice) |
| `chart_url` | string | no       | Direct image URL for screenshot     |

---

## Adding a New Strategy

1. Create a Telegram channel and add your bot as an admin
2. Get the chat_id:
   ```
   https://api.telegram.org/bot<TOKEN>/getUpdates
   ```
   Send a message to the channel first, then look for `"chat": {"id": ...}` in the response.
3. Add the env var in Vercel dashboard:
   ```
   TELEGRAM_CHAT_<NAME>=<chat_id>
   ```
4. Add an entry to `TELEGRAM_CHANNEL_MAP` in `api/webhook.js`:
   ```js
   const TELEGRAM_CHANNEL_MAP = {
     "qt-amdx":    process.env.TELEGRAM_CHAT_QT_AMDX,
     "ash-sweep":  process.env.TELEGRAM_CHAT_ASH_SWEEP,
     "my-strategy": process.env.TELEGRAM_CHAT_MY_STRATEGY,  // ← add this
   };
   ```
5. Set up TradingView alerts with `?strategy=my-strategy` appended to the webhook URL

The strategy name in the URL is normalised to lowercase with spaces/underscores replaced by hyphens, so `My_Strategy`, `my-strategy`, and `MY STRATEGY` all resolve to the same key.

---

## P&L Calculation

- Formula per exit: `(exitPrice − entryPrice) × qty × pointValue` for longs; reversed for shorts
- Any qty not covered by TP exits when an SL fires is settled at SL price
- Result is `"win"` if `pnl >= 0`, otherwise `"loss"`

---

## Dashboard

- URL: https://anileppakayala88.github.io/trade-log
- Auto-refreshes every 30 seconds (appends `?t=Date.now()` to bust CDN cache)
- Shows open trades with entry details and partial fills
- Shows closed trades with PnL and result

---

## Initial Setup

### 1. GitHub repo
- Enable GitHub Pages: Settings → Pages → Source: `main` branch → `/docs` folder

### 2. GitHub Personal Access Token
- GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens
- Permission needed: **Contents: Read and Write** on this repo

### 3. Deploy to Vercel
- vercel.com → New Project → import this repo
- Add all environment variables listed above
- The webhook route is pre-configured in `vercel.json`

### 4. Reset all trades
Manually edit `docs/trades.json` back to:
```json
{ "openTrades": {}, "closedTrades": [] }
```

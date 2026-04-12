# Trade Log — TradingView → Vercel → GitHub Pages

## Repo structure
```
trade-log/
├── api/
│   └── webhook.js      ← Vercel serverless function
├── public/
│   ├── index.html      ← GitHub Pages dashboard
│   └── trades.json     ← live trade data (auto-updated by webhook)
├── vercel.json
└── README.md
```

## Setup steps

### 1. Create GitHub repo
- Create a new repo (e.g. `trade-log`) — can be public or private
- Push this folder to it
- Enable GitHub Pages: Settings → Pages → Source: `main` branch → `/public` folder

### 2. Create a GitHub Personal Access Token
- GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens
- Permissions needed: **Contents: Read and Write** on your `trade-log` repo
- Copy the token

### 3. Deploy to Vercel
- Go to vercel.com → New Project → import your `trade-log` repo
- Set these environment variables in Vercel dashboard:
  ```
  GITHUB_TOKEN=ghp_your_token_here
  GITHUB_REPO=youruser/trade-log
  GITHUB_BRANCH=main
  WEBHOOK_SECRET=pick_any_secret_string   (optional but recommended)
  ```
- Deploy. Your webhook URL will be: `https://your-project.vercel.app/webhook`

### 4. Set up TradingView alerts
- Create an alert → Notifications → enable Webhook URL
- Paste your Vercel webhook URL
- Set the message body to your JSON payload:

**Entry:**
```json
{"ticker":"MNQ1!","action":"buy","price":{{close}},"qty":5,"sl":25203.75,"tp1":25280.75,"tp1_qty":1,"tp2":25302.75,"tp2_qty":0,"tp3":25313.75,"tp3_qty":4}
```

**Exit (TP):**
```json
{"ticker":"MNQ1!","action":"exit","tp":"TP1","qty":1,"price":{{close}}}
```

**SL hit:**
```json
{"ticker":"MNQ1!","action":"sl","price":{{close}}}
```

If you set a WEBHOOK_SECRET, add this header in TradingView alert settings:
```
x-webhook-secret: your_secret_here
```

### 5. View your dashboard
Open: `https://youruser.github.io/trade-log`

---

## Notes
- MNQ point value is hardcoded as **$2/point/contract** in `webhook.js` — adjust if trading other instruments
- Partial fills (TP1 + TP3 in your example) are stitched together; trade closes when total qty is filled
- Any unfilled qty when SL hits is calculated at SL price
- Dashboard auto-refreshes every 30 seconds

// api/webhook.js — Vercel serverless function
// Receives TradingView webhook payloads and writes to trades.json in your GitHub repo

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO  = process.env.GITHUB_REPO;   // e.g. "youruser/trade-log"
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || "main";
const FILE_PATH    = "public/trades.json";
const API_BASE     = "https://api.github.com";

// ---------- GitHub helpers ----------

async function getFile() {
  const res = await fetch(`${API_BASE}/repos/${GITHUB_REPO}/contents/${FILE_PATH}?ref=${GITHUB_BRANCH}`, {
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
    },
  });
  if (res.status === 404) return { content: { openTrades: {}, closedTrades: [] }, sha: null };
  const data = await res.json();
  const decoded = JSON.parse(Buffer.from(data.content, "base64").toString("utf8"));
  return { content: decoded, sha: data.sha };
}

async function saveFile(content, sha) {
  const body = {
    message: `trade update ${new Date().toISOString()}`,
    content: Buffer.from(JSON.stringify(content, null, 2)).toString("base64"),
    branch: GITHUB_BRANCH,
  };
  if (sha) body.sha = sha;

  const res = await fetch(`${API_BASE}/repos/${GITHUB_REPO}/contents/${FILE_PATH}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`GitHub write failed: ${res.status} ${await res.text()}`);
}

// ---------- P&L calculator ----------

function calcPnl(trade) {
  // MNQ point value = $2 per point per contract
  const POINT_VALUE = 2;
  let totalPnl = 0;
  let exitedQty = 0;

  for (const exit of trade.exits) {
    const points = trade.direction === "buy"
      ? exit.price - trade.entryPrice
      : trade.entryPrice - exit.price;
    totalPnl += points * exit.qty * POINT_VALUE;
    exitedQty += exit.qty;
  }

  // Any remaining qty closed at SL
  const remainingQty = trade.qty - exitedQty;
  if (remainingQty > 0 && trade.slPrice) {
    const points = trade.direction === "buy"
      ? trade.slPrice - trade.entryPrice
      : trade.entryPrice - trade.slPrice;
    totalPnl += points * remainingQty * POINT_VALUE;
  }

  return Math.round(totalPnl * 100) / 100;
}

// ---------- Main handler ----------

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  // Optional: shared secret check
  const secret = process.env.WEBHOOK_SECRET;
  if (secret && req.headers["x-webhook-secret"] !== secret) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  let payload;
  try {
    payload = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  } catch {
    return res.status(400).json({ error: "Invalid JSON" });
  }

  const { ticker, action, price, qty, sl, tp1, tp1_qty, tp2, tp2_qty, tp3, tp3_qty, tp } = payload;
  const strategy = (req.query.strategy || "").trim() || null;

  try {
    const { content, sha } = await getFile();
    const { openTrades, closedTrades } = content;

    // ---- ENTRY ----
    if (action === "buy" || action === "sell") {
      const id = `${ticker}-${Date.now()}`;
      openTrades[ticker] = {
        id,
        ticker,
        strategy,
        direction: action,
        entryTime: new Date().toISOString(),
        entryPrice: price,
        qty,
        slPrice: sl,
        targets: { tp1, tp1_qty, tp2, tp2_qty, tp3, tp3_qty },
        exits: [],
        status: "open",
      };

    // ---- TP EXIT (partial or full) ----
    } else if (action === "exit") {
      const trade = openTrades[ticker];
      if (!trade) return res.status(400).json({ error: `No open trade for ${ticker}` });

      trade.exits.push({ tp, price, qty, time: new Date().toISOString() });

      const exitedQty = trade.exits.reduce((sum, e) => sum + e.qty, 0);
      if (exitedQty >= trade.qty) {
        // All qty filled — close the trade
        trade.status = "closed";
        trade.closeTime = new Date().toISOString();
        trade.pnl = calcPnl(trade);
        trade.result = trade.pnl >= 0 ? "win" : "loss";
        closedTrades.unshift(trade);
        delete openTrades[ticker];
      }

    // ---- SL HIT ----
    } else if (action === "sl") {
      const trade = openTrades[ticker];
      if (!trade) return res.status(400).json({ error: `No open trade for ${ticker}` });

      trade.status = "closed";
      trade.closeTime = new Date().toISOString();
      trade.slHit = true;
      trade.slHitPrice = price || trade.slPrice;
      trade.pnl = calcPnl(trade);
      trade.result = "loss";
      closedTrades.unshift(trade);
      delete openTrades[ticker];

    } else {
      return res.status(400).json({ error: `Unknown action: ${action}` });
    }

    await saveFile({ openTrades, closedTrades }, sha);
    return res.status(200).json({ ok: true, action, ticker });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
}

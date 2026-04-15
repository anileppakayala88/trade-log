// api/webhook.js — Vercel serverless function
// Receives TradingView webhook payloads and writes to trades.json in your GitHub repo

const GITHUB_TOKEN  = process.env.GITHUB_TOKEN;
const GITHUB_REPO   = process.env.GITHUB_REPO;   // e.g. "youruser/trade-log"
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || "main";
const FILE_PATH     = "public/trades.json";
const API_BASE      = "https://api.github.com";

// Point value per contract per point — update for other instruments
const POINT_VALUES = { "MNQ1!": 2, "MGC1!": 10, "MES1!": 5, "NQ1!": 20, "ES1!": 50 };

// ---------- GitHub helpers ----------

async function getFile() {
  const res = await fetch(`${API_BASE}/repos/${GITHUB_REPO}/contents/${FILE_PATH}?ref=${GITHUB_BRANCH}`, {
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
    },
  });
  if (res.status === 404) return { content: { openTrades: {}, closedTrades: [], logs: [] }, sha: null };
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

  const { ticker, action, price, qty } = payload;
  const strategy = (req.query.strategy || "").trim() || null;

  if (!ticker || !action) return res.status(400).json({ error: "Missing ticker or action" });

  try {
    const { content, sha } = await getFile();
    const { openTrades, closedTrades } = content;
    const logs = content.logs || [];

    // Always log the raw incoming payload
    const logEntry = {
      time: new Date().toISOString(),
      strategy,
      payload,
      result: null,
      error: null,
    };

    let responseBody;

    try {
      // ---- ENTRY ----
      if (action === "buy" || action === "sell") {
        openTrades[ticker] = {
          id: `${ticker}-${Date.now()}`,
          ticker,
          strategy,
          direction: action,
          entryTime: new Date().toISOString(),
          entryPrice: price,
          qty: qty || 1,
          status: "open",
        };
        logEntry.result = `opened ${action} trade`;

      // ---- EXIT (win or loss determined by price vs entry) ----
      } else if (action === "exit") {
        const trade = openTrades[ticker];
        if (!trade) {
          logEntry.error = `No open trade for ${ticker}`;
          logs.unshift(logEntry);
          if (logs.length > 100) logs.splice(100);
          await saveFile({ openTrades, closedTrades, logs }, sha);
          return res.status(400).json({ error: logEntry.error });
        }

        const pointValue = POINT_VALUES[ticker] || 1;
        const points = trade.direction === "buy"
          ? price - trade.entryPrice
          : trade.entryPrice - price;
        const pnl = Math.round(points * trade.qty * pointValue * 100) / 100;

        trade.status    = "closed";
        trade.closeTime = new Date().toISOString();
        trade.exitPrice = price;
        trade.pnl       = pnl;
        trade.result    = pnl >= 0 ? "win" : "loss";

        closedTrades.unshift(trade);
        delete openTrades[ticker];
        logEntry.result = `closed trade — ${trade.result} — pnl: ${pnl}`;

      } else {
        logEntry.error = `Unknown action: ${action}`;
        logs.unshift(logEntry);
        if (logs.length > 100) logs.splice(100);
        await saveFile({ openTrades, closedTrades, logs }, sha);
        return res.status(400).json({ error: logEntry.error });
      }

      responseBody = { ok: true, action, ticker };

    } catch (innerErr) {
      logEntry.error = innerErr.message;
      responseBody = { error: innerErr.message };
    }

    logs.unshift(logEntry);
    if (logs.length > 100) logs.splice(100);
    await saveFile({ openTrades, closedTrades, logs }, sha);

    return logEntry.error
      ? res.status(500).json(responseBody)
      : res.status(200).json(responseBody);

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
}

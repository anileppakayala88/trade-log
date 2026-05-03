// api/webhook.js — Vercel serverless function
// Receives TradingView webhook payloads and writes to trades.json + journal.jsonl in your GitHub repo

const GITHUB_TOKEN  = process.env.GITHUB_TOKEN;
const GITHUB_REPO   = process.env.GITHUB_REPO;   // e.g. "youruser/trade-log"
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || "main";
const TRADES_PATH   = "docs/trades.json";
const JOURNAL_PATH  = "docs/journal.jsonl";
const API_BASE      = "https://api.github.com";

// Point value per contract per point
const POINT_VALUES = { "MNQ1!": 2, "MGC1!": 10, "MES1!": 5, "NQ1!": 20, "ES1!": 50 };

// ---------- GitHub helpers ----------

async function ghGet(path) {
  const res = await fetch(`${API_BASE}/repos/${GITHUB_REPO}/contents/${path}?ref=${GITHUB_BRANCH}`, {
    headers: { Authorization: `Bearer ${GITHUB_TOKEN}`, Accept: "application/vnd.github+json" },
  });
  if (res.status === 404) return { content: null, sha: null };
  const data = await res.json();
  return { content: Buffer.from(data.content, "base64").toString("utf8"), sha: data.sha };
}

async function ghPut(path, content, sha, message) {
  const body = { message, content: Buffer.from(content).toString("base64"), branch: GITHUB_BRANCH };
  if (sha) body.sha = sha;
  const res = await fetch(`${API_BASE}/repos/${GITHUB_REPO}/contents/${path}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`GitHub write failed (${path}): ${res.status} ${await res.text()}`);
}

// ---------- Main handler ----------

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  const secret = process.env.WEBHOOK_SECRET;
  if (secret && req.headers["x-webhook-secret"] !== secret)
    return res.status(401).json({ error: "Unauthorized" });

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
    // Fetch trades.json and journal.jsonl in parallel
    const [tradesResult, journalResult] = await Promise.all([
      ghGet(TRADES_PATH),
      ghGet(JOURNAL_PATH),
    ]);

    const trades = tradesResult.content
      ? JSON.parse(tradesResult.content)
      : { openTrades: {}, closedTrades: [], logs: [] };
    const tradesSha   = tradesResult.sha;
    const journalText = (journalResult.content || "").trimEnd();
    const journalSha  = journalResult.sha;

    const { openTrades, closedTrades } = trades;
    const logs = trades.logs || [];

    const now = new Date().toISOString();
    const logEntry = { time: now, strategy, payload, result: null, error: null };
    const journalEntries = [];

    let responseBody;

    try {
      // ---- ENTRY ----
      if (action === "buy" || action === "sell") {
        const tradeId = `${ticker}-${Date.now()}`;
        openTrades[ticker] = {
          id: tradeId,
          ticker,
          strategy,
          direction: action,
          entryTime: now,
          entryPrice: price,
          qty: qty || 1,
          exits: [],
          status: "open",
        };
        logEntry.result = `opened ${action} trade`;

        journalEntries.push({
          signal_id:    tradeId,
          timestamp:    now,
          message_type: "new_signal",
          source:       "TradingView",
          strategy,
          instrument:   ticker,
          direction:    action.toUpperCase(),
          order_type:   "market",
          entry:        price,
          qty:          qty || 1,
          sl:           payload.sl   ?? null,
          tp:           [payload.tp1,  payload.tp2,  payload.tp3 ].filter(v => v != null),
          tp_qty:       [payload.tp1_qty, payload.tp2_qty, payload.tp3_qty].filter(v => v != null),
          parse_status: "parsed",
        });

      // ---- EXIT ----
      } else if (action === "exit") {
        const trade = openTrades[ticker];
        if (!trade) {
          logEntry.error = `No open trade for ${ticker}`;
          logs.unshift(logEntry);
          if (logs.length > 100) logs.splice(100);
          await ghPut(TRADES_PATH, JSON.stringify(trades, null, 2), tradesSha, `trade log ${now}`);
          return res.status(400).json({ error: logEntry.error });
        }

        const exitQty = qty || 1;
        if (!trade.exits) trade.exits = [];
        trade.exits.push({ price, qty: exitQty, time: now, tp: payload.tp || null });

        const filledQty = trade.exits.reduce((s, e) => s + e.qty, 0);
        const pointValue = POINT_VALUES[ticker] || 1;

        if (filledQty >= trade.qty) {
          // All contracts filled — calculate distributed P&L across each exit
          const pnl = Math.round(
            trade.exits.reduce((sum, e) => {
              const pts = trade.direction === "buy"
                ? e.price - trade.entryPrice
                : trade.entryPrice - e.price;
              return sum + pts * e.qty * pointValue;
            }, 0) * 100
          ) / 100;

          trade.status    = "closed";
          trade.closeTime = now;
          trade.exitPrice = price;  // last exit price
          trade.pnl       = pnl;
          trade.result    = pnl >= 0 ? "win" : "loss";

          closedTrades.unshift(trade);
          delete openTrades[ticker];
          logEntry.result = `closed trade — ${trade.result} — pnl: ${pnl} (${filledQty}/${trade.qty} qty)`;

          journalEntries.push({
            signal_id:    trade.id,
            timestamp:    now,
            message_type: "trade_update",
            source:       "TradingView",
            strategy,
            instrument:   ticker,
            update_type:  "exit",
            entry_price:  trade.entryPrice,
            exits:        trade.exits,
            point_value:  pointValue,
            pnl,
            result:       trade.result,
          });
        } else {
          logEntry.result = `partial exit ${exitQty} @ ${price} — filled ${filledQty}/${trade.qty}`;
        }

      } else {
        logEntry.error = `Unknown action: ${action}`;
        logs.unshift(logEntry);
        if (logs.length > 100) logs.splice(100);
        await ghPut(TRADES_PATH, JSON.stringify(trades, null, 2), tradesSha, `trade log ${now}`);
        return res.status(400).json({ error: logEntry.error });
      }

      responseBody = { ok: true, action, ticker };

    } catch (innerErr) {
      logEntry.error = innerErr.message;
      responseBody = { error: innerErr.message };
    }

    logs.unshift(logEntry);
    if (logs.length > 100) logs.splice(100);

    const newLines = journalEntries.map(e => JSON.stringify(e)).join("\n");
    const updatedJournal = journalText ? journalText + "\n" + newLines : newLines;

    // Write trades.json and journal.jsonl in parallel (independent shas)
    const writes = [ghPut(TRADES_PATH, JSON.stringify(trades, null, 2), tradesSha, `trade log ${now}`)];
    if (journalEntries.length > 0)
      writes.push(ghPut(JOURNAL_PATH, updatedJournal + "\n", journalSha, `journal ${now}`));

    await Promise.all(writes);

    return logEntry.error
      ? res.status(500).json(responseBody)
      : res.status(200).json(responseBody);

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
}

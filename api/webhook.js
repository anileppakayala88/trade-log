// api/webhook.js — Vercel serverless function
// Receives TradingView webhook payloads and writes to trades.json + journal.jsonl in your GitHub repo

const GITHUB_TOKEN  = process.env.GITHUB_TOKEN;
const GITHUB_REPO   = process.env.GITHUB_REPO;   // e.g. "youruser/trade-log"
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || "main";
const TRADES_PATH   = "docs/trades.json";
const JOURNAL_PATH  = "docs/journal.jsonl";
const API_BASE      = "https://api.github.com";

const TG_TOKEN   = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHANNEL = process.env.TELEGRAM_CHANNEL_ID;  // e.g. "-1003720726531"

// Sends raw JSON signal to the fixed MT5-routing channel (xauusd_bot)
async function sendTelegramJson(obj) {
  if (!TG_TOKEN || !TG_CHANNEL) return;
  try {
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TG_CHANNEL, text: JSON.stringify(obj) }),
    });
  } catch (err) {
    console.error("Telegram send failed:", err.message);
  }
}

// Point value per contract per point
const POINT_VALUES = { "MNQ1!": 2, "MGC1!": 10, "MES1!": 5, "NQ1!": 20, "ES1!": 50 };

// Telegram routing: strategy name → chat_id env var
const TELEGRAM_CHANNEL_MAP = {
  "qt-amdx":   process.env.TELEGRAM_CHAT_QT_AMDX,
  "ash-sweep": process.env.TELEGRAM_CHAT_ASH_SWEEP,
  "project2":  process.env.TELEGRAM_CHAT_PROJECT2,
  "project3":  process.env.TELEGRAM_CHAT_PROJECT3,
};

function strategyKey(name) {
  return (name || "").toLowerCase().replace(/[\s_]+/g, "-");
}

function getTelegramChatId(strategy) {
  return TELEGRAM_CHANNEL_MAP[strategyKey(strategy)] || process.env.TELEGRAM_CHAT_DEFAULT || null;
}

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

// Find the most-recently-opened trade for a ticker (LIFO — matches the strategy's last entry)
function findOpenTrade(openTrades, ticker) {
  return Object.values(openTrades)
    .filter(t => t.ticker === ticker && t.status === "open")
    .sort((a, b) => new Date(b.entryTime) - new Date(a.entryTime))[0] || null;
}

// ---------- Screenshot / Telegram helpers ----------

async function captureScreenshot(chartUrl) {
  if (!process.env.SCREENSHOTONE_KEY || !chartUrl) return null;
  try {
    const params = new URLSearchParams({
      access_key:            process.env.SCREENSHOTONE_KEY,
      url:                   chartUrl,
      viewport_width:        1440,
      viewport_height:       900,
      full_page:             false,
      format:                "jpg",
      image_quality:         85,
      delay:                 3,
      block_ads:             true,
      block_cookie_banners:  true,
    });
    console.log("calling ScreenshotOne with url:", chartUrl);
    const res = await fetch(`https://api.screenshotone.com/take?${params}`);
    console.log("ScreenshotOne status:", res.status);
    if (!res.ok) return null;
    const base64 = Buffer.from(await res.arrayBuffer()).toString("base64");
    return { base64, mimeType: "image/jpeg" };
  } catch {
    return null;
  }
}

async function uploadScreenshotToGitHub(base64, filename) {
  try {
    const path = `docs/screenshots/${filename}`;
    const res = await fetch(`${API_BASE}/repos/${GITHUB_REPO}/contents/${path}`, {
      method: "PUT",
      headers: {
        Authorization:    `Bearer ${GITHUB_TOKEN}`,
        Accept:           "application/vnd.github+json",
        "Content-Type":   "application/json",
      },
      body: JSON.stringify({ message: `screenshot ${filename}`, content: base64, branch: GITHUB_BRANCH }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.content?.download_url || null;
  } catch {
    return null;
  }
}

async function sendTelegram(chatId, caption, screenshotUrl) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || !chatId) return;
  try {
    const base = `https://api.telegram.org/bot${token}`;
    if (screenshotUrl) {
      await fetch(`${base}/sendPhoto`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, photo: screenshotUrl, caption, parse_mode: "HTML" }),
      });
    } else {
      await fetch(`${base}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: caption, parse_mode: "HTML" }),
      });
    }
  } catch (err) {
    console.error("sendTelegram failed:", err.message);
  }
}

function buildCaption(action, ticker, price, strategy, payload, pnl, result) {
  let emoji;
  if (action === "buy")        emoji = "🟢";
  else if (action === "sell")  emoji = "🔴";
  else if (pnl !== undefined)  emoji = result === "win" ? "✅" : "❌";
  else                         emoji = "🔁";

  const lines = [`${emoji} <b>${action.toUpperCase()} ${ticker}</b>`];
  if (strategy)            lines.push(`Strategy: ${strategy}`);
  lines.push(`Price: ${price}`);
  if (payload.sl != null)  lines.push(`SL: ${payload.sl}`);
  const tps = [payload.tp1, payload.tp2, payload.tp3].filter(v => v != null);
  if (tps.length)          lines.push(`TP: ${tps.join(" / ")}`);
  if (payload.qty != null) lines.push(`Qty: ${payload.qty}`);
  if (pnl !== undefined) {
    const sign = pnl >= 0 ? "+" : "";
    lines.push(`PnL: <b>${sign}$${pnl}</b>`);
  }
  lines.push(`<i>${new Date().toUTCString()}</i>`);
  return lines.join("\n");
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
  const strategy  = (req.query.strategy || "").trim() || null;
  const chartUrl  = payload.chart_url || req.query.chart_url || null;

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
    let finalPnl, finalResult;

    try {
      // ---- ENTRY ----
      if (action === "buy" || action === "sell") {
        const tradeId = `${ticker}-${Date.now()}`;
        openTrades[tradeId] = {
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

        // Notify MT5-routing channel (best-effort)
        sendTelegramJson({
          tv: "entry", id: tradeId, ticker,
          action,
          price,
          sl:  payload.sl  ?? undefined,
          tp1: payload.tp1 ?? undefined,
          tp2: payload.tp2 ?? undefined,
          tp3: payload.tp3 ?? undefined,
        });

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

      // ---- EXIT (TP) ----
      } else if (action === "exit") {
        const trade = findOpenTrade(openTrades, ticker);
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
          finalPnl        = pnl;
          finalResult     = trade.result;

          closedTrades.unshift(trade);
          delete openTrades[trade.id];
          logEntry.result = `closed trade — ${trade.result} — pnl: ${pnl} (${filledQty}/${trade.qty} qty)`;

          // Notify MT5-routing channel (best-effort)
          const tgAction = payload.tp ? "exit" : "sl";
          const tgMsg = { tv: "exit", id: trade.id, ticker, action: tgAction, price };
          if (payload.tp) tgMsg.tp = payload.tp;
          sendTelegramJson(tgMsg);

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

      // ---- SL HIT ----
      } else if (action === "sl") {
        const trade = findOpenTrade(openTrades, ticker);
        if (!trade) {
          logEntry.error = `No open trade for ${ticker}`;
          logs.unshift(logEntry);
          if (logs.length > 100) logs.splice(100);
          await ghPut(TRADES_PATH, JSON.stringify(trades, null, 2), tradesSha, `trade log ${now}`);
          return res.status(400).json({ error: logEntry.error });
        }

        const pointValue = POINT_VALUES[ticker] || 1;
        const slPrice = price || trade.entryPrice;
        const remainingQty = trade.qty - trade.exits.reduce((s, e) => s + e.qty, 0);
        if (remainingQty > 0) trade.exits.push({ price: slPrice, qty: remainingQty, time: now, tp: "SL" });

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
        trade.exitPrice = slPrice;
        trade.pnl       = pnl;
        trade.result    = "loss";
        finalPnl        = pnl;
        finalResult     = trade.result;

        closedTrades.unshift(trade);
        delete openTrades[trade.id];
        logEntry.result = `SL hit — pnl: ${pnl}`;

        sendTelegramJson({ tv: "exit", id: trade.id, ticker, action: "sl", price: slPrice });

        journalEntries.push({
          signal_id:    trade.id,
          timestamp:    now,
          message_type: "trade_update",
          source:       "TradingView",
          strategy,
          instrument:   ticker,
          update_type:  "sl_hit",
          entry_price:  trade.entryPrice,
          exits:        trade.exits,
          point_value:  pointValue,
          pnl,
          result:       "loss",
        });

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

    // trades.json is critical — must succeed
    await ghPut(TRADES_PATH, JSON.stringify(trades, null, 2), tradesSha, `trade log ${now}`);

    // journal.jsonl is best-effort — don't fail the request if it errors
    if (journalEntries.length > 0) {
      ghPut(JOURNAL_PATH, updatedJournal + "\n", journalSha, `journal ${now}`)
        .catch(err => console.error("journal write failed:", err.message));
    }

    // Telegram + screenshot — awaited before response so Vercel doesn't kill the execution
    try {
      const chatId = getTelegramChatId(strategy);
      console.log("TELEGRAM chatId:", chatId);
      console.log("SCREENSHOTONE_KEY present:", !!process.env.SCREENSHOTONE_KEY);
      if (chatId || process.env.SCREENSHOTONE_KEY) {
        const caption = buildCaption(action, ticker, price, strategy, payload, finalPnl, finalResult);

        let screenshotUrl = null;
        const shouldCapture = (action === "buy" || action === "sell" || finalPnl !== undefined) && chartUrl;
        if (shouldCapture) {
          const shot = await captureScreenshot(chartUrl);
          console.log("screenshot result:", shot ? "got image" : "null");
          if (shot) {
            const filename = `${ticker}-${Date.now()}.jpg`;
            screenshotUrl = await uploadScreenshotToGitHub(shot.base64, filename);
            console.log("screenshotUrl:", screenshotUrl);
          }
        }

        await sendTelegram(chatId, caption, screenshotUrl);
      }
    } catch (err) {
      console.error("telegram block failed:", err.message);
    }

    return logEntry.error
      ? res.status(500).json(responseBody)
      : res.status(200).json(responseBody);

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
}

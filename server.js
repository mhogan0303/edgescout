import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import { createSign } from 'crypto';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Sports filtering ─────────────────────────────────────────────────
const SPORTS_KEYWORDS = [
  'NBA', 'NFL', 'MLB', 'NHL', 'NCAAB', 'NCAAF',
  'PGA', 'UFC', 'MMA', 'TENNIS', 'SOCCER', 'WNBA',
  'EPL', 'FIFA', 'NCAA', 'GOLF', 'F1', 'NASCAR',
  'BOXING', 'SERIES', 'PLAYOFF', 'CHAMPION',
];

function isSportsMarket(market) {
  const haystack = [
    market.ticker ?? '',
    market.series_ticker ?? '',
    market.title ?? '',
    market.subtitle ?? '',
    market.category ?? '',
    market.event_ticker ?? '',
  ].join(' ').toUpperCase();
  return SPORTS_KEYWORDS.some(kw => haystack.includes(kw));
}

function pickFields(market) {
  return {
    ticker:        market.ticker        ?? null,
    title:         market.title         ?? null,
    yes_bid:       market.yes_bid       ?? null,
    yes_ask:       market.yes_ask       ?? null,
    no_bid:        market.no_bid        ?? null,
    no_ask:        market.no_ask        ?? null,
    volume:        market.volume        ?? 0,
    open_interest: market.open_interest ?? 0,
    close_time:    market.close_time    ?? null,
    status:        market.status        ?? null,
    series_ticker: market.series_ticker ?? null,
    event_ticker:  market.event_ticker  ?? null,
    category:      market.category      ?? null,
  };
}

// ─── RSA-PSS Signing ──────────────────────────────────────────────────
/**
 * Kalshi auth requires three headers per request:
 *   KALSHI-ACCESS-KEY       — the Key ID from your Kalshi dashboard
 *   KALSHI-ACCESS-TIMESTAMP — current Unix time in milliseconds (as string)
 *   KALSHI-ACCESS-SIGNATURE — base64(RSA-PSS-SHA256(timestamp + METHOD + path))
 *
 * The path must NOT include the query string.
 */
function buildKalshiHeaders(keyId, privateKeyPem, method, urlPath) {
  // Strip query string from path before signing
  const pathOnly = urlPath.split('?')[0];

  const timestampMs = String(Date.now());
  const message     = timestampMs + method.toUpperCase() + pathOnly;

  const sign = createSign('RSA-SHA256');
  sign.update(message);
  sign.end();

  // RSA-PSS with SHA-256, salt length = digest length (32 bytes)
  const signature = sign.sign({
    key:            privateKeyPem,
    padding:        6,    // crypto.constants.RSA_PKCS1_PSS_PADDING = 6
    saltLength:     32,   // SHA-256 digest length
  }, 'base64');

  return {
    'Content-Type':           'application/json',
    'KALSHI-ACCESS-KEY':      keyId,
    'KALSHI-ACCESS-TIMESTAMP': timestampMs,
    'KALSHI-ACCESS-SIGNATURE': signature,
  };
}

/**
 * Render (and most CI systems) store multiline secrets with literal \n.
 * This normalises them back to real newlines so the PEM parser is happy.
 */
function normalisePem(raw) {
  return raw.replace(/\\n/g, '\n').trim();
}

// ─── Kalshi market fetcher ────────────────────────────────────────────
const BASE_URL  = 'https://api.elections.kalshi.com';
const API_PATH  = '/trade-api/v2/markets';

async function fetchAllMarkets(keyId, privateKeyPem) {
  let markets = [];
  let cursor  = null;
  let pages   = 0;
  const MAX_PAGES = 20;

  do {
    // Build query string
    const params = new URLSearchParams({ limit: '200', status: 'open' });
    if (cursor) params.set('cursor', cursor);

    const fullPath = `${API_PATH}?${params.toString()}`;
    const url      = `${BASE_URL}${fullPath}`;

    const headers = buildKalshiHeaders(keyId, privateKeyPem, 'GET', API_PATH);

    const res = await fetch(url, { headers });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Kalshi API error ${res.status}: ${body}`);
    }

    const data  = await res.json();
    const batch = data.markets ?? [];
    markets = markets.concat(batch);
    cursor  = data.cursor ?? null;
    pages++;

    if (batch.length < 200) break;
  } while (cursor && pages < MAX_PAGES);

  return markets;
}

// ─── Middleware ───────────────────────────────────────────────────────
app.use(cors());
app.use(express.static(join(__dirname, 'public')));

// ─── Routes ───────────────────────────────────────────────────────────
app.get('/api/markets', async (req, res) => {
  const rawKey = process.env.KALSHI_API_KEY;
  const keyId  = process.env.KALSHI_KEY_ID;

  // Validate env vars
  if (!rawKey || rawKey === 'your_key_here') {
    return res.status(500).json({
      error: 'KALSHI_API_KEY is not set. Paste your RSA private key PEM into the Render environment variable.',
    });
  }
  if (!keyId || keyId === 'your_key_id_here') {
    return res.status(500).json({
      error: 'KALSHI_KEY_ID is not set. Add your Key ID from the Kalshi dashboard as a Render environment variable.',
    });
  }

  const privateKeyPem = normalisePem(rawKey);

  try {
    const allMarkets    = await fetchAllMarkets(keyId, privateKeyPem);
    const sportsMarkets = allMarkets.filter(isSportsMarket);
    const result        = sportsMarkets.map(pickFields);

    res.json({
      count:         result.length,
      total_fetched: allMarkets.length,
      markets:       result,
    });
  } catch (err) {
    console.error('[/api/markets] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`EdgeScout running on http://localhost:${PORT}`);
});

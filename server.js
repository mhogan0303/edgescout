import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import { createSign } from 'crypto';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

const app  = express();
const PORT = process.env.PORT || 3000;

const BASE_URL = 'https://api.elections.kalshi.com';

// ─── Sports filtering ─────────────────────────────────────────────────
const SPORTS_KEYWORDS = [
  'NBA', 'NFL', 'MLB', 'NHL', 'NCAAB', 'NCAAF',
  'PGA', 'UFC', 'MMA', 'TENNIS', 'SOCCER', 'WNBA',
  'EPL', 'FIFA', 'NCAA', 'GOLF', 'BOXING',
  'SERIES', 'PLAYOFF', 'CHAMPION',
];

function isSportsMarket(market) {
  const haystack = [
    market.ticker        ?? '',
    market.series_ticker ?? '',
    market.title         ?? '',
    market.subtitle      ?? '',
    market.category      ?? '',
    market.event_ticker  ?? '',
  ].join(' ').toUpperCase();
  return SPORTS_KEYWORDS.some(kw => haystack.includes(kw));
}

// ─── RSA-PSS Signing ──────────────────────────────────────────────────
function buildKalshiHeaders(keyId, privateKeyPem, method, urlPath) {
  const pathOnly    = urlPath.split('?')[0];
  const timestampMs = String(Date.now());
  const message     = timestampMs + method.toUpperCase() + pathOnly;

  const sign = createSign('RSA-SHA256');
  sign.update(message);
  sign.end();

  const signature = sign.sign(
    { key: privateKeyPem, padding: 6, saltLength: 32 },
    'base64'
  );

  return {
    'Content-Type':            'application/json',
    'KALSHI-ACCESS-KEY':       keyId,
    'KALSHI-ACCESS-TIMESTAMP': timestampMs,
    'KALSHI-ACCESS-SIGNATURE': signature,
  };
}

function normalisePem(raw) {
  return raw.replace(/\\n/g, '\n').trim();
}

// ─── Kalshi API helpers ───────────────────────────────────────────────
async function kalshiGet(path, keyId, pem) {
  const url     = `${BASE_URL}${path}`;
  const headers = buildKalshiHeaders(keyId, pem, 'GET', path.split('?')[0]);
  const res     = await fetch(url, { headers });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Kalshi ${res.status} on ${path}: ${body}`);
  }
  return res.json();
}

// Fetch all open markets (paginated)
async function fetchAllMarkets(keyId, pem) {
  let markets  = [];
  let cursor   = null;
  let pages    = 0;

  do {
    const params = new URLSearchParams({ limit: '200', status: 'open' });
    if (cursor) params.set('cursor', cursor);

    const path = `/trade-api/v2/markets?${params}`;
    const data = await kalshiGet(path, keyId, pem);

    const batch = data.markets ?? [];
    markets = markets.concat(batch);
    cursor  = data.cursor ?? null;
    pages++;

    if (batch.length < 200) break;
  } while (cursor && pages < 20);

  return markets;
}

// Fetch orderbook for one ticker — returns { yes_bid, no_bid }
async function fetchOrderbook(ticker, keyId, pem) {
  try {
    const path = `/trade-api/v2/markets/${ticker}/orderbook`;
    const data = await kalshiGet(path, keyId, pem);

    const ob = data.orderbook ?? data;

    const yesBids = (ob.yes ?? [])
      .filter(l => l.quantity > 0)
      .sort((a, b) => b.price - a.price);

    const noBids = (ob.no ?? [])
      .filter(l => l.quantity > 0)
      .sort((a, b) => b.price - a.price);

    return {
      yes_bid: yesBids.length ? yesBids[0].price : null,
      no_bid:  noBids.length  ? noBids[0].price  : null,
    };
  } catch {
    return { yes_bid: null, no_bid: null };
  }
}

// ─── Middleware ───────────────────────────────────────────────────────
app.use(cors());
app.use(express.static(join(__dirname, 'public')));

// ─── Main route ───────────────────────────────────────────────────────
app.get('/api/markets', async (req, res) => {
  const rawKey = process.env.KALSHI_API_KEY;
  const keyId  = process.env.KALSHI_KEY_ID;

  if (!rawKey || rawKey === 'your_key_here') {
    return res.status(500).json({ error: 'KALSHI_API_KEY not configured.' });
  }
  if (!keyId || keyId === 'your_key_id_here') {
    return res.status(500).json({ error: 'KALSHI_KEY_ID not configured.' });
  }

  const pem = normalisePem(rawKey);

  try {
    // 1. Fetch all open markets
    const allMarkets = await fetchAllMarkets(keyId, pem);

    // 2. Filter to sports
    const sports = allMarkets.filter(isSportsMarket);

    // 3. Sort by liquidity, take top 60
    const top = sports
      .sort((a, b) =>
        ((b.open_interest ?? 0) + (b.volume ?? 0)) -
        ((a.open_interest ?? 0) + (a.volume ?? 0))
      )
      .slice(0, 60);

    // 4. Fetch orderbook prices in parallel batches of 10
    const enriched = [];
    const BATCH = 10;

    for (let i = 0; i < top.length; i += BATCH) {
      const batch  = top.slice(i, i + BATCH);
      const prices = await Promise.all(
        batch.map(m => fetchOrderbook(m.ticker, keyId, pem))
      );
      batch.forEach((m, idx) => {
        enriched.push({
          ticker:        m.ticker        ?? null,
          title:         m.title         ?? null,
          yes_bid:       prices[idx].yes_bid,
          yes_ask:       null,
          no_bid:        prices[idx].no_bid,
          no_ask:        null,
          volume:        m.volume        ?? 0,
          open_interest: m.open_interest ?? 0,
          close_time:    m.close_time    ?? null,
          status:        m.status        ?? null,
          series_ticker: m.series_ticker ?? null,
          event_ticker:  m.event_ticker  ?? null,
          category:      m.category      ?? null,
        });
      });
    }

    // 5. Only return markets where we got real prices
    const withPrices = enriched.filter(
      m => m.yes_bid !== null && m.no_bid !== null
    );

    res.json({
      count:         withPrices.length,
      total_fetched: allMarkets.length,
      sports_found:  sports.length,
      markets:       withPrices,
    });

  } catch (err) {
    console.error('[/api/markets]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`EdgeScout running on http://localhost:${PORT}`);
});

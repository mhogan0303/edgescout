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
// Broad list — catches Kalshi's internal naming conventions
const SPORTS_KEYWORDS = [
  // Standard sport abbreviations
  'NBA', 'NFL', 'MLB', 'NHL', 'NCAAB', 'NCAAF', 'WNBA',
  'PGA', 'UFC', 'MMA', 'EPL', 'FIFA', 'NCAA',
  // Kalshi-specific ticker patterns
  'SPORT', 'MULTI', 'GAME', 'MATCH', 'PLAYER',
  // Sport names written out
  'BASKETBALL', 'FOOTBALL', 'BASEBALL', 'HOCKEY', 'TENNIS',
  'SOCCER', 'GOLF', 'BOXING', 'WRESTLING',
  // Common in Kalshi sports titles
  'SERIES', 'PLAYOFF', 'CHAMPION', 'FINALS', 'TOURNAMENT',
  'SCORE', 'WINS', 'BEATS', 'POINTS', 'GOALS', 'RUNS',
  // Player/team context words common in sports props
  'QUARTERBACK', 'PITCHER', 'TOUCHDOWN',
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
  let markets = [];
  let cursor  = null;
  let pages   = 0;

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

// Fetch orderbook for one ticker
// Returns best yes bid and best no bid (in cents, 1-99)
async function fetchOrderbook(ticker, keyId, pem) {
  try {
    const path = `/trade-api/v2/markets/${ticker}/orderbook`;
    const data = await kalshiGet(path, keyId, pem);

    // Kalshi orderbook response shape:
    // { orderbook: { yes: [{price, quantity}], no: [{price, quantity}] } }
    // OR sometimes the levels are under yes_levels / no_levels
    const ob = data.orderbook ?? data;

    const yesLevels = ob.yes ?? ob.yes_levels ?? [];
    const noLevels  = ob.no  ?? ob.no_levels  ?? [];

    const yesBids = yesLevels
      .filter(l => (l.quantity ?? l.delta ?? 0) > 0)
      .sort((a, b) => b.price - a.price);

    const noBids = noLevels
      .filter(l => (l.quantity ?? l.delta ?? 0) > 0)
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

    // 2. Filter to sports using broad keyword list
    const sports = allMarkets.filter(isSportsMarket);

    // 3. Take up to 80 markets — spread across the list
    //    Don't sort by volume since Kalshi often returns 0 for these fields.
    //    Instead interleave from front/middle/back to get variety.
    const MAX = 80;
    let candidates = sports;
    if (candidates.length > MAX) {
      const step = Math.floor(candidates.length / MAX);
      candidates = candidates.filter((_, i) => i % step === 0).slice(0, MAX);
    }

    // 4. Fetch orderbooks in parallel batches of 10
    const enriched = [];
    const BATCH = 10;

    for (let i = 0; i < candidates.length; i += BATCH) {
      const batch  = candidates.slice(i, i + BATCH);
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

    // 5. Only return markets where we got real prices on both sides
    const withPrices = enriched.filter(
      m => m.yes_bid !== null && m.no_bid !== null
    );

    res.json({
      count:         withPrices.length,
      total_fetched: allMarkets.length,
      sports_found:  sports.length,
      sampled:       candidates.length,
      markets:       withPrices,
    });

  } catch (err) {
    console.error('[/api/markets]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Debug route — shows raw sample of sports markets WITHOUT orderbook fetch
// Helps diagnose what data Kalshi is actually returning
app.get('/api/debug', async (req, res) => {
  const rawKey = process.env.KALSHI_API_KEY;
  const keyId  = process.env.KALSHI_KEY_ID;
  if (!rawKey || !keyId) return res.status(500).json({ error: 'Keys not configured.' });

  const pem = normalisePem(rawKey);
  try {
    const allMarkets = await fetchAllMarkets(keyId, pem);
    const sports     = allMarkets.filter(isSportsMarket);

    // Return first 5 sports markets raw + first orderbook raw
    const sample    = sports.slice(0, 5);
    let obSample = null;
    if (sample.length) {
      const path = `/trade-api/v2/markets/${sample[0].ticker}/orderbook`;
      try { obSample = await kalshiGet(path, keyId, pem); } catch (e) { obSample = { error: e.message }; }
    }

    res.json({
      total_fetched: allMarkets.length,
      sports_found:  sports.length,
      sample_markets: sample,
      sample_orderbook: obSample,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`EdgeScout running on http://localhost:${PORT}`);
});

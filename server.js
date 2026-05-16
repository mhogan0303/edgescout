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

// ─── Parlay exclusion ─────────────────────────────────────────────────
function isParlay(market) {
  const ticker = (market.ticker ?? '').toUpperCase();
  if (ticker.startsWith('KXMVE')) return true;
  if (market.mve_collection_ticker) return true;
  if (Array.isArray(market.mve_selected_legs) && market.mve_selected_legs.length > 1) return true;
  return false;
}

// ─── Sports filtering ─────────────────────────────────────────────────
const SPORTS_KEYWORDS = [
  'NBA', 'NFL', 'MLB', 'NHL', 'NCAAB', 'NCAAF', 'WNBA',
  'PGA', 'UFC', 'MMA', 'EPL', 'FIFA', 'NCAA', 'GOLF', 'BOXING',
  'BASKETBALL', 'FOOTBALL', 'BASEBALL', 'HOCKEY', 'TENNIS',
  'SOCCER', 'WRESTLING',
  'SERIES', 'PLAYOFF', 'CHAMPION', 'FINALS', 'TOURNAMENT',
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

// ─── Price extraction ─────────────────────────────────────────────────
function dollarsToCents(val) {
  if (!val) return null;
  const n = Math.round(parseFloat(val) * 100);
  return (n > 0 && n < 100) ? n : null;
}

function extractPrices(market) {
  const yesBid = dollarsToCents(market.yes_bid_dollars)
              ?? dollarsToCents(market.yes_ask_dollars);
  const noBid  = dollarsToCents(market.no_bid_dollars)
              ?? dollarsToCents(market.no_ask_dollars);
  return { yes_bid: yesBid, no_bid: noBid };
}

function hasBothPrices(market) {
  const { yes_bid, no_bid } = extractPrices(market);
  return yes_bid !== null && no_bid !== null;
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
    const allMarkets = await fetchAllMarkets(keyId, pem);

    // Apply filters one at a time and track counts at each stage
    const afterParlayFilter = allMarkets.filter(m => !isParlay(m));
    const afterSportsFilter = afterParlayFilter.filter(m => isSportsMarket(m));
    const afterPriceFilter  = afterSportsFilter.filter(m => hasBothPrices(m));

    const result = afterPriceFilter.map(m => {
      const { yes_bid, no_bid } = extractPrices(m);
      return {
        ticker:        m.ticker        ?? null,
        title:         m.title         ?? null,
        yes_bid,
        no_bid,
        volume:        Math.round(parseFloat(m.volume_fp        ?? m.volume        ?? 0)),
        open_interest: Math.round(parseFloat(m.open_interest_fp ?? m.open_interest ?? 0)),
        close_time:    m.close_time    ?? null,
        status:        m.status        ?? null,
        series_ticker: m.series_ticker ?? null,
        event_ticker:  m.event_ticker  ?? null,
        category:      m.category      ?? null,
      };
    });

    res.json({
      count:         result.length,
      total_fetched: allMarkets.length,
      // Shows exactly where markets are being dropped
      debug_counts: {
        total:            allMarkets.length,
        after_no_parlay:  afterParlayFilter.length,
        after_sports:     afterSportsFilter.length,
        after_prices:     afterPriceFilter.length,
        // Sample of sports markets that have NO prices — helps diagnose timing
        unpriced_sample:  afterSportsFilter
          .filter(m => !hasBothPrices(m))
          .slice(0, 3)
          .map(m => ({
            ticker:          m.ticker,
            title:           m.title,
            yes_bid_dollars: m.yes_bid_dollars,
            no_bid_dollars:  m.no_bid_dollars,
            yes_ask_dollars: m.yes_ask_dollars,
            no_ask_dollars:  m.no_ask_dollars,
            close_time:      m.close_time,
          })),
      },
      markets: result,
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

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Sports keywords used to filter Kalshi markets
const SPORTS_KEYWORDS = [
  'NBA', 'NFL', 'MLB', 'NHL', 'NCAAB', 'NCAAF',
  'PGA', 'UFC', 'MMA', 'TENNIS', 'SOCCER', 'WNBA',
  'EPL', 'FIFA', 'NCAA', 'GOLF', 'F1', 'NASCAR',
  'BOXING', 'SERIES', 'PLAYOFF', 'CHAMPION',
];

// Helpers
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
    ticker: market.ticker ?? null,
    title: market.title ?? null,
    yes_bid: market.yes_bid ?? null,
    yes_ask: market.yes_ask ?? null,
    no_bid: market.no_bid ?? null,
    no_ask: market.no_ask ?? null,
    volume: market.volume ?? 0,
    open_interest: market.open_interest ?? 0,
    close_time: market.close_time ?? null,
    status: market.status ?? null,
    series_ticker: market.series_ticker ?? null,
    event_ticker: market.event_ticker ?? null,
    category: market.category ?? null,
  };
}

// Fetch ALL markets from Kalshi with cursor pagination
async function fetchAllMarkets(apiKey) {
  const base = 'https://api.elections.kalshi.com/trade-api/v2/markets';
  const headers = {
    'Authorization': `Bearer ${apiKey}`,
    'Accept': 'application/json',
  };

  let markets = [];
  let cursor = null;
  let pages = 0;
  const MAX_PAGES = 20; // cap to avoid infinite loops

  do {
    const url = new URL(base);
    url.searchParams.set('limit', '200');
    url.searchParams.set('status', 'open');
    if (cursor) url.searchParams.set('cursor', cursor);

    const res = await fetch(url.toString(), { headers });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Kalshi API error ${res.status}: ${body}`);
    }

    const data = await res.json();
    const batch = data.markets ?? [];
    markets = markets.concat(batch);
    cursor = data.cursor ?? null;
    pages++;

    // Stop early if we get fewer results than we asked for (last page)
    if (batch.length < 200) break;
  } while (cursor && pages < MAX_PAGES);

  return markets;
}

// ------- Middleware -------
app.use(cors());
app.use(express.static(join(__dirname, 'public')));

// ------- Routes -------
app.get('/api/markets', async (req, res) => {
  const apiKey = process.env.KALSHI_API_KEY;

  if (!apiKey || apiKey === 'your_key_here') {
    return res.status(500).json({
      error: 'KALSHI_API_KEY not configured. Set it in your .env file or environment variables.',
    });
  }

  try {
    const allMarkets = await fetchAllMarkets(apiKey);

    // Filter to sports-related markets
    const sportsMarkets = allMarkets.filter(isSportsMarket);

    // Return only the fields the frontend needs
    const result = sportsMarkets.map(pickFields);

    res.json({
      count: result.length,
      total_fetched: allMarkets.length,
      markets: result,
    });
  } catch (err) {
    console.error('[/api/markets] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`EdgeScout server running on http://localhost:${PORT}`);
});

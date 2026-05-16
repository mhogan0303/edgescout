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
  return false; // handled by series-level fetching
}

// ─── Sports filtering ─────────────────────────────────────────────────
const SPORT_PREFIXES = [
  'KXMLB', 'KXNBA', 'KXNHL', 'KXNFL',
  'KXUFC', 'KXPGA', 'KXWNBA', 'KXMLS',
];

function isSportsMarket(market) {
  const haystack = [
    market.ticker        ?? '',
    market.event_ticker  ?? '',
    market.series_ticker ?? '',
  ].join(' ').toUpperCase();
  return SPORT_PREFIXES.some(p => haystack.includes(p));
}

// ─── Price extraction ─────────────────────────────────────────────────
function dollarsToCents(val) {
  if (!val) return null;
  const n = Math.round(parseFloat(val) * 100);
  return (n > 0 && n <= 100) ? n : null;
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

// ─── Two-sided market check ───────────────────────────────────────────
// Filters out markets that are already resolving (96¢/2¢ type situations)
// and markets with negative vig (broken pricing).
// A healthy two-sided market has yes+no between 85 and 115 cents.
function isTwoSided(market) {
  const { yes_bid, no_bid } = extractPrices(market);
  if (!yes_bid || !no_bid) return false;

  // Prices must add up to a reasonable two-sided market
  const total = yes_bid + no_bid;
  if (total < 85 || total > 115) return false;

  // Moneylines only for now — exclude totals and spreads entirely
  const ticker = (market.ticker ?? '').toUpperCase();
  if (ticker.includes('TOTAL') || ticker.includes('SPREAD')) return false;

  return true;
}

// ─── Title enrichment ─────────────────────────────────────────────────
// Kalshi titles like "Philadelphia vs Pittsburgh Total Runs?" don't include
// the actual line. We parse it from the ticker suffix and append it.
//
// Ticker examples:
//   KXMLBTOTAL-26MAY161605PHIPIT-9    → "Over 8.5 runs"
//   KXMLBSPREAD-26MAY161605PHIPIT-PHI2 → "PHI wins by over 1.5 runs"
//   KXNBATOTAL-26MAY18SASOKC-220      → "Over 219.5 points"
//   KXNBASPREAD-26MAY18SASOKC-OKC6    → "OKC wins by over 5.5 points"

function enrichTitle(market) {
  const ticker = market.ticker ?? '';
  const title  = market.title  ?? ticker;
  const upper  = ticker.toUpperCase();

  // Extract the suffix after the last hyphen
  const parts  = ticker.split('-');
  const suffix = parts[parts.length - 1] ?? '';
  const num    = parseInt(suffix.replace(/[^0-9]/g, ''), 10);

  // MLB Total Runs — suffix is a whole number representing the line
  // e.g. -9 means "over 8.5 runs scored"
  if (upper.includes('MLBTOTAL') && !isNaN(num)) {
    return `${title} — Over ${num - 0.5} runs`;
  }

  // MLB Spread — suffix like PHI2, STL3, DET4
  // number = runs margin, e.g. PHI2 = "PHI wins by over 1.5 runs"
  if (upper.includes('MLBSPREAD') && !isNaN(num) && num > 0) {
    const team = suffix.replace(/[0-9]/g, '');
    return `${title} — ${team} by ${num - 0.5}+ runs`;
  }

  // NBA Total Points — suffix is the line, e.g. 220 = over 219.5
  if (upper.includes('NBATOTAL') && !isNaN(num)) {
    return `${title} — Over ${num - 0.5} pts`;
  }

  // NBA Spread — suffix like OKC6, SAS14
  if (upper.includes('NBASPREAD') && !isNaN(num) && num > 0) {
    const team = suffix.replace(/[0-9]/g, '');
    return `${title} — ${team} by ${num - 0.5}+ pts`;
  }

  // NHL / NFL game winner — suffix is team abbreviation, already clear
  // PGA / UFC — title is already descriptive enough

  return title;
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
  const SERIES = [
    'KXMLBGAME', 'KXMLBSPREAD', 'KXMLBTOTAL',
    'KXNBAGAME', 'KXNBASPREAD', 'KXNBATOTAL', 'KXNBASERIES',
    'KXNHLGAME',
    'KXNFLGAME',
    'KXUFCFIGHT',
    'KXPGATOUR',
  ];

  let allMarkets = [];

  for (const series of SERIES) {
    const params = new URLSearchParams({
      limit:         '200',
      status:        'open',
      series_ticker: series,
    });
    const path = `/trade-api/v2/markets?${params}`;
    try {
      const data = await kalshiGet(path, keyId, pem);
      allMarkets = allMarkets.concat(data.markets ?? []);
    } catch (e) {
      console.error(`Failed to fetch series ${series}:`, e.message);
    }
  }

  return allMarkets;
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

    const result = allMarkets
      .filter(m => isSportsMarket(m))   // sports only
      .filter(m => hasBothPrices(m))    // must have both sides priced
      .filter(m => isTwoSided(m))       // must be a live two-sided market
      .map(m => {
        const { yes_bid, no_bid } = extractPrices(m);
        return {
          ticker:        m.ticker        ?? null,
          title:         enrichTitle(m),  // enriched with line info
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
      markets:       result,
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

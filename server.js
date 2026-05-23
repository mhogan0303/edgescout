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

const BASE_URL     = 'https://api.elections.kalshi.com';
const ODDS_API_URL = 'https://api.the-odds-api.com/v4/sports';

// ─── Sport key mapping ────────────────────────────────────────────────
// Maps Kalshi ticker prefixes to The Odds API sport keys
const SPORT_KEY_MAP = {
  KXNFL:    'americanfootball_nfl',
  KXMLB:    'baseball_mlb',
  KXNBA:    'basketball_nba',
  KXNHL:    'icehockey_nhl',
  KXUFC:    'mma_mixed_martial_arts',
};

function getSportKey(ticker) {
  const upper = ticker.toUpperCase();
  for (const [prefix, key] of Object.entries(SPORT_KEY_MAP)) {
    if (upper.startsWith(prefix)) return key;
  }
  return null;
}

// ─── Team name normalization ──────────────────────────────────────────
// Kalshi uses short codes (NYY, LAD, KC) while Odds API uses full names.
// We match by checking if any word in the full team name matches the
// Kalshi abbreviation, or by a lookup table for common ones.
const TEAM_ALIASES = {
  // MLB
  'NYY': ['New York Yankees', 'Yankees'],
  'NYM': ['New York Mets', 'Mets'],
  'LAD': ['Los Angeles Dodgers', 'Dodgers'],
  'LAA': ['Los Angeles Angels', 'Angels'],
  'SF':  ['San Francisco Giants', 'Giants'],
  'ATH': ["Athletics", "Oakland Athletics", "A's"],
  'SD':  ['San Diego Padres', 'Padres'],
  'SEA': ['Seattle Mariners', 'Mariners'],
  'HOU': ['Houston Astros', 'Astros'],
  'TEX': ['Texas Rangers', 'Rangers'],
  'ATL': ['Atlanta Braves', 'Braves'],
  'MIA': ['Miami Marlins', 'Marlins'],
  'PHI': ['Philadelphia Phillies', 'Phillies'],
  'WSH': ['Washington Nationals', 'Nationals'],
  'NYY': ['New York Yankees'],
  'BOS': ['Boston Red Sox', 'Red Sox'],
  'TB':  ['Tampa Bay Rays', 'Rays'],
  'BAL': ['Baltimore Orioles', 'Orioles'],
  'TOR': ['Toronto Blue Jays', 'Blue Jays'],
  'CLE': ['Cleveland Guardians', 'Guardians'],
  'DET': ['Detroit Tigers', 'Tigers'],
  'CWS': ['Chicago White Sox', 'White Sox'],
  'CHC': ['Chicago Cubs', 'Cubs'],
  'MIN': ['Minnesota Twins', 'Twins'],
  'KC':  ['Kansas City Royals', 'Royals'],
  'MIL': ['Milwaukee Brewers', 'Brewers'],
  'STL': ['St. Louis Cardinals', 'Cardinals'],
  'CIN': ['Cincinnati Reds', 'Reds'],
  'PIT': ['Pittsburgh Pirates', 'Pirates'],
  'AZ':  ['Arizona Diamondbacks', 'Diamondbacks'],
  'COL': ['Colorado Rockies', 'Rockies'],
  // NBA
  'OKC': ['Oklahoma City Thunder', 'Thunder'],
  'SAS': ['San Antonio Spurs', 'Spurs'],
  'DET': ['Detroit Pistons', 'Pistons'],
  // NHL
  'MTL': ['Montreal Canadiens', 'Canadiens'],
  'BUF': ['Buffalo Sabres', 'Sabres'],
  'VGK': ['Vegas Golden Knights', 'Golden Knights'],
  // NFL
  'NE':  ['New England Patriots', 'Patriots'],
  'LAR': ['Los Angeles Rams', 'Rams'],
  'LAC': ['Los Angeles Chargers', 'Chargers'],
  'GB':  ['Green Bay Packers', 'Packers'],
  'NO':  ['New Orleans Saints', 'Saints'],
  'JAC': ['Jacksonville Jaguars', 'Jaguars'],
  'IND': ['Indianapolis Colts', 'Colts'],
  'CAR': ['Carolina Panthers', 'Panthers'],
  'CHI': ['Chicago Bears', 'Bears'],
  'LV':  ['Las Vegas Raiders', 'Raiders'],
  'WAS': ['Washington Commanders', 'Commanders'],
  'TEN': ['Tennessee Titans', 'Titans'],
  'NYJ': ['New York Jets', 'Jets'],
  'NYG': ['New York Giants', 'Giants'],
  'DAL': ['Dallas Cowboys', 'Cowboys'],
  'DEN': ['Denver Broncos', 'Broncos'],
  'PIT': ['Pittsburgh Steelers', 'Steelers'],
  'ATL': ['Atlanta Falcons', 'Falcons'],
  'CIN': ['Cincinnati Bengals', 'Bengals'],
  'CLE': ['Cleveland Browns', 'Browns'],
  'BAL': ['Baltimore Ravens', 'Ravens'],
  'MIA': ['Miami Dolphins', 'Dolphins'],
  'BUF': ['Buffalo Bills', 'Bills'],
  'HOU': ['Houston Texans', 'Texans'],
  'TB':  ['Tampa Bay Buccaneers', 'Buccaneers'],
  'SF':  ['San Francisco 49ers', '49ers'],
  'SEA': ['Seattle Seahawks', 'Seahawks'],
  'ARI': ['Arizona Cardinals', 'Cardinals'],
  'MIN': ['Minnesota Vikings', 'Vikings'],
  'DET': ['Detroit Lions', 'Lions'],
  'GB':  ['Green Bay Packers', 'Packers'],
  'CHI': ['Chicago Bears', 'Bears'],
};

function teamMatches(kalshiCode, oddsTeamName) {
  const aliases = TEAM_ALIASES[kalshiCode.toUpperCase()] ?? [];
  const oddsUpper = oddsTeamName.toUpperCase();
  return aliases.some(a => oddsUpper.includes(a.toUpperCase()) || a.toUpperCase().includes(oddsUpper));
}

// ─── Vegas odds cache ─────────────────────────────────────────────────
// Cache odds for 5 minutes to avoid burning API quota
let oddsCache = {};
let oddsCacheTime = {};
const CACHE_TTL_MS = 5 * 60 * 1000;

async function fetchVegasOdds(sportKey, oddsApiKey) {
  const now = Date.now();
  if (oddsCache[sportKey] && (now - oddsCacheTime[sportKey]) < CACHE_TTL_MS) {
    return oddsCache[sportKey];
  }

  try {
    const url = `${ODDS_API_URL}/${sportKey}/odds?apiKey=${oddsApiKey}&regions=us&markets=h2h&oddsFormat=american`;
    const res = await fetch(url);
    if (!res.ok) {
      console.warn(`[Odds API] ${res.status} for ${sportKey}`);
      return [];
    }
    const data = await res.json();
    oddsCache[sportKey]     = data;
    oddsCacheTime[sportKey] = now;
    return data;
  } catch (e) {
    console.warn(`[Odds API] fetch error for ${sportKey}:`, e.message);
    return [];
  }
}

// Convert American odds to implied probability (with vig removed)
function americanToImplied(american) {
  if (american > 0) return 100 / (american + 100);
  return Math.abs(american) / (Math.abs(american) + 100);
}

// Get consensus Vegas implied probability for a team in a game
// Returns null if no match found
function getVegasProb(vegasGames, kalshiTeamCode, eventTicker) {
  if (!vegasGames || !vegasGames.length) return null;

  for (const game of vegasGames) {
    const homeMatch = teamMatches(kalshiTeamCode, game.home_team);
    const awayMatch = teamMatches(kalshiTeamCode, game.away_team);
    if (!homeMatch && !awayMatch) continue;

    // Found the game — get consensus implied prob across all books
    const probs = [];
    for (const book of (game.bookmakers ?? [])) {
      const h2h = book.markets?.find(m => m.key === 'h2h');
      if (!h2h) continue;
      const outcome = h2h.outcomes?.find(o =>
        homeMatch ? teamMatches(kalshiTeamCode, o.name) : teamMatches(kalshiTeamCode, o.name)
      );
      if (outcome) probs.push(americanToImplied(outcome.price));
    }

    if (!probs.length) return null;

    // Average across books and remove vig
    const raw = probs.reduce((a, b) => a + b, 0) / probs.length;
    return Math.min(0.97, Math.max(0.03, raw));
  }

  return null;
}

// ─── Parlay exclusion ─────────────────────────────────────────────────
function isParlay(market) {
  return false;
}

// ─── Sports filtering ─────────────────────────────────────────────────
const SPORT_PREFIXES = [
  'KXMLB', 'KXNBA', 'KXNHL', 'KXNFL',
  'KXUFC', 'KXWNBA', 'KXMLS',
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

// ─── Market type filter ───────────────────────────────────────────────
function isTwoSided(market) {
  const { yes_bid, no_bid } = extractPrices(market);
  if (!yes_bid || !no_bid) return false;
  const total = yes_bid + no_bid;
  if (total < 85 || total > 115) return false;
  // Moneylines only
  const ticker = (market.ticker ?? '').toUpperCase();
  if (ticker.includes('TOTAL') || ticker.includes('SPREAD')) return false;
  return true;
}

// ─── Actionable timing filter ─────────────────────────────────────────
function isActionable(market) {
  const ticker    = (market.ticker ?? '').toUpperCase();
  const closeTime = market.close_time;
  if (!closeTime) return true;
  if (ticker.includes('KXNFL') || ticker.includes('KXNBASERIES')) return true;
  const hoursUntilClose = (new Date(closeTime) - new Date()) / (1000 * 60 * 60);
  return hoursUntilClose <= 48;
}

// ─── Title enrichment ─────────────────────────────────────────────────
function enrichTitle(market) {
  const ticker = market.ticker ?? '';
  const title  = market.title  ?? ticker;
  const upper  = ticker.toUpperCase();
  const isGameWinner = upper.includes('GAME') || upper.includes('SERIES') || upper.includes('FIGHT');
  if (isGameWinner) {
    const parts = ticker.split('-');
    const teamSuffix = parts[parts.length - 1];
    if (teamSuffix && !teamSuffix.match(/^\d+$/)) {
      return `${title} — YES = ${teamSuffix} wins`;
    }
  }
  return title;
}

// ─── Extract team code from ticker ───────────────────────────────────
// e.g. KXNFLGAME-26SEP09NESEA-SEA → SEA
//      KXNFLGAME-26SEP09NESEA-NE  → NE
function extractTeamCode(ticker) {
  const parts = ticker.split('-');
  const last = parts[parts.length - 1];
  if (last && !last.match(/^\d+$/)) return last.toUpperCase();
  return null;
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
    'KXMLBGAME',
    'KXNBAGAME',
    'KXNBASERIES',
    'KXNHLGAME',
    'KXNFLGAME',
    'KXUFCFIGHT',
  ];

  let allMarkets = [];
  for (const series of SERIES) {
    const params = new URLSearchParams({ limit: '200', status: 'open', series_ticker: series });
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
  const rawKey    = process.env.KALSHI_API_KEY;
  const keyId     = process.env.KALSHI_KEY_ID;
  const oddsApiKey = process.env.ODDS_API_KEY;

  if (!rawKey || rawKey === 'your_key_here') {
    return res.status(500).json({ error: 'KALSHI_API_KEY not configured.' });
  }
  if (!keyId || keyId === 'your_key_id_here') {
    return res.status(500).json({ error: 'KALSHI_KEY_ID not configured.' });
  }

  const pem = normalisePem(rawKey);

  try {
    const allMarkets = await fetchAllMarkets(keyId, pem);

    // Filter to actionable moneyline markets
    const candidates = allMarkets
      .filter(m => isSportsMarket(m))
      .filter(m => hasBothPrices(m))
      .filter(m => isTwoSided(m))
      .filter(m => isActionable(m));

    // Fetch Vegas odds for each sport we need (cached)
    const sportsNeeded = new Set();
    for (const m of candidates) {
      const sk = getSportKey(m.ticker ?? '');
      if (sk) sportsNeeded.add(sk);
    }

    const vegasOddsMap = {};
    if (oddsApiKey) {
      await Promise.all([...sportsNeeded].map(async sk => {
        vegasOddsMap[sk] = await fetchVegasOdds(sk, oddsApiKey);
      }));
    }

    // Build result with Vegas baseline attached
    const result = candidates.map(m => {
      const { yes_bid, no_bid } = extractPrices(m);
      const teamCode  = extractTeamCode(m.ticker ?? '');
      const sportKey  = getSportKey(m.ticker ?? '');
      const vegasGames = sportKey ? (vegasOddsMap[sportKey] ?? []) : [];

      // Get Vegas implied probability for this specific team
      let vegasProb = null;
      if (teamCode && vegasGames.length) {
        vegasProb = getVegasProb(vegasGames, teamCode, m.event_ticker);
      }

      return {
        ticker:        m.ticker        ?? null,
        title:         enrichTitle(m),
        yes_bid,
        no_bid,
        volume:        Math.round(parseFloat(m.volume_fp        ?? m.volume        ?? 0)),
        open_interest: Math.round(parseFloat(m.open_interest_fp ?? m.open_interest ?? 0)),
        close_time:    m.close_time    ?? null,
        status:        m.status        ?? null,
        series_ticker: m.series_ticker ?? null,
        event_ticker:  m.event_ticker  ?? null,
        category:      m.category      ?? null,
        vegas_prob:    vegasProb,        // null if no match found
        has_vegas:     vegasProb !== null,
      };
    });

    res.json({
      count:         result.length,
      total_fetched: allMarkets.length,
      has_vegas_odds: oddsApiKey ? true : false,
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

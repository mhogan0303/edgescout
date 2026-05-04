/**
 * EdgeScout — Edge Detection Model
 * Loaded by the frontend dashboard. All logic runs client-side.
 * Exposed on the global `EdgeModel` object.
 */

const EdgeModel = (() => {

  // ─── Sport Baselines ──────────────────────────────────────────────
  const SPORT_BASELINES = {
    NBA:    0.51,
    NFL:    0.51,
    MLB:    0.51,
    NHL:    0.51,
    NCAAB:  0.50,
    NCAAF:  0.50,
    PGA:    0.48,
    GOLF:   0.48,
    UFC:    0.50,
    MMA:    0.50,
    TENNIS: 0.50,
    SOCCER: 0.50,
    WNBA:   0.51,
    EPL:    0.50,
    FIFA:   0.50,
    NCAA:   0.50,
    Other:  0.50,
  };

  // ─── Sport Keywords for Detection ─────────────────────────────────
  const SPORT_KEYWORDS = [
    'NBA', 'NFL', 'MLB', 'NHL', 'NCAAB', 'NCAAF',
    'PGA', 'GOLF', 'UFC', 'MMA', 'TENNIS', 'SOCCER',
    'WNBA', 'EPL', 'FIFA', 'NCAA',
  ];

  // ─── 1. removeVig ─────────────────────────────────────────────────
  /**
   * Strips the bookmaker vig from raw bid prices.
   * @param {number} yesPrice - YES bid in cents (1–99)
   * @param {number} noPrice  - NO bid in cents (1–99)
   * @returns {{ adjYes: number, adjNo: number, vigPct: number }}
   */
  function removeVig(yesPrice, noPrice) {
    const yesProb = yesPrice / 100;
    const noProb  = noPrice  / 100;
    const total   = yesProb + noProb;

    const adjYes = yesProb / total;
    const adjNo  = noProb  / total;
    const vigPct = (total - 1) * 100;

    return { adjYes, adjNo, vigPct };
  }

  // ─── 2. consensusFairValue ────────────────────────────────────────
  /**
   * Blends the market's vig-free price with a sport baseline
   * weighted by how much we trust the market (volume).
   */
  function consensusFairValue(adjYes, historicalHitRate, volumeWeight) {
    const raw  = (adjYes * volumeWeight) + (historicalHitRate * (1 - volumeWeight));
    return Math.min(0.97, Math.max(0.03, raw));
  }

  // ─── 3. scoreEdge ────────────────────────────────────────────────
  /**
   * Computes edge on each side vs the fair value.
   */
  function scoreEdge(fairProb, adjYes, adjNo) {
    const edgeYes  = fairProb - adjYes;
    const edgeNo   = (1 - fairProb) - adjNo;
    const bestEdge = Math.max(edgeYes, edgeNo);
    const bestSide = edgeYes >= edgeNo ? 'YES' : 'NO';
    const edgeScore = bestEdge * 100;

    return { edgeYes, edgeNo, bestEdge, bestSide, edgeScore };
  }

  // ─── 4. kellySize ────────────────────────────────────────────────
  /**
   * Fractional Kelly bet sizing.
   */
  function kellySize(edge, priceInCents, bankroll, kellyFraction) {
    const decimalOdds = (100 / priceInCents) - 1;
    const fairProb    = edge + (priceInCents / 100);

    const kelly = ((fairProb * decimalOdds) - (1 - fairProb)) / decimalOdds;
    const recommendedBet = Math.max(0, kelly * kellyFraction * bankroll);

    return {
      recommendedBet,
      halfKelly:    recommendedBet * 0.5,
      quarterKelly: recommendedBet * 0.25,
    };
  }

  // ─── 5. volumeScore ──────────────────────────────────────────────
  /**
   * Returns a 0–1 liquidity trust score.
   */
  function volumeScore(volume, openInterest) {
    return Math.min(1, (volume + openInterest) / 50000);
  }

  // ─── 6. detectSport ──────────────────────────────────────────────
  /**
   * Detects sport from ticker/title string.
   */
  function detectSport(ticker = '', title = '') {
    const haystack = `${ticker} ${title}`.toUpperCase();
    for (const kw of SPORT_KEYWORDS) {
      if (haystack.includes(kw)) return kw;
    }
    return 'Other';
  }

  // ─── 7. analyzeMarket ────────────────────────────────────────────
  /**
   * Full analysis pipeline for a single market.
   * @param {object} market      - market object from /api/markets
   * @param {number} bankroll    - total bankroll in dollars
   * @param {number} kellyFraction - 0–1, e.g. 0.25 for quarter Kelly
   * @returns {object}           - all computed fields + original market data
   */
  function analyzeMarket(market, bankroll = 500, kellyFraction = 0.25) {
    const {
      ticker = '',
      title  = '',
      yes_bid,
      no_bid,
      volume      = 0,
      open_interest = 0,
    } = market;

    // Guard: need valid prices to analyze
    const yb = Number(yes_bid);
    const nb = Number(no_bid);

    if (!yb || !nb || yb <= 0 || nb <= 0 || yb >= 100 || nb >= 100) {
      return {
        ...market,
        sport:         detectSport(ticker, title),
        valid:         false,
        flagged:       false,
        tier:          'NONE',
        edgeScore:     0,
        bestSide:      null,
        fairValue:     null,
        adjYes:        null,
        adjNo:         null,
        vigPct:        null,
        volScore:      0,
        recommendedBet: 0,
      };
    }

    const sport       = detectSport(ticker, title);
    const baseline    = SPORT_BASELINES[sport] ?? 0.50;
    const volScore    = volumeScore(volume, open_interest);

    const { adjYes, adjNo, vigPct }  = removeVig(yb, nb);
    const fairValue                   = consensusFairValue(adjYes, baseline, volScore);
    const { edgeYes, edgeNo, bestEdge, bestSide, edgeScore } = scoreEdge(fairValue, adjYes, adjNo);

    // Price of the best side for Kelly sizing
    const bestPrice = bestSide === 'YES' ? yb : nb;
    const { recommendedBet, halfKelly, quarterKelly } = kellySize(
      bestEdge, bestPrice, bankroll, kellyFraction
    );

    // Tier classification
    let tier = 'NONE';
    if (edgeScore >= 6)   tier = 'STRONG';
    else if (edgeScore >= 2.5) tier = 'MILD';

    const flagged = tier === 'STRONG' || tier === 'MILD';

    return {
      ...market,
      sport,
      valid:    true,
      flagged,
      tier,
      edgeScore,
      bestSide,
      fairValue,
      adjYes,
      adjNo,
      vigPct,
      edgeYes,
      edgeNo,
      volScore,
      recommendedBet,
      halfKelly,
      quarterKelly,
    };
  }

  // ─── Public API ───────────────────────────────────────────────────
  return {
    SPORT_BASELINES,
    detectSport,
    removeVig,
    consensusFairValue,
    scoreEdge,
    kellySize,
    volumeScore,
    analyzeMarket,
  };

})();

// Make available as ESM default if bundled, or as global in browser
if (typeof module !== 'undefined' && module.exports) {
  module.exports = EdgeModel;
}

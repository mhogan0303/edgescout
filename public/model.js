/**
 * EdgeScout — Edge Detection Model v2
 * Loaded by the frontend dashboard. All logic runs client-side.
 * Exposed on the global `EdgeModel` object.
 *
 * v2 improvements:
 *   1. Market-type aware baselines (game winner / spread / total / prop)
 *   2. Hard Kelly cap (never more than MAX_KELLY_PCT of bankroll per bet)
 *   3. Confidence weighting — zero-volume markets get a discounted edge score
 */

const EdgeModel = (() => {

  // ─── Constants ────────────────────────────────────────────────────

  // Maximum bet as a fraction of bankroll regardless of Kelly output
  // e.g. 0.05 = never recommend more than 5% of bankroll on one market
  const MAX_KELLY_PCT = 0.05;

  // Volume+OI threshold above which we give full confidence
  const CONFIDENCE_THRESHOLD = 500;

  // ─── Market Type Detection ────────────────────────────────────────
  // Parses the Kalshi ticker to identify what kind of market it is.
  // Returns one of: 'GAME_WINNER' | 'SPREAD' | 'TOTAL' | 'PROP' | 'UNKNOWN'
  //
  // Kalshi ticker patterns:
  //   KXNBAGAME-...     NBA game winner
  //   KXMLBGAME-...     MLB game winner
  //   KXNHLGAME-...     NHL game winner
  //   KXNFlgame-...     NFL game winner
  //   KXNBASPREAD-...   NBA point spread
  //   KXMLBSPREAD-...   MLB run line
  //   KXNBATOTAL-...    NBA over/under
  //   KXMLBTOTAL-...    MLB over/under
  //   KXNBAPTS-...      NBA points prop
  //   KXNBAREB-...      NBA rebounds prop
  //   KXNBAAST-...      NBA assists prop
  //   KXNBABLK-...      NBA blocks prop
  //   KXNBASTL-...      NBA steals prop
  //   KXMLBHR-...       MLB home run prop
  //   KXMLBK-...        MLB strikeout prop

  const MARKET_TYPE_PATTERNS = {
    GAME_WINNER: ['GAME'],
    SPREAD:      ['SPREAD'],
    TOTAL:       ['TOTAL'],
    PROP:        ['PTS', 'REB', 'AST', 'BLK', 'STL', 'HR', 'MLBK', 'PASS', 'RUSH', 'REC'],
  };

  function detectMarketType(ticker = '') {
    const t = ticker.toUpperCase();
    for (const [type, patterns] of Object.entries(MARKET_TYPE_PATTERNS)) {
      if (patterns.some(p => t.includes(p))) return type;
    }
    return 'UNKNOWN';
  }

  // ─── Sport Detection ──────────────────────────────────────────────
  const SPORT_KEYWORDS = [
    'NBA', 'NFL', 'MLB', 'NHL', 'NCAAB', 'NCAAF',
    'PGA', 'GOLF', 'UFC', 'MMA', 'TENNIS', 'SOCCER',
    'WNBA', 'EPL', 'FIFA', 'NCAA',
  ];

  function detectSport(ticker = '', title = '') {
    const haystack = `${ticker} ${title}`.toUpperCase();
    for (const kw of SPORT_KEYWORDS) {
      if (haystack.includes(kw)) return kw;
    }
    return 'Other';
  }

  // ─── Baselines ────────────────────────────────────────────────────
  // Fair value baseline = what % of the time does YES resolve,
  // before looking at the market price at all.
  //
  // GAME_WINNER: favorites win more than 50% — but since Kalshi markets
  //   are on specific teams (not always the favorite), we use 52% as a
  //   slight lean reflecting that most listed teams are competitive.
  //
  // SPREAD: by design, a well-set spread should hit 50% on each side.
  //
  // TOTAL: same as spread — sharp totals are set to ~50%.
  //
  // PROP: player props are typically set slightly under 50% on the over
  //   (books shade them). 49% reflects that slight under-pricing of YES.
  //
  // These are conservative starting estimates. They will be refined
  // as real hit rate data accumulates.

  const BASELINES = {
    // By market type (primary lookup)
    GAME_WINNER: {
      NBA: 0.54,   // NBA favorites cover ~54% historically
      NFL: 0.53,
      MLB: 0.53,
      NHL: 0.53,
      NCAAB: 0.54,
      NCAAF: 0.54,
      Other: 0.52,
    },
    SPREAD: {
      NBA: 0.50,
      NFL: 0.50,
      MLB: 0.50,
      NHL: 0.50,
      NCAAB: 0.50,
      NCAAF: 0.50,
      Other: 0.50,
    },
    TOTAL: {
      NBA: 0.50,
      NFL: 0.50,
      MLB: 0.50,
      NHL: 0.50,
      NCAAB: 0.50,
      NCAAF: 0.50,
      Other: 0.50,
    },
    PROP: {
      NBA: 0.49,
      NFL: 0.49,
      MLB: 0.49,
      NHL: 0.49,
      Other: 0.49,
    },
    UNKNOWN: {
      Other: 0.50,
    },
  };

  function getBaseline(marketType, sport) {
    const typeBaselines = BASELINES[marketType] ?? BASELINES.UNKNOWN;
    return typeBaselines[sport] ?? typeBaselines['Other'] ?? 0.50;
  }

  // ─── 1. removeVig ─────────────────────────────────────────────────
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
  // Blends the vig-free market price with the historical baseline,
  // weighted by how much we trust the market (volume score).
  // High volume = trust the market price more than the baseline.
  // Zero volume = lean heavily on the baseline.
  function consensusFairValue(adjYes, baseline, volumeWeight) {
    const raw = (adjYes * volumeWeight) + (baseline * (1 - volumeWeight));
    return Math.min(0.97, Math.max(0.03, raw));
  }

  // ─── 3. scoreEdge ────────────────────────────────────────────────
  function scoreEdge(fairProb, adjYes, adjNo) {
    const edgeYes   = fairProb - adjYes;
    const edgeNo    = (1 - fairProb) - adjNo;
    const bestEdge  = Math.max(edgeYes, edgeNo);
    const bestSide  = edgeYes >= edgeNo ? 'YES' : 'NO';
    const edgeScore = bestEdge * 100;

    return { edgeYes, edgeNo, bestEdge, bestSide, edgeScore };
  }

  // ─── 4. kellySize ────────────────────────────────────────────────
  // Standard fractional Kelly with a hard cap.
  // The cap ensures we never recommend more than MAX_KELLY_PCT of
  // bankroll on a single market, protecting against model error.
  function kellySize(edge, priceInCents, bankroll, kellyFraction) {
    const decimalOdds    = (100 / priceInCents) - 1;
    const fairProb       = edge + (priceInCents / 100);
    const kelly          = ((fairProb * decimalOdds) - (1 - fairProb)) / decimalOdds;
    const fractional     = Math.max(0, kelly * kellyFraction * bankroll);

    // Hard cap: never more than MAX_KELLY_PCT of bankroll
    const cap            = bankroll * MAX_KELLY_PCT;
    const recommendedBet = Math.min(fractional, cap);
    const wasCapped      = fractional > cap;

    return {
      recommendedBet,
      halfKelly:    recommendedBet * 0.5,
      quarterKelly: recommendedBet * 0.25,
      wasCapped,
      capAmount:    cap,
    };
  }

  // ─── 5. volumeScore ──────────────────────────────────────────────
  // Returns a 0–1 liquidity trust score.
  // Reaches 1.0 at CONFIDENCE_THRESHOLD contracts.
  function volumeScore(volume, openInterest) {
    return Math.min(1, (volume + openInterest) / CONFIDENCE_THRESHOLD);
  }

  // ─── 6. confidenceWeight ─────────────────────────────────────────
  // Discounts the edge score for low-volume markets.
  // Zero volume = 40% of face value (still shows up, but clearly marked)
  // Full volume = 100% of face value
  // This prevents ghost markets with no trading activity from
  // appearing as high-confidence edges.
  //
  // Formula: weight = 0.40 + (0.60 * volumeScore)
  //   volumeScore 0.0 → weight 0.40  (40% confidence)
  //   volumeScore 0.5 → weight 0.70  (70% confidence)
  //   volumeScore 1.0 → weight 1.00  (full confidence)

  function confidenceWeight(volume, openInterest) {
    const vs = volumeScore(volume, openInterest);
    return 0.40 + (0.60 * vs);
  }

  // ─── 7. analyzeMarket ────────────────────────────────────────────
  function analyzeMarket(market, bankroll = 500, kellyFraction = 0.25) {
    const {
      ticker        = '',
      title         = '',
      yes_bid,
      no_bid,
      volume        = 0,
      open_interest = 0,
      vegas_prob    = null,
      has_vegas     = false,
    } = market;

    const yb = Number(yes_bid);
    const nb = Number(no_bid);

    const sport      = detectSport(ticker, title);
    const marketType = detectMarketType(ticker);

    // Guard: need valid prices on both sides
    if (!yb || !nb || yb <= 0 || nb <= 0 || yb >= 100 || nb >= 100) {
      return {
        ...market,
        sport,
        marketType,
        valid:          false,
        flagged:        false,
        tier:           'NONE',
        edgeScore:      0,
        rawEdgeScore:   0,
        confidence:     0,
        bestSide:       null,
        fairValue:      null,
        adjYes:         null,
        adjNo:          null,
        vigPct:         null,
        volScore:       0,
        recommendedBet: 0,
        wasCapped:      false,
      };
    }

    const volScore   = volumeScore(volume, open_interest);
    const confidence = confidenceWeight(volume, open_interest);
    const { adjYes, adjNo, vigPct } = removeVig(yb, nb);

    let fairValue, edgeYes, edgeNo, bestEdge, bestSide, rawEdgeScore, baseline;

    if (has_vegas && vegas_prob !== null) {
      // ── Vegas mode ──────────────────────────────────────────────────
      // When we have a real Vegas implied probability, use it directly
      // as the fair value. No blending needed — Vegas IS the benchmark.
      //
      // Edge = Vegas fair prob minus Kalshi vig-free prob, per side:
      //   edgeYes = vegas_prob - adjYes  (positive = YES is underpriced on Kalshi)
      //   edgeNo  = (1 - vegas_prob) - adjNo  (positive = NO is underpriced)
      //
      // Example: Vegas PHI = 70%, Kalshi PHI = 61¢
      //   adjYes ≈ 0.619 (after vig removal)
      //   edgeYes = 0.70 - 0.619 = +0.081 → BET YES on PHI
      baseline     = vegas_prob;
      fairValue    = vegas_prob;
      edgeYes      = vegas_prob - adjYes;
      edgeNo       = (1 - vegas_prob) - adjNo;
      bestEdge     = Math.max(edgeYes, edgeNo);
      bestSide     = edgeYes >= edgeNo ? 'YES' : 'NO';
      rawEdgeScore = bestEdge * 100;
    } else {
      // ── Baseline mode ───────────────────────────────────────────────
      // No Vegas data — use sport/type historical baseline blended
      // with the market price weighted by volume trust.
      baseline     = getBaseline(marketType, sport);
      fairValue    = consensusFairValue(adjYes, baseline, volScore);
      const scored = scoreEdge(fairValue, adjYes, adjNo);
      edgeYes      = scored.edgeYes;
      edgeNo       = scored.edgeNo;
      bestEdge     = scored.bestEdge;
      bestSide     = scored.bestSide;
      rawEdgeScore = scored.edgeScore;
    }

    // Apply confidence discount — Vegas markets get less discount
    // because the benchmark is already sharp. Baseline markets keep
    // the full discount since the model is less reliable.
    const confidenceMult = has_vegas
      ? Math.min(1, 0.70 + (0.30 * volScore))   // floor at 70% for Vegas
      : confidence;                               // standard for baseline

    const edgeScore = rawEdgeScore * confidenceMult;

    const bestPrice = bestSide === 'YES' ? yb : nb;
    const { recommendedBet, halfKelly, quarterKelly, wasCapped, capAmount } = kellySize(
      bestEdge, bestPrice, bankroll, kellyFraction
    );

    // Tier based on confidence-adjusted edge score
    let tier = 'NONE';
    if (edgeScore >= 6)        tier = 'STRONG';
    else if (edgeScore >= 2.5) tier = 'MILD';

    const flagged = tier === 'STRONG' || tier === 'MILD';

    return {
      ...market,
      sport,
      marketType,
      valid: true,
      flagged,
      tier,
      edgeScore,       // confidence-adjusted (what the UI shows)
      rawEdgeScore,    // pre-discount (shown as secondary info)
      confidence,      // 0–1 confidence multiplier
      baseline,        // what baseline was used
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
      wasCapped,
      capAmount,
    };
  }

  // ─── Public API ───────────────────────────────────────────────────
  return {
    BASELINES,
    MAX_KELLY_PCT,
    detectSport,
    detectMarketType,
    getBaseline,
    removeVig,
    consensusFairValue,
    scoreEdge,
    kellySize,
    volumeScore,
    confidenceWeight,
    analyzeMarket,
  };

})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = EdgeModel;
}

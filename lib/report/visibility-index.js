/**
 * Unified Visibility Index (UVI) — a single 0-100 score that combines four
 * signals from a run into one number, with transparent weights you can audit.
 *
 * Inspired by Rankability's "SPI" but open — no proprietary scoring,
 * everything is documented and verifiable from `_summary.json`.
 *
 *   UVI = w1·presence + w2·sentiment + w3·rank + w4·citation
 *
 * Default weights:
 *   - presence  35%   (% of cells where brand was mentioned)
 *   - sentiment 25%   (avg sentiment, 50 = neutral)
 *   - rank      20%   (avg position strength when listed)
 *   - citation  20%   (% of cells where brand appeared in a citation URL)
 *
 * Components without any underlying measurement return `null` (e.g. no cell
 * has a numeric `position` → rank is `null`, not 50) and are EXCLUDED from
 * the composite — remaining weights are re-normalised over the present
 * components only. This stops the report from inflating UVI with phantom
 * fallback values when a signal was never measured this run.
 *
 * Designed so each component is independently meaningful and the user can
 * spot which signal dragged the index down.
 */

import { isOwnDomain } from './own-domain.js';

const DEFAULT_WEIGHTS = {
  presence: 0.35,
  sentiment: 0.25,
  rank: 0.20,
  citation: 0.20,
};

const SENTIMENT_VALUE = { positive: 100, neutral: 50, negative: 0 };

// AP-PROSE-RANK — prose ordinals are softer than explicit list positions, so a
// prose-rank cell's position-strength is multiplied by this factor before it
// enters the rank average. 0.7 = "a prose #1 counts like a list #1 docked one
// notch"; an explicit list rank always outweighs the same prose rank.
const PROSE_RANK_DISCOUNT = 0.7;

// Confidence labels a prose-rank verdict may carry (from mergeProseRanks). Only
// these count toward the rank axis — 'low' is INCLUDED (it still carries a real
// ordinal) but 'none'/'failed'/'empty' are not (no usable order). Kept as a set
// so the gate is one obvious list, not scattered string compares.
const PROSE_RANK_OK_CONFIDENCE = new Set(['med', 'low', 'single-model']);

/**
 * Is a cell's `proseRank` field a usable ordinal for the rank axis? Requires a
 * positive integer rank AND a confidence above the floor. A cell with
 * `proseRank: { rank: null }` (model saw no prose ordering) contributes nothing.
 * @param {{rank?:number, confidence?:string}|undefined} pr
 */
export function usableProseRank(pr) {
  return !!(pr
    && typeof pr.rank === 'number' && pr.rank > 0
    && PROSE_RANK_OK_CONFIDENCE.has(pr.confidence));
}

/**
 * Per-cell presence contribution (0..1).
 *
 * AP-MEASURE-SAMPLING-CI invariance seam. A SAMPLED cell (`--samples N>1`)
 * carries `presence.rate` ∈ [0,1] — its fractional share of trials that were a
 * hit — and contributes that fraction. A single-shot cell has no `presence`
 * field and contributes a hard boolean: 1 when mentioned ('yes'|'src'), else 0.
 *
 * This is the ONE place the boolean→fraction switch lives, so the default
 * (samples=1) run is byte-for-byte identical to the pre-feature presence math,
 * and the fractional path is strictly opt-in (R39). Error cells are excluded by
 * the caller (results already filtered), so they never reach here.
 *
 * @param {{mention?:string, presence?:{rate?:number}}} r a non-error result cell
 * @returns {number} 0..1
 */
export function perCellPresence(r) {
  if (r && r.presence && typeof r.presence.rate === 'number') {
    return r.presence.rate;
  }
  return (r && (r.mention === 'yes' || r.mention === 'src')) ? 1 : 0;
}

/**
 * Decide whether a cell's sentiment record carries a real signal. Cells
 * flagged as `confidence: 'low'` AND `label: 'neutral'` are model-disagreement
 * tie-breaks (see `mergeSentiments` in sentiment-classify.js) — they record
 * "we don't know", not "neutral tone". Averaging them as 50 drags the
 * sentiment component toward the middle for runs where the only high-signal
 * cells are unambiguously positive (or negative). Same treatment applies to
 * `confidence: 'failed'` / `'empty'` rows.
 */
function isSignalBearingSentiment(s) {
  if (!s || !s.label) return false;
  if (s.confidence === 'failed' || s.confidence === 'empty') return false;
  if (s.confidence === 'low' && s.label === 'neutral') return false;
  return true;
}

/**
 * Compute the four sub-components from a `_summary.json`-shaped object.
 * Pure function — easy to unit-test, easy to surface in the report.
 *
 * Each numeric component is either a 0–100 number or `null` when the signal
 * is genuinely absent (no cells contributed). `sentimentSample` and
 * `rankSample` expose the effective sample size for each so the UVI section
 * can show «n=2 high-confidence cells» instead of an opaque score.
 */
export function computeComponents(latest) {
  const results = (latest?.results || []).filter(r => r.mention !== 'error');
  const total = results.length;

  if (total === 0) {
    // No cells at all — nothing to measure. Presence/citation are 0 by
    // construction (share-of-cells with 0 cells = 0); sentiment/rank are
    // null because there is no underlying data, NOT zero.
    return {
      presence: 0, sentiment: null, rank: null, citation: 0,
      sample: 0, sentimentSample: 0, rankSample: 0, proseRankSample: 0,
    };
  }

  // Presence — share of non-error cells where brand was mentioned.
  //
  // AP-MEASURE-SAMPLING-CI: when a cell was SAMPLED (`--samples N>1` → it
  // carries a `presence` object with a fractional rate), the cell contributes
  // its FRACTION (e.g. 0.667 for 2-of-3 trials) instead of a hard 1/0. A
  // single-shot cell has no `presence` field → it contributes the boolean
  // 1/0 exactly as before, so a default (samples=1) run's presence/UVI is
  // arithmetically identical to the pre-feature value (R39 invariance point).
  const presenceSum = results.reduce((s, r) => s + perCellPresence(r), 0);
  const presence = (presenceSum / total) * 100;

  // Sentiment — average across cells with SIGNAL-BEARING sentiment only.
  // Low-confidence neutrals (model disagreement tie-breaks) are excluded;
  // they record "no signal", not "neutral signal". When no cells survive
  // the filter the component is `null` and excluded from the composite.
  const withSentiment = results.filter(r => isSignalBearingSentiment(r.sentiment));
  const sentiment = withSentiment.length > 0
    ? withSentiment.reduce((s, r) => s + (SENTIMENT_VALUE[r.sentiment.label] ?? 50), 0) / withSentiment.length
    : null;

  // Rank — average position strength (lower position = higher score). Only
  // counts cells where brand appeared in body (mention === 'yes' with a
  // numeric position). `null` when no cell has position data — a hardcoded
  // 50 fallback fabricated 10pt of UVI for runs where rank was never measured.
  //
  // AP-PROSE-RANK: list-rank (`r.position`, from findPosition) is the primary,
  // high-confidence rank and is computed exactly as before. A SECOND, softer
  // source — `r.proseRank`, an LLM-extracted ordinal for PROSE answers where
  // findPosition returned null — fills the axis where it was previously empty.
  // Prose-rank cells are folded in at a CONFIDENCE DISCOUNT (PROSE_RANK_DISCOUNT)
  // so a soft ordinal never counts as much as an explicit list position, and a
  // cell that already has a list-rank is NEVER also counted as prose (no double
  // count). Records with no `proseRank` field (the default — every run without
  // the prose-rank pass, and every legacy snapshot) contribute nothing here, so
  // the rank value is byte-identical to the pre-feature math (R39).
  const ranked = results.filter(r => r.mention === 'yes' && typeof r.position === 'number' && r.position > 0);
  const rankStrength = (pos) => Math.max(0, 100 - (pos - 1) * 15);
  const listRankSum = ranked.reduce((s, r) => s + rankStrength(r.position), 0);

  // Prose-rank cells: body mention, NO usable list position, but a usable
  // prose ordinal with confidence above the floor. `usableProseRank` is the
  // single gate so the report's rankSample and this math can't drift.
  const proseRanked = results.filter(r =>
    r.mention === 'yes'
    && !(typeof r.position === 'number' && r.position > 0)
    && usableProseRank(r.proseRank),
  );
  const proseRankSum = proseRanked.reduce(
    (s, r) => s + rankStrength(r.proseRank.rank) * PROSE_RANK_DISCOUNT, 0);

  const rankCount = ranked.length + proseRanked.length;
  const rank = rankCount > 0 ? (listRankSum + proseRankSum) / rankCount : null;

  // Citation share — share of cells where the brand domain appeared in a
  // canonical citation URL. Independent of body-mention so it surfaces
  // "AI cited my page but didn't name me" patterns.
  //
  // Matched by registrable-domain (eTLD+1) host equality, NOT raw substring:
  // a substring test (`url.includes('gcore.com')`) falsely matched look-alike
  // hosts like `gcore.com.evil.com` / `notgcore.com.evil.com`, inflating the
  // citation axis with citations that were never ours. `isOwnDomain` accepts
  // the exact host and any subdomain (`blog.gcore.com`) and rejects spoofs.
  const citationCells = results.filter(r => {
    const cites = r.canonicalCitations || [];
    if (cites.length === 0) return false;
    return cites.some(u => isOwnDomain(u, latest.domain));
  }).length;
  const citation = (citationCells / total) * 100;

  return {
    presence: Math.round(presence),
    sentiment: sentiment === null ? null : Math.round(sentiment),
    rank: rank === null ? null : Math.round(rank),
    citation: Math.round(citation),
    sample: total,
    sentimentSample: withSentiment.length,
    // rankSample = list-rank cells + prose-rank cells (the axis denominator).
    // proseRankSample is broken out so the report can say «n=4 ranked (1 from
    // prose, lower confidence)» instead of hiding the soft contribution.
    rankSample: ranked.length + proseRanked.length,
    proseRankSample: proseRanked.length,
  };
}

/**
 * Compute the composite UVI score from components and weights.
 *
 * Components with value `null` are excluded; remaining weights are
 * re-normalised so the composite stays on a 0–100 scale instead of being
 * pulled down by a missing dimension. Example: when rank is null, the
 * remaining 80% of weight (presence 35 + sentiment 25 + citation 20) is
 * re-normalised so each part counts as `orig / 0.80`.
 */
export function computeUVI(components, weights = DEFAULT_WEIGHTS) {
  const w = { ...DEFAULT_WEIGHTS, ...(weights || {}) };
  const keys = ['presence', 'sentiment', 'rank', 'citation'];

  let weightSum = 0;
  let weighted = 0;
  for (const k of keys) {
    const v = components?.[k];
    if (v === null || v === undefined) continue; // exclude unmeasured signals
    weightSum += w[k];
    weighted += v * w[k];
  }
  if (weightSum === 0) return 0;
  return Math.round(weighted / weightSum);
}

/**
 * Human-readable per-axis meaning lines. Kept here (alongside the math) so the
 * UVI section, popover and any future surface share one source of truth — if
 * the formula changes, the meaning blurb sits right next to the change.
 */
const COMPONENT_META = {
  presence:  { label: 'Presence',  meaning: 'share of cells where brand was mentioned' },
  sentiment: { label: 'Sentiment', meaning: 'avg tone (50 = neutral)' },
  rank:      { label: 'Rank',      meaning: 'avg position strength when listed' },
  citation:  { label: 'Citation',  meaning: 'share of cells with brand domain in citations' },
};

/**
 * Compute the calculation-trace that backs the UVI score block — the same
 * arithmetic `computeUVI` performs, but exposed as a structured per-axis
 * breakdown the report can render inside an inspectable popover.
 *
 * Each row contains:
 *   - key, label, meaning      — identity + plain-English axis description
 *   - value                    — the component score (0–100), or `null` when
 *                                the signal was absent this run
 *   - sample {n, denominator}  — effective sample size for that axis. `n` is
 *                                the count that contributed; `denominator`
 *                                is the right total for the axis (e.g. total
 *                                cells for presence/citation, only high-conf
 *                                cells for sentiment).
 *   - weight                   — default (unnormalised) weight, e.g. 0.35
 *   - appliedWeight            — re-normalised weight actually used in the
 *                                composite (e.g. 0.35/0.80 = 0.4375 when
 *                                rank is null). `null` when the component
 *                                is excluded.
 *   - contribution             — `value * appliedWeight` (the row's actual
 *                                share of the 0–100 composite), or `null`
 *                                when excluded.
 *
 * Plus run-level totals:
 *   - weightSum                — sum of default weights for measured axes
 *                                (e.g. 0.80 when rank is null)
 *   - rawSum                   — sum of `value * defaultWeight` over
 *                                measured axes (numerator before re-norm).
 *                                Lets the popover show
 *                                «48.1 / 0.80 = 60».
 *   - uvi                      — the final rounded composite, identical to
 *                                what `computeUVI()` returns.
 *   - excluded                 — array of component keys with `null` values
 *                                (so the popover can spell out which axis
 *                                was redistributed and why).
 *
 * Pure derivation from `components` — no I/O, no second pass through results.
 */
export function computeUVIBreakdown(components, weights = DEFAULT_WEIGHTS) {
  const w = { ...DEFAULT_WEIGHTS, ...(weights || {}) };
  const keys = ['presence', 'sentiment', 'rank', 'citation'];

  // First pass — figure out which axes are measured this run, so we can
  // compute the re-normalisation denominator BEFORE we render rows. The
  // contribution column shows the re-normalised weight × value, otherwise
  // the row arithmetic would not sum to the headline UVI.
  let weightSum = 0;
  let rawSum = 0;
  const measured = new Set();
  for (const k of keys) {
    const v = components?.[k];
    if (v === null || v === undefined) continue;
    weightSum += w[k];
    rawSum += v * w[k];
    measured.add(k);
  }

  const sample = components?.sample ?? 0;
  const sentimentSample = components?.sentimentSample ?? 0;
  const rankSample = components?.rankSample ?? 0;

  // Sample denominators are AXIS-SPECIFIC and must stay distinct in the
  // popover. Presence and Citation are denominated over total non-error
  // cells; Sentiment is denominated only over signal-bearing cells (high-
  // confidence + non-tie-break). Rank is denominated over cells that
  // actually returned a numeric position. Conflating these is the exact
  // confusion the popover is meant to dispel.
  const sampleFor = (k) => {
    switch (k) {
      case 'presence': return { n: sample, denominator: sample, basis: 'cells' };
      case 'citation': return { n: sample, denominator: sample, basis: 'cells' };
      case 'sentiment': return { n: sentimentSample, denominator: sample, basis: 'high-confidence cells' };
      case 'rank': return { n: rankSample, denominator: sample, basis: 'ranked cells' };
      default: return { n: 0, denominator: 0, basis: 'cells' };
    }
  };

  const rows = keys.map(k => {
    const v = components?.[k];
    const present = measured.has(k);
    const appliedWeight = present && weightSum > 0 ? w[k] / weightSum : null;
    const contribution = present ? v * appliedWeight : null;
    return {
      key: k,
      label: COMPONENT_META[k].label,
      meaning: COMPONENT_META[k].meaning,
      value: present ? v : null,
      sample: sampleFor(k),
      weight: w[k],
      appliedWeight,
      contribution,
    };
  });

  const uvi = weightSum === 0 ? 0 : Math.round(rawSum / weightSum);
  const excluded = keys.filter(k => !measured.has(k));

  return {
    rows,
    weightSum,
    rawSum,
    uvi,
    excluded,
  };
}

/**
 * Crawl-readiness score — composite of the TECHNICAL preconditions for being
 * cited: crawl directives, AI-bot access, a usable sitemap, and content that is
 * actually in the server's HTML. Range 0-100. Pure derivation from the audit
 * object plus (optionally) the cached page-signals crawl — no extra fetches.
 *
 * Weighting (must sum to 1.00):
 *   - 30% — robots.txt present
 *   - 25% — share of AI bots NOT blocked (allowed + partial + unspecified)
 *   - 25% — sitemap.xml reachable (or declared in robots.txt)
 *   - 20% — homepage content served in the HTML (no JS-shell)
 *
 * AP-DEAD-TACTIC-LLMSTXT (2026-08-02) — WHY THE FOURTH SLOT CHANGED HANDS.
 * That 20% used to be «/llms.txt present», and the report told clients to add
 * the file. It is a dead tactic and we were docking a fifth of the score for
 * not following it. Evidence, first-party first: Google — «For Google Search,
 * llms.txt isn't needed for AI Overviews, AI Mode, or other generative AI
 * Search features», with the 2026-06-15 changelog clarifying the file «aren't
 * required for Google Search visibility or rankings»; a 2026 study across
 * ~300,000 domains, reported by lumentir.com, found no relationship between
 * having the file and how often a domain is cited (the page reports the finding
 * without naming who ran the study — cite it as reported, not as settled);
 * no major provider has confirmed support.
 * (An Otterly experiment — 84 of 62,100 AI-crawler visits over 90 days — points
 * the same way, but it is a SINGLE site, so it is context, not evidence.)
 * The file is still MEASURED (`crawlability.summary.hasLlmsTxt`) and still
 * reported as a plain fact — it just no longer moves the score and is never
 * recommended.
 *
 * WHY THESE WEIGHTS, AND WHY THE OTHER THREE DID NOT MOVE. The brief was «put
 * the 20% on things that really are necessary conditions for being cited: bot
 * access, sitemap presence/validity, server-rendered content». Of those three,
 * only the last one can carry weight without making somebody's score go DOWN,
 * and here is the arithmetic, because it is not obvious:
 *
 *   Redistributing the 20% across only robots/bots/sitemap CANNOT be
 *   non-regressive. `robots` absent implies no rules at all, hence every bot is
 *   `unspecified`, hence bots = 100 — so the reachable worst cases are
 *   (robots 1, bots 0, sitemap 0, llms 1), which needs w_robots ≥ 0.50, and
 *   (robots 0, bots 1, sitemap 1, llms 1), which needs w_bots + w_sitemap ≥
 *   0.70. Together they need more than 1.00 of weight. No three-way split of a
 *   100-point scale can do it.
 *
 * So the new axis takes over the vacated slot AT THE SAME WEIGHT and the three
 * survivors keep their exact old weights. The score difference is then
 * `20 × (serverRendered − llmsTxt)` plus the sitemap credit below, which gives
 * a guarantee that can be stated in one line and is pinned by tests:
 *
 *   - Content is server-rendered → NOBODY scores lower than under the old
 *     formula. A client who had llms.txt lands on the identical number, unless
 *     the sitemap credit below applies to them, in which case they land higher;
 *     everyone else gains up to 20 points.
 *   - Content is a JS shell AND the client publishes llms.txt → up to 20 points
 *     lower. That is a true finding (engines fetch HTML; Anthropic's web_fetch
 *     «does not support sites with dynamic JS rendering»), not a formula
 *     artefact.
 *   - Page signals absent (legacy snapshot, `--no-page-signals`, blocked fetch)
 *     → the axis is `null` and the remaining 80% is re-normalised, exactly as
 *     `computeUVI` handles an unmeasured component. A client who had llms.txt
 *     can then land up to 13.75 points lower.
 *
 * The sitemap axis got the «validity» half of the brief in the only direction
 * that cannot cost anyone points: it now also credits a sitemap that is
 * DECLARED in robots.txt but not served at /sitemap.xml (previously scored a
 * flat zero — a false negative for every site using /sitemap_index.xml), and it
 * flags a sitemap with no <loc> entries in the note without docking for it.
 *
 * @param {Object} crawlability  `_summary.json::crawlability`
 * @param {Object} [pageSignals] `_summary.json::pageSignals` — optional; when
 *   omitted the server-rendered axis is `null` and weights re-normalise, so
 *   every existing single-argument caller keeps working.
 */
export function computeDiscoverability(crawlability, pageSignals) {
  if (!crawlability || !crawlability.summary) return null;
  const s = crawlability.summary;
  const total = s.totalBots || 1;
  const notBlocked = total - (s.blockedCount || 0);
  const botShare = notBlocked / total;

  const robotsScore   = s.hasRobots  ? 100 : 0;
  const botsScore     = botShare * 100;

  // Sitemap — presence, plus the two validity refinements described above.
  // Both are strictly ADDITIVE: no input that scored 100 before scores less now.
  const sitemapObj = crawlability.sitemap || {};
  const declaredOnly = !s.hasSitemap && Array.isArray(sitemapObj.declaredInRobots) && sitemapObj.declaredInRobots.length > 0;
  const emptySitemap = !!s.hasSitemap && sitemapObj.urlCount === 0;
  const sitemapScore = s.hasSitemap ? 100 : (declaredOnly ? 70 : 0);
  const sitemapNote = s.hasSitemap
    ? (emptySitemap ? 'reachable, but lists no <loc> entries — check it covers your pages' : 'present')
    : (declaredOnly ? 'not at /sitemap.xml, but declared in robots.txt' : 'missing');

  const ssr = serverRenderedAxis(pageSignals);

  const parts = [
    ['robots',         robotsScore,  0.30],
    ['bots',           botsScore,    0.25],
    ['sitemap',        sitemapScore, 0.25],
    ['serverRendered', ssr.value,    0.20],
  ];

  // Re-normalise over MEASURED axes only — same contract as computeUVI: an
  // unmeasured signal is excluded, never substituted with a fabricated value.
  let weightSum = 0;
  let weighted = 0;
  for (const [, value, weight] of parts) {
    if (value === null) continue;
    weightSum += weight;
    weighted += value * weight;
  }
  const score = weightSum === 0 ? 0 : weighted / weightSum;
  const applied = (value, weight) => (value === null || weightSum === 0 ? null : weight / weightSum);

  return {
    score: Math.round(score),
    // `weightSum` < 1 means an axis was unmeasured and the rest were
    // re-normalised; renderers show `appliedWeight` so the column still sums
    // to 100%.
    weightSum,
    breakdown: {
      robots:   { value: Math.round(robotsScore),  weight: 0.30, appliedWeight: applied(robotsScore, 0.30), note: s.hasRobots ? 'present' : 'missing' },
      // notBlocked = allowed + partial + unspecified (matches the score formula).
      // Earlier versions reported `allowedCount/total`, which understated the
      // signal whenever sites had no robots.txt at all (all bots → unspecified).
      bots:     { value: Math.round(botsScore),    weight: 0.25, appliedWeight: applied(botsScore, 0.25), note: `${notBlocked}/${total} bots not blocked` },
      sitemap:  { value: Math.round(sitemapScore), weight: 0.25, appliedWeight: applied(sitemapScore, 0.25), note: sitemapNote },
      serverRendered: {
        value: ssr.value === null ? null : Math.round(ssr.value),
        weight: 0.20,
        appliedWeight: applied(ssr.value, 0.20),
        note: ssr.note,
      },
    },
  };
}

/**
 * Server-rendered-content axis: did the homepage arrive with its content in the
 * HTML, or is it a JS shell an AI crawler cannot read? This is a genuine
 * necessary condition — Anthropic states `web_fetch` «does not support sites
 * with dynamic JS rendering», and the same holds by observation for GPTBot /
 * PerplexityBot / ClaudeBot.
 *
 * Deliberately FAIL-RARELY: a false «shell» verdict costs 20 points, so we only
 * call it a shell on evidence that leaves no room for the alternative — a body
 * under 500 bytes, or a body with no headings AND no JSON-LD AND no answer
 * paragraphs. Anything else passes. A page-signals crawl that never ran or
 * FAILED (Cloudflare 403, timeout) returns `null` = unmeasured, never 0: a wall
 * is not evidence of a JS shell.
 *
 * @param {Object} [pageSignals] `_summary.json::pageSignals` — `{ homepage: {...} }`
 *   as written by `checkPageSignals`; a flat `crawlPageSignals` result is also
 *   accepted.
 * @returns {{value: number|null, note: string}}
 */
export function serverRenderedAxis(pageSignals) {
  const hp = pageSignals?.homepage ?? pageSignals;
  if (!hp || typeof hp !== 'object') {
    return { value: null, note: 'not measured this run — weight redistributed' };
  }
  if (hp.ok !== true) {
    return { value: null, note: `page fetch unavailable (${hp.error || hp.status || 'no response'}) — weight redistributed` };
  }

  const bytes = typeof hp.bytes === 'number' ? hp.bytes : null;
  const headings = (hp.headings?.h1?.count || 0) + (hp.headings?.h2?.count || 0);
  const schemaBlocks = hp.schemaOrg?.blockCount || 0;
  const capsules = hp.answerCapsules?.withCapsule || 0;

  if (bytes !== null && bytes < 500) {
    return { value: 0, note: `homepage returned ${bytes} bytes — nothing for an AI crawler to read` };
  }
  if (headings === 0 && schemaBlocks === 0 && capsules === 0) {
    // …unless we only read part of the body. `crawlPageSignals` caps the read
    // at 2MB and flags `truncated`; a page whose first 2MB carries no heading
    // is not a shape we should call on partial evidence. Unmeasured, not failed.
    if (hp.truncated === true) {
      return { value: null, note: 'homepage body exceeded the read cap — not enough of it seen to judge; weight redistributed' };
    }
    return { value: 0, note: 'no headings or structured content in the served HTML — looks JS-rendered' };
  }
  return { value: 100, note: `content in served HTML (${headings} heading${headings === 1 ? '' : 's'})` };
}

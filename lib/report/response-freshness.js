/**
 * Response-freshness heuristic — approximates whether an LLM's response
 * reflects current knowledge or is trapped in older training data.
 *
 * Why this matters: training-data-only engines (ChatGPT non-search, Claude
 * non-search) can be 6-18 months behind real-world events. If a brand
 * launched after the engine's training cutoff, it will be invisible until the
 * next training cut — recommending "improve content" tactics in this case is
 * wasted effort.
 *
 * Approach (no LLM call, pure heuristic):
 *
 *   1. **Year mention scan**: extract all 4-digit years (2020-2030) from
 *      response text. The MAX year mentioned is a soft proxy for the model's
 *      knowledge horizon — a model that mentions 2026 events likely "knows"
 *      about 2026.
 *
 *   2. **Cutoff phrase detection**: phrases like "as of my last update",
 *      "training data", "I don't have information after" are STRONG signals
 *      that the model is aware of and disclosing its knowledge cutoff.
 *
 *   3. **Web-search bypass**: if the cell used web search (annotations /
 *      groundingChunks / search_results present), freshness defaults to
 *      'fresh' regardless of training cutoff — the model fetched live data.
 *
 *   4. **Classification**:
 *        - 'fresh'   — web-search OR latest year mentioned is current/last year
 *        - 'stale'   — cutoff phrase found OR latest year is >2 years ago
 *        - 'unknown' — no year mentions, no cutoff phrases (can't tell)
 *
 *   5. **Caveats** (returned with output):
 *        - Year-mention heuristic is APPROXIMATE — a model can know about 2026
 *          without explicitly stating "2026" in its response.
 *        - For non-search models the practical question is "does it know about
 *          our brand?" — freshness adds context but isn't sufficient alone.
 *
 * Aggregated output: per-provider freshness + count of stale-flagged cells.
 */

const CURRENT_YEAR = new Date().getFullYear();
const YEAR_RANGE_MIN = 2020;
const YEAR_RANGE_MAX = CURRENT_YEAR + 2; // tolerate near-future mentions
const STALE_GAP_YEARS = 2; // latestYear < currentYear - STALE_GAP → stale

// Cutoff-disclosure phrases (English-first; common patterns across models)
const CUTOFF_PHRASES = [
  /\bas of my (?:last|knowledge) (?:update|cutoff|training)\b/i,
  /\bmy training (?:data|cutoff|knowledge)\b/i,
  /\bknowledge (?:cut[\s-]?off|cutoff date)\b/i,
  /\bI don['']?t have (?:information|data|knowledge) (?:after|past|beyond)\b/i,
  /\bI'?m not (?:sure|aware) of (?:any|the most|recent)\b/i,
  /\b(?:my|the) (?:training|knowledge) (?:was last|ended|cut off|cuts off)\b/i,
  /\b(?:as of|up to|until|before) (?:my|the) (?:last|knowledge|training)\b/i,
];

// Web-search signals — if any present, response is fresh
function usedWebSearch(cell) {
  if (!cell || typeof cell !== 'object') return false;
  if (cell.usedWebSearch === true) return true;
  // Provider-specific signals from raw response
  const raw = cell.raw || {};
  // OpenAI Responses shape: a web_search_call item means the tool actually ran.
  if (Array.isArray(raw.output) && raw.output.some(o => o?.type === 'web_search_call')) return true;
  // OpenAI Chat shape (legacy caches): annotations[].url_citation
  const ann = raw.choices?.[0]?.message?.annotations;
  if (Array.isArray(ann) && ann.some(a => a.url_citation)) return true;
  // Gemini: groundingMetadata.groundingChunks
  const gm = raw.candidates?.[0]?.groundingMetadata;
  if (gm && Array.isArray(gm.groundingChunks) && gm.groundingChunks.length > 0) return true;
  // Perplexity: search_results
  if (Array.isArray(raw.search_results) && raw.search_results.length > 0) return true;
  // Citations field populated → likely web-search
  if (Array.isArray(cell.canonicalCitations) && cell.canonicalCitations.length > 0) return true;
  // citationCount field
  if (typeof cell.citationCount === 'number' && cell.citationCount > 0) return true;
  return false;
}

/**
 * Extract all in-range year mentions from text. Returns sorted descending
 * unique array.
 */
export function extractYearMentions(text) {
  if (!text || typeof text !== 'string') return [];
  const set = new Set();
  // Match 4-digit numbers in word boundaries — avoid matching part of larger numbers
  const re = /\b(20\d{2})\b/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const year = Number(m[1]);
    if (year >= YEAR_RANGE_MIN && year <= YEAR_RANGE_MAX) set.add(year);
  }
  return Array.from(set).sort((a, b) => b - a);
}

/**
 * Detect cutoff-disclosure phrases. Returns array of matched phrase patterns
 * (for transparency, so plan generator can show user "engine X said: 'as of
 * my last training update'").
 */
export function detectCutoffPhrases(text) {
  if (!text || typeof text !== 'string') return [];
  const matched = [];
  for (const re of CUTOFF_PHRASES) {
    const m = text.match(re);
    if (m) matched.push(m[0]);
  }
  return matched;
}

/**
 * Classify one cell's freshness.
 *
 * @param {Object} cell  one entry from summary.results[]
 * @returns {Object} {
 *   provider, freshness, confidence,
 *   latestYearMentioned, cutoffPhrases, usedWebSearch,
 *   reasoning: string  // human-readable why
 * }
 */
export function classifyResponseFreshness(cell, opts = {}) {
  const currentYear = opts.currentYear || CURRENT_YEAR;
  const result = {
    provider: cell?.provider || null,
    freshness: 'unknown',
    confidence: 'low',
    latestYearMentioned: null,
    cutoffPhrases: [],
    usedWebSearch: false,
    reasoning: '',
  };
  if (!cell || typeof cell !== 'object') {
    result.reasoning = 'no cell data';
    return result;
  }

  // Web-search bypass
  if (usedWebSearch(cell)) {
    result.usedWebSearch = true;
    result.freshness = 'fresh';
    result.confidence = 'high';
    result.reasoning = 'web-search active — response reflects live data';
    return result;
  }

  // Text-based heuristics (only run if NOT web-search)
  const text = (cell.responseExcerpt || cell.response || cell.text || '').toString();
  const years = extractYearMentions(text);
  const cutoffs = detectCutoffPhrases(text);
  result.latestYearMentioned = years[0] || null;
  result.cutoffPhrases = cutoffs;

  // Cutoff phrase = STRONGEST stale signal
  if (cutoffs.length > 0) {
    result.freshness = 'stale';
    result.confidence = 'high';
    result.reasoning = `engine self-disclosed knowledge cutoff: "${cutoffs[0].slice(0, 80)}..."`;
    return result;
  }

  // Year-based heuristic
  if (years.length > 0) {
    const latest = years[0];
    const gap = currentYear - latest;
    if (gap <= 1) {
      result.freshness = 'fresh';
      result.confidence = years.length >= 3 ? 'high' : 'med';
      result.reasoning = `latest year mentioned: ${latest} (current: ${currentYear})`;
    } else if (gap <= STALE_GAP_YEARS) {
      result.freshness = 'unknown';
      result.confidence = 'low';
      result.reasoning = `latest year mentioned: ${latest} — within ${STALE_GAP_YEARS}-year window, ambiguous`;
    } else {
      result.freshness = 'stale';
      result.confidence = 'med';
      result.reasoning = `latest year mentioned: ${latest} (${gap} years ago)`;
    }
    return result;
  }

  // No years, no cutoff phrases, no web search → unknown
  result.reasoning = 'no year mentions, no cutoff phrases, no web search — cannot determine';
  return result;
}

/**
 * Aggregate freshness across all cells. Returns per-provider summary +
 * overall counts.
 */
export function aggregateFreshness(cellResults) {
  const perProvider = {};
  const counts = { fresh: 0, stale: 0, unknown: 0, total: 0 };
  for (const r of (cellResults || [])) {
    if (!r || !r.provider) continue;
    const p = r.provider;
    if (!perProvider[p]) {
      perProvider[p] = { fresh: 0, stale: 0, unknown: 0, total: 0, latestYear: null };
    }
    perProvider[p][r.freshness]++;
    perProvider[p].total++;
    if (r.latestYearMentioned && (!perProvider[p].latestYear || r.latestYearMentioned > perProvider[p].latestYear)) {
      perProvider[p].latestYear = r.latestYearMentioned;
    }
    counts[r.freshness]++;
    counts.total++;
  }

  // Per-provider verdict
  for (const p of Object.keys(perProvider)) {
    const x = perProvider[p];
    if (x.total === 0) { x.verdict = 'unknown'; continue; }
    if (x.stale > x.fresh) x.verdict = 'stale';
    else if (x.fresh > x.stale + x.unknown) x.verdict = 'fresh';
    else x.verdict = 'mixed';
  }

  return {
    overall: counts.total === 0 ? 'unknown'
      : counts.stale > counts.fresh ? 'stale'
      : counts.fresh > counts.stale + counts.unknown ? 'fresh'
      : 'mixed',
    counts,
    perProvider,
  };
}

/**
 * Top-level: classify all cells in summary, return aggregate +
 * per-cell results. Cached in `_summary.json::responseFreshness`.
 */
export function checkResponseFreshness(summary, opts = {}) {
  const cells = (summary && Array.isArray(summary.results)) ? summary.results : [];
  const perCell = cells.map(c => classifyResponseFreshness(c, opts));
  const aggregate = aggregateFreshness(perCell);
  return {
    ranAt: new Date().toISOString(),
    aggregate,
    perCell,
    caveats: [
      'Year-mention heuristic is approximate — a model can know about year N without explicitly stating it in response.',
      'Web-search responses always classified as "fresh" regardless of training cutoff.',
      'For non-search engines, "stale" indicates KNOWLEDGE-HORIZON gap; the practical AEO question is whether engine knows about YOUR brand specifically — combine with brand-mention rate.',
    ],
  };
}

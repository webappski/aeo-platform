/**
 * AP-FIX-BRANDFIT — brand-capability fit classifier.
 *
 * The gap (Gcore root-cause 2026-06-17): the pipeline checked query→industry
 * fit but NEVER query→brand-capability fit. "VPC for healthcare" is on-industry
 * for a cloud brand yet the brand may be invisible there — a brand-irrelevant
 * zero, distinct from the "model doesn't know the brand" zero the retrieval
 * gate already catches.
 *
 * This module classifies a single candidate query as how plausibly the brand is
 * a real answer:
 *   - core         — squarely on a product the brand actually sells
 *   - adjacent     — related/expanded, brand is a plausible-but-secondary answer
 *   - aspirational — brand would like to rank but is not a core player here
 *   - unknown      — not enough signal to classify (degraded grounding /
 *                    single-provider mode) → NEVER penalise the basket
 *
 * DESIGN — ranking signal, NOT a blocker (Архип ruling):
 *   The label rides ALONGSIDE `score` on each candidate and biases ordering
 *   (core > adjacent > aspirational), exactly the way `score` already orders.
 *   It NEVER feeds `valid`, never touches the validator-recovery / top-up
 *   binary contract (valid===true && search_behavior===RETRIEVAL). An
 *   `aspirational`/`unknown` query is down-ranked, never dropped.
 *
 * Pure + network-free. The cross-model judgement comes IN as `llmFit` (the
 * `brand_fit` field added to the existing Phase-4 validate-category call — no
 * 4th round-trip). The product lines come IN as `productLines` (derived once
 * via product-lines.js). When the LLM field is absent we fall back to a local
 * lexical-overlap heuristic against the product lines; when BOTH are absent we
 * return `unknown`.
 */

export const BRAND_FIT = Object.freeze({
  CORE: 'core',
  ADJACENT: 'adjacent',
  ASPIRATIONAL: 'aspirational',
  UNKNOWN: 'unknown',
});

// Ordering weight — higher = brand is a more plausible answer. `unknown` sits
// at the SAME rank as `adjacent` (neutral): an unclassifiable query must not be
// pushed below a genuinely-aspirational one just because we lacked signal.
const FIT_RANK = Object.freeze({
  [BRAND_FIT.CORE]: 2,
  [BRAND_FIT.ADJACENT]: 1,
  [BRAND_FIT.UNKNOWN]: 1,
  [BRAND_FIT.ASPIRATIONAL]: 0,
});

const VALID_LABELS = new Set(Object.values(BRAND_FIT));

/**
 * Numeric ordering weight for a fit label. Unrecognised → neutral (adjacent).
 * @param {string} fit
 * @returns {number}
 */
export function brandFitRank(fit) {
  return FIT_RANK[fit] ?? FIT_RANK[BRAND_FIT.ADJACENT];
}

// Drop short/structural tokens so overlap measures real product nouns, not
// "for", "the", "best", "2026".
const STOPWORDS = new Set([
  'for', 'the', 'and', 'with', 'best', 'top', 'tools', 'tool', 'services',
  'service', 'platform', 'platforms', 'software', 'solution', 'solutions',
  'company', 'companies', 'vendor', 'vendors', 'provider', 'providers',
  'a', 'an', 'of', 'in', 'to', 'your', 'how', 'what', '2025', '2026', '2027',
]);

function tokenize(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/[\s-]+/)
    .filter(t => t.length >= 3 && !STOPWORDS.has(t));
}

/**
 * Local fallback classifier — lexical overlap between the query and the brand's
 * product lines. Deliberately conservative: it can promote to `core` only on a
 * direct product-noun hit, otherwise `adjacent`. It NEVER returns
 * `aspirational` (the local signal is too weak to assert "brand is not a player
 * here" — that judgement needs the cross-model verdict). No product lines →
 * `unknown`.
 *
 * @param {string} queryText
 * @param {string[]} productLines
 * @returns {{ fit: string, confidence: 'low'|'medium', reason: string }}
 */
export function classifyByOverlap(queryText, productLines) {
  const lines = Array.isArray(productLines) ? productLines.filter(Boolean) : [];
  if (lines.length === 0) {
    return { fit: BRAND_FIT.UNKNOWN, confidence: 'low', reason: 'no product lines to compare' };
  }

  const qTokens = new Set(tokenize(queryText));
  if (qTokens.size === 0) {
    return { fit: BRAND_FIT.UNKNOWN, confidence: 'low', reason: 'query had no comparable tokens' };
  }

  let bestHit = null;
  for (const line of lines) {
    const lTokens = tokenize(line);
    const overlap = lTokens.filter(t => qTokens.has(t));
    if (overlap.length > 0) {
      bestHit = { line, overlap };
      break;
    }
  }

  if (bestHit) {
    return {
      fit: BRAND_FIT.CORE,
      confidence: 'medium',
      reason: `overlaps product line "${bestHit.line}" on: ${bestHit.overlap.join(', ')}`,
    };
  }

  // Tokens exist on both sides but nothing matched — query is in the brand's
  // language yet not on a named line. Treat as adjacent, low confidence; the
  // cross-model verdict (if any) overrides this above.
  return { fit: BRAND_FIT.ADJACENT, confidence: 'low', reason: 'no product-line overlap; treated as adjacent' };
}

/**
 * Classify one candidate's brand-capability fit.
 *
 * Precedence:
 *   1. A valid cross-model `llmFit` label (from validate-category brand_fit) —
 *      authoritative; carries the model's confidence.
 *   2. Otherwise the local lexical-overlap fallback against product lines.
 *   3. Otherwise `unknown`.
 *
 * @param {Object} opts
 * @param {string} opts.queryText
 * @param {string[]} [opts.productLines=[]]
 * @param {string} [opts.llmFit]              brand_fit from the validator, if present
 * @param {string} [opts.llmConfidence]       'high'|'low' from the validator
 * @param {boolean} [opts.singleProvider]     true when Phase-4 validator was skipped
 * @returns {{ fit: string, confidence: string, source: 'llm'|'overlap'|'none', reason: string }}
 */
export function classifyBrandFit({
  queryText, productLines = [], llmFit, llmConfidence, singleProvider = false,
}) {
  // 1 — trust the cross-model verdict when it gave a recognised label.
  if (typeof llmFit === 'string' && VALID_LABELS.has(llmFit.toLowerCase())) {
    const fit = llmFit.toLowerCase();
    return {
      fit,
      confidence: llmConfidence || 'unknown',
      source: 'llm',
      reason: `cross-model verdict: ${fit}`,
    };
  }

  // 2 — single-provider mode: never assert fit from one model's basket bias.
  if (singleProvider) {
    return {
      fit: BRAND_FIT.UNKNOWN,
      confidence: 'low',
      source: 'none',
      reason: 'single-provider mode — brand-fit not cross-checked',
    };
  }

  // 3 — local fallback from product lines.
  const local = classifyByOverlap(queryText, productLines);
  return { ...local, source: local.fit === BRAND_FIT.UNKNOWN ? 'none' : 'overlap' };
}

/**
 * Batch helper: attach `brandFit` + `brandFitRank` to each candidate
 * non-destructively. Used by research.js Phase 4. When grounding is degraded
 * (no product lines AND no usable llm field), every candidate becomes
 * `unknown` with rank 1 (neutral) — selection order then falls back to `score`
 * alone, which is exactly the pre-fix behaviour. Never penalises the basket.
 *
 * @param {Array} candidates                  scored candidates
 * @param {Object} opts
 * @param {string[]} [opts.productLines=[]]
 * @param {Map<string,Object>} [opts.llmByText]  query text → { brand_fit, confidence }
 * @param {boolean} [opts.singleProvider=false]
 * @returns {Array} new candidate array with brandFit fields
 */
export function annotateBrandFit(candidates, { productLines = [], llmByText = new Map(), singleProvider = false } = {}) {
  return (candidates || []).map(c => {
    const verdict = llmByText.get(c.text);
    const result = classifyBrandFit({
      queryText: c.text,
      productLines,
      llmFit: verdict?.brand_fit,
      llmConfidence: verdict?.confidence,
      singleProvider,
    });
    return {
      ...c,
      brandFit: result.fit,
      brandFitSource: result.source,
      brandFitReason: result.reason,
      brandFitRank: brandFitRank(result.fit),
    };
  });
}

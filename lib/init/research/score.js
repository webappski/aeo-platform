/**
 * Phase 3 part 2 — candidate scoring.
 *
 * Produces a 0–100 score for each candidate based on linguistic features.
 * Used by selection (C7) to pick top candidate per intent bucket.
 *
 * Philosophy: we can't measure "AI visibility volume" so we score on
 * proxies for query quality that SEO professionals would use.
 */

import { AMBIGUOUS_ACRONYMS } from './filter.js';
import { tokenize } from './brand-fit.js';

const SPECIFICITY_RE = /\b(saas|enterprise|startups?|agencies|healthcare|fintech|ecommerce|e-commerce|b2b|b2c|founders?|teams?|companies|firms?|consultancies|marketers?|developers?)\b/i;

/**
 * Score one candidate. Non-destructive — returns a new object with score + reasons.
 *
 * @param {{ text: string, intent: string }} cand
 * @param {Object} opts
 * @param {string} opts.lang         site language (for language-match bonus)
 * @param {Array}  [opts.ambiguous]  override AMBIGUOUS_ACRONYMS list
 * @returns {{ text, intent, score, scoreReasons: string[] }}
 */
export function scoreCandidate(cand, { lang = 'en', ambiguous = AMBIGUOUS_ACRONYMS, productLines = [] } = {}) {
  const text = cand.text;
  const lower = text.toLowerCase();
  const words = text.split(/\s+/).filter(Boolean);
  const wc = words.length;

  let score = 50;
  const reasons = [];

  // Word count sweet spot: 3–7 words
  if (wc >= 3 && wc <= 7) {
    score += 20;
    reasons.push(`+20 word-count sweet-spot (${wc})`);
  } else if (wc < 3) {
    score -= 10;
    reasons.push(`-10 too short (${wc} words)`);
  } else if (wc > 10) {
    score -= 15;
    reasons.push(`-15 too long (${wc} words)`);
  }

  // Safety-net check: bare ambiguous acronym (filter.js should have caught it)
  for (const { abbr, expansion } of ambiguous) {
    const abbrRegex = new RegExp(`\\b${abbr}\\b`, 'i');
    if (abbrRegex.test(text) && !lower.includes(expansion.toLowerCase())) {
      score -= 30;
      reasons.push(`-30 bare "${abbr}" without expansion (should have been filtered)`);
      break;
    }
  }

  // Recency marker
  if (/\b(2026|2027|latest|newest|current|recent|this year)\b/i.test(text)) {
    score += 5;
    reasons.push('+5 recency marker');
  }

  // Specificity (industry/audience/segment).
  // AP-FIX-COVERAGE-AXIS: a bare vertical marker (healthcare/fintech/…) used to
  // earn +10 unconditionally, floating off-target queries (a vertical the brand
  // doesn't serve) into the top-3. Now the bonus is gated:
  //   - product lines known → reward ONLY when the query overlaps a real line;
  //     a vertical marker with no product-line overlap earns nothing.
  //   - product lines unknown → keep legacy behaviour (don't regress
  //     single-vertical brands whose offering we couldn't enumerate).
  const hasSpec = SPECIFICITY_RE.test(text);
  const lines = Array.isArray(productLines) ? productLines.filter(Boolean) : [];
  // Token-equality overlap (shared tokenizer with brand-fit.js) instead of the
  // old naive substring match: "cloud" no longer spuriously matches "clouds",
  // stopwords ("for"/"the"/"2026") and <3-char tokens are dropped, and the
  // coverage axis stays in lockstep with the brand-fit classifier.
  const qTokens = new Set(tokenize(text));
  const overlapsLine = lines.length > 0 && qTokens.size > 0 && lines.some(line => {
    const lineTokens = tokenize(line);
    return lineTokens.some(t => qTokens.has(t));
  });
  const awardSpec = lines.length > 0 ? overlapsLine : hasSpec;
  if (awardSpec) {
    score += 10;
    reasons.push(lines.length > 0 ? '+10 product-line match' : '+10 specificity marker');
  }

  // Long-tail bonus: ≥5 words AND the (gated) specificity award above.
  if (wc >= 5 && awardSpec) {
    score += 10;
    reasons.push('+10 long-tail structure');
  }

  // Comparison structure (explicit "X vs Y" or "alternative to" patterns)
  if (/\b(vs|versus|alternative to|compared to|better than|cheaper than)\b/i.test(text)) {
    score += 8;
    reasons.push('+8 comparison structure');
  }

  // Language match heuristic (cheap: ASCII heavy on English sites is fine;
  // Cyrillic/CJK on en-site is a strong mismatch signal)
  const nonAsciiRatio = ([...text].filter(ch => ch.charCodeAt(0) > 127).length / text.length);
  if (lang === 'en' && nonAsciiRatio > 0.15) {
    score -= 20;
    reasons.push('-20 non-ASCII on English site');
  }

  score = Math.max(0, Math.min(100, score));
  return { text, intent: cand.intent, score, scoreReasons: reasons };
}

/**
 * Score a batch of candidates, preserving order.
 */
export function scoreAll(candidates, opts) {
  return candidates.map(c => scoreCandidate(c, opts));
}

import { brandTerms, textMentionsBrand, citationsMentionBrand, earliestBrandIndex } from './brand-match.js';

/**
 * Classify how the brand shows up in one AI answer.
 *
 *   'yes' — named (or an alias / the domain) in the answer body
 *   'src' — only present in a citation URL
 *   'no'  — absent in every spelling
 *
 * @param {string} text          AI response text
 * @param {string[]} citations   citation URLs extracted from the answer
 * @param {string} brand         primary brand name
 * @param {string} domain        root domain
 * @param {string[]} [aliases]   alternate spellings (config.brandAliases) — optional;
 *                               omitting it reproduces the pre-1.4 behaviour exactly.
 *                               Matching is separator-tolerant: "gcore" ≈ "g-core"
 *                               ≈ "g core" (see lib/brand-match.js).
 * @returns {'yes'|'src'|'no'}
 */
export function detectMention(text, citations, brand, domain, aliases = []) {
  const terms = brandTerms(brand, domain, aliases);
  if (textMentionsBrand(text, terms)) return 'yes';
  if (citationsMentionBrand(citations, terms)) return 'src';
  return 'no';
}

/**
 * Resolve where the brand sits in a ranked AI answer.
 *
 * Returns:
 *   - integer N (≥1)  → brand sits as the Nth item of a structured list
 *   - null            → brand mentioned in prose (no reliable rank signal)
 *                        OR brand not found at all
 *
 * Logic:
 *
 *   1. Locate the earliest brand/domain occurrence (case-insensitive).
 *   2. Decide the answer's structural shape: numbered list (≥3 numbered
 *      items) > bulleted list (≥3 `-` / `*` / `•` items) > prose.
 *   3. For list answers, return the rank of the list item the brand mention
 *      sits inside — or null if the mention falls outside the list block
 *      (e.g. an intro line before item 1, or a closing paragraph after the
 *      last item).
 *   4. For prose answers, return null — we'd rather show «—» than fake a
 *      misleading «#1». Sentiment + presence give the actual signal there.
 *
 * @param {string} text       AI response text
 * @param {string} brand      brand name (e.g. "Webappski")
 * @param {string} domain     root domain (e.g. "webappski.com")
 * @param {string[]} [aliases] alternate spellings (config.brandAliases) — optional;
 *                            omitting it reproduces the pre-1.4 behaviour exactly.
 * @returns {number|null}
 */
export function findPosition(text, brand, domain, aliases = []) {
  if (!text || typeof text !== 'string') return null;

  const earliest = earliestBrandIndex(text, brandTerms(brand, domain, aliases));
  if (earliest < 0) return null;

  const lines = text.split(/\r?\n/);
  // \d{1,3} caps rank at 3 digits — no real LLM list goes past ~999 items, and
  // an unbounded \d+ on attacker-controlled response text is a (mild) ReDoS
  // hardening concern.
  const NUM_RE = /^\s*\d{1,3}[.)]\s+\S/;
  const BUL_RE = /^\s*[-*•]\s+\S/;

  const numberedCount = lines.reduce((n, l) => n + (NUM_RE.test(l) ? 1 : 0), 0);
  const bulletedCount = lines.reduce((n, l) => n + (BUL_RE.test(l) ? 1 : 0), 0);

  // Need ≥3 list items of the dominant shape — fewer is just incidental
  // bullets in a prose answer.
  let pattern = null;
  if (numberedCount >= 3) pattern = NUM_RE;
  else if (bulletedCount >= 3) pattern = BUL_RE;
  if (!pattern) return null;

  let cumOffset = 0;
  let rank = 0;
  for (const line of lines) {
    const lineLen = line.length;
    const lineStart = cumOffset;
    const lineEnd = cumOffset + lineLen;
    const isListItem = pattern.test(line);
    if (isListItem) rank++;
    if (lineStart <= earliest && earliest <= lineEnd) {
      // Mention falls on this line. Return rank only if THIS line is itself a
      // list item (i.e. the brand appears as / inside item N). Otherwise the
      // mention is before/after/between list items — no reliable rank.
      return isListItem && rank > 0 ? rank : null;
    }
    // +1 for the consumed newline (whether LF or CRLF, we treat it as one
    // separator for offset arithmetic — the CR byte gets absorbed into the
    // line by split's regex). Off-by-one on a CRLF source shifts subsequent
    // line offsets by 1 byte, but the brand-on-line check uses range
    // membership not exact position, so a 1-byte drift is harmless.
    cumOffset = lineEnd + 1;
  }
  return null;
}

export function extractUrls(text) {
  if (!text) return [];
  const regex = /https?:\/\/[^\s<>()"'\[\]{}|\\^`]+/g;
  const matches = text.match(regex) || [];
  // Strip trailing punctuation that commonly follows URLs in prose
  const cleaned = matches.map(u => u.replace(/[.,;:!?)\]]+$/, ''));
  return [...new Set(cleaned)];
}

// Competitor extraction moved to lib/report/extract-competitors-llm.js — two-model
// LLM cross-check replaces the regex + filter-dictionary approach. See that module
// for rationale. This file keeps only the brand-mention, citation-URL, and
// position-in-ranked-list helpers.

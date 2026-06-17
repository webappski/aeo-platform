/**
 * Brand-name matching helpers — separator-tolerant, alias-aware.
 *
 * Why this module exists
 * ----------------------
 * `detectMention` / `findPosition` used a naive `lowerText.includes(lowerBrand)`
 * substring check. That produces a SILENT false-zero whenever an AI engine spells
 * the brand with a different separator than the config does: a brand stored as
 * "gcore" is invisible in an answer that writes "G-Core" or "G Core", and a brand
 * stored as "G-Core" is invisible in an answer that writes "Gcore". The generator
 * side already expands query acronyms maniacally — the same care was never applied
 * to the brand name on the matching side (root-cause 2026-06-17, Gcore false 0%).
 *
 * What "separator-tolerant" means here
 * ------------------------------------
 *   "gcore"  ≈ "g-core" ≈ "g core"     — a hyphen/space BETWEEN the brand's
 *                                          characters is treated as no-op.
 *
 * Word-boundary anchoring (why no cross-word false positives)
 * ----------------------------------------------------------
 * The separator tolerance applies only WITHIN the brand term; the whole term is
 * wrapped in Unicode word-boundary lookarounds. So "gcore" matches "Gcore",
 * "G-Core", "(Gcore)", "Gcore," — but NOT "a bi[g core] network", "[g]core[house]",
 * or "open AI" for "openai". A neighbour that is a letter (any script) or digit
 * defeats the match; punctuation / whitespace / string edges are boundaries.
 *
 * What it deliberately does NOT do
 * --------------------------------
 *   - It does not drop the dot in "Node.js" — a needle "Node.js" still requires
 *     the literal "node.js" in the text (the dot is significant punctuation, not a
 *     word separator). Hyphen/space tolerance only.
 *   - It does not match a brand glued inside a longer word — boundary anchors mean
 *     "gcore" never fires inside "gcorehouse" or across the "bi|g core" seam.
 *   - It does not do fuzzy / edit-distance matching — only exact-with-flexible-
 *     separators + explicit operator-supplied aliases. No new false POSITIVES.
 *
 * Backward compatibility
 * ----------------------
 * With no aliases and a brand that contains no internal separators, the regex this
 * builds matches exactly the same spans the old `includes` did — so existing
 * behaviour (and every existing test) is preserved.
 */

/**
 * Collect the distinct, non-empty match terms for a brand.
 *
 * @param {string} brand           primary brand name (e.g. "Gcore")
 * @param {string} domain          root domain (e.g. "gcore.com")
 * @param {string[]} [aliases]     operator-supplied alternates (config.brandAliases)
 * @returns {{ nameTerms: string[], domainTerm: string|null }}
 *   nameTerms  — brand + aliases, deduped, separator-tolerant matching applies
 *   domainTerm — the domain, matched as a plain (lowercased) substring; a dot in a
 *                domain is significant, so it is NOT given separator tolerance
 */
export function brandTerms(brand, domain, aliases = []) {
  const seen = new Set();
  const nameTerms = [];
  for (const raw of [brand, ...(Array.isArray(aliases) ? aliases : [])]) {
    if (typeof raw !== 'string') continue;
    const t = raw.trim();
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    nameTerms.push(t);
  }
  const domainTerm = (typeof domain === 'string' && domain.trim()) ? domain.trim() : null;
  return { nameTerms, domainTerm };
}

// Characters that count as in-name separators: ASCII hyphen, ASCII space, and the
// common unicode variants engines emit (en/em dash, non-breaking space). A run of
// these between brand characters is treated as optional during matching.
const SEP_CLASS = '[\\s\\-\\u2010-\\u2015\\u00a0]';
const SEP_RUN_RE = new RegExp(`${SEP_CLASS}+`, 'g');
// Regex metacharacters to neutralise when a literal brand fragment is embedded in
// a constructed pattern (a brand like "C++" or "Node.js" must match literally).
const META_RE = /[.*+?^${}()|[\]\\]/g;

function escapeRegex(s) {
  return s.replace(META_RE, '\\$&');
}

/**
 * Build a case-insensitive RegExp that matches `term` allowing any run of
 * separator characters where `term` itself has a separator OR between two adjacent
 * non-separator characters.
 *
 * "gcore"  → /g\s*-?\s*c.../  effectively → matches "gcore", "g-core", "g core"
 * "g-core" → same pattern (the explicit hyphen is just one more optional-separator
 *            seam) → also matches "gcore"
 *
 * Implementation: split the term on separator runs into "chunks", regex-escape each
 * chunk, then join the chunks with an OPTIONAL separator-run matcher. Within a
 * chunk, also insert an optional separator-run between every pair of characters so
 * "gcore" (one chunk, no internal separator) still matches "g-core".
 */
function buildTermRegex(term) {
  const chunks = term.split(SEP_RUN_RE).filter(Boolean);
  if (chunks.length === 0) return null;

  // Per chunk: allow an optional separator between each character so a separator-
  // less needle ("gcore") matches a separated form ("g-core"). Escape first so a
  // metacharacter (the "." in "node.js" lives inside a chunk) stays literal.
  const optSep = `${SEP_CLASS}*`;
  const chunkToPattern = (chunk) =>
    [...chunk].map(escapeRegex).join(optSep);

  // Between chunks (where the needle HAD a separator) require zero-or-more
  // separators too — same matcher, so the seam is symmetric.
  const body = chunks.map(chunkToPattern).join(optSep);
  // Word-boundary anchors around the WHOLE term. Without these the separator-
  // tolerant body matches across word seams: "gcore" (→ g[sep]*c[sep]*o...) would
  // hit the span "g core" inside "a bi[g core] network", and "openai" would hit
  // "open AI". The anchors require a non-word neighbour on each side, where "word"
  // = any Unicode letter (\p{L}, so Cyrillic/Greek/CJK brands are covered too) or
  // digit (\p{N}). They are zero-width LOOKAROUNDS, so re.exec().index still points
  // at the brand's first character — earliestBrandIndex / findPosition offsets are
  // unchanged. Separator tolerance INSIDE the term is preserved (the body is
  // untouched), so "g-core" ≈ "g core" ≈ "gcore" and "(Gcore)" / "Gcore," / "Gcore's"
  // (punctuation = boundary) still match. The `u` flag is required for \p{…} and is
  // safe: every fragment is escaped via escapeRegex and SEP_CLASS is u-valid.
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${body})(?![\\p{L}\\p{N}])`, 'iu');
}

// Small cache so the per-cell loop (one run = dozens of cells, same brand) doesn't
// recompile identical patterns. Keyed by the lowercased term.
const _regexCache = new Map();
function termRegex(term) {
  const key = term.toLowerCase();
  let re = _regexCache.get(key);
  if (re === undefined) {
    re = buildTermRegex(term);
    _regexCache.set(key, re);
  }
  return re;
}

/**
 * Does `text` mention the brand (by name/alias, separator-tolerant) or its domain
 * (plain substring)?
 *
 * @param {string} text
 * @param {{ nameTerms: string[], domainTerm: string|null }} terms  from brandTerms()
 * @returns {boolean}
 */
export function textMentionsBrand(text, terms) {
  if (!text || typeof text !== 'string') return false;
  const lower = text.toLowerCase();
  if (terms.domainTerm && lower.includes(terms.domainTerm.toLowerCase())) return true;
  for (const name of terms.nameTerms) {
    const re = termRegex(name);
    if (re && re.test(text)) return true;
  }
  return false;
}

/**
 * Does any citation URL contain the brand name/alias or domain?
 * URLs rarely carry the separated form, but aliases (and the domain) still apply.
 *
 * @param {string[]} citations
 * @param {{ nameTerms: string[], domainTerm: string|null }} terms
 * @returns {boolean}
 */
export function citationsMentionBrand(citations, terms) {
  if (!Array.isArray(citations) || citations.length === 0) return false;
  return citations.some(url => {
    if (typeof url !== 'string') return false;
    const lowerUrl = url.toLowerCase();
    if (terms.domainTerm && lowerUrl.includes(terms.domainTerm.toLowerCase())) return true;
    for (const name of terms.nameTerms) {
      const re = termRegex(name);
      if (re && re.test(url)) return true;
    }
    return false;
  });
}

/**
 * Index of the EARLIEST brand/alias/domain occurrence in `text`, or -1.
 * Used by findPosition to locate which ranked list item the brand sits in — so it
 * must return a position in the ORIGINAL string (not a normalised copy).
 *
 * @param {string} text
 * @param {{ nameTerms: string[], domainTerm: string|null }} terms
 * @returns {number}  earliest 0-based index, or -1 if absent
 */
export function earliestBrandIndex(text, terms) {
  if (!text || typeof text !== 'string') return -1;
  let earliest = Infinity;

  if (terms.domainTerm) {
    const idx = text.toLowerCase().indexOf(terms.domainTerm.toLowerCase());
    if (idx >= 0 && idx < earliest) earliest = idx;
  }
  for (const name of terms.nameTerms) {
    const re = termRegex(name);
    if (!re) continue;
    const m = re.exec(text);
    if (m && m.index < earliest) earliest = m.index;
  }
  return earliest === Infinity ? -1 : earliest;
}

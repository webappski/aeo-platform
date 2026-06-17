/**
 * Shared product-line derivation for the research pipeline.
 *
 * Both AP-FIX-BRANDFIT (brand-capability fit) and AP-FIX-COVERAGE-AXIS
 * (coverage = product lines, not verticals) need the SAME answer to one
 * question: "what does this brand actually sell?" — its product lines, not the
 * industries it serves. This module is the single derivation both reuse.
 *
 * Grounding source: site H2 headings (primary) + H1 (secondary). On most
 * product sites H2 enumerates the offering ("CDN", "DDoS Protection", "GPU
 * Cloud", "Object Storage"). Pure + network-free — works on the `site` object
 * already parsed in research.js.
 *
 * Honest degradation (flagged by Архип): on horizontal-infrastructure sites
 * H2 is often a marketing slogan ("Build without limits", "Trusted by
 * thousands"), NOT a product list — and some sites never enumerate their
 * lines at all. When we cannot extract real lines we return an EMPTY list and
 * the caller treats brand-fit as `unknown` (never penalise the basket by
 * pretending everything is "aspirational" from an empty H2).
 */

// Phrases that look like H2/H1 but are marketing chrome, not product lines.
// Used to drop sloganry so an all-slogan H2 set degrades to "no lines found"
// rather than producing junk "lines".
const SLOGAN_MARKERS = [
  /\bbuild\b/i, /\bget started\b/i, /\bsign up\b/i, /\btrusted by\b/i,
  /\bwhy\b/i, /\bhow it works\b/i, /\bwithout limits\b/i, /\bfor everyone\b/i,
  /\bteams? love\b/i, /\bloved by\b/i, /\bjoin\b/i, /\btestimonials?\b/i,
  /\bpricing\b/i, /\bcontact\b/i, /\babout us\b/i, /\bfaqs?\b/i,
  /\bready to\b/i, /\bstart (?:free|today|now)\b/i, /\blearn more\b/i,
  /\bcustomers?\b/i, /\bcase stud(?:y|ies)\b/i, /\bnewsletter\b/i,
];

// A candidate line is junk if it's a full sentence (ends with terminal
// punctuation), a question, or absurdly long. Product-line headings are short
// noun phrases ("Edge Network", "Managed Kubernetes"), not sentences.
function looksLikeSlogan(s) {
  const t = s.trim();
  if (!t) return true;
  if (/[.!?]$/.test(t)) return true;            // sentence/question
  if (t.split(/\s+/).length > 6) return true;   // too long for a line label
  if (SLOGAN_MARKERS.some(re => re.test(t))) return true;
  return false;
}

/**
 * Derive the brand's product lines from parsed site content.
 *
 * @param {Object} site                parseSiteContent output ({ h1, h2, ... })
 * @param {Object} [opts]
 * @param {number} [opts.max=12]       cap on returned lines
 * @returns {{ lines: string[], source: 'h2'|'h1'|'none', degraded: boolean }}
 *   lines    — extracted product-line labels (may be empty)
 *   source   — which field they came from
 *   degraded — true when nothing usable could be extracted (caller → unknown)
 */
export function deriveProductLines(site, { max = 12 } = {}) {
  const clean = (arr) => (Array.isArray(arr) ? arr : [])
    .map(s => String(s || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .filter(s => !looksLikeSlogan(s));

  // De-dupe case-insensitively, preserving first-seen order/casing.
  const dedupe = (arr) => {
    const seen = new Set();
    const out = [];
    for (const s of arr) {
      const key = s.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(s);
    }
    return out;
  };

  const fromH2 = dedupe(clean(site?.h2)).slice(0, max);
  if (fromH2.length >= 2) {
    return { lines: fromH2, source: 'h2', degraded: false };
  }

  // H2 yielded too little (slogan-heavy or sparse) — try H1 as a weaker source.
  const fromH1 = dedupe(clean(site?.h1)).slice(0, max);
  if (fromH1.length >= 2) {
    return { lines: fromH1, source: 'h1', degraded: false };
  }

  // Could not extract real product lines. Honest degradation: empty + flag.
  // (nav/sitemap fallback intentionally NOT done here — parseSiteContent does
  //  not expose nav, and a fresh fetch is not cheap. See session notes.)
  return { lines: [], source: 'none', degraded: true };
}

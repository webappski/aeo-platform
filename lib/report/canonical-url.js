// Canonical-URL helper for topCanonicalSources de-duplication
// (fail-branch #12, AP-FAILBRANCH-REMAINDER).
//
// PROBLEM: topCanonicalSources keyed on the raw citation URL, so the SAME page
// cited as `https://firstpagesage.com/seo-blog/...`, `.../seo-blog/...?utm_source=chatgpt`,
// `.../seo-blog/.../` (trailing slash), and `.../seo-blog/...#section` counted
// as four separate sources — splitting one page's real citation weight and
// pushing genuinely-distinct pages out of the top-20.
//
// FIX: collapse the variants that mean "the same page" while KEEPING distinct
// pages on the same host distinct (this is page-level data — collapsing to bare
// host would duplicate topDomains and destroy the "which page AI cites" signal).
//
// Normalization (conservative — only strips what is provably non-identifying):
//   - lowercase scheme + host, strip a leading `www.`
//   - drop the default port (:80 / :443)
//   - drop the fragment (#…) — never identifies a distinct page server-side
//   - strip known tracking query params (utm_*, ref, fbclid, gclid, …); keep
//     genuine query params (e.g. ?id=42) that DO select a different page
//   - collapse a single trailing slash on a non-root path
//   - http vs https for the same host+path → treat as the same page (engines
//     cite both; the page is identical)

const TRACKING_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'utm_id', 'utm_name', 'utm_reader', 'utm_referrer',
  'ref', 'ref_src', 'referrer', 'source',
  'fbclid', 'gclid', 'gclsrc', 'dclid', 'msclkid', 'yclid',
  'mc_cid', 'mc_eid', '_hsenc', '_hsmi', 'igshid', 'spm', 'scid',
]);

/**
 * Return a canonical key for a citation URL — variants that point at the same
 * page collapse to one key. Returns the input unchanged when it cannot be
 * parsed (never throws — a weird citation should still be counted as itself).
 *
 * @param {string} rawUrl
 * @returns {string} canonical key (NOT for display — for grouping)
 */
export function canonicalizeUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl) return rawUrl;
  let u;
  try {
    u = new URL(rawUrl);
  } catch {
    return rawUrl.trim();
  }
  // Scheme is non-identifying for the page (http/https serve the same content);
  // normalize to https so the two never split.
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  const port = (u.port && u.port !== '80' && u.port !== '443') ? `:${u.port}` : '';

  // Path: collapse a single trailing slash except for the bare root.
  let path = u.pathname || '/';
  if (path.length > 1 && path.endsWith('/')) path = path.replace(/\/+$/, '');

  // Query: drop tracking params, keep the rest sorted for stable keys.
  const kept = [];
  for (const [k, v] of u.searchParams) {
    if (TRACKING_PARAMS.has(k.toLowerCase())) continue;
    kept.push([k, v]);
  }
  kept.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const query = kept.length
    ? '?' + kept.map(([k, v]) => (v === '' ? k : `${k}=${v}`)).join('&')
    : '';

  return `https://${host}${port}${path}${query}`;
}

/**
 * Aggregate raw citation URLs into topCanonicalSources, merging same-page
 * variants under one canonical key. Keeps the FIRST-seen original URL for
 * display (so the client sees a real URL, not the normalized key) and sums the
 * counts of every variant that collapsed into it.
 *
 * @param {string[]} urls  flat list of every canonicalCitation across results
 * @param {number} [limit=20]
 * @returns {{url: string, count: number}[]}  sorted by count desc
 */
export function aggregateCanonicalSources(urls, limit = 20) {
  /** @type {Map<string, {url: string, count: number}>} */
  const byKey = new Map();
  for (const raw of urls) {
    if (!raw) continue;
    const key = canonicalizeUrl(raw);
    const existing = byKey.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      // Display the canonical key itself — it is a clean, real URL and avoids
      // surfacing whichever tracking-laden variant happened to arrive first.
      byKey.set(key, { url: key, count: 1 });
    }
  }
  return [...byKey.values()].sort((a, b) => b.count - a.count).slice(0, limit);
}

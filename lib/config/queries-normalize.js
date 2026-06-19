/**
 * Normalise queries from `.aeo-tracker.json` into a uniform shape.
 *
 * Supported input formats (backwards-compatible — string-only is the
 * historical shape, object form is new in v0.4):
 *
 *   queries: ["best CRM 2026", "free SEO tools"]                // strings only
 *   queries: [
 *     { q: "best CRM 2026", tag: "comparison-bofu" },           // tagged object
 *     { q: "free SEO tools", tag: "tofu" },
 *     "untagged top-of-funnel keyword",                          // mixed OK
 *   ]
 *
 * Output:
 *   {
 *     texts: ["best CRM 2026", "free SEO tools", "untagged ..."],
 *     tags:  ["comparison-bofu", "tofu", null],
 *     brandFits: ["core", "core", null],
 *     hasTags: true,         // any item carries a tag
 *     uniqueTags: ["comparison-bofu", "tofu"],
 *   }
 *
 * The parallel arrays mean existing code that loops `for (qi of queries)`
 * keeps working unchanged — `texts[qi]` returns the same string it always did.
 * `tag` (funnel/intent) and `brandFit` (core/adjacent/aspirational — the
 * brand-capability dimension from AP-FIX-BRANDFIT) are SEPARATE axes carried in
 * separate slots; never conflate them. Each is looked up by index and attached
 * to results so the report can segment without re-running the research pipeline.
 */

/**
 * Normalise raw `queries` from `.aeo-tracker.json` into a uniform
 * { texts, tags, hasTags, uniqueTags } shape.
 *
 * Why: tagged objects are new in v0.4 (sales/comparison/tofu); legacy configs
 * are bare strings. Centralising the parse keeps every consumer (`run`, report,
 * topic clusterer) on one shape and unaware of the input variant.
 *
 * Unknown items in the array are silently skipped — keeping the function pure
 * and cheap. Validation/warnings happen earlier in `cmdInit`.
 *
 * @param {Array<string|{q:string,tag?:string,brandFit?:string}>} rawQueries
 * @returns {{ texts: string[], tags: Array<string|null>, brandFits: Array<string|null>, hasTags: boolean, uniqueTags: string[] }}
 */
export function normalizeQueries(rawQueries) {
  if (!Array.isArray(rawQueries)) {
    return { texts: [], tags: [], brandFits: [], hasTags: false, uniqueTags: [] };
  }

  const texts = [];
  const tags = [];
  const brandFits = [];

  for (const item of rawQueries) {
    if (typeof item === 'string') {
      texts.push(item);
      tags.push(null);
      brandFits.push(null);
    } else if (item && typeof item === 'object' && typeof item.q === 'string') {
      texts.push(item.q);
      const tag = typeof item.tag === 'string' ? item.tag.trim() : null;
      tags.push(tag && tag.length > 0 ? tag : null);
      // brandFit is a separate axis (core/adjacent/aspirational/unknown) — a
      // single string slot, looked up by index exactly like `tag`. Unknown /
      // empty → null so the report treats the query as un-segmented rather
      // than inventing a bucket.
      const bf = typeof item.brandFit === 'string' ? item.brandFit.trim().toLowerCase() : null;
      brandFits.push(bf && bf.length > 0 ? bf : null);
    } else {
      // unknown shape — skip
    }
  }

  const tagSet = new Set(tags.filter(t => !!t));
  return {
    texts,
    tags,
    brandFits,
    hasTags: tagSet.size > 0,
    uniqueTags: Array.from(tagSet),
  };
}

/** The four brand-fit labels the report segments by. Mirrors BRAND_FIT in
 * lib/init/research/brand-fit.js — kept as a local Set so this module stays
 * dependency-free (the parser must not import the research pipeline). */
const VALID_BRAND_FITS = new Set(['core', 'adjacent', 'aspirational', 'unknown']);

/**
 * Plain query string for any supported item shape (string or {q,...}).
 * The single place that knows how to read the text out of a basket entry —
 * basket-history dedup and any other consumer share it so the string-only and
 * object forms never diverge.
 *
 * @param {string|{q?:string}} item
 * @returns {string} the query text ('' for an unrecognised shape)
 */
export function queryText(item) {
  if (typeof item === 'string') return item;
  if (item && typeof item === 'object' && typeof item.q === 'string') return item.q;
  return '';
}

/**
 * Persist brand-fit labels onto a list of query STRINGS, producing the mixed
 * string|{q,brandFit} array that `.aeo-tracker.json` stores and normalizeQueries
 * reads back. This is the source→config link that wakes the dormant
 * core/aspirational segmentation (AP-SEGMENT-LIVE): init computes the label on
 * the selected basket, this stamps it on, `run` reads it via normalizeQueries
 * and attaches `brandFit` to each result → the report's segment block fires.
 *
 * MINIMAL-DIFF / BACK-COMPAT by design:
 *   - A query whose label is absent, falsy, or unrecognised stays a BARE STRING
 *     (not `{q}`), so a basket where nothing was classified is byte-identical to
 *     the historical string-only shape — and the segmentation stays gracefully
 *     dormant exactly as before.
 *   - Only queries carrying a recognised lower-cased label become objects.
 *   - `tag` (funnel axis) — and ANY other field a pre-existing query object
 *     already carried — is preserved (spread), so the two axes never clobber
 *     each other and a future per-query field is not silently dropped.
 *   - Pure; never mutates the input (spread builds a fresh object).
 *
 * @param {Array<string|{q:string,tag?:string,brandFit?:string}>} queries  current basket entries
 * @param {Object<string,string>|Map<string,string>} brandFitByText  query-text → label (core/adjacent/aspirational/unknown)
 * @returns {Array<string|{q:string,tag?:string,brandFit:string}>}  strings whose label was absent; otherwise `{q, …prior fields, brandFit}`
 */
export function attachBrandFit(queries, brandFitByText) {
  if (!Array.isArray(queries)) return [];
  const lookup = brandFitByText instanceof Map
    ? (k) => brandFitByText.get(k)
    : (k) => (brandFitByText && typeof brandFitByText === 'object' ? brandFitByText[k] : undefined);

  return queries.map(item => {
    const text = queryText(item);
    if (!text) return item; // unrecognised shape — pass through untouched
    const rawFit = lookup(text);
    const fit = typeof rawFit === 'string' ? rawFit.trim().toLowerCase() : '';

    // No usable label → keep the entry in its CURRENT shape (string stays a
    // string; a pre-existing object keeps its fields). Never invent `{q}`.
    if (!fit || !VALID_BRAND_FITS.has(fit)) return item;

    // A bare string becomes the minimal `{ q, brandFit }` object.
    if (typeof item === 'string') return { q: text, brandFit: fit };

    // A pre-existing object keeps EVERY field it already had and only gains /
    // overwrites `brandFit`. Spreading (rather than re-listing q/tag) means a
    // future per-query field (e.g. `weight`, `note`) added upstream rides
    // through untouched instead of being silently dropped — the two query axes
    // (funnel `tag`, capability `brandFit`) and anything else stay intact.
    return { ...item, brandFit: fit };
  });
}

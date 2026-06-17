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

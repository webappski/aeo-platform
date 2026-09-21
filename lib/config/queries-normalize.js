/**
 * Normalise queries from `.aeo-tracker.json` into a uniform shape.
 *
 * Supported input formats (backwards-compatible — string-only is the
 * historical shape, object form is new in v0.4):
 *
 *   queries: ["best CRM 2026", "free SEO tools"]                // strings only
 *   queries: [
 *     { q: "best CRM 2026", tag: "commercial" },                // tagged object
 *     { q: "CRM vs spreadsheet", tag: "comparison" },
 *     "untagged question",                                       // mixed OK
 *   ]
 *
 * Output:
 *   {
 *     texts: ["best CRM 2026", "CRM vs spreadsheet", "untagged ..."],
 *     tags:  ["commercial", "comparison", null],
 *     brandFits: ["core", "core", null],
 *     hasTags: true,         // any item carries a tag
 *     uniqueTags: ["commercial", "comparison"],
 *   }
 *
 * `init` writes the intent class it already computed (see attachIntentTag). A
 * hand-written tag is honoured as-is — the report segments by whatever strings
 * the basket carries.
 *
 * The parallel arrays mean existing code that loops `for (qi of queries)`
 * keeps working unchanged — `texts[qi]` returns the same string it always did.
 * `tag` (intent class) and `brandFit` (core/adjacent/aspirational — the
 * brand-capability dimension from AP-FIX-BRANDFIT) are SEPARATE axes carried in
 * separate slots; never conflate them. Each is looked up by index and attached
 * to results so the report can segment without re-running the research pipeline.
 */

/**
 * Normalise raw `queries` from `.aeo-tracker.json` into a uniform
 * { texts, tags, hasTags, uniqueTags } shape.
 *
 * Why: tagged objects are new in v0.4 (intent classes); legacy configs
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

/** The five intent classes `lib/init/research/classify-intent.js` can return.
 * Mirrors its PRIORITY_ORDER — a local Set for the same reason VALID_BRAND_FITS
 * is one: this module parses config and must not import the research pipeline.
 *
 * These are INTENTS, not funnel stages. We store the classification we actually
 * compute; mapping it onto a ToFu/MoFu/BoFu model would publish our judgement as
 * if it were a measurement (founder ruling 2026-09-21). A hand-written tag
 * outside this set still rides through `normalizeQueries` and still segments the
 * report — the set gates only what `init` is allowed to stamp automatically. */
const VALID_INTENTS = new Set(['comparison', 'problem', 'commercial', 'informational', 'vertical']);

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
 *   - `tag` (intent axis) — and ANY other field a pre-existing query object
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
    // (intent `tag`, capability `brandFit`) and anything else stay intact.
    return { ...item, brandFit: fit };
  });
}

/**
 * Persist intent tags onto a list of basket entries — the `tag` axis, exactly as
 * `attachBrandFit` does for the `brandFit` axis, and deliberately symmetric with
 * it (same shapes in, same back-compat contract, same purity).
 *
 * Why this exists: `init` ALREADY classifies every query it selects
 * (lib/init/research/classify-intent.js) and then threw the result away — it
 * lived only in memory for validator-recovery's intent-diversity check. The
 * report has carried a by-tag section since v0.4 that no run ever reached,
 * because no config ever stored a tag. This is the one missing link: init stamps
 * what it already computed, `run` reads it back via normalizeQueries and hangs
 * `tag` on each result, and the section wakes.
 *
 * No new prompt, no new call, no new cost — the classification already happened.
 *
 * KEY BY TEXT, NEVER BY INDEX. Validator-recovery substitutes a blocked query
 * for a pool candidate by text, so the positional intent array `init` builds
 * before recovery no longer describes the basket after it. A text-keyed lookup
 * resolves selected, hand-edited-to-match and recovery-substituted queries alike
 * (the pool candidate carries its own intent), which is what keeps a basket from
 * ending up half tagged.
 *
 * BACK-COMPAT, identical to attachBrandFit:
 *   - no / unrecognised intent → the entry stays in its CURRENT shape, so a
 *     basket nothing classified is byte-identical to the historical string form
 *     and the section stays gracefully dormant exactly as before;
 *   - a pre-existing object keeps every field (spread) — `brandFit` and any
 *     future per-query field are never clobbered by this axis;
 *   - pure; never mutates the input.
 *
 * Composes with attachBrandFit in either order — both are pure and both spread.
 *
 * @param {Array<string|{q:string,tag?:string,brandFit?:string}>} queries  current basket entries
 * @param {Object<string,string>|Map<string,string>} intentByText  query-text → intent class
 * @returns {Array<string|{q:string,tag:string}>}  strings whose intent was absent; otherwise `{q, …prior fields, tag}`
 */
export function attachIntentTag(queries, intentByText) {
  if (!Array.isArray(queries)) return [];
  const lookup = intentByText instanceof Map
    ? (k) => intentByText.get(k)
    : (k) => (intentByText && typeof intentByText === 'object' ? intentByText[k] : undefined);

  return queries.map(item => {
    const text = queryText(item);
    if (!text) return item; // unrecognised shape — pass through untouched
    const rawIntent = lookup(text);
    const intent = typeof rawIntent === 'string' ? rawIntent.trim().toLowerCase() : '';

    // Unclassified → leave it alone. Never guess a class for a query the
    // classifier declined to place: an invented tag would show up in the report
    // as a measured intent, which is the one thing this feature must not do.
    if (!intent || !VALID_INTENTS.has(intent)) return item;

    if (typeof item === 'string') return { q: text, tag: intent };
    return { ...item, tag: intent };
  });
}

/**
 * Stamp BOTH per-query axes on a basket in one call — the only form config
 * writers should use.
 *
 * Why a wrapper over two one-line calls: `.aeo-tracker.json` is written in two
 * places (`init` and `init --queries-only`, the latter in two modes), and the
 * axes were added a release apart. A writer that remembers one and forgets the
 * other produces a basket that is half-labelled, and nothing downstream can
 * tell that from a basket the classifier genuinely declined to label. Naming
 * the pair makes the omission impossible to make quietly.
 *
 * @param {Array<string|{q:string,tag?:string,brandFit?:string}>} queries
 * @param {Object<string,string>|Map<string,string>} brandFitByText  query-text → core/adjacent/aspirational/unknown
 * @param {Object<string,string>|Map<string,string>} intentByText    query-text → intent class
 * @returns {Array<string|{q:string,tag?:string,brandFit?:string}>}
 */
export function stampQueryAxes(queries, brandFitByText, intentByText) {
  return attachIntentTag(attachBrandFit(queries, brandFitByText), intentByText);
}

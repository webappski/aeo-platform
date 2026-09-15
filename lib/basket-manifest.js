/**
 * Basket manifest — the stable identity of a measured question.
 *
 * A run records each cell under the ORDINAL label its query happened to have
 * that day (`Q12`). The label is a position in the config array, not an
 * identity: reorder the basket, drop one question, add three, and `Q12` is a
 * different question with the same name. `lib/diff.js` keyed cells as
 * `` `${r.query}|${r.provider}` `` — so comparing the 2026-08-27 run (56
 * questions) with the 2026-08-31 run (50 questions) lined up 50 label pairs in
 * which ALL 50 texts differ. Every row of that comparison was two different
 * questions presented as movement.
 *
 * The manifest fixes identity outside the array order:
 *   id      — sha256 of the normalised question text, first 12 hex chars.
 *             Same text ⇒ same id, on any machine, in any run, forever.
 *   q       — the text itself, so a manifest is readable without the config.
 *   market  — the DECLARED market/language of the question.
 *
 * Why the market is declared here and not derived: `lib/report/region-context.js`
 * infers a market per cell from the answer, with a confidence — a measurement,
 * and a fine one, but not a basis for "compare PL to PL". Two runs must be
 * matched on what we ASKED, which is a property of the basket, not of the
 * answer. This module therefore NEVER guesses a market: it copies what the
 * config declares and leaves `null` when nothing is declared. A null market
 * means "unknown", and a comparison treats unknown as comparable-without-market
 * rather than asserting a match.
 *
 * KNOWN LIMIT OF THE DECLARED MARKET, since a reader will otherwise trust it
 * further than it can carry. `scripts/build-basket-manifest.mjs` can derive an
 * assignment from each question's language and will refuse to write it unless
 * the totals reproduce a ratio a human declared (e.g. PL 35 / DE 5 / EN 5 /
 * RU 5). That check is a real constraint, but it is a check on TOTALS: two
 * questions swapped between two markets cancel out and still reproduce the
 * ratio exactly. It therefore rules out a systematic mistake, not a
 * compensating pair of individual ones. The per-question list is printed for a
 * human to read before it becomes a "declared" field, and that reading — not
 * the ratio check — is what makes any single entry trustworthy.
 *
 * `runRoot` rides in the manifest for a related reason: the same basket has
 * been run from two working directories, so `aeo-responses/<domain>/<date>/`
 * resolves to two different trees and "compare with the baseline" silently
 * depends on where you stand. The manifest names the canonical tree; the CLI
 * warns when the current directory is not it. Nothing is deleted or moved —
 * the fork becomes visible instead of silent.
 *
 * Pure (no I/O) and dependency-free beyond node:crypto, so it is unit-tested
 * against exact expected values (R37: E2E would only smear the arithmetic —
 * same reasoning as lib/sampling.js's header).
 */

import { createHash } from 'node:crypto';

/** Manifest schema version — bumped when the ID RULE changes, because that
 *  invalidates every stored id. Adding an optional field does not bump it. */
export const MANIFEST_SCHEMA = 1;

/** Prefix on every generated id, so a manifest id is never mistaken for an
 *  ordinal label (`Q12`) or a bare hash in a log line. */
const ID_PREFIX = 'q_';

/** Fallback identity for a record that carries no text at all — the ordinal
 *  label, explicitly marked as the weak identity it is. Two runs of the same
 *  unchanged basket still line up on it (that is the pre-manifest behaviour,
 *  preserved); two runs of different baskets line up on it wrongly, which is
 *  why `resolveQueryIdentity` reports the source and callers can refuse. */
const LABEL_PREFIX = 'label:';

/**
 * Normalise a question text for identity purposes.
 *
 * NFKC first (so a pre-composed «ó» and a combining «ó» are one question),
 * then lower-case, then whitespace collapse. Deliberately NOT stripping
 * punctuation or diacritics: «tanie agencje AEO» and «tanie agencje AEO?» are
 * arguably the same intent but they are NOT the same prompt, and this id
 * decides whether two measurements may be subtracted from each other.
 *
 * @param {string} text
 * @returns {string} '' for a missing/blank input
 */
export function normalizeQueryText(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Stable id for a question text. Returns null for blank input rather than the
 * hash of an empty string — a question with no text has no identity, and a
 * shared "id of nothing" would silently merge every such record.
 *
 * @param {string} text
 * @returns {string|null} e.g. 'q_3f1c9a0b7d22'
 */
export function queryIdFor(text) {
  const norm = normalizeQueryText(text);
  if (!norm) return null;
  return ID_PREFIX + createHash('sha256').update(norm, 'utf8').digest('hex').slice(0, 12);
}

/** Normalise a declared market label to an upper-case short code, or null.
 *  Never invents one: anything unusable becomes null (= unknown). */
export function normalizeMarket(market) {
  if (typeof market !== 'string') return null;
  const m = market.trim().toUpperCase();
  return m.length > 0 && m.length <= 8 ? m : null;
}

/** Read the text out of a basket entry (string form or `{q}` object form).
 *  Mirrors `lib/config/queries-normalize.js#queryText`; kept local so the
 *  manifest module stays importable on its own. */
function entryText(item) {
  if (typeof item === 'string') return item;
  if (item && typeof item === 'object' && typeof item.q === 'string') return item.q;
  return '';
}

/**
 * Build a manifest from a basket.
 *
 * The market comes from the entry itself (`{ q, market }`) or from an explicit
 * `opts.markets` lookup keyed by the RAW text — never from inspection of the
 * text. Callers that want to assign markets in bulk (e.g. a one-off migration)
 * do the assigning themselves and pass the result in, so the guess lives in
 * the caller's audit trail and not inside a function that is supposed to be
 * a lookup.
 *
 * @param {Array<string|{q:string,market?:string}>} queries basket entries
 * @param {object} [opts]
 * @param {number} [opts.version] basket version (`basketVersion` in the config)
 * @param {string} [opts.runRoot] canonical absolute run-output directory
 * @param {string} [opts.generatedAt] ISO date stamp
 * @param {string} [opts.marketProvenance] one honest sentence: where the markets came from
 * @param {Object<string,string>|Map<string,string>} [opts.markets] text → market
 * @returns {{schema:number, version:(number|null), generatedAt:(string|null),
 *            runRoot:(string|null), marketProvenance:(string|null),
 *            queries:Array<{id:string,q:string,market:(string|null)}>}}
 */
export function buildManifest(queries, opts = {}) {
  const lookup = opts.markets instanceof Map
    ? (k) => opts.markets.get(k)
    : (k) => (opts.markets && typeof opts.markets === 'object' ? opts.markets[k] : undefined);

  const entries = [];
  const seen = new Set();
  for (const item of (Array.isArray(queries) ? queries : [])) {
    const text = entryText(item);
    const id = queryIdFor(text);
    if (!id) continue;                       // unrecognised / empty entry — skip, never id it
    if (seen.has(id)) continue;              // duplicate text = one question, listed once
    seen.add(id);
    const declared = (item && typeof item === 'object' ? item.market : undefined) ?? lookup(text);
    entries.push({ id, q: text, market: normalizeMarket(declared) });
  }

  return {
    schema: MANIFEST_SCHEMA,
    version: Number.isFinite(opts.version) ? opts.version : null,
    generatedAt: opts.generatedAt || null,
    runRoot: typeof opts.runRoot === 'string' && opts.runRoot ? opts.runRoot : null,
    marketProvenance: opts.marketProvenance || null,
    queries: entries,
  };
}

/**
 * Index a manifest for lookup by id and by text. Returns empty maps for a
 * missing/garbage manifest so every caller can index unconditionally.
 *
 * @param {{queries?:Array<{id:string,q:string,market?:string}>}} manifest
 * @returns {{byId:Map<string,object>, byText:Map<string,object>, size:number}}
 */
export function manifestIndex(manifest) {
  const byId = new Map();
  const byText = new Map();
  for (const e of (manifest?.queries || [])) {
    if (!e || typeof e.id !== 'string') continue;
    byId.set(e.id, e);
    const norm = normalizeQueryText(e.q);
    if (norm) byText.set(norm, e);
  }
  return { byId, byText, size: byId.size };
}

/**
 * Resolve the comparable identity of ONE result record.
 *
 * Source ladder, strongest first:
 *   'record' — the run stamped `queryId` (runs from this version on);
 *   'text'   — derived from the record's own `queryText` (every run on disk
 *              since the text was added to the record — the reason the
 *              historical baseline is comparable at all);
 *   'label'  — only the ordinal `Q12` survives. Identity is position-based and
 *              therefore unreliable across baskets; reported so the caller can
 *              decide, not silently upgraded.
 *
 * The market is taken from the record if the run stamped one, otherwise from
 * the manifest, otherwise null (unknown — never guessed).
 *
 * @param {{queryId?:string, queryText?:string, query?:string, market?:string}} record
 * @param {{byId:Map,byText:Map}} [index] from `manifestIndex`
 * @returns {{id:string, source:'record'|'text'|'label', text:(string|null), market:(string|null)}}
 */
export function resolveQueryIdentity(record, index = null) {
  const byId = index?.byId instanceof Map ? index.byId : new Map();
  const byText = index?.byText instanceof Map ? index.byText : new Map();

  let id = null;
  let source = null;
  if (record && typeof record.queryId === 'string' && record.queryId) {
    id = record.queryId;
    source = 'record';
  } else if (record && typeof record.queryText === 'string' && normalizeQueryText(record.queryText)) {
    id = queryIdFor(record.queryText);
    source = 'text';
  } else {
    id = LABEL_PREFIX + String(record?.query ?? '');
    source = 'label';
  }

  const fromManifest = byId.get(id)
    || (record?.queryText ? byText.get(normalizeQueryText(record.queryText)) : undefined);

  const text = (record && typeof record.queryText === 'string' && record.queryText)
    || fromManifest?.q
    || null;

  const market = normalizeMarket(record?.market) ?? (fromManifest ? normalizeMarket(fromManifest.market) : null);

  return { id, source, text, market };
}

/** True when the identity is position-based (`Q12`) rather than text-based. */
export function isLabelIdentity(id) {
  return typeof id === 'string' && id.startsWith(LABEL_PREFIX);
}

/**
 * Check a manifest against the basket it claims to describe.
 *
 * `missing` — a basket question the manifest does not list (the config was
 *             edited and the manifest was not regenerated);
 * `extra`   — a manifest entry no longer in the basket (retired question);
 * `ok`      — both empty.
 *
 * This is the drift check that keeps the manifest from becoming another stale
 * cache: a stale manifest silently degrades market lookups to null, and a
 * silent degradation is exactly what this work exists to remove.
 *
 * @param {{queries?:Array<{id:string,q:string}>}} manifest
 * @param {Array<string|{q:string}>} queries
 * @returns {{ok:boolean, missing:string[], extra:string[]}}
 */
export function verifyManifest(manifest, queries) {
  const idx = manifestIndex(manifest);
  const basketIds = new Map();
  for (const item of (Array.isArray(queries) ? queries : [])) {
    const text = entryText(item);
    const id = queryIdFor(text);
    if (id) basketIds.set(id, text);
  }
  const missing = [...basketIds.entries()].filter(([id]) => !idx.byId.has(id)).map(([, text]) => text);
  const extra = [...idx.byId.values()].filter(e => !basketIds.has(e.id)).map(e => e.q);
  return { ok: missing.length === 0 && extra.length === 0, missing, extra };
}

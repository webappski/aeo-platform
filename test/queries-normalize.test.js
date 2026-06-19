import assert from 'node:assert/strict';
import { normalizeQueries, attachBrandFit, queryText } from '../lib/config/queries-normalize.js';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n    ${err.message}`); }
}

console.log('\nnormalizeQueries');

test('all-strings input — backward compatible', () => {
  const r = normalizeQueries(['best CRM', 'top SEO tools']);
  assert.deepEqual(r.texts, ['best CRM', 'top SEO tools']);
  assert.deepEqual(r.tags, [null, null]);
  assert.equal(r.hasTags, false);
  assert.deepEqual(r.uniqueTags, []);
});

test('all-objects input', () => {
  const r = normalizeQueries([
    { q: 'a', tag: 'tofu' },
    { q: 'b', tag: 'bofu' },
  ]);
  assert.deepEqual(r.texts, ['a', 'b']);
  assert.deepEqual(r.tags, ['tofu', 'bofu']);
  assert.equal(r.hasTags, true);
  assert.deepEqual(r.uniqueTags.sort(), ['bofu', 'tofu']);
});

test('mixed input — strings and objects', () => {
  const r = normalizeQueries([
    'untagged one',
    { q: 'tagged one', tag: 'comparison' },
    'untagged two',
  ]);
  assert.deepEqual(r.texts, ['untagged one', 'tagged one', 'untagged two']);
  assert.deepEqual(r.tags, [null, 'comparison', null]);
  assert.equal(r.hasTags, true);
});

test('empty tag string treated as null', () => {
  const r = normalizeQueries([{ q: 'x', tag: '' }, { q: 'y', tag: '   ' }]);
  assert.deepEqual(r.tags, [null, null]);
  assert.equal(r.hasTags, false);
});

test('object missing q field is skipped', () => {
  const r = normalizeQueries([
    { q: 'ok', tag: 't' },
    { tag: 'orphan' },
    'plain',
  ]);
  assert.equal(r.texts.length, 2);
  assert.deepEqual(r.texts, ['ok', 'plain']);
});

test('non-array input → empty result', () => {
  const r = normalizeQueries(null);
  assert.deepEqual(r.texts, []);
  assert.equal(r.hasTags, false);
});

test('whitespace in tag is trimmed', () => {
  const r = normalizeQueries([{ q: 'x', tag: '  bofu  ' }]);
  assert.equal(r.tags[0], 'bofu');
});

// ── brandFit axis (AP-FIX-SCORE-SEGMENT wiring) ──────────────────────────────

test('brandFits is a parallel array, null for untagged/string queries', () => {
  const r = normalizeQueries(['plain', { q: 'tagged', tag: 't' }]);
  assert.deepEqual(r.brandFits, [null, null],
    'string and tag-only objects carry no brandFit');
});

test('brandFit is carried, lower-cased, parallel to texts', () => {
  const r = normalizeQueries([
    { q: 'best CDN', brandFit: 'CORE' },
    { q: 'edge AI', tag: 'tofu', brandFit: 'aspirational' },
    'untagged',
  ]);
  assert.deepEqual(r.brandFits, ['core', 'aspirational', null]);
  // brandFit must NOT leak into the funnel-tag axis (separate dimensions).
  assert.deepEqual(r.tags, [null, 'tofu', null]);
});

test('empty / whitespace brandFit treated as null', () => {
  const r = normalizeQueries([{ q: 'x', brandFit: '' }, { q: 'y', brandFit: '   ' }]);
  assert.deepEqual(r.brandFits, [null, null]);
});

test('non-array input → empty brandFits', () => {
  assert.deepEqual(normalizeQueries(null).brandFits, []);
});

// ── queryText: shared text extractor (AP-SEGMENT-LIVE) ───────────────────────

test('queryText reads a bare string', () => {
  assert.equal(queryText('best CDN 2026'), 'best CDN 2026');
});

test('queryText reads {q} object', () => {
  assert.equal(queryText({ q: 'best CDN', brandFit: 'core' }), 'best CDN');
});

test('queryText returns "" for an unrecognised shape (never throws / stringifies)', () => {
  assert.equal(queryText(null), '');
  assert.equal(queryText({ tag: 'orphan' }), '');
  assert.equal(queryText(42), '');
});

// ── attachBrandFit: the source→config link that wakes segmentation ───────────

test('attachBrandFit stamps a recognised label as {q,brandFit}', () => {
  const out = attachBrandFit(['best CDN', 'edge AI'], { 'best CDN': 'core', 'edge AI': 'aspirational' });
  assert.deepEqual(out, [
    { q: 'best CDN', brandFit: 'core' },
    { q: 'edge AI', brandFit: 'aspirational' },
  ]);
});

test('R39 BACK-COMPAT: no labels → identical bare-string array (byte-identical to historical shape)', () => {
  const input = ['best CDN', 'edge AI', 'object storage'];
  const out = attachBrandFit(input, {});
  // Must be plain strings, not {q} objects — an unclassified basket stays
  // exactly as it was written before AP-SEGMENT-LIVE (segmentation dormant).
  assert.deepEqual(out, input);
  assert.ok(out.every(x => typeof x === 'string'), 'every entry stays a bare string');
});

test('attachBrandFit leaves an unlabelled query a bare string even when siblings are labelled', () => {
  const out = attachBrandFit(['has-label', 'no-label'], { 'has-label': 'core' });
  assert.deepEqual(out, [{ q: 'has-label', brandFit: 'core' }, 'no-label']);
});

test('attachBrandFit normalises label case and rejects unrecognised labels', () => {
  const out = attachBrandFit(['a', 'b'], { a: 'CORE', b: 'banana' });
  // 'CORE' → 'core' (object); 'banana' is not a valid fit → stays a string.
  assert.deepEqual(out, [{ q: 'a', brandFit: 'core' }, 'b']);
});

test('attachBrandFit preserves an existing funnel tag alongside the new brandFit', () => {
  const out = attachBrandFit([{ q: 'a', tag: 'tofu' }], { a: 'core' });
  assert.deepEqual(out, [{ q: 'a', tag: 'tofu', brandFit: 'core' }]);
});

test('attachBrandFit preserves ANY pre-existing field on a query object (forward-compat spread)', () => {
  // A future per-query field added upstream (here: `weight` + `note`) must ride
  // through untouched — the stamp only ADDS brandFit, never rebuilds the object
  // from a fixed {q,tag} whitelist that would silently drop unknown keys.
  const out = attachBrandFit(
    [{ q: 'a', tag: 'tofu', weight: 2, note: 'keep me' }],
    { a: 'core' },
  );
  assert.deepEqual(out, [{ q: 'a', tag: 'tofu', weight: 2, note: 'keep me', brandFit: 'core' }]);
});

test('attachBrandFit keeps unknown fields even when the entry had no tag', () => {
  // No funnel tag, but a future field present → object preserved + labelled.
  const out = attachBrandFit([{ q: 'a', weight: 5 }], { a: 'adjacent' });
  assert.deepEqual(out, [{ q: 'a', weight: 5, brandFit: 'adjacent' }]);
});

test('attachBrandFit accepts a Map as the lookup', () => {
  const out = attachBrandFit(['a'], new Map([['a', 'adjacent']]));
  assert.deepEqual(out, [{ q: 'a', brandFit: 'adjacent' }]);
});

test('attachBrandFit is pure — does not mutate the input array or its entries', () => {
  const input = [{ q: 'a', tag: 'tofu' }];
  const snapshot = JSON.parse(JSON.stringify(input));
  attachBrandFit(input, { a: 'core' });
  assert.deepEqual(input, snapshot, 'input untouched');
});

test('attachBrandFit on non-array → []', () => {
  assert.deepEqual(attachBrandFit(null, { a: 'core' }), []);
});

// ── ROUND-TRIP: attach → normalize is the live wiring run uses ────────────────
// This is the contract that wakes the report: a basket stamped at init, read
// back by `run` via normalizeQueries, yields a brandFit per index that the
// result-attach (bin/aeo-tracker.js) copies onto each result → segment fires.

test('ROUND-TRIP: stamped basket → normalizeQueries recovers the label per index', () => {
  const saved = attachBrandFit(
    ['core q', 'asp q', 'plain q'],
    { 'core q': 'core', 'asp q': 'aspirational' },
  );
  const norm = normalizeQueries(saved);
  assert.deepEqual(norm.texts, ['core q', 'asp q', 'plain q'], 'texts unchanged — run loop iterates these');
  assert.deepEqual(norm.brandFits, ['core', 'aspirational', null], 'labels recovered, plain stays null (dormant for that cell)');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

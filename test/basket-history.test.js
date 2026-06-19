/**
 * basket-history dedup/merge contract — object-aware after AP-SEGMENT-LIVE.
 *
 * The active basket is now a MIXED array of bare strings (unclassified queries)
 * and {q,brandFit} objects (the brand-fit label persisted so the report's
 * core/aspirational segment block wakes). The historical dedup keyed off
 * `String(q)`, which turns an object into the literal "[object Object]" — so
 * every distinct object query collapsed to ONE dedup key, silently corrupting
 * `--add-queries` (only the first object survived, the rest were dropped as
 * "duplicates"). These tests pin the fix: dedup keys off the query TEXT.
 */

import assert from 'node:assert/strict';
import {
  mergeQueries, recordExpansion, recordReplacement, initialBasket, readBasket,
} from '../lib/init/basket-history.js';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n    ${err.message}`); }
}

console.log('\nbasket-history (object-aware dedup)');

// ── mergeQueries: the string→object corruption fix ───────────────────────────

test('BACK-COMPAT: string + string merge is unchanged (order preserved, case-insensitive dedup)', () => {
  const out = mergeQueries(['a', 'b'], ['B', 'c']);
  assert.deepEqual(out, ['a', 'b', 'c'], '"B" dedups against "b"; "c" appended');
});

test('MUTATION SANITY: two distinct object queries do NOT collapse to one (the [object Object] bug)', () => {
  // Pre-fix: String({q:'x'}) === String({q:'y'}) === "[object Object]" → the
  // second object was dropped as a duplicate. Must keep BOTH.
  const out = mergeQueries(
    [{ q: 'edge ai', brandFit: 'core' }],
    [{ q: 'gpu cloud', brandFit: 'aspirational' }, { q: 'object storage', brandFit: 'adjacent' }],
  );
  assert.equal(out.length, 3, 'all three distinct object queries survive');
  assert.deepEqual(out.map(q => q.q), ['edge ai', 'gpu cloud', 'object storage']);
});

test('object query dedups against an existing STRING of the same text (mixed shapes)', () => {
  // Adding {q:'best cdn'} when 'best cdn' is already present (as a string) must
  // be a no-op — same query, different shape.
  const out = mergeQueries(['best cdn', 'edge ai'], [{ q: 'Best CDN', brandFit: 'core' }]);
  assert.deepEqual(out, ['best cdn', 'edge ai'], 'case-insensitive text dedup across shapes');
});

test('a genuinely new object query is appended and keeps its brandFit label', () => {
  const out = mergeQueries(['best cdn'], [{ q: 'gpu rental', brandFit: 'aspirational' }]);
  assert.deepEqual(out, ['best cdn', { q: 'gpu rental', brandFit: 'aspirational' }]);
});

test('existing object entries keep their shape and label through a merge', () => {
  const out = mergeQueries(
    [{ q: 'best cdn', brandFit: 'core' }],
    ['new plain query'],
  );
  assert.deepEqual(out, [{ q: 'best cdn', brandFit: 'core' }, 'new plain query'],
    'prior object survives with its label; new string appended');
});

test('unrecognised-shape entries produce an empty key and are skipped, not crashed', () => {
  // {tag:'orphan'} has no q → queryText('') → empty dedup key → skipped.
  const out = mergeQueries(['a'], [{ tag: 'orphan' }, 'b']);
  assert.deepEqual(out, ['a', 'b']);
});

// ── recordExpansion / recordReplacement / initialBasket carry the shape ──────

test('initialBasket stores the basket verbatim (objects preserved in history)', () => {
  const b = initialBasket([{ q: 'a', brandFit: 'core' }, 'b'], '2026-06-19');
  assert.equal(b.basketVersion, 1);
  assert.deepEqual(b.basketHistory[0].queries, [{ q: 'a', brandFit: 'core' }, 'b']);
});

test('recordExpansion bumps version and snapshots the merged (object-bearing) basket', () => {
  const base = { ...initialBasket(['a'], '2026-06-01') };
  const merged = mergeQueries(['a'], [{ q: 'b', brandFit: 'adjacent' }]);
  const upd = recordExpansion(base, merged, '2026-06-19');
  assert.equal(upd.basketVersion, 2);
  assert.equal(upd.basketHistory.at(-1).kind, 'additive');
  assert.deepEqual(upd.basketHistory.at(-1).queries, ['a', { q: 'b', brandFit: 'adjacent' }]);
});

test('recordReplacement forks and snapshots the new object basket as kind=replace', () => {
  const base = { ...initialBasket(['old'], '2026-06-01') };
  const upd = recordReplacement(base, [{ q: 'new', brandFit: 'core' }], '2026-06-19');
  assert.equal(upd.basketVersion, 2);
  assert.equal(upd.basketHistory.at(-1).kind, 'replace');
  assert.deepEqual(upd.basketHistory.at(-1).queries, [{ q: 'new', brandFit: 'core' }]);
});

test('readBasket legacy migration is unaffected by entry shape', () => {
  const r = readBasket({ queries: [{ q: 'a', brandFit: 'core' }, 'b'] }, '2026-06-19');
  assert.equal(r.version, 1);
  assert.deepEqual(r.history[0].queries, [{ q: 'a', brandFit: 'core' }, 'b']);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

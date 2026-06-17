// Unit tests for lib/stats.js — Wilson interval, two-proportion z-test, CI
// overlap and the signal/noise classifier behind AP-MEASURE-SAMPLING-CI.
//
// These are pure-math assertions on exact values (R37: an E2E would only smear
// the arithmetic). Reference values were independently recomputed by the
// test-design audit and confirmed against this implementation.
//
// MUTATION-SANITY (each block names the regression it catches):
//   - swap Wilson → Wald in lib/stats.js → wilson(0,5)/wilson(5,5) boundary
//     assertions go RED (Wald collapses to a zero-width [0,0]/[1,1]).
//   - shift z 1.96 → 1.64 (DEFAULT_Z) → wilson(50,100) half-width assertion
//     (±1e-3) goes RED — this is the z-sensitive mutant the design asked for
//     (Wald and Wilson are too close at 50/100 to discriminate, so we pin the
//     interval WIDTH which only z moves).
//   - pooled→unpooled SE in twoProportionZ → the 5/5-vs-0/5 z value drifts and
//     the pinned z (3.1623 ±1e-3) goes RED.
//   - flip classifyProportionChange to "non-overlap OR significant" → the
//     5/5-vs-0/5 = signal stays, but loosening to overlap-only would let
//     3/5-vs-2/5 become signal (asserted noise here).

import assert from 'node:assert/strict';
import {
  wilson, zForConfidence, DEFAULT_Z,
  twoProportionZ, ciOverlap, classifyProportionChange,
  presenceFromCounts,
} from '../lib/stats.js';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n    ${err.message}`); }
}
const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg}: ${a} vs ${b} (eps ${eps})`);

console.log('\nstats — wilson');

test('wilson(0,0) → maximal-ignorance [0,1], rate 0', () => {
  const w = wilson(0, 0);
  assert.equal(w.low, 0);
  assert.equal(w.high, 1);
  assert.equal(w.rate, 0);
  assert.equal(w.n, 0);
});

test('wilson(5,5) — unanimous yes: high=1, low≈0.566 (NOT Wald [1,1])', () => {
  const w = wilson(5, 5);
  assert.equal(w.high, 1);
  near(w.low, 0.5655, 1e-3, 'wilson(5,5).low');
  assert.ok(w.low > 0 && w.low < 1, 'lower bound must be strictly inside (0,1) — Wald would give 1');
});

test('wilson(0,5) — unanimous no: low=0, high≈0.434 (NOT Wald [0,0])', () => {
  const w = wilson(0, 5);
  assert.equal(w.low, 0);
  near(w.high, 0.4345, 1e-3, 'wilson(0,5).high');
  assert.ok(w.high > 0, 'upper bound must be strictly > 0 — Wald would give 0');
});

test('wilson(3,5) — centre and half-width', () => {
  const w = wilson(3, 5);
  near((w.low + w.high) / 2, 0.5566, 1e-3, 'wilson(3,5) centre');
  near(w.low, 0.2307, 1e-3, 'wilson(3,5).low');
  near(w.high, 0.8824, 1e-3, 'wilson(3,5).high');
});

test('wilson(50,100) ≈ [0.404, 0.596] — z-sensitive width (Wald≈Wilson here)', () => {
  const w = wilson(50, 100);
  near(w.low, 0.4038, 1e-3, 'wilson(50,100).low');
  near(w.high, 0.5962, 1e-3, 'wilson(50,100).high');
  // The interval WIDTH is what the z-mutant (1.96→1.64) moves; pin it.
  near(w.high - w.low, 0.1924, 1e-3, 'wilson(50,100) width is z-driven');
});

test('wilson symmetry: low(k,n) == 1 − high(n−k,n)', () => {
  near(wilson(3, 5).low, 1 - wilson(2, 5).high, 1e-9, '3/5 low vs 2/5 high mirror');
  near(wilson(1, 7).low, 1 - wilson(6, 7).high, 1e-9, '1/7 low vs 6/7 high mirror');
});

test('wilson always within [0,1] across a grid', () => {
  for (let n = 1; n <= 20; n++) {
    for (let h = 0; h <= n; h++) {
      const w = wilson(h, n);
      assert.ok(w.low >= 0 && w.low <= 1, `low out of range at ${h}/${n}`);
      assert.ok(w.high >= 0 && w.high <= 1, `high out of range at ${h}/${n}`);
      assert.ok(w.low <= w.high, `low>high at ${h}/${n}`);
    }
  }
});

console.log('\nstats — confidence levels');

test('zForConfidence known + unknown fallback', () => {
  near(zForConfidence(0.95), 1.959963984540054, 1e-12, '95% z');
  near(zForConfidence(0.90), 1.6448536269514722, 1e-12, '90% z');
  // unknown level degrades to 95% (never-fail), NOT throw
  assert.equal(zForConfidence(0.42), DEFAULT_Z);
  assert.equal(zForConfidence(), DEFAULT_Z);
});

test('90% interval is NARROWER than 95% for the same data', () => {
  const w95 = wilson(3, 5, zForConfidence(0.95));
  const w90 = wilson(3, 5, zForConfidence(0.90));
  assert.ok((w90.high - w90.low) < (w95.high - w95.low),
    'lower confidence → narrower interval');
});

console.log('\nstats — presenceFromCounts');

test('presenceFromCounts shapes the persisted presence object', () => {
  const p = presenceFromCounts(2, 3, 0.95);
  assert.equal(p.hits, 2);
  assert.equal(p.n, 3);
  near(p.rate, 2 / 3, 1e-12, 'rate');
  assert.equal(p.ci.level, 0.95);
  near(p.ci.low, wilson(2, 3).low, 1e-12, 'ci.low matches wilson');
  near(p.ci.high, wilson(2, 3).high, 1e-12, 'ci.high matches wilson');
});

test('presenceFromCounts(0,0) → rate 0, CI [0,1]', () => {
  const p = presenceFromCounts(0, 0);
  assert.equal(p.rate, 0);
  assert.equal(p.ci.low, 0);
  assert.equal(p.ci.high, 1);
});

console.log('\nstats — two-proportion z');

test('twoProportionZ 3/5 vs 2/5 → small z, not significant', () => {
  const r = twoProportionZ(3, 5, 2, 5);
  near(r.z, 0.6325, 1e-3, 'z(3/5,2/5)');
  assert.equal(r.significant, false);
});

test('twoProportionZ 5/5 vs 0/5 → large z, significant (POOLED SE)', () => {
  const r = twoProportionZ(5, 5, 0, 5);
  // Pinned value discriminates pooled vs unpooled SE — unpooled SE is 0 here
  // (both groups are at a boundary) and would yield z=0/Infinity, not 3.1623.
  near(r.z, 3.1623, 1e-3, 'z(5/5,0/5) pooled');
  assert.equal(r.significant, true);
});

test('twoProportionZ degenerate (n=0 or pooled boundary) → z 0, not significant', () => {
  assert.equal(twoProportionZ(0, 0, 1, 5).significant, false);
  assert.equal(twoProportionZ(5, 5, 5, 5).z, 0, 'identical unanimous → no difference');
  assert.equal(twoProportionZ(0, 5, 0, 5).z, 0, 'both all-no → no difference');
});

console.log('\nstats — ciOverlap + classifyProportionChange');

test('ciOverlap inclusive (touching counts as overlap)', () => {
  assert.equal(ciOverlap({ low: 0.1, high: 0.5 }, { low: 0.5, high: 0.9 }), true);
  assert.equal(ciOverlap({ low: 0.1, high: 0.4 }, { low: 0.5, high: 0.9 }), false);
  assert.equal(ciOverlap(null, { low: 0, high: 1 }), false);
});

test('classify 3/5 vs 2/5 → noise (overlapping CIs)', () => {
  const v = classifyProportionChange({ hits: 3, n: 5 }, { hits: 2, n: 5 });
  assert.equal(v.classification, 'noise');
  assert.equal(v.overlap, true);
});

test('classify 5/5 vs 0/5 → signal (disjoint + significant)', () => {
  const v = classifyProportionChange({ hits: 5, n: 5 }, { hits: 0, n: 5 });
  assert.equal(v.classification, 'signal');
  assert.equal(v.overlap, false);
});

test('classify 10/10 vs 0/10 → signal (large clean separation)', () => {
  assert.equal(classifyProportionChange({ hits: 10, n: 10 }, { hits: 0, n: 10 }).classification, 'signal');
});

test('classify requires BOTH non-overlap AND significance (borderline stays noise)', () => {
  // 4/5 vs 1/5: CIs likely still touch at n=5 → conservative noise. The point
  // is that ONE rule alone (e.g. "rates differ") would call it a change; the
  // combined rule does not at this tiny n.
  const v = classifyProportionChange({ hits: 4, n: 5 }, { hits: 1, n: 5 });
  assert.equal(v.classification, 'noise',
    'n=5 with 4-vs-1 split is not enough separation to declare signal');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

// Unit tests for lib/sampling.js — aggregateCellTrials() + resolveSamples().
//
// aggregateCellTrials collapses a cell's N trial outcomes into ONE
// representative record + a fractional presence object (AP-MEASURE-SAMPLING-CI).
// Pure arithmetic → unit, exact values (R37).
//
// MUTATION-SANITY:
//   - count 'no' as a presence hit → frequency [y,y,n,y,n] hits goes 3→4 RED.
//   - drop 'src' from the hit set → src-in-hits test RED.
//   - last-trial instead of modal mention → tie-break test RED.
//   - include error trials in n → all-error and error-excluded tests RED.
//   - sum instead of max for citationCount → citation-union test RED.
//   - CAVEAT #6 dual-rule: presence.hits counts yes+src as a hit AND the
//     representative `mention` resolves a [yes,src] tie to 'yes'. Both are
//     asserted on the SAME trial set so a change to either rule is caught.

import assert from 'node:assert/strict';
import { aggregateCellTrials, resolveSamples, MAX_SAMPLES } from '../lib/sampling.js';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n    ${err.message}`); }
}
const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg}: ${a} vs ${b}`);

console.log('\nsampling — aggregateCellTrials presence');

test('frequency [y,y,n,y,n] → hits 3 / n 5, rate 0.6', () => {
  const a = aggregateCellTrials([
    { mention: 'yes' }, { mention: 'yes' }, { mention: 'no' }, { mention: 'yes' }, { mention: 'no' },
  ]);
  assert.equal(a.presence.hits, 3);
  assert.equal(a.presence.n, 5);
  near(a.presence.rate, 0.6, 1e-12, 'rate');
  assert.ok(a.presence.ci.low > 0 && a.presence.ci.high < 1, 'CI present and inside (0,1)');
});

test("'src' counts toward presence hits", () => {
  const a = aggregateCellTrials([{ mention: 'src' }, { mention: 'src' }, { mention: 'no' }]);
  assert.equal(a.presence.hits, 2, 'src is a hit');
  assert.equal(a.presence.n, 3);
});

test('error trials excluded from n (NOT counted as no)', () => {
  const a = aggregateCellTrials([{ mention: 'yes' }, { mention: 'error' }, { mention: 'no' }]);
  assert.equal(a.presence.n, 2, 'error dropped from denominator');
  assert.equal(a.presence.hits, 1);
});

test('all-error cell → presence n 0, rate 0, CI [0,1], mention error', () => {
  const a = aggregateCellTrials([{ mention: 'error' }, { mention: 'error' }]);
  assert.equal(a.presence.n, 0);
  assert.equal(a.presence.rate, 0);
  assert.equal(a.presence.ci.low, 0);
  assert.equal(a.presence.ci.high, 1);
  assert.equal(a.mention, 'error', 'no measured trial → representative is error (uncovered)');
});

console.log('\nsampling — representative mention (modal + tie-break)');

test('modal mention: [y,y,n] → yes', () => {
  assert.equal(aggregateCellTrials([{ mention: 'yes' }, { mention: 'yes' }, { mention: 'no' }]).mention, 'yes');
});

test('modal mention: [n,n,y] → no', () => {
  assert.equal(aggregateCellTrials([{ mention: 'no' }, { mention: 'no' }, { mention: 'yes' }]).mention, 'no');
});

test('CAVEAT #6 dual-rule — [yes,src] tie: presence hits=2/n=2 AND mention=yes', () => {
  const a = aggregateCellTrials([{ mention: 'yes' }, { mention: 'src' }]);
  // Rule (a): both yes and src are presence hits.
  assert.equal(a.presence.hits, 2, 'yes+src both count as hits');
  assert.equal(a.presence.n, 2);
  // Rule (b): the representative mention breaks the yes-vs-src tie toward 'yes'.
  assert.equal(a.mention, 'yes', 'tie yes vs src resolves to the stronger yes');
});

test('tie-break src > no when tied', () => {
  assert.equal(aggregateCellTrials([{ mention: 'src' }, { mention: 'no' }]).mention, 'src');
});

console.log('\nsampling — position median (yes-trials only)');

test('position = median over yes trials with numeric position', () => {
  const a = aggregateCellTrials([
    { mention: 'yes', position: 5 },
    { mention: 'yes', position: 1 },
    { mention: 'yes', position: 3 },
    { mention: 'no', position: null },
  ]);
  assert.equal(a.mention, 'yes');
  assert.equal(a.position, 3, 'median of [1,3,5]');
});

test('position null when representative mention is not yes', () => {
  const a = aggregateCellTrials([{ mention: 'no' }, { mention: 'no' }, { mention: 'yes', position: 2 }]);
  assert.equal(a.mention, 'no');
  assert.equal(a.position, null, 'no body rank when cell is representatively a no');
});

test('position even-count → lower-mid (deterministic, no fractional rank)', () => {
  const a = aggregateCellTrials([
    { mention: 'yes', position: 2 }, { mention: 'yes', position: 4 },
  ]);
  assert.equal(a.position, 2, 'lower-mid of [2,4] is 2, never 3');
});

console.log('\nsampling — citation union + hasBrand OR');

test('citationCount = MAX across trials (union magnitude), not sum', () => {
  const a = aggregateCellTrials([
    { mention: 'yes', citationCount: 2 },
    { mention: 'yes', citationCount: 5 },
    { mention: 'no', citationCount: 1 },
  ]);
  assert.equal(a.citationCount, 5, 'max, not sum (=8)');
});

test('hasBrandInCitations = OR across trials', () => {
  assert.equal(aggregateCellTrials([
    { mention: 'no', hasBrandInCitations: false },
    { mention: 'src', hasBrandInCitations: true },
  ]).hasBrandInCitations, true);
  assert.equal(aggregateCellTrials([
    { mention: 'no', hasBrandInCitations: false },
    { mention: 'no', hasBrandInCitations: false },
  ]).hasBrandInCitations, false);
});

test('canonicalCitations = first-seen-stable union (dedup)', () => {
  const a = aggregateCellTrials([
    { mention: 'yes', canonicalCitations: ['https://a.com', 'https://b.com'] },
    { mention: 'yes', canonicalCitations: ['https://b.com', 'https://c.com'] },
  ]);
  assert.deepEqual(a.canonicalCitations, ['https://a.com', 'https://b.com', 'https://c.com']);
});

console.log('\nsampling — resolveSamples (never-fail)');

test('resolveSamples default + garbage → 1', () => {
  assert.equal(resolveSamples(undefined), 1);
  assert.equal(resolveSamples(''), 1);
  assert.equal(resolveSamples('abc'), 1);
  assert.equal(resolveSamples('0'), 1);
  assert.equal(resolveSamples('-4'), 1);
  assert.equal(resolveSamples(null), 1);
});

test('resolveSamples valid values pass through; over-cap clamps', () => {
  assert.equal(resolveSamples('5'), 5);
  assert.equal(resolveSamples(3), 3);
  assert.equal(resolveSamples('7.9'), 7, 'floors fractional');
  assert.equal(resolveSamples('1000'), MAX_SAMPLES, 'cost-stop cap');
  assert.equal(resolveSamples(String(MAX_SAMPLES)), MAX_SAMPLES);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

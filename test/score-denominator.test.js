// MEAS-2 — one numerator, one denominator, across every surface that publishes
// a share.
//
// Two defects are pinned here:
//   M01 — a sampled cell was scored by its REPRESENTATIVE label (modal,
//         tie-broken yes>src>no), so a cell measured twice as yes/no counted
//         whole. The fraction was already computed and stored next to it
//         (`presence.hits/n`) and simply not read.
//   M07 — three different denominators shipped in the same report: the headline
//         excluded errored calls, the per-engine rate and the lift aggregate
//         included them, and nothing said which was which.
//
// R37: this is arithmetic on pure functions, so it is unit-tested against exact
// expected values rather than through E2E — the same standard `lib/sampling.js`
// states in its header ("kept pure … unit-tested against exact expected values
// (R37: E2E would only smear the arithmetic)"). The cross-surface rendering of
// the same denominator additionally has a live HTML assertion in
// test/html-render-smoke.js ("every hero KPI that counts answers uses the SAME
// denominator").

import assert from 'node:assert/strict';
import { aggregateScore, cellCounts, sliceStats, scorePercent } from '../lib/score.js';
import { aggregateCellTrials } from '../lib/sampling.js';
import { buildLiftOpportunity } from '../lib/report/run-metrics.js';
import { sectionFunnelBreakdown, segmentByBrandFit } from '../lib/report/sections.js';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n    ${err.message}`); }
}

console.log('\nFIXTURE 1 — a cell measured twice as yes/no is 50, not 100');

test('samples=2 with outcomes yes/no scores 50', () => {
  const agg = aggregateCellTrials([
    { mention: 'yes', position: 2, citationCount: 1 },
    { mention: 'no', position: null, citationCount: 0 },
  ]);
  assert.deepEqual({ hits: agg.presence.hits, n: agg.presence.n }, { hits: 1, n: 2 },
    'the fraction the run already stores must be 1 of 2');

  const cell = {
    query: 'Q1', queryText: 'best aeo agencies 2026', provider: 'openai',
    mention: agg.mention, presence: agg.presence,
    trials: [{ mention: 'yes' }, { mention: 'no' }],
  };
  assert.equal(aggregateScore([cell]).score, 50,
    'the score counted the representative label instead of the measured frequency');
});

test('the representative label is still yes — it stopped being the score, it did not disappear', () => {
  // 7+ consumers do results.find(query && provider) and read `mention`; the
  // collapse rule (modal, tie-break yes>src>no) is unchanged on purpose.
  const agg = aggregateCellTrials([{ mention: 'yes' }, { mention: 'no' }]);
  assert.equal(agg.mention, 'yes', 'the cell record must keep its representative mention');
});

console.log('\nFIXTURE 2 — one denominator across the surfaces of one report');

// Three cells, one run:
//   A — sampled twice: one answer, one failed call  → hits 1, valid 1, attempts 2
//   B — single-shot absence                          → hits 0, valid 1, attempts 1
//   C — single-shot failed call                      → hits 0, valid 0, attempts 1
// Honest headline: 1 hit out of 2 valid trials = 50%, from 4 attempts, 2 of
// which measured nothing.
const RUN = [
  {
    query: 'Q1', queryText: 'best aeo agencies 2026', provider: 'openai',
    tag: 'bofu', brandFit: 'core',
    mention: 'yes',
    presence: { hits: 1, n: 1, rate: 1, ci: { low: 0, high: 1, level: 0.95 } },
    trials: [{ mention: 'yes' }, { mention: 'error' }],
  },
  { query: 'Q2', queryText: 'aeo tracking tools', provider: 'openai', tag: 'bofu', brandFit: 'core', mention: 'no' },
  { query: 'Q3', queryText: 'ai visibility checker', provider: 'openai', tag: 'bofu', brandFit: 'core', mention: 'error' },
];

test('valid trials are fewer than attempts, and both are reported', () => {
  const agg = aggregateScore(RUN);
  assert.deepEqual(
    { hits: agg.hits, valid: agg.valid, attempts: agg.attempts, errors: agg.errors, score: agg.score },
    { hits: 1, valid: 2, attempts: 4, errors: 2, score: 50 },
  );
  assert.ok(agg.valid < agg.attempts, 'coverage is invisible when valid and attempts are the same number');
});

test('every surface that publishes a share divides by the SAME 2', () => {
  const expected = 2;

  assert.equal(aggregateScore(RUN).valid, expected, 'headline score');
  assert.equal(sliceStats(RUN).total, expected, 'per-slice helper');

  const lift = buildLiftOpportunity({ results: RUN });
  assert.equal(lift.valid, expected, 'lift aggregate (hero KPI + markdown run verdict)');
  assert.equal(lift.total, 3, 'the attempt count stays available, it is just not the denominator');

  const funnel = sectionFunnelBreakdown([{ results: RUN }]);
  assert.match(funnel, /\| 1\/2 \|/, `funnel/intent table must print 1/${expected}, not 1/3`);

  const fit = segmentByBrandFit(RUN);
  assert.equal(fit.core.total, expected, 'brand-fit segment');
  assert.equal(fit.core.mentions, 1);
});

test('a cell where every trial errored is not a zero — it is excluded', () => {
  const allErrored = aggregateCellTrials([{ mention: 'error' }, { mention: 'error' }]);
  assert.equal(allErrored.mention, 'error');
  assert.deepEqual({ hits: allErrored.presence.hits, n: allErrored.presence.n }, { hits: 0, n: 0 });

  const counts = cellCounts({
    mention: 'error', presence: allErrored.presence,
    trials: [{ mention: 'error' }, { mention: 'error' }],
  });
  assert.deepEqual(counts, { hits: 0, valid: 0, attempts: 2, errors: 2 });

  // …and a run of nothing but such cells scores 0 without dividing by zero.
  assert.equal(aggregateScore([{ mention: 'error' }]).score, 0);
  assert.equal(scorePercent(0, 0), 0);
  assert.equal(aggregateScore([]).score, 0);
});

console.log('\ncellCounts — legacy records degrade exactly, not approximately');

test('a single-shot record reads as one attempt', () => {
  assert.deepEqual(cellCounts({ mention: 'yes' }), { hits: 1, valid: 1, attempts: 1, errors: 0 });
  assert.deepEqual(cellCounts({ mention: 'src' }), { hits: 1, valid: 1, attempts: 1, errors: 0 });
  assert.deepEqual(cellCounts({ mention: 'no' }), { hits: 0, valid: 1, attempts: 1, errors: 0 });
  assert.deepEqual(cellCounts({ mention: 'error' }), { hits: 0, valid: 0, attempts: 1, errors: 1 });
});

test('a cell nobody asked is not a failed call — it contributes nothing', () => {
  // 'missing' is the matrix placeholder for "this engine has no row for this
  // question". Counting it as an error would report calls that were never made
  // as calls that failed; counting it as valid would report an answer nobody
  // asked for. It is neither.
  assert.deepEqual(cellCounts({ mention: 'missing' }), { hits: 0, valid: 0, attempts: 0, errors: 0 });
  const row = [{ mention: 'yes' }, { mention: 'missing' }, { mention: 'error' }];
  assert.deepEqual(
    (({ hits, valid, attempts, errors }) => ({ hits, valid, attempts, errors }))(aggregateScore(row)),
    { hits: 1, valid: 1, attempts: 2, errors: 1 },
    'a matrix row of yes/missing/error is 1 of 1, from 2 calls, 1 of which failed',
  );
});

test('an engine whose every cell errored has no percentage, not a zero', () => {
  // Pins the prevPct / series behaviour change in the engine cards: `valid: 0`
  // is what bin/aeo-tracker.js turns into a null previous-run figure, so the
  // delta is suppressed instead of showing a jump out of a fabricated 0%.
  const allErrored = [{ mention: 'error' }, { mention: 'error' }];
  assert.equal(sliceStats(allErrored).total, 0);
  assert.equal(sliceStats(allErrored).rate, 0, 'the rate degrades to 0 rather than NaN…');
  assert.equal(sliceStats(allErrored).errors, 2, '…and the failures are still counted, just not as absences');
});

test('a malformed presence object degrades to single-shot instead of poisoning the run', () => {
  // never-fail: a corrupt field must not be trusted into the headline.
  assert.deepEqual(cellCounts({ mention: 'yes', presence: { hits: 5, n: 2 } }),
    { hits: 1, valid: 1, attempts: 1, errors: 0 });
  assert.deepEqual(cellCounts({ mention: 'yes', presence: { hits: 'a', n: 2 } }),
    { hits: 1, valid: 1, attempts: 1, errors: 0 });
  assert.deepEqual(cellCounts(null), { hits: 0, valid: 0, attempts: 0, errors: 0 });
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

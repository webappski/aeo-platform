import assert from 'node:assert/strict';
import { buildRunComparison } from '../lib/report/run-comparison.js';
import {
  computeComponents, SENTIMENT_VALUE, isSignalBearingSentiment,
} from '../lib/report/visibility-index.js';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n    ${err.message}`); }
}

const cell = (query, provider, mention, extra = {}) => ({
  query, provider, mention, queryText: `${query} text`, label: provider, ...extra,
});
const toned = (query, provider, label, extra = {}) =>
  cell(query, provider, 'yes', { sentiment: { label, confidence: 'high' }, ...extra });
const run = (date, results) => ({ date, domain: 'example.com', results });

console.log('\nbuildRunComparison — pair selection');

test('returns null with fewer than two runs', () => {
  assert.equal(buildRunComparison([]), null);
  assert.equal(buildRunComparison([run('2026-01-01', [])]), null);
});

test('compares the LAST TWO entries of the given array, not a fixed index', () => {
  // Simulates --for-date truncation: the caller slices `snapshots` before
  // this is called, so a stale first/second run in the full array must never
  // leak into the comparison once the array has been cut down.
  const full = [
    run('2026-01-01', [cell('Q1', 'openai', 'no')]),
    run('2026-02-01', [cell('Q1', 'openai', 'yes')]),
    run('2026-03-01', [cell('Q1', 'openai', 'no')]),
  ];
  const truncated = full.slice(0, 2); // pretend --for-date targeted the Feb run
  const model = buildRunComparison(truncated);
  assert.equal(model.prevDate, '2026-01-01');
  assert.equal(model.currDate, '2026-02-01');
});

console.log('\nbuildRunComparison — counts mirror segment lengths');

test('counts is a faithful mirror of segments.*.length, never a reduced number', () => {
  const prev = run('2026-01-01', [
    cell('Q1', 'openai', 'yes'), cell('Q2', 'openai', 'yes'), cell('Q3', 'openai', 'no'),
  ]);
  const latest = run('2026-02-01', [
    cell('Q1', 'openai', 'no'), cell('Q2', 'openai', 'yes'), cell('Q3', 'openai', 'yes'),
  ]);
  const model = buildRunComparison([prev, latest]);
  assert.equal(model.counts.lost, model.segments.lost.length);
  assert.equal(model.counts.held, model.segments.held.length);
  assert.equal(model.counts.gained, model.segments.gained.length);
  assert.equal(model.counts.never, model.segments.never.length);
  assert.equal(model.counts.lost, 1);
  assert.equal(model.counts.gained, 1);
});

console.log('\nbuildRunComparison — component classification');

test('presence and citation are direct; sentiment and rank are conditional', () => {
  const prev = run('2026-01-01', [toned('Q1', 'openai', 'positive', { position: 2 })]);
  const latest = run('2026-02-01', [toned('Q1', 'openai', 'positive', { position: 2 })]);
  const model = buildRunComparison([prev, latest]);
  const kindOf = (key) => model.components.find((c) => c.key === key).kind;
  assert.equal(kindOf('presence'), 'direct');
  assert.equal(kindOf('citation'), 'direct');
  assert.equal(kindOf('sentiment'), 'conditional');
  assert.equal(kindOf('rank'), 'conditional');
});

console.log('\nbuildRunComparison — sentiment tie-break gate');

test('a low-confidence neutral tie-break cell is excluded from like-for-like, not averaged as 50', () => {
  // Same cell held in both runs, genuinely positive both times, but the
  // extractor recorded a SECOND cell as a low-confidence neutral tie-break
  // (model disagreement, not a real "neutral" reading). If the orchestrator's
  // sentiment extractor did not replicate computeComponents' signal-bearing
  // gate, this tie-break cell would be averaged in as 50 and manufacture a
  // like-for-like decline that was never really there.
  const prev = run('2026-01-01', [
    toned('Q1', 'openai', 'positive'),
    cell('Q2', 'openai', 'yes', { sentiment: { label: 'neutral', confidence: 'low' } }),
  ]);
  const latest = run('2026-02-01', [
    toned('Q1', 'openai', 'positive'),
    cell('Q2', 'openai', 'yes', { sentiment: { label: 'neutral', confidence: 'low' } }),
  ]);
  const model = buildRunComparison([prev, latest]);
  const sentiment = model.components.find((c) => c.key === 'sentiment');
  assert.equal(sentiment.decomposition.likeForLike.cellCount, 1,
    'the tie-break cell must not count toward like-for-like eligibility');
  assert.equal(sentiment.decomposition.likeForLike.delta, 0);
});

console.log('\nbuildRunComparison — weight-basis caveat');

test('flags weight-basis change when an axis goes from unmeasured to measured', () => {
  const prev = run('2026-01-01', [cell('Q1', 'openai', 'yes')]); // no position anywhere -> rank null
  const latest = run('2026-02-01', [cell('Q1', 'openai', 'yes', { position: 3 })]);
  const model = buildRunComparison([prev, latest]);
  assert.equal(model.weightBasis.changed, true);
  assert.ok(model.weightBasis.axes.includes('rank'));
});

test('nulls out every contributionDelta when the weight basis changed, not just the shifted axis', () => {
  const prev = run('2026-01-01', [cell('Q1', 'openai', 'yes')]);
  const latest = run('2026-02-01', [cell('Q1', 'openai', 'yes', { position: 3 })]);
  const model = buildRunComparison([prev, latest]);
  for (const comp of model.components) {
    assert.equal(comp.contributionDelta, null, `${comp.key} contributionDelta must be null across a basis shift`);
  }
});

test('reports contributionDelta normally when the weight basis is unchanged', () => {
  // All four axes measured, identically, in both runs (position + a citation
  // present both times) so weightSum stays 1.0 and appliedWeight === default
  // weight — the delta below isn't diluted by re-normalisation.
  const extra = { position: 1, canonicalCitations: ['https://example.com/page'] };
  const prev = run('2026-01-01', [toned('Q1', 'openai', 'positive', extra)]);
  const latest = run('2026-02-01', [toned('Q1', 'openai', 'neutral', extra)]);
  const model = buildRunComparison([prev, latest]);
  assert.equal(model.weightBasis.changed, false);
  const sentiment = model.components.find((c) => c.key === 'sentiment');
  assert.equal(sentiment.contributionDelta, -12.5, 'delta of (50-100) * weight .25');
});

console.log('\nbuildRunComparison — noise annotation (--samples N)');

test('a statistically noisy sampled flip is annotated isNoise but still counted as lost', () => {
  const sampled = (n, hits) => ({ n, hits, rate: hits / n, ci: { low: 0, high: 1, level: 0.95 } });
  const prev = run('2026-01-01', [
    cell('Q1', 'openai', 'yes', { presence: sampled(5, 3) }), // 3/5 -> majority yes
  ]);
  const latest = run('2026-02-01', [
    cell('Q1', 'openai', 'no', { presence: sampled(5, 2) }), // 2/5 -> majority no, but overlapping CI
  ]);
  const model = buildRunComparison([prev, latest]);
  assert.equal(model.segments.lost.length, 1, 'the mention flip still puts the cell in "lost"');
  assert.equal(model.segments.lost[0].isNoise, true);
  assert.equal(model.counts.lost, 1, 'counts must mirror segments, not hide the noisy cell');
  assert.equal(model.counts.noiseSuppressed, 1, 'but the noise flag is surfaced for the renderer');
});

test('a single-shot (unsampled) flip is never flagged as noise', () => {
  const prev = run('2026-01-01', [cell('Q1', 'openai', 'yes')]);
  const latest = run('2026-02-01', [cell('Q1', 'openai', 'no')]);
  const model = buildRunComparison([prev, latest]);
  assert.equal(model.segments.lost[0].isNoise, false);
  assert.equal(model.counts.noiseSuppressed, 0);
});

console.log('\nbuildRunComparison — competitor substitution');

test('lost cells carry newEntrants / droppedOut, and replacements rolls them up', () => {
  const prev = run('2026-01-01', [
    cell('Q1', 'openai', 'yes', { competitors: ['Acme'] }),
    cell('Q2', 'gemini', 'yes', { competitors: ['Acme'] }),
  ]);
  const latest = run('2026-02-01', [
    cell('Q1', 'openai', 'no', { competitors: ['Acme', 'Zenith'] }),
    cell('Q2', 'gemini', 'no', { competitors: ['Zenith'] }),
  ]);
  const model = buildRunComparison([prev, latest]);
  assert.equal(model.segments.lost.length, 2);
  const q1 = model.segments.lost.find((e) => e.query === 'Q1');
  assert.deepEqual(q1.competitorShift.newEntrants, ['Zenith']);
  assert.deepEqual(q1.competitorShift.droppedOut, []);
  const q2 = model.segments.lost.find((e) => e.query === 'Q2');
  assert.deepEqual(q2.competitorShift.newEntrants, ['Zenith']);
  assert.deepEqual(q2.competitorShift.droppedOut, ['Acme']);
  assert.deepEqual(model.replacements, [{ name: 'Zenith', count: 2 }]);
});

console.log('\nregression: real Gcore run pair (2026-06-17 -> 2026-08-24)');

test('reproduces the fixed reference values end to end', () => {
  // Minimal reconstruction of the real basket's outcome, not the full 18-cell
  // fixture (house convention: inline, only fields under test). Five cells
  // held/lost from June, one newly gained neutral mention in August.
  const prev = run('2026-06-17', [
    toned('Q1', 'openai', 'positive', { position: 2 }),
    toned('Q1', 'gemini', 'positive'),
    toned('Q4', 'gemini', 'positive'),
    toned('Q5', 'openai', 'positive'),
    toned('Q6', 'openai', 'positive', { position: 10 }),
    cell('Q5', 'anthropic', 'no'),
  ]);
  const latest = run('2026-08-24', [
    cell('Q1', 'openai', 'no'), cell('Q1', 'gemini', 'no'),
    cell('Q4', 'gemini', 'no'), cell('Q6', 'openai', 'no'),
    toned('Q5', 'openai', 'positive', { position: 11 }),
    toned('Q5', 'anthropic', 'neutral', { position: 10 }),
  ]);
  const model = buildRunComparison([prev, latest]);

  assert.equal(model.counts.lost, 4);
  assert.equal(model.counts.held, 1);
  assert.equal(model.counts.gained, 1); // this mini-basket has one gained cell (Q5::anthropic)

  const sentiment = model.components.find((c) => c.key === 'sentiment');
  assert.equal(sentiment.decomposition.likeForLike.delta, 0,
    'no surviving answer changed tone — the whole movement is compositional');
  assert.equal(sentiment.decomposition.isPurelyCompositional, true);

  assert.equal(model.driverSummary.allMovementIsCompositional, true);
  assert.equal(model.driverSummary.hasGenuineConditionalChange, false);
});

// ─── The sentiment axis is valued in ONE place ──────────────────────────────
// This module decomposes an axis that `visibility-index.js` owns and reports.
// It used to keep its own copy of the label->score table and its own copy of
// the confidence gate, with a comment admitting the duplication. Two copies of
// a valuation rule do not fail loudly when they drift: the decomposition simply
// starts averaging a cell the index excluded, `likeForLike.delta` moves off
// zero, and the report states a tone finding that did not happen.
//
// These tests assert the two agree BEHAVIOURALLY, so re-introducing a private
// copy that differs is what goes red — importing the same symbol is not by
// itself the thing under test.
console.log('\nsentiment axis — index and comparison value a cell identically');

test('every label in the exported table is the value the index itself computes', () => {
  for (const [label, expected] of Object.entries(SENTIMENT_VALUE)) {
    const snap = run('2026-01-01', [
      toned('Q1', 'openai', label),
      toned('Q2', 'gemini', label),
    ]);
    assert.equal(computeComponents(snap).sentiment, expected,
      `the index scores "${label}" as something other than the table's ${expected}`);
  }
});

test('the gate excludes exactly the rows the index refuses to average', () => {
  const cases = [
    [{ label: 'positive', confidence: 'high' }, true],
    [{ label: 'neutral', confidence: 'high' }, true],
    [{ label: 'neutral', confidence: 'low' }, false],   // model-disagreement tie-break
    [{ label: 'positive', confidence: 'low' }, true],
    [{ label: 'positive', confidence: 'failed' }, false],
    [{ label: 'positive', confidence: 'empty' }, false],
    [null, false],
  ];
  for (const [sentiment, signalBearing] of cases) {
    assert.equal(isSignalBearingSentiment(sentiment), signalBearing,
      `gate disagrees on ${JSON.stringify(sentiment)}`);
    const snap = run('2026-01-01', [cell('Q1', 'openai', 'yes', { sentiment })]);
    assert.equal(computeComponents(snap).sentimentSample, signalBearing ? 1 : 0,
      `the index's own sample size disagrees with the gate on ${JSON.stringify(sentiment)}`);
  }
});

test('a tie-break cell is excluded from the decomposition, not averaged in as a real 50', () => {
  // Regression the duplicated gate existed to prevent: if the decomposition
  // values the low-confidence neutral at 50 while the index excludes it, the
  // like-for-like delta moves off zero and invents a tone change.
  const tie = { label: 'neutral', confidence: 'low' };
  const prev = run('2026-01-01', [
    toned('Q1', 'openai', 'positive'),
    cell('Q2', 'gemini', 'yes', { sentiment: tie }),
  ]);
  const latest = run('2026-02-01', [
    toned('Q1', 'openai', 'positive'),
    cell('Q2', 'gemini', 'yes', { sentiment: tie }),
  ]);
  const model = buildRunComparison([prev, latest]);
  const sentiment = model.components.find((c) => c.key === 'sentiment');
  assert.equal(sentiment.prevValue, 100, 'the index reported only the high-signal cell');
  assert.equal(sentiment.currValue, 100);
  assert.equal(sentiment.decomposition.likeForLike.delta, 0,
    'nothing changed tone; a non-zero delta here is the tie-break leaking in at 50');
});

test('a real tone change is decomposed with the SAME table the index reports with', () => {
  // The teeth of the shared-table claim: the like-for-like delta is arithmetic
  // on the label values, so a private copy of the table in run-comparison.js
  // that differs by even one point makes this assertion fail.
  const prev = run('2026-01-01', [toned('Q1', 'openai', 'positive')]);
  const latest = run('2026-02-01', [toned('Q1', 'openai', 'negative')]);
  const sentiment = buildRunComparison([prev, latest]).components.find((c) => c.key === 'sentiment');
  assert.equal(
    sentiment.decomposition.likeForLike.delta,
    SENTIMENT_VALUE.negative - SENTIMENT_VALUE.positive,
    'the decomposition values a label differently from the table the index reports with',
  );
  assert.equal(sentiment.prevValue, SENTIMENT_VALUE.positive);
  assert.equal(sentiment.currValue, SENTIMENT_VALUE.negative);
});

test('an unknown label is valued as null by the comparison, never as the index fallback', () => {
  // The two modules answer different questions and keep different fallbacks on
  // purpose: the index averages over a population it already filtered (?? 50),
  // this module averages only cells it can value (?? null). A shared table must
  // not quietly unify them.
  const odd = { label: 'mixed', confidence: 'high' };
  const prev = run('2026-01-01', [
    toned('Q1', 'openai', 'positive'),
    cell('Q2', 'gemini', 'yes', { sentiment: odd }),
  ]);
  const latest = run('2026-02-01', [
    toned('Q1', 'openai', 'positive'),
    cell('Q2', 'gemini', 'yes', { sentiment: odd }),
  ]);
  const sentiment = buildRunComparison([prev, latest]).components.find((c) => c.key === 'sentiment');
  assert.equal(sentiment.decomposition.likeForLike.delta, 0,
    'an unvaluable label must drop out of like-for-like, not enter it as a number');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

// trend-model — significance floor, noise test, degradation ladder, coverage gate.
//
// Every case below is a decision the loud report makes about whether it is
// ALLOWED to say something. The regressions guarded here are the ones that
// make a report lie quietly: a delta printed as a trend on two runs, a metric
// whose population halved reported as movement, or a real drop suppressed by
// a noise test that could never be beaten.

import assert from 'node:assert/strict';
import {
  FLOOR, NOISE_TEST_MIN_RUNS, MIN_COVERAGE_RATIO,
  significanceFloor, clearsFloor, medianStep, beatsNoise, isMover,
  chipTone, formatDelta, trendCapabilities, coverageAllowsDelta,
  isPartialRun, expectedCellCount, buildMetric, whereToAct, round1,
} from '../lib/report/trend-model.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n    ${err.message}`); }
}

console.log('\ntrend-model — significance');

test('floors are keyed by unit', () => {
  assert.equal(significanceFloor('points'), 3.0);
  assert.equal(significanceFloor('count'), 1);
  assert.equal(significanceFloor('rank'), 0.5);
  assert.equal(significanceFloor('unknown-unit'), FLOOR.points, 'unknown units fall back to the points floor');
});

test('a sub-floor delta does not clear', () => {
  assert.equal(clearsFloor(2.9, 'points'), false);
  assert.equal(clearsFloor(3.0, 'points'), true, 'the floor is inclusive');
  assert.equal(clearsFloor(-3.1, 'points'), true);
  assert.equal(clearsFloor(null, 'points'), false);
});

test('medianStep breaks the chain at an unmeasured run rather than inventing a step', () => {
  assert.equal(medianStep([10, 12, 14]), 2);
  // 10 -> (unmeasured) -> 14 is a change over TWO runs. Counting it as one
  // step of 4 would overstate the metric's typical wobble and make real
  // movement look normal; the gap is skipped instead.
  assert.equal(medianStep([10, null, 14]), null, 'a lone gap leaves no measurable step');
  assert.equal(medianStep([10, 12, null, 14, 16]), 2, 'steps either side of a gap still count');
  assert.equal(medianStep([5]), null);
  assert.equal(medianStep([]), null);
});

test('the noise test is offline below the run threshold', () => {
  assert.equal(beatsNoise(1, [10, 11, 12, 13]), true, `offline below ${NOISE_TEST_MIN_RUNS} runs`);
});

test('the noise test counts MEASURED points, not array slots', () => {
  // A check added recently: eight runs on record, two of them measured. There
  // is exactly one step, and it IS the delta being judged — it can never beat
  // its own median. Counting slots would silently veto every such finding.
  const history = [null, null, null, null, null, null, 18, 9];
  assert.equal(beatsNoise(-9, history), true, 'two measured points must not switch the test on');
});

test('a real drop inside the metric\'s usual wobble is not a mover', () => {
  const history = [33, 42, 42, 58, 100, 83, 100, 92]; // median step 16
  assert.equal(medianStep(history), 16);
  assert.equal(clearsFloor(-8, 'points'), true, 'it still clears the floor and gets a chip');
  assert.equal(isMover(-8, 'points', history), false, 'but it is not named as the thing to act on');
});

test('counts are exempt from the noise test', () => {
  // Answers naming the brand: median step exactly 1, so a "must beat the
  // median" rule would make losing an answer permanently unreportable.
  const history = [4, 5, 5, 7, 9, 10, 12, 11];
  assert.equal(medianStep(history), 1);
  assert.equal(isMover(-1, 'count', history), true, 'losing an answer must stay reportable');
  assert.equal(isMover(0, 'count', history), false, 'no movement is not a mover');
});

console.log('\ntrend-model — tone');

test('tone respects direction and metrics where lower is better', () => {
  assert.equal(chipTone(5, 'points', true), 'good');
  assert.equal(chipTone(-5, 'points', true), 'bad');
  assert.equal(chipTone(-1, 'rank', false), 'good', 'moving to a better rank is good');
  assert.equal(chipTone(0, 'points'), 'flat');
  assert.equal(chipTone(1.5, 'points'), 'quiet', 'sub-floor movement is shown, uncoloured');
  assert.equal(chipTone(null, 'points'), 'quiet');
});

test('formatDelta carries an arrow, a magnitude and a unit', () => {
  assert.equal(formatDelta(-8, 'points'), '▼ 8 points');
  assert.equal(formatDelta(3, 'tools'), '▲ 3 tools');
  assert.equal(formatDelta(0, ''), '– 0');
  assert.equal(formatDelta(null), '—');
});

console.log('\ntrend-model — degradation ladder');

test('run 1 draws nothing that implies a change', () => {
  const c = trendCapabilities(1);
  assert.equal(c.chips, false);
  assert.equal(c.shapes, false);
  assert.equal(c.whereToAct, false);
  assert.equal(c.trendLanguage, false);
});

test('run 2 gets chips only — no shape, no baseline caption', () => {
  const c = trendCapabilities(2);
  assert.equal(c.chips, true);
  assert.equal(c.shapes, false, 'two points are a delta, not a trend');
  assert.equal(c.baselineCaption, false, 'the baseline caption would restate the same delta');
  assert.equal(c.trendLanguage, false);
});

test('runs 3-4 switch everything on at full size', () => {
  const c = trendCapabilities(3);
  assert.equal(c.shapes, true);
  assert.equal(c.baselineCaption, true);
  assert.equal(c.trendLanguage, true);
  assert.equal(c.noiseTest, false, 'the noise test is not online yet');
  assert.equal(c.dotSize, 13);
});

test('runs 5-9 bring the noise test online', () => {
  assert.equal(trendCapabilities(5).noiseTest, true);
  assert.equal(trendCapabilities(9).dotSize, 13);
});

test('runs 10-16 compress the marks and thin the labels', () => {
  const c = trendCapabilities(12);
  assert.equal(c.dotSize, 9);
  assert.equal(c.labelEvery, 2);
  assert.equal(c.dotWindow, null, 'still one row, nothing hidden');
});

test('17+ windows the marks behind a +N prefix', () => {
  const c = trendCapabilities(20);
  assert.equal(c.dotWindow, 16);
  assert.equal(c.dotSize, 9);
});

console.log('\ntrend-model — coverage gate');

test('a metric reported on too few answers prints coverage, not a delta', () => {
  const r = coverageAllowsDelta({ n: 4, denominator: 12 }, { n: 12, denominator: 12 });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'below-floor');
});

test('a metric whose population halved is blocked even above the floor', () => {
  // 12/12 -> 8/12 is 100% -> 67%: both clear MIN_COVERAGE_RATIO, but the
  // population moved enough to explain the average on its own.
  assert.ok(8 / 12 > MIN_COVERAGE_RATIO);
  const r = coverageAllowsDelta({ n: 8, denominator: 12 }, { n: 12, denominator: 12 });
  assert.equal(r.allowed, false);
  assert.equal(r.reason, 'coverage-shift');
});

test('stable, well-covered metrics are allowed a delta', () => {
  const r = coverageAllowsDelta({ n: 12, denominator: 12 }, { n: 11, denominator: 12 });
  assert.equal(r.allowed, true);
  assert.equal(r.reason, null);
});

test('a missing coverage record blocks the delta rather than assuming full coverage', () => {
  assert.equal(coverageAllowsDelta(null, { n: 12, denominator: 12 }).allowed, false);
  assert.equal(coverageAllowsDelta({ n: 3 }, { n: 3 }).allowed, false, 'no denominator, no ratio');
});

console.log('\ntrend-model — partial runs');

test('a run that measured fewer answers than the basket is partial', () => {
  const snaps = [{ results: new Array(12) }, { results: new Array(9) }, { results: new Array(12) }];
  assert.equal(expectedCellCount(snaps), 12);
  assert.equal(isPartialRun(snaps[1], 12), true);
  assert.equal(isPartialRun(snaps[0], 12), false);
  assert.equal(isPartialRun({ results: [] }, 12), false, 'an empty run is not "partial", it is absent');
});

console.log('\ntrend-model — metric assembly');

test('prev is the last run that REPORTED a value, not simply the previous slot', () => {
  const m = buildMetric({ id: 'x', label: 'X', unit: 'points', history: [50, 60, null, 70] });
  assert.equal(m.current, 70);
  assert.equal(m.prev, 60, 'skipping the unmeasured run, not comparing against nothing');
  assert.equal(m.deltaPrev, 10);
  assert.equal(m.first, 50);
  assert.equal(m.deltaFirst, 20);
});

test('a singular unit label is used at magnitude 1', () => {
  const m = buildMetric({
    id: 'a', label: 'Answers', unit: 'count',
    history: [12, 11], unitLabel: 'answers', unitLabelOne: 'answer',
  });
  assert.equal(m.chipText, '▼ 1 answer');
  const m2 = buildMetric({
    id: 'a', label: 'Answers', unit: 'count',
    history: [12, 9], unitLabel: 'answers', unitLabelOne: 'answer',
  });
  assert.equal(m2.chipText, '▼ 3 answers');
});

test('a first run carries no delta at all', () => {
  const m = buildMetric({ id: 'x', label: 'X', unit: 'points', history: [42] });
  assert.equal(m.deltaPrev, null);
  assert.equal(m.isSignificant, false);
  assert.equal(m.isMover, false);
});

console.log('\ntrend-model — where to act');

test('the no-mover sentence is explicit, never an empty string', () => {
  const flat = buildMetric({ id: 'x', label: 'X', unit: 'points', history: [50, 50, 50] });
  const r = whereToAct([flat], '2026-07-11');
  assert.equal(r.metric, null);
  assert.ok(r.text.length > 0);
  assert.match(r.text, /No metric moved far enough/, 'silence must be stated, not implied');
  assert.match(r.text, /2026-07-11/, 'the comparison date is named');
});

test('movers are ranked in multiples of their own floor, not raw magnitude', () => {
  // 13 hosts is 13 floors; 9 percentage points is 3 floors. Raw magnitude
  // would let the metric with the largest natural scale always win.
  const hosts = buildMetric({ id: 'h', label: 'Hosts cited', unit: 'count', history: [88, 75], unitLabel: 'hosts' });
  const capsules = buildMetric({ id: 'c', label: 'Capsule coverage', unit: 'points', history: [18, 9], unitLabel: 'pp' });
  assert.equal(whereToAct([capsules, hosts], '2026-07-11').metric.id, 'h');
  // 9pp = 3 floors ties 3 tools = 3 floors. The tie must resolve the same way
  // regardless of the order the caller listed them in.
  const small = buildMetric({ id: 's', label: 'Rivals', unit: 'count', history: [4, 7], unitLabel: 'tools' });
  assert.equal(whereToAct([small, capsules], '2026-07-11').metric.id, 'c');
  assert.equal(whereToAct([capsules, small], '2026-07-11').metric.id, 'c', 'tie-break is order-independent');
});

test('round1 removes float dust', () => {
  assert.equal(round1(8.299999999), 8.3);
  assert.equal(round1(-2.94999), -2.9);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

import assert from 'node:assert/strict';
import { segmentCells } from '../lib/report/comparison-segments.js';
import {
  decomposeConditional, summarizeDrivers, KIND_DIRECT, KIND_CONDITIONAL,
} from '../lib/report/comparison-drivers.js';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n    ${err.message}`); }
}

const TONE = { positive: 100, neutral: 50, negative: 0 };
const toneOf = (row) => {
  const label = row?.sentiment?.label;
  return label in TONE ? TONE[label] : null;
};
const rankOf = (row) => (typeof row?.position === 'number' ? row.position : null);

const cell = (query, provider, mention, extra = {}) => ({
  query, provider, mention, queryText: `${query} text`, label: provider, ...extra,
});
const toned = (query, provider, label, extra = {}) =>
  cell(query, provider, 'yes', { sentiment: { label, confidence: 'high' }, ...extra });

console.log('\ndecomposeConditional');

test('separates a genuine tone change from a compositional one', () => {
  // The one cell present in both runs actually got worse: positive -> neutral.
  const prev = { results: [toned('Q1', 'openai', 'positive')] };
  const latest = { results: [toned('Q1', 'openai', 'neutral')] };
  const out = decomposeConditional({
    segments: segmentCells(latest, prev),
    valueOf: toneOf, prevValue: 100, currValue: 50,
  });
  assert.equal(out.likeForLike.cellCount, 1);
  assert.equal(out.likeForLike.delta, -50, 'a real decline must show up like-for-like');
  assert.equal(out.isPurelyCompositional, false);
});

test('flags a drop as purely compositional when surviving cells are unchanged', () => {
  const prev = { results: [
    toned('Q1', 'openai', 'positive'), toned('Q2', 'openai', 'positive'),
  ] };
  const latest = { results: [
    toned('Q1', 'openai', 'positive'), cell('Q2', 'openai', 'no'),
  ] };
  const out = decomposeConditional({
    segments: segmentCells(latest, prev),
    valueOf: toneOf, prevValue: 100, currValue: 100,
  });
  assert.equal(out.likeForLike.delta, 0);
  assert.equal(out.isPurelyCompositional, true);
});

test('reports likeForLike as null when nothing qualified in both runs', () => {
  // Rank: neither run ranked the same cell, so no comparison is possible.
  const prev = { results: [toned('Q1', 'openai', 'positive', { position: 2 })] };
  const latest = { results: [
    cell('Q1', 'openai', 'no'),
    toned('Q2', 'openai', 'positive', { position: 11 }),
  ] };
  const out = decomposeConditional({
    segments: segmentCells(latest, prev),
    valueOf: rankOf, prevValue: 43, currValue: 23,
  });
  assert.equal(out.likeForLike, null, 'no cell was ranked in both runs');
  assert.equal(out.compositionalDelta, -20, 'whole movement is compositional');
  assert.equal(out.isPurelyCompositional, true);
});

test('gainDrag names a newly gained cell that pulled the average down', () => {
  const prev = { results: [
    toned('Q1', 'openai', 'positive'), cell('Q5', 'anthropic', 'no'),
  ] };
  const latest = { results: [
    toned('Q1', 'openai', 'positive'), toned('Q5', 'anthropic', 'neutral'),
  ] };
  const out = decomposeConditional({
    segments: segmentCells(latest, prev),
    valueOf: toneOf, prevValue: 100, currValue: 75,
  });
  assert.equal(out.gainDrag.length, 1);
  assert.equal(out.gainDrag[0].label, 'anthropic');
  assert.equal(out.gainDrag[0].value, 50);
});

test('a gained cell at or above the previous average is not flagged as drag', () => {
  const prev = { results: [toned('Q1', 'openai', 'neutral')] };
  const latest = { results: [
    toned('Q1', 'openai', 'neutral'), toned('Q5', 'gemini', 'positive'),
  ] };
  const out = decomposeConditional({
    segments: segmentCells(latest, prev),
    valueOf: toneOf, prevValue: 50, currValue: 75,
  });
  assert.deepEqual(out.gainDrag, []);
});

test('lowerIsBetter flags a gained cell that arrived at a WORSE position', () => {
  // Rank cells: #3 held, and a new mention arrives at #14 - worse than the
  // previous average of #3, so it drags the average even though 14 > 3.
  const prev = { results: [
    toned('Q1', 'openai', 'positive', { position: 3 }),
    cell('Q5', 'gemini', 'no'),
  ] };
  const latest = { results: [
    toned('Q1', 'openai', 'positive', { position: 3 }),
    toned('Q5', 'gemini', 'positive', { position: 14 }),
  ] };
  const out = decomposeConditional({
    segments: segmentCells(latest, prev),
    valueOf: rankOf, prevValue: 70, currValue: 45, lowerIsBetter: true,
  });
  assert.equal(out.gainDrag.length, 1);
  assert.equal(out.gainDrag[0].value, 14);
});

test('lowerIsBetter does not flag a gained cell that ranked BETTER', () => {
  const prev = { results: [
    toned('Q1', 'openai', 'positive', { position: 9 }),
    cell('Q5', 'gemini', 'no'),
  ] };
  const latest = { results: [
    toned('Q1', 'openai', 'positive', { position: 9 }),
    toned('Q5', 'gemini', 'positive', { position: 2 }),
  ] };
  const out = decomposeConditional({
    segments: segmentCells(latest, prev),
    valueOf: rankOf, prevValue: 40, currValue: 60, lowerIsBetter: true,
  });
  assert.deepEqual(out.gainDrag, []);
});

test('gain drag baseline is per-cell units, not the reported component value', () => {
  // Rank component reads as a 0-100 strength (70) while cells carry positions
  // (#3). Comparing a position against the strength would flag every gain.
  const prev = { results: [
    toned('Q1', 'openai', 'positive', { position: 3 }),
    cell('Q5', 'gemini', 'no'),
  ] };
  const latest = { results: [
    toned('Q1', 'openai', 'positive', { position: 3 }),
    toned('Q5', 'gemini', 'positive', { position: 2 }),
  ] };
  const out = decomposeConditional({
    segments: segmentCells(latest, prev),
    valueOf: rankOf, prevValue: 70, currValue: 78, lowerIsBetter: true,
  });
  assert.deepEqual(out.gainDrag, [], '#2 beats the #3 baseline, so it is not drag');
});

test('tolerates missing component values without throwing', () => {
  const empty = { results: [] };
  const out = decomposeConditional({
    segments: segmentCells(empty, empty),
    valueOf: toneOf, prevValue: null, currValue: null,
  });
  assert.equal(out.totalDelta, null);
  assert.equal(out.likeForLike, null);
  assert.deepEqual(out.gainDrag, []);
});

console.log('\nsummarizeDrivers');

test('marks movement compositional when no conditional component really moved', () => {
  const out = summarizeDrivers([
    { key: 'presence', kind: KIND_DIRECT, contributionDelta: -3.85 },
    { key: 'citation', kind: KIND_DIRECT, contributionDelta: -1.2 },
    {
      key: 'sentiment', kind: KIND_CONDITIONAL, contributionDelta: -4.25,
      decomposition: { likeForLike: { delta: 0 }, gainDrag: [{ key: 'Q5::anthropic' }] },
    },
    {
      key: 'rank', kind: KIND_CONDITIONAL, contributionDelta: -4,
      decomposition: { likeForLike: null, gainDrag: [] },
    },
  ]);
  assert.equal(out.hasGenuineConditionalChange, false);
  assert.equal(out.allMovementIsCompositional, true);
  assert.deepEqual(out.gainPenalisedComponents, ['sentiment']);
  assert.equal(out.primary.length, 2);
  assert.equal(out.derived.length, 2);
});

test('does not claim compositional when a conditional component truly moved', () => {
  const out = summarizeDrivers([
    { key: 'presence', kind: KIND_DIRECT, contributionDelta: -1 },
    {
      key: 'sentiment', kind: KIND_CONDITIONAL, contributionDelta: -5,
      decomposition: { likeForLike: { delta: -20 }, gainDrag: [] },
    },
  ]);
  assert.equal(out.hasGenuineConditionalChange, true);
  assert.equal(out.allMovementIsCompositional, false);
});

test('handles an empty component list', () => {
  const out = summarizeDrivers([]);
  assert.equal(out.allMovementIsCompositional, false);
  assert.deepEqual(out.primary, []);
});

console.log('\nregression: the real run pair that motivated this module');

test('a gained factual mention is never reported as a tone decline', () => {
  // June: five mentions, all positive. August: two survive positive, and a
  // third engine starts mentioning the brand neutrally for the first time.
  const prev = { results: [
    toned('Q1', 'openai', 'positive', { position: 2 }),
    toned('Q1', 'gemini', 'positive'),
    toned('Q4', 'gemini', 'positive'),
    toned('Q5', 'openai', 'positive'),
    toned('Q6', 'openai', 'positive', { position: 10 }),
    cell('Q5', 'anthropic', 'no'),
  ] };
  const latest = { results: [
    cell('Q1', 'openai', 'no'), cell('Q1', 'gemini', 'no'),
    cell('Q4', 'gemini', 'no'), cell('Q6', 'openai', 'no'),
    toned('Q5', 'openai', 'positive', { position: 11 }),
    toned('Q5', 'anthropic', 'neutral', { position: 10 }),
  ] };
  const segments = segmentCells(latest, prev);
  assert.equal(segments.lost.length, 4);
  assert.equal(segments.held.length, 1);
  assert.equal(segments.gained.length, 1);

  const tone = decomposeConditional({
    segments, valueOf: toneOf, prevValue: 100, currValue: 83,
  });
  assert.equal(tone.likeForLike.delta, 0, 'no surviving answer changed tone');
  assert.equal(tone.isPurelyCompositional, true);
  assert.equal(tone.gainDrag.length, 1, 'the new neutral mention is the whole story');
  assert.equal(tone.gainDrag[0].label, 'anthropic');

  const rank = decomposeConditional({
    segments, valueOf: rankOf, prevValue: 43, currValue: 23,
  });
  assert.equal(rank.likeForLike, null, 'no cell carried a rank in both runs');
  assert.equal(rank.isPurelyCompositional, true);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

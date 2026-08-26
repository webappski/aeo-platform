import assert from 'node:assert/strict';
import {
  segmentCells, findBlankQueries, isPresent, isIndeterminate, cellKey,
  SEG_LOST, SEG_HELD, SEG_GAINED, SEG_NEVER, SEG_INDETERMINATE,
} from '../lib/report/comparison-segments.js';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n    ${err.message}`); }
}

const cell = (query, provider, mention, extra = {}) => ({
  query, provider, mention, queryText: `${query} text`, label: provider, ...extra,
});

console.log('\nisPresent / isIndeterminate');

test('"yes" and "src" both count as present', () => {
  assert.equal(isPresent({ mention: 'yes' }), true);
  assert.equal(isPresent({ mention: 'src' }), true);
  assert.equal(isPresent({ mention: 'no' }), false);
  assert.equal(isPresent(null), false);
});

test('error and missing rows are indeterminate, not absent', () => {
  assert.equal(isIndeterminate({ mention: 'error' }), true);
  assert.equal(isIndeterminate({ mention: 'missing' }), true);
  assert.equal(isIndeterminate(null), true);
  assert.equal(isIndeterminate({ mention: 'no' }), false);
});

test('cellKey ignores model so a provider version swap is not a lost cell', () => {
  assert.equal(
    cellKey({ query: 'Q1', provider: 'gemini', model: 'gemini-3.5' }),
    cellKey({ query: 'Q1', provider: 'gemini', model: 'gemini-3.7' }),
  );
});

console.log('\nsegmentCells');

test('splits cells into lost / held / gained / never', () => {
  const prev = { results: [
    cell('Q1', 'openai', 'yes'), cell('Q2', 'openai', 'yes'),
    cell('Q3', 'openai', 'no'), cell('Q4', 'openai', 'no'),
  ] };
  const latest = { results: [
    cell('Q1', 'openai', 'no'), cell('Q2', 'openai', 'yes'),
    cell('Q3', 'openai', 'yes'), cell('Q4', 'openai', 'no'),
  ] };
  const seg = segmentCells(latest, prev);
  assert.equal(seg[SEG_LOST].length, 1);
  assert.equal(seg[SEG_LOST][0].query, 'Q1');
  assert.equal(seg[SEG_HELD].length, 1);
  assert.equal(seg[SEG_HELD][0].query, 'Q2');
  assert.equal(seg[SEG_GAINED].length, 1);
  assert.equal(seg[SEG_GAINED][0].query, 'Q3');
  assert.equal(seg[SEG_NEVER].length, 1);
  assert.equal(seg[SEG_NEVER][0].query, 'Q4');
});

test('an errored cell is indeterminate, never reported as a loss', () => {
  const prev = { results: [cell('Q1', 'gemini', 'yes')] };
  const latest = { results: [cell('Q1', 'gemini', 'error')] };
  const seg = segmentCells(latest, prev);
  assert.equal(seg[SEG_LOST].length, 0, 'an API error must not read as a loss');
  assert.equal(seg[SEG_INDETERMINATE].length, 1);
});

test('carries both raw rows so the renderer can show before/after detail', () => {
  const prev = { results: [cell('Q1', 'openai', 'yes', { position: 2 })] };
  const latest = { results: [cell('Q1', 'openai', 'no')] };
  const entry = segmentCells(latest, prev)[SEG_LOST][0];
  assert.equal(entry.before.position, 2);
  assert.equal(entry.after.mention, 'no');
  assert.equal(entry.queryText, 'Q1 text');
});

test('handles an empty previous run without throwing', () => {
  const seg = segmentCells({ results: [cell('Q1', 'openai', 'yes')] }, { results: [] });
  assert.equal(seg[SEG_INDETERMINATE].length, 1);
  assert.equal(seg[SEG_GAINED].length, 0);
});

console.log('\nfindBlankQueries');

test('finds queries with zero mentions across both runs', () => {
  const prev = { results: [
    cell('Q1', 'openai', 'yes'), cell('Q1', 'gemini', 'no'),
    cell('Q2', 'openai', 'no'), cell('Q2', 'gemini', 'no'),
  ] };
  const latest = { results: [
    cell('Q1', 'openai', 'no'), cell('Q1', 'gemini', 'no'),
    cell('Q2', 'openai', 'no', { competitors: ['CoreWeave', 'Together AI'] }),
    cell('Q2', 'gemini', 'no', { competitors: ['CoreWeave'] }),
  ] };
  const blanks = findBlankQueries(latest, prev);
  assert.equal(blanks.length, 1, 'Q1 had a mention last run so it is not blank');
  assert.equal(blanks[0].query, 'Q2');
  assert.equal(blanks[0].cellsPerRun, 2);
  assert.deepEqual(blanks[0].occupiedBy, ['CoreWeave', 'Together AI']);
});

test('only dual-model verified competitors are listed as occupants', () => {
  const rows = (mention) => [cell('Q9', 'openai', mention, {
    competitors: ['Verified Co'], competitorsUnverified: ['Unconfirmed Co'],
  })];
  const blanks = findBlankQueries({ results: rows('no') }, { results: rows('no') });
  assert.deepEqual(blanks[0].occupiedBy, ['Verified Co']);
});

test('returns empty list when every query had a mention', () => {
  const rows = { results: [cell('Q1', 'openai', 'yes')] };
  assert.deepEqual(findBlankQueries(rows, rows), []);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);

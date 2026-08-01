// Guard: the live `run` loop and `run-manual` must aggregate competitor names the
// same way.
//
// Root cause this prevents: the two sinks used to compute this inline and
// separately. `run-manual` implemented only the verified half and never produced
// `unverifiedOnly` at all, so merging a manual provider column into a day left
// that tier describing whatever the live run had computed earlier — the same
// drift class as the `responseExcerpt` gap that `prose-rank.js`'s shared field
// builder exists to prevent.
//
// Unit rather than E2E (R37 exception): aggregateCompetitorCounts is a pure
// function over result rows. The E2E (test/e2e/run-manual.test.js) covers the
// wiring; this covers the arithmetic, which an offline E2E fixture cannot exercise
// (its extractor returns empty lists under a fake key).

import assert from 'node:assert/strict';
import { aggregateCompetitorCounts } from '../lib/report/competitor-counts.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n    ${err.message}`); }
}

console.log('\ncompetitor counts (shared run / run-manual aggregator)');

const ROWS = [
  { competitors: ['Profound', 'Conductor'], competitorsUnverified: ['Peec AI'] },
  { competitors: ['Profound'],              competitorsUnverified: ['Peec AI', 'Ghost'] },
  { competitors: ['Conductor'],             competitorsUnverified: ['Profound'] },
];

test('verified names are counted across cells and ranked', () => {
  const { topCompetitors } = aggregateCompetitorCounts(ROWS);
  assert.deepEqual(topCompetitors, [
    { name: 'Profound',  count: 2 },
    { name: 'Conductor', count: 2 },
  ]);
});

test('a name verified in ANY cell is excluded from the unverified tier', () => {
  const { unverifiedOnly } = aggregateCompetitorCounts(ROWS);
  // Profound appears unverified in row 3 but verified in rows 1-2 → not "unverified only".
  assert.deepEqual(unverifiedOnly, [
    { name: 'Peec AI', count: 2 },
    { name: 'Ghost',   count: 1 },
  ]);
});

test('the verified list is capped, the unverified tier is not', () => {
  const many = Array.from({ length: 12 }, (_, i) => ({ competitors: [`Brand${i}`] }));
  assert.equal(aggregateCompetitorCounts(many).topCompetitors.length, 8);
  assert.equal(aggregateCompetitorCounts(many, { limit: 3 }).topCompetitors.length, 3);
});

test('rows with missing lists, and no rows at all, are handled', () => {
  assert.deepEqual(aggregateCompetitorCounts([{}, { competitors: undefined }]).topCompetitors, []);
  assert.deepEqual(aggregateCompetitorCounts(undefined).unverifiedOnly, []);
});

test('classifiedCompetitors keeps the entry-pair shape the run loop prints', () => {
  const { classifiedCompetitors } = aggregateCompetitorCounts(ROWS);
  assert.deepEqual(classifiedCompetitors[0], ['Profound', 2]);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

// `basket.kind` must be a SCHEMA VALUE, not the author's prose.
//
// The field is hand-written in .aeo-tracker.json and in practice gets used as a
// human note. Passing that through made an otherwise valid payload unloadable
// downstream — one free-text field rejecting a whole 10-run record.
import assert from 'node:assert/strict';
import { buildMcMetadata } from '../lib/report/mc-metadata.js';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n    ${err.message}`); }
}

const summary = {
  date: '2026-08-27', brand: 'Acme', domain: 'acme.com', score: 10, mentions: 1, total: 2,
  results: [
    { query: 'Q1', provider: 'openai', mention: 'yes', canonicalCitations: [], competitors: [] },
    { query: 'Q2', provider: 'openai', mention: 'no', canonicalCitations: [], competitors: [] },
  ],
  topCompetitors: [], topCanonicalSources: [], topDomains: [],
};
const build = (config) => buildMcMetadata(summary, [summary], { trackerVersion: '1.8.0', config }).basket;

console.log('\nbasket.kind coercion');

test('a schema value is passed through untouched, with no note', () => {
  const b = build({ basketHistory: [{ version: 1, since: '2026-01-01', kind: 'initial', queries: ['Q1'] }] });
  assert.equal(b.kind, 'initial');
  assert.equal(b.kindNote, null);
});

test('free text never reaches `kind` — it moves to `kindNote`', () => {
  const prose = 'locale-expansion: all 17 themes × RU/PL/DE';
  const b = build({
    basketHistory: [
      { version: 1, since: '2026-01-01', kind: 'pre-locale (unversioned)', queries: ['Q1'] },
      { version: 2, since: '2026-07-31', kind: prose, queries: ['Q1', 'Q2'] },
    ],
  });
  assert.ok(['initial', 'additive', 'replace'].includes(b.kind), `kind must be a schema value, got "${b.kind}"`);
  assert.equal(b.kindNote, prose, 'the author note must survive, just not in `kind`');
});

test('a basket that kept every earlier query reads as additive', () => {
  const b = build({
    basketHistory: [
      { version: 1, since: '2026-01-01', kind: 'note', queries: ['Q1', 'Q2'] },
      { version: 2, since: '2026-07-31', kind: 'note', queries: ['Q1', 'Q2', 'Q3'] },
    ],
  });
  assert.equal(b.kind, 'additive');
});

test('a basket that dropped an earlier query reads as replace', () => {
  const b = build({
    basketHistory: [
      { version: 1, since: '2026-01-01', kind: 'note', queries: ['Q1', 'Q2'] },
      { version: 2, since: '2026-07-31', kind: 'note', queries: ['Q2', 'Q3'] },
    ],
  });
  assert.equal(b.kind, 'replace');
});

test('a single free-text entry is the initial basket', () => {
  const b = build({ basketHistory: [{ version: 1, since: '2026-01-01', kind: 'first cut, mixed locales' }] });
  assert.equal(b.kind, 'initial');
  assert.equal(b.kindNote, 'first cut, mixed locales');
});

test('with no query lists to compare, a later basket is additive — not a drop claim', () => {
  const b = build({
    basketHistory: [
      { version: 1, since: '2026-01-01', kind: 'note' },
      { version: 2, since: '2026-07-31', kind: 'note' },
    ],
  });
  assert.equal(b.kind, 'additive');
});

test('no config at all still emits a schema value', () => {
  const b = build(null);
  assert.equal(b.kind, 'initial');
  assert.equal(b.kindNote, null);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);

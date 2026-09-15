// MEAS-1 — stable question identity, declared market, manifest drift.
//
// The id is the hinge of the whole comparison story: if it is not stable across
// machines and runs, MEAS-3 silently degrades back to positional matching. If
// it is stable but the market is GUESSED, the report gains a confident field
// nobody declared. Both are pinned here.
//
// R37: pure functions, exact expected values (same standard as lib/sampling.js).

import assert from 'node:assert/strict';
import {
  queryIdFor, normalizeQueryText, normalizeMarket, buildManifest, manifestIndex,
  resolveQueryIdentity, verifyManifest, isLabelIdentity, MANIFEST_SCHEMA,
} from '../lib/basket-manifest.js';

let passed = 0;
let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n    ${err.message}`); }
}

console.log('\nqueryIdFor — same question, same id, everywhere, forever');

test('the id is a pinned constant, not just self-consistent', () => {
  // Pinned so a future change to the normalisation or the hash is caught here
  // rather than as a mysteriously empty intersection in a diff months later.
  assert.equal(queryIdFor('best Answer Engine Optimization agencies 2026'), 'q_9235493a5855');
  assert.equal(queryIdFor('  Best   Answer Engine Optimization AGENCIES 2026 '),
    queryIdFor('best Answer Engine Optimization agencies 2026'),
    'case and whitespace are not part of a question\'s identity');
});

test('punctuation and wording ARE part of identity', () => {
  assert.notEqual(queryIdFor('best aeo agencies 2026'), queryIdFor('best aeo agencies 2026?'));
  assert.notEqual(queryIdFor('best aeo agencies 2026'), queryIdFor('best aeo agencies 2027'));
});

test('unicode composition is normalised (NFKC) — one Polish question, one id', () => {
  const precomposed = 'najlepsze agencje optymalizacji';        // ó as one code point
  const decomposed = 'najlepsze agencje optymalizacji'.normalize('NFD');
  assert.equal(queryIdFor(precomposed), queryIdFor(decomposed));
});

test('a blank question has no identity rather than a shared one', () => {
  assert.equal(queryIdFor(''), null);
  assert.equal(queryIdFor('   '), null);
  assert.equal(queryIdFor(undefined), null);
  assert.equal(normalizeQueryText(null), '');
});

console.log('\nbuildManifest — copies declared markets, never invents one');

test('a market is only ever what the config declared', () => {
  const m = buildManifest([
    { q: 'agencja aeo w Polsce', market: 'pl' },
    'beste KI-Sichtbarkeit Agentur',                  // German text, NO declaration
    { q: 'free ai visibility checker' },
  ]);
  assert.equal(m.schema, MANIFEST_SCHEMA);
  assert.equal(m.queries.length, 3);
  assert.equal(m.queries[0].market, 'PL', 'declared markets are upper-cased, not re-interpreted');
  assert.equal(m.queries[1].market, null, 'a German-looking question with no declaration stays unknown');
  assert.equal(m.queries[2].market, null);
  assert.equal(normalizeMarket('  de '), 'DE');
  assert.equal(normalizeMarket(''), null);
  assert.equal(normalizeMarket(42), null);
});

test('a bulk market map is honoured, and duplicates collapse to one entry', () => {
  const m = buildManifest(
    ['a question', 'a question', 'another question'],
    { markets: { 'a question': 'EN', 'another question': 'DE' }, version: 4, runRoot: '/tmp/x', marketProvenance: 'declared in basketHistory v4' },
  );
  assert.equal(m.queries.length, 2, 'the same text twice is one question');
  assert.equal(m.queries[0].market, 'EN');
  assert.equal(m.version, 4);
  assert.equal(m.runRoot, '/tmp/x');
  assert.equal(m.marketProvenance, 'declared in basketHistory v4');
});

console.log('\nresolveQueryIdentity — strongest available identity, and it says which');

const MANIFEST = buildManifest([
  { q: 'agencja aeo w Polsce', market: 'PL' },
  { q: 'free ai visibility checker', market: 'EN' },
]);
const IDX = manifestIndex(MANIFEST);

test('a stamped queryId wins', () => {
  const id = queryIdFor('agencja aeo w Polsce');
  const r = resolveQueryIdentity({ query: 'Q7', queryId: id, queryText: 'agencja aeo w Polsce' }, IDX);
  assert.deepEqual({ id: r.id, source: r.source, market: r.market }, { id, source: 'record', market: 'PL' });
});

test('an unstamped record is identified by its text, and picks up the declared market', () => {
  const r = resolveQueryIdentity({ query: 'Q7', queryText: 'agencja aeo w Polsce' }, IDX);
  assert.equal(r.source, 'text');
  assert.equal(r.id, queryIdFor('agencja aeo w Polsce'));
  assert.equal(r.market, 'PL');
});

test('a record with only an ordinal label falls back to the label, flagged as weak', () => {
  const r = resolveQueryIdentity({ query: 'Q7' }, IDX);
  assert.equal(r.source, 'label');
  assert.ok(isLabelIdentity(r.id), 'positional identity must be recognisable as positional');
  assert.equal(r.market, null);
});

test('a market on the record beats the manifest (the run is the record of what was asked)', () => {
  const r = resolveQueryIdentity({ queryText: 'agencja aeo w Polsce', market: 'DE' }, IDX);
  assert.equal(r.market, 'DE');
});

test('no manifest at all still yields a text identity', () => {
  const r = resolveQueryIdentity({ query: 'Q1', queryText: 'free ai visibility checker' });
  assert.equal(r.id, queryIdFor('free ai visibility checker'));
  assert.equal(r.market, null);
});

console.log('\nverifyManifest — a stale manifest is caught, not silently trusted');

test('reports questions missing from the manifest and entries no longer asked', () => {
  const basket = [{ q: 'agencja aeo w Polsce' }, 'a brand new question'];
  const v = verifyManifest(MANIFEST, basket);
  assert.equal(v.ok, false);
  assert.deepEqual(v.missing, ['a brand new question']);
  assert.deepEqual(v.extra, ['free ai visibility checker']);
});

test('a manifest that matches its basket is ok', () => {
  const basket = [{ q: 'agencja aeo w Polsce' }, { q: 'free ai visibility checker' }];
  assert.deepEqual(verifyManifest(MANIFEST, basket), { ok: true, missing: [], extra: [] });
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

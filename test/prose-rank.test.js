// prose-rank.js — pure parser + two-model merge (AP-PROSE-RANK). The LLM call
// itself (providerCall round-trip) is integration and is NOT exercised here —
// only the deterministic JSON parsing and merge logic, which is where the real
// "don't fabricate a rank / don't over-state confidence" decisions live.

import assert from 'node:assert/strict';
import {
  buildProseRankPrompt, parseProseRankResponse, mergeProseRanks,
} from '../lib/report/prose-rank.js';

let passed = 0; let failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n    ${err.message}`); }
}

console.log('\nbuildProseRankPrompt');

test('interpolates brand + domain and includes the response text', () => {
  const p = buildProseRankPrompt({ text: 'X is best, then Y.', brand: 'Webappski', domain: 'webappski.com' });
  assert.ok(p.includes('Webappski'));
  assert.ok(p.includes('webappski.com'));
  assert.ok(p.includes('X is best, then Y.'));
  assert.ok(/STRICT JSON/.test(p));
});

console.log('\nparseProseRankResponse');

test('parses a clean ranked verdict', () => {
  const r = parseProseRankResponse('{"rank": 2, "comparableCount": 4, "rationale": "named second after Profound"}');
  assert.equal(r.rank, 2);
  assert.equal(r.comparableCount, 4);
  assert.ok(r.rationale.length > 0);
});

test('strips ```json fences', () => {
  const r = parseProseRankResponse('```json\n{"rank": 1, "comparableCount": 3, "rationale": "leading option"}\n```');
  assert.equal(r.rank, 1);
});

test('extracts the {...} block from surrounding prose', () => {
  const r = parseProseRankResponse('Here is the result: {"rank": 3, "comparableCount": 5, "rationale": "third"} done');
  assert.equal(r.rank, 3);
});

test('rank null is a VALID "no prose order" verdict, not an error', () => {
  const r = parseProseRankResponse('{"rank": null, "comparableCount": 1, "rationale": "named alone"}');
  assert.equal(r.rank, null);
  assert.equal(r.comparableCount, 1);
});

test('rank with <2 comparable options is dropped to null (nothing to rank against)', () => {
  const r = parseProseRankResponse('{"rank": 1, "comparableCount": 1, "rationale": "only option"}');
  assert.equal(r.rank, null);
});

test('rank 0 / negative / non-numeric → null (never fabricate a position)', () => {
  assert.equal(parseProseRankResponse('{"rank": 0, "comparableCount": 3}').rank, null);
  assert.equal(parseProseRankResponse('{"rank": -2, "comparableCount": 3}').rank, null);
  assert.equal(parseProseRankResponse('{"rank": "first", "comparableCount": 3}').rank, null);
});

test('non-integer rank floors to integer', () => {
  assert.equal(parseProseRankResponse('{"rank": 2.9, "comparableCount": 4}').rank, 2);
});

test('empty / non-string input throws (model failure)', () => {
  assert.throws(() => parseProseRankResponse(''));
  assert.throws(() => parseProseRankResponse(null));
});

test('non-JSON without a {...} block throws', () => {
  assert.throws(() => parseProseRankResponse('the brand is ranked second'));
});

console.log('\nmergeProseRanks');

const ok = (rank, rationale = 'r') => ({ ok: true, rank, rationale });
const fail = (error = 'boom') => ({ ok: false, rank: null, rationale: null, error });

test('both agree on a rank → that rank, confidence med (never high)', () => {
  const m = mergeProseRanks(ok(2), ok(2));
  assert.equal(m.rank, 2);
  assert.equal(m.confidence, 'med');
});

test('both ranked but DIFFER → lower (stronger) rank, confidence low', () => {
  const m = mergeProseRanks(ok(2), ok(4));
  assert.equal(m.rank, 2);
  assert.equal(m.confidence, 'low');
  assert.ok(/disagreed/i.test(m.rationale));
});

test('both agree NO rank (null) → null, confidence none', () => {
  const m = mergeProseRanks(ok(null), ok(null));
  assert.equal(m.rank, null);
  assert.equal(m.confidence, 'none');
});

test('one ranked, one null → the rank, confidence low (weak)', () => {
  const m = mergeProseRanks(ok(3), ok(null));
  assert.equal(m.rank, 3);
  assert.equal(m.confidence, 'low');
});

test('one model failed, other ranked → single-model', () => {
  const m = mergeProseRanks(ok(2), fail());
  assert.equal(m.rank, 2);
  assert.equal(m.confidence, 'single-model');
});

test('one model failed, other null → none (no usable rank)', () => {
  const m = mergeProseRanks(ok(null), fail());
  assert.equal(m.rank, null);
  assert.equal(m.confidence, 'none');
});

test('both failed → null verdict', () => {
  assert.equal(mergeProseRanks(fail(), fail()), null);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

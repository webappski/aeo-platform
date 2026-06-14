// AP-RATELIMIT-UX: learned-limit persistence (export / import) for the TPM
// ledger. Non-lying tests — exercise the real ledger module, no mocks.

import assert from 'node:assert/strict';
import {
  learnTpmLimit,
  exportLearnedLimits,
  importLearnedLimits,
  getLearnedOrTierLimit,
  _resetForTests,
} from '../lib/providers/tpm-ledger.js';

let passed = 0, failed = 0;
function test(name, fn) {
  _resetForTests();
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n    ${err.message}`); }
}

console.log('\ntpm-ledger learned-limit persistence');

test('export captures learned limits with their source', () => {
  learnTpmLimit('openai:gpt-5-search-api', 30000, 'observed');
  learnTpmLimit('anthropic:claude-sonnet-4-6', 40000, 'header');
  const out = exportLearnedLimits();
  assert.deepEqual(out['openai:gpt-5-search-api'], { limit: 30000, source: 'observed' });
  assert.deepEqual(out['anthropic:claude-sonnet-4-6'], { limit: 40000, source: 'header' });
});

test('export omits cdKeys that never learned a limit', () => {
  // reserve-only activity, no learnTpmLimit → nothing to persist
  const out = exportLearnedLimits();
  assert.deepEqual(out, {});
});

test('import seeds limits queryable via getLearnedOrTierLimit', () => {
  const n = importLearnedLimits({ 'openai:gpt-5-search-api': { limit: 25000, source: 'persisted' } });
  assert.equal(n, 1);
  assert.equal(getLearnedOrTierLimit('openai', 'gpt-5-search-api'), 25000);
});

test('export → import roundtrip preserves the learned ceiling', () => {
  learnTpmLimit('gemini:gemini-2.5-flash', 12000, 'observed');
  const snapshot = exportLearnedLimits();
  _resetForTests();
  importLearnedLimits(snapshot);
  assert.equal(getLearnedOrTierLimit('gemini', 'gemini-2.5-flash'), 12000);
});

test('import is shrink-only — a looser persisted value never widens a tighter in-memory one', () => {
  learnTpmLimit('openai:gpt-5-search-api', 10000, 'observed'); // tight, learned now
  importLearnedLimits({ 'openai:gpt-5-search-api': { limit: 99999 } }); // looser, from disk
  assert.equal(getLearnedOrTierLimit('openai', 'gpt-5-search-api'), 10000);
});

test('import of a tighter persisted value DOES apply', () => {
  learnTpmLimit('openai:gpt-5-search-api', 50000, 'observed');
  importLearnedLimits({ 'openai:gpt-5-search-api': { limit: 8000 } });
  assert.equal(getLearnedOrTierLimit('openai', 'gpt-5-search-api'), 8000);
});

test('import tolerates malformed input without throwing', () => {
  assert.equal(importLearnedLimits(null), 0);
  assert.equal(importLearnedLimits(undefined), 0);
  assert.equal(importLearnedLimits('not an object'), 0);
  assert.equal(importLearnedLimits({ 'k': null }), 0);
  assert.equal(importLearnedLimits({ 'k': { limit: 'NaN' } }), 0);
  assert.equal(importLearnedLimits({ 'k': { limit: -5 } }), 0);
  assert.equal(importLearnedLimits({ 'k': { limit: 0 } }), 0);
});

// Mutation-sanity: if importLearnedLimits silently ignored the value (regression
// to a no-op), this assertion would fail.
test('mutation-sanity: a seeded limit is actually readable, not silently dropped', () => {
  importLearnedLimits({ 'perplexity:sonar': { limit: 7777 } });
  assert.equal(getLearnedOrTierLimit('perplexity', 'sonar'), 7777);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

// Unit tests for lib/providers/pick-classify.js — the single-model classify
// provider selector (Gemini first, then Claude, then OpenAI residual — see
// CLASSIFY_PROVIDER_PRIORITY in lib/config.js, decision Alex 2026-07-08).
// Pure function, no I/O.

import assert from 'node:assert/strict';
import { pickClassifyProvider } from '../lib/providers/pick-classify.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n    ${err.message}`); }
}

console.log('\npickClassifyProvider');

test('gemini available among several → gemini wins (default priority)', () => {
  const openai = { name: 'openai' };
  const gemini = { name: 'gemini' };
  const anthropic = { name: 'anthropic' };
  assert.equal(pickClassifyProvider([openai, gemini, anthropic]), gemini);
});

test('gemini absent, anthropic present → anthropic wins (2nd priority)', () => {
  const openai = { name: 'openai' };
  const anthropic = { name: 'anthropic' };
  assert.equal(pickClassifyProvider([openai, anthropic]), anthropic);
});

test('gemini and anthropic both absent → next by priority (openai, residual)', () => {
  const openai = { name: 'openai' };
  const perplexity = { name: 'perplexity' };
  assert.equal(pickClassifyProvider([perplexity, openai]), openai);
});

test('empty list → null, no throw', () => {
  assert.equal(pickClassifyProvider([]), null);
});

test('null/undefined entries in the array are tolerated (filtered out)', () => {
  const gemini = { name: 'gemini' };
  assert.equal(pickClassifyProvider([null, undefined, gemini]), gemini);
});

test('order of the input array does not matter — priority order wins', () => {
  const openai = { name: 'openai' };
  const gemini = { name: 'gemini' };
  assert.equal(pickClassifyProvider([openai, gemini]), gemini);
  assert.equal(pickClassifyProvider([gemini, openai]), gemini);
});

test('custom priority order is honoured (openai-first override)', () => {
  const openai = { name: 'openai' };
  const gemini = { name: 'gemini' };
  assert.equal(pickClassifyProvider([gemini, openai], ['openai', 'gemini']), openai);
});

test('provider not present in priority list at all is never picked', () => {
  const mystery = { name: 'mystery-provider' };
  assert.equal(pickClassifyProvider([mystery], ['gemini', 'openai']), null);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

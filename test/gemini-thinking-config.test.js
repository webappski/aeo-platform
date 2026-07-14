// Guards the tier→thinking mapping for Gemini (lib/providers/gemini.js).
//
// Why it matters: cost hinges on this. gemini-3.x is forced to thinkingLevel
// 'high' (output tokens ~5-10x), while gemini-2.5 non-lite gets a dynamic
// thinkingBudget (-1, auto-scaled). The classify tier is deliberately pinned to
// gemini-2.5-flash so it lands on the cheap dynamic path — this test locks that
// mapping so a future refactor can't silently push classify back onto forced-high.

import assert from 'node:assert/strict';
import { geminiThinkingConfig, isGeminiThinkingBudgetModel } from '../lib/providers/gemini.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n    ${err.message}`); }
}

console.log('\ngeminiThinkingConfig — tier→thinking mapping');

test('gemini-2.5-flash (classify tier) → dynamic thinkingBudget:-1', () => {
  assert.deepStrictEqual(geminiThinkingConfig('gemini-2.5-flash'), { thinkingBudget: -1 });
});

test('gemini-3.5-flash (main tier) → forced thinkingLevel:high', () => {
  assert.deepStrictEqual(geminiThinkingConfig('gemini-3.5-flash'), { thinkingLevel: 'high' });
});

test('any gemini-3.x → thinkingLevel:high (even a hypothetical 3.x flash)', () => {
  assert.deepStrictEqual(geminiThinkingConfig('gemini-3.1-flash'), { thinkingLevel: 'high' });
});

test('gemini-2.5-flash-lite → no thinking field (null)', () => {
  assert.deepStrictEqual(geminiThinkingConfig('gemini-2.5-flash-lite'), null);
});

test('gemini-2.0-flash → no thinking field (null)', () => {
  assert.deepStrictEqual(geminiThinkingConfig('gemini-2.0-flash'), null);
});

test('served id with suffix still maps by prefix (gemini-2.5-flash-002)', () => {
  assert.deepStrictEqual(geminiThinkingConfig('gemini-2.5-flash-002'), { thinkingBudget: -1 });
});

test('non-gemini model → null', () => {
  assert.deepStrictEqual(geminiThinkingConfig('gpt-5'), null);
});

// isGeminiThinkingBudgetModel is the shared predicate main-options.js reuses —
// re-assert the load-bearing cases so the two can't drift.
test('isGeminiThinkingBudgetModel: 2.5-flash true, lite false, 2.0 false', () => {
  assert.equal(isGeminiThinkingBudgetModel('gemini-2.5-flash'), true);
  assert.equal(isGeminiThinkingBudgetModel('gemini-2.5-flash-lite'), false);
  assert.equal(isGeminiThinkingBudgetModel('gemini-2.0-flash'), false);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

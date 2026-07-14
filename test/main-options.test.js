// Drift catcher for lib/providers/main-options.js.
//
// MAIN_OPTIONS_BY_PROVIDER is consumed silently by mainCall in cmdRun. If
// someone edits the map and drops reasoning_effort / thinking — there's no
// runtime error, just silent quality regression (user pays for main-tier model
// without the reasoning bonus). These deepStrictEqual assertions are the only
// thing standing between "thinking always on" and "thinking accidentally off".

import assert from 'node:assert/strict';
import { MAIN_OPTIONS_BY_PROVIDER, CLASSIFY_OPTIONS_BY_PROVIDER, detectThinkingActive } from '../lib/providers/main-options.js';
import { PROVIDERS } from '../lib/providers/index.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n    ${err.message}`); }
}

console.log('\nMAIN_OPTIONS_BY_PROVIDER per-provider invariants');

test('openai: {} — omit reasoning_effort → model-default adaptive effort (no forced high; decision Alex 2026-07-14)', () => {
  assert.deepStrictEqual(MAIN_OPTIONS_BY_PROVIDER.openai, {});
});

test('anthropic: extended thinking enabled, budget=16k', () => {
  assert.deepStrictEqual(MAIN_OPTIONS_BY_PROVIDER.anthropic, {
    thinking: { type: 'enabled', budget_tokens: 16000 },
  });
});

test('gemini: empty object (thinking injected by gemini.js purely from the model id — thinkingLevel for 3.x, thinkingBudget for 2.x-non-lite — identically for main AND classify calls)', () => {
  assert.deepStrictEqual(MAIN_OPTIONS_BY_PROVIDER.gemini, {});
});

test('perplexity: empty object (reasoning built-in for sonar-reasoning*)', () => {
  assert.deepStrictEqual(MAIN_OPTIONS_BY_PROVIDER.perplexity, {});
});

console.log('\nMAIN_OPTIONS_BY_PROVIDER coverage invariants');

test('every PROVIDERS key has a MAIN_OPTIONS entry (no missing providers)', () => {
  const expected = Object.keys(PROVIDERS).sort();
  const actual = Object.keys(MAIN_OPTIONS_BY_PROVIDER).sort();
  assert.deepStrictEqual(actual, expected,
    `MAIN_OPTIONS_BY_PROVIDER coverage drift: PROVIDERS=${expected.join(',')} vs MAIN_OPTIONS=${actual.join(',')}`);
});

test('no extra providers in MAIN_OPTIONS beyond known PROVIDERS', () => {
  for (const key of Object.keys(MAIN_OPTIONS_BY_PROVIDER)) {
    assert.ok(key in PROVIDERS, `unknown provider "${key}" in MAIN_OPTIONS — typo?`);
  }
});

console.log('\nCLASSIFY_OPTIONS_BY_PROVIDER per-provider invariants (2026-07-08: classify now gets a lighter thinking pass too)');

test('openai: reasoning_effort=low (lighter than main\'s high)', () => {
  assert.deepStrictEqual(CLASSIFY_OPTIONS_BY_PROVIDER.openai, { reasoning_effort: 'low' });
});

test('anthropic: extended thinking enabled, budget=4096 (lighter than main\'s 16000)', () => {
  assert.deepStrictEqual(CLASSIFY_OPTIONS_BY_PROVIDER.anthropic, {
    thinking: { type: 'enabled', budget_tokens: 4096 },
  });
});

test('gemini: empty object (thinking already unconditional/model-driven — nothing tier-specific to inject)', () => {
  assert.deepStrictEqual(CLASSIFY_OPTIONS_BY_PROVIDER.gemini, {});
});

test('perplexity: empty object (reasoning is a model-choice — sonar-reasoning — not a request field)', () => {
  assert.deepStrictEqual(CLASSIFY_OPTIONS_BY_PROVIDER.perplexity, {});
});

console.log('\nCLASSIFY_OPTIONS_BY_PROVIDER coverage invariants');

test('every PROVIDERS key has a CLASSIFY_OPTIONS entry (no missing providers)', () => {
  const expected = Object.keys(PROVIDERS).sort();
  const actual = Object.keys(CLASSIFY_OPTIONS_BY_PROVIDER).sort();
  assert.deepStrictEqual(actual, expected,
    `CLASSIFY_OPTIONS_BY_PROVIDER coverage drift: PROVIDERS=${expected.join(',')} vs CLASSIFY_OPTIONS=${actual.join(',')}`);
});

test('no extra providers in CLASSIFY_OPTIONS beyond known PROVIDERS', () => {
  for (const key of Object.keys(CLASSIFY_OPTIONS_BY_PROVIDER)) {
    assert.ok(key in PROVIDERS, `unknown provider "${key}" in CLASSIFY_OPTIONS — typo?`);
  }
});

console.log('\ndetectThinkingActive — gemini generation gate (2.x-non-lite AND 3.x, not just 3.x)');

test('gemini-3.x → thinking active', () => {
  assert.equal(detectThinkingActive('gemini', 'gemini-3.5-flash'), true);
});

test('gemini-2.5-flash → thinking active (thinkingBudget=-1, previously silently NOT counted)', () => {
  assert.equal(detectThinkingActive('gemini', 'gemini-2.5-flash'), true);
});

test('gemini-2.5-flash-lite → thinking NOT active (Google defaults it off; we don\'t override)', () => {
  assert.equal(detectThinkingActive('gemini', 'gemini-2.5-flash-lite'), false);
});

test('gemini-2.0-flash → thinking NOT active (pre-thinking generation)', () => {
  assert.equal(detectThinkingActive('gemini', 'gemini-2.0-flash'), false);
});

test('perplexity sonar-reasoning → thinking active', () => {
  assert.equal(detectThinkingActive('perplexity', 'sonar-reasoning'), true);
});

test('perplexity plain sonar → thinking NOT active', () => {
  assert.equal(detectThinkingActive('perplexity', 'sonar'), false);
});

test('openai → thinking NOT active (main omits reasoning_effort; model uses its adaptive default, not forced high)', () => {
  assert.equal(detectThinkingActive('openai', 'gpt-5-mini'), false);
  assert.equal(detectThinkingActive('openai', 'gpt-5.4-mini'), false);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

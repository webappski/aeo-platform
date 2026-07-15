// fail-branch #6: an unknown model must NOT silently render as $0 («free»).
// The contract the run summary relies on: calcCost returns null for a model
// absent from the pricing table (so the caller flags costTracked:false rather
// than implying free). Real module, no mocks.

import assert from 'node:assert/strict';
import { calcCost, estimateWeeklyCost, extractUsage } from '../lib/providers/pricing.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n    ${err.message}`); }
}

console.log('\ncost honesty for untracked models (fail-branch #6)');

test('calcCost returns null for a model not in the pricing table', () => {
  const r = calcCost('totally-made-up-model-9000', { inputTokens: 1000, outputTokens: 1000 });
  assert.equal(r, null);
});

test('calcCost returns a real number for a known model (regression guard)', () => {
  // gpt-5 prefix is in the table; exact id may carry a suffix.
  const r = calcCost('gpt-5', { inputTokens: 1_000_000, outputTokens: 0 });
  assert.ok(r && typeof r.costUsd === 'number' && r.costUsd > 0,
    'a known model must produce a positive cost, not null');
});

test('estimateWeeklyCost flags unknown model with ~$?? rather than $0', () => {
  assert.equal(estimateWeeklyCost('totally-made-up-model-9000'), '~$??/run');
});

test('Gemini output usage includes candidate + thought tokens and bills both on 3.5 Flash', () => {
  const usage = extractUsage('gemini', {
    usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 30 },
  });
  assert.deepStrictEqual(usage, { inputTokens: 100, outputTokens: 50 });
  const priced = calcCost('gemini-3.5-flash', usage);
  assert.equal(priced.costUsd, 0.0006, '100×$1.50/M input + 50×$9/M output');
});

test('Gemini missing candidate/thought counters safely contribute zero', () => {
  assert.deepStrictEqual(
    extractUsage('gemini', { usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 4 } }),
    { inputTokens: 7, outputTokens: 4 },
  );
  assert.deepStrictEqual(
    extractUsage('gemini', { usageMetadata: { promptTokenCount: 7, thoughtsTokenCount: 6 } }),
    { inputTokens: 7, outputTokens: 6 },
  );
  assert.deepStrictEqual(extractUsage('gemini', {}), { inputTokens: 0, outputTokens: 0 });
});

// Mutation-sanity: if calcCost regressed to returning {costUsd:0} for unknowns,
// the first assertion (=== null) would fail — i.e. the honesty contract is
// load-bearing, not cosmetic.

console.log('\nweb_search tool fee (calcCost opts.webSearchCalls)');

test('general model + 1 web_search call → adds one flat $0.01 tool fee', () => {
  const base     = calcCost('gpt-5-mini', { inputTokens: 1_000_000, outputTokens: 0 });                            // 0.25
  const searched = calcCost('gpt-5-mini', { inputTokens: 1_000_000, outputTokens: 0 }, { webSearchCalls: 1 });     // 0.26
  assert.equal(base.costUsd, 0.25);
  assert.equal(searched.costUsd, 0.26);
});

test('general model + N web_search calls → fee scales with the real count', () => {
  const two = calcCost('gpt-5-mini', { inputTokens: 1_000_000, outputTokens: 0 }, { webSearchCalls: 2 });  // 0.25 + 0.02
  assert.equal(two.costUsd, 0.27);
});

test('general model with 0 / no calls → NO tool fee (training/classify calls)', () => {
  const noopt = calcCost('gpt-5-mini', { inputTokens: 1_000_000, outputTokens: 0 });
  const zero  = calcCost('gpt-5-mini', { inputTokens: 1_000_000, outputTokens: 0 }, { webSearchCalls: 0 });
  assert.equal(noopt.costUsd, 0.25);
  assert.equal(zero.costUsd, 0.25);
});

test('search-SKU model → row perRequest only, NOT double-charged by the tool-call count', () => {
  // gpt-5-search-api row already carries perRequest:0.01 → 1.25 token + 0.01 = 1.26,
  // regardless of any webSearchCalls passed.
  const searched = calcCost('gpt-5-search-api', { inputTokens: 1_000_000, outputTokens: 0 }, { webSearchCalls: 3 });
  const noopt    = calcCost('gpt-5-search-api', { inputTokens: 1_000_000, outputTokens: 0 });
  assert.equal(searched.costUsd, 1.26);
  assert.equal(noopt.costUsd, 1.26);  // identical — the count must not add a second fee
});

test('estimateWeeklyCost includes the tool fee for a general OpenAI main (3 web cells × $0.01)', () => {
  // gpt-5-mini token-only ≈ $0.009/run; + 3×$0.01 tool fee → ~$0.039/run.
  const hint = estimateWeeklyCost('gpt-5-mini');
  assert.match(hint, /0\.039/, `expected the $0.03 tool fee reflected, got: ${hint}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

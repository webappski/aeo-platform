// fail-branch #6: an unknown model must NOT silently render as $0 («free»).
// The contract the run summary relies on: calcCost returns null for a model
// absent from the pricing table (so the caller flags costTracked:false rather
// than implying free). Real module, no mocks.

import assert from 'node:assert/strict';
import { calcCost, estimateWeeklyCost } from '../lib/providers/pricing.js';

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

// Mutation-sanity: if calcCost regressed to returning {costUsd:0} for unknowns,
// the first assertion (=== null) would fail — i.e. the honesty contract is
// load-bearing, not cosmetic.

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

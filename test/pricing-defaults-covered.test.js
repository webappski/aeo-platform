// Guard: every default/fallback model MUST have an explicit pricing row.
//
// Root cause this prevents: gemini-3.5-flash shipped as the default model with
// NO pricing row, so it silently matched a generic 'gemini' catch-all ($0.10/
// $0.40) and under-reported real cost (~$1.50/$9.00) by ~20x. The generic
// catch-alls are now removed (calcCost returns null → honest "cost not tracked"),
// so a default model without a row would show "untracked" instead of a wrong
// number — this test makes that failure loud at CI time, on the NEXT default bump.
//
// Contract: for every model in DEFAULT_CONFIG.providers (main + classifyModel)
// and discover.js FALLBACK (main + classify), calcCost(model, …) !== null.

import assert from 'node:assert/strict';
import { calcCost, findPricingPrefix } from '../lib/providers/pricing.js';
import { DEFAULT_CONFIG } from '../lib/config.js';
import { FALLBACK } from '../lib/providers/discover.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n    ${err.message}`); }
}

// Collect every shipped default/fallback model id (deduped), tagged with source.
const entries = new Map(); // model → "source" label (first wins, for the message)
function note(model, source) {
  if (model && !entries.has(model)) entries.set(model, source);
}
for (const [name, p] of Object.entries(DEFAULT_CONFIG.providers)) {
  note(p.model, `DEFAULT_CONFIG.providers.${name}.model`);
  note(p.classifyModel, `DEFAULT_CONFIG.providers.${name}.classifyModel`);
}
for (const [name, f] of Object.entries(FALLBACK)) {
  note(f.main, `FALLBACK.${name}.main`);
  note(f.classify, `FALLBACK.${name}.classify`);
}

console.log('\npricing coverage for shipped default/fallback models');

for (const [model, source] of entries) {
  test(`${model} (${source}) is explicitly priced`, () => {
    const cost = calcCost(model, { inputTokens: 1000, outputTokens: 1000 });
    assert.notEqual(
      cost, null,
      `"${model}" (${source}) resolves to NO pricing row → would display "cost not tracked". ` +
      `Add an explicit row in lib/providers/pricing.js (matched prefix: ${findPricingPrefix(model) ?? 'none'}).`,
    );
  });
}

// Sanity: the guard is load-bearing — an obviously-unlisted id must be null,
// so a regression that reintroduced a generic catch-all would fail this file too.
test('control: an unlisted model id is null (no generic catch-all resurfaced)', () => {
  assert.equal(calcCost('gemini-99.9-imaginary', { inputTokens: 1000, outputTokens: 1000 }), null);
  assert.equal(calcCost('claude-imaginary-42', { inputTokens: 1000, outputTokens: 1000 }), null);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

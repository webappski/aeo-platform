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
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { calcCost, findPricingPrefix, pricingRows } from '../lib/providers/pricing.js';
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

// Models the APIs actually SERVE, which is not the same set as the models we
// configure. Gemini served `gemini-3.6-flash` for a config pinning 3.5-flash
// (model drift) — unlisted, so calcCost returned null and every main Gemini call
// in a real run recorded as "cost not tracked": an ~$1.60 run reported $0. The
// loop above only covers CONFIGURED defaults and could never have caught it.
// Add an id here when a provider starts serving one.
const SERVED_IDS = [
  ['gemini-3.6-flash', 'served for a config pinning gemini-3.5-flash (drift, 2026-07)'],
  // The gpt-6 line (2026-10-11 run): `gpt-6.1-sol` is what discovery picks on
  // our key, `gpt-6-luna` is what the run was pinned to, and with no row for it
  // every ChatGPT cell read "cost not tracked" — the largest item of the run
  // (the 102 web searches) went missing with it. `gpt-6-sol` and `gpt-6-astra`
  // are the rest of that generation on the same pricing page.
  ['gpt-6-luna',   'pinned for the 2026-10-11 measurement; priced on developers.openai.com/api/docs/pricing'],
  ['gpt-6.1-sol',  'what discovery picks on the operator key (generation 6.1 ships only this id)'],
  ['gpt-6-sol',    'gpt-6 generation, same page'],
  ['gpt-6-astra',  'gpt-6 flagship, same page'],
  // One generation behind the search SKU is where classify/extraction lands;
  // unpriced, its calls recorded $0 with no "not tracked" marker at all.
  ['gpt-4.1-mini', 'classify/extraction tier one generation behind gpt-5-search-api'],
];
for (const [model, seenAs] of SERVED_IDS) {
  test(`${model} (${seenAs}) is explicitly priced`, () => {
    assert.notEqual(
      calcCost(model, { inputTokens: 1000, outputTokens: 1000 }), null,
      `"${model}" resolves to NO pricing row → real spend silently reports $0.`,
    );
  });
}

// Ordering invariant, stated as a rule instead of a comment: a '-flash-lite' id
// must never fall through to its '-flash' sibling's row. It did — gemini-3.5-flash
// shipped without a matching lite row, so `gemini-3.5-flash-lite` prefix-matched it
// and billed $1.50/$9.00 instead of $0.30/$2.50.
test('every -flash-lite id resolves to its own row, never the -flash sibling', () => {
  for (const row of pricingRows()) {
    if (!row.prefix.endsWith('-flash')) continue;
    const liteId = `${row.prefix}-lite`;
    const matched = findPricingPrefix(liteId);
    if (matched === null) continue;   // unlisted → honest "not tracked", fine
    assert.equal(
      matched, liteId,
      `"${liteId}" matched "${matched}" — a lite row is missing, or is ordered after its -flash sibling.`,
    );
  }
});

// Prefix-overlap invariant for the gpt-6 rows, stated as a rule: `gpt-6.1-sol`
// and `gpt-6-sol` are different SKUs at the same price today, which is exactly
// when a wrong match is invisible — until the prices diverge. And a dated
// snapshot must resolve to its family row, never to nothing.
test('every gpt-6 / gpt-4.1 id resolves to its OWN row', () => {
  for (const id of ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-luna', 'gpt-4.1-nano', 'gpt-4.1-mini', 'gpt-4.1']) {
    assert.equal(findPricingPrefix(id), id, `${id} matched ${findPricingPrefix(id)} instead of its own row`);
    assert.equal(findPricingPrefix(`${id}-2026-10-01`), id, `a dated ${id} snapshot must resolve to ${id}`);
  }
  // No bare family catch-all: a SKU the page does not list stays "not tracked".
  assert.equal(calcCost('gpt-6-terra', { inputTokens: 1000, outputTokens: 1000 }), null);
  assert.equal(calcCost('gpt-6.2-sol', { inputTokens: 1000, outputTokens: 1000 }), null);
});

// First-source figures. The fixture is the provider's own pricing page (Standard
// tier), read 2026-10-13 from the raw HTML — see its `_provenance`. It is data
// from the OTHER side of the seam, not a restatement of lib/providers/pricing.js:
// importing the constants from there would make this test agree with itself.
//
// Input-only and output-only probes, not their sum: a row with input and output
// swapped (`gpt-6.1-sol` $10 in / $2 out, `gpt-6-astra` $50 / $10 — the sum is
// the same) priced every ChatGPT answer wrong and passed a sum check.
const PAGE = JSON.parse(readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'openai-pricing-standard-2026-10-13.json'), 'utf-8'));
const perMillion = (id, which) => {
  const c = calcCost(id, which === 'input'
    ? { inputTokens: 1_000_000, outputTokens: 0 }
    : { inputTokens: 0, outputTokens: 1_000_000 });
  return c.costUsd;
};

test('the fixture carries the rows this card is about (a deleted row cannot silently skip a check)', () => {
  const ids = new Set(PAGE.rows.map((r) => r.id));
  for (const id of ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-luna', 'gpt-4.1', 'gpt-4.1-mini', 'gpt-4.1-nano']) {
    assert.ok(ids.has(id), `${id} missing from the pricing-page fixture`);
  }
  assert.ok(!ids.has('gpt-6-terra'), 'the page lists no gpt-6-terra; if it does now, add its row and this pin');
});

test('every table row that has its OWN prefix carries the page\'s input and output rate, one direction at a time', () => {
  let checked = 0;
  for (const row of PAGE.rows) {
    if (findPricingPrefix(row.id) !== row.id) continue;      // priced via a sibling's prefix (or unlisted): not this row's figure
    assert.equal(perMillion(row.id, 'input'), row.input, `${row.id}: input per 1M`);
    assert.equal(perMillion(row.id, 'output'), row.output, `${row.id}: output per 1M`);
    checked++;
  }
  // The new rows alone are 7; a regression that makes the loop skip them all
  // must not read as green.
  assert.ok(checked >= 7, `only ${checked} fixture rows matched an own prefix`);
});

// Sanity: the guard is load-bearing — an obviously-unlisted id must be null,
// so a regression that reintroduced a generic catch-all would fail this file too.
test('control: an unlisted model id is null (no generic catch-all resurfaced)', () => {
  assert.equal(calcCost('gemini-99.9-imaginary', { inputTokens: 1000, outputTokens: 1000 }), null);
  assert.equal(calcCost('claude-imaginary-42', { inputTokens: 1000, outputTokens: 1000 }), null);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

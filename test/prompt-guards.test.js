// Prompt-content guards for two 1.1.8 calibration decisions that live INSIDE
// prompt strings and would otherwise regress silently:
//
//   D1 (founder, 2026-06-11): adjacent-market commercial queries in the
//   brand's OWN vertical are VALID — the validator must not reject "best
//   appointment scheduling services for salons" for a salon-configurable
//   booking widget. Reject only wrong-INDUSTRY interpretations.
//
//   F3: the top-up brainstorm round must carry the previous round's rejection
//   reasons as negative guidance.

import assert from 'node:assert/strict';
import { buildValidatorPrompt } from '../lib/init/research/validate-query-llm.js';
import { buildBrainstormPrompt } from '../lib/init/research/brainstorm.js';

let passed = 0;
let failed = 0;
const results = [];

function test(name, fn) {
  try {
    fn();
    passed++; results.push({ name, ok: true });
  } catch (err) {
    failed++; results.push({ name, ok: false, err: err.message });
  }
}

const SITE = { lang: 'en', title: 't', metaDesc: '', h1: [], h2: [], text: '' };

test('validator prompt carries the adjacent-market VALID clause (D1)', () => {
  const p = buildValidatorPrompt({
    brand: 'typelessity', domain: 'typelessity.com',
    category: 'AI conversational booking widget', geography: [], queries: ['q'],
  });
  assert.match(p, /WHAT IS NOT A FAILURE/);
  assert.match(p, /Adjacent-market commercial query/);
  assert.match(p, /Reject ONLY when the dominant\s+interpretation belongs to a DIFFERENT industry/);
});

test('brainstorm prompt without avoidFeedback has no rejection block', () => {
  const p = buildBrainstormPrompt({
    brand: 'b', domain: 'd.com', site: SITE, categoryDescription: 'c',
  });
  assert.doesNotMatch(p, /PREVIOUSLY REJECTED/);
});

test('brainstorm prompt with avoidFeedback lists rejected texts + reasons (F3)', () => {
  const p = buildBrainstormPrompt({
    brand: 'b', domain: 'd.com', site: SITE, categoryDescription: 'c',
    avoidFeedback: [
      { query: 'salon services 2026', reason: 'returns general platforms' },
      { query: 'what is booking', reason: '' },
    ],
  });
  assert.match(p, /PREVIOUSLY REJECTED/);
  assert.match(p, /"salon services 2026" — rejected because: returns general platforms/);
  assert.match(p, /"what is booking" — rejected because: failed validation/);
});

// ─── Summary ───
console.log('');
for (const r of results) {
  console.log(r.ok ? `✓ ${r.name}` : `✗ ${r.name}\n    ${r.err}`);
}
console.log('');
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

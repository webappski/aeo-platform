// Tests for the 1.1.8 one-round candidate top-up (F3): when fewer than 3 of
// the brainstormed candidates pass validation, ONE extra brainstorm round runs
// with the rejection reasons fed back as negative guidance.

import assert from 'node:assert/strict';
import { topUpCommercialCandidates } from '../lib/init/research/topup.js';

let passed = 0;
let failed = 0;
const results = [];

function test(name, fn) {
  const p = (async () => fn())();
  return p.then(
    () => { passed++; results.push({ name, ok: true }); },
    err => { failed++; results.push({ name, ok: false, err: err.message }); }
  );
}

const BASE = {
  brand: 'typelessity', domain: 'typelessity.com',
  site: { lang: 'en', title: 't', metaDesc: '', h1: [], h2: [], text: '' },
  categoryDescription: 'AI conversational booking widget',
  provider: { providerCall: async () => ({ text: '{}' }), apiKey: 'k', model: 'm' },
};

await test('dedups vs existing, validates only fresh, returns passing with topUp flag + score 0', async () => {
  let validatedQueries = null;
  const r = await topUpCommercialCandidates({
    ...BASE,
    avoidFeedback: [{ query: 'old bad query', reason: 'too generic' }],
    existingTexts: ['Existing Query One', 'best AI tools 2026'],
    runBrainstormImpl: async () => ({
      flat: [
        { text: 'existing query one', intent: 'commercial' },          // dup (case-insensitive)
        { text: 'top booking widgets for dental clinics 2026', intent: 'commercial' },
        { text: 'best conversational scheduling tools 2026', intent: 'commercial' },
      ],
    }),
    validateBatch: async (qs) => {
      validatedQueries = qs;
      return [
        { query: 'top booking widgets for dental clinics 2026', valid: true, search_behavior: 'retrieval-triggered', confidence: 0.9 },
        { query: 'best conversational scheduling tools 2026', valid: false, search_behavior: 'retrieval-triggered', confidence: 0.8 },
      ];
    },
  });
  assert.deepEqual(validatedQueries, [
    'top booking widgets for dental clinics 2026',
    'best conversational scheduling tools 2026',
  ]);
  assert.equal(r.added.length, 1);
  assert.equal(r.added[0].text, 'top booking widgets for dental clinics 2026');
  assert.equal(r.added[0].topUp, true);
  assert.equal(r.added[0].score, 0);
  assert.equal(r.added[0].valid, true);
  assert.equal(r.verdicts.length, 2);
});

await test('avoidFeedback reaches the brainstorm round', async () => {
  let receivedFeedback = null;
  await topUpCommercialCandidates({
    ...BASE,
    avoidFeedback: [{ query: 'salon services 2026', reason: 'returns general platforms' }],
    existingTexts: [],
    runBrainstormImpl: async (opts) => {
      receivedFeedback = opts.avoidFeedback;
      return { flat: [{ text: 'fresh query', intent: 'commercial' }] };
    },
    validateBatch: async () => [],
  });
  assert.equal(receivedFeedback.length, 1);
  assert.equal(receivedFeedback[0].reason, 'returns general platforms');
});

await test('all brainstorm output already seen → empty result, validateBatch NOT called', async () => {
  let validateCalled = false;
  const r = await topUpCommercialCandidates({
    ...BASE,
    avoidFeedback: [],
    existingTexts: ['only query'],
    runBrainstormImpl: async () => ({ flat: [{ text: 'Only Query', intent: 'commercial' }] }),
    validateBatch: async () => { validateCalled = true; return []; },
  });
  assert.equal(validateCalled, false);
  assert.deepEqual(r, { added: [], verdicts: [], attempted: [] });
});

await test('verdictless candidate fails closed (not added)', async () => {
  const r = await topUpCommercialCandidates({
    ...BASE,
    avoidFeedback: [],
    existingTexts: [],
    runBrainstormImpl: async () => ({ flat: [{ text: 'no verdict query', intent: 'commercial' }] }),
    validateBatch: async () => [],
  });
  assert.equal(r.added.length, 0);
  assert.deepEqual(r.attempted, ['no verdict query']);
});

// ─── Summary ───
console.log('');
for (const r of results) {
  console.log(r.ok ? `✓ ${r.name}` : `✗ ${r.name}\n    ${r.err}`);
}
console.log('');
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

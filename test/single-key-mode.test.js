// Tests for single-key mode (1.1.8, founder decision 2026-06-11): the CLI
// admits clients with ONE research-capable key; cross-model checks degrade
// honestly (single-model + unverified marking) instead of walling the client.

import assert from 'node:assert/strict';
import { classifyKeyMode, RESEARCH_CAPABLE } from '../lib/init/keys.js';
import { extractWithTwoModels } from '../lib/report/extract-competitors-llm.js';
import { classifySentimentWithTwoModels } from '../lib/report/sentiment-classify.js';
import { sectionActionableGaps } from '../lib/report/sections.js';

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

// ─── classifyKeyMode ───

await test('classifyKeyMode: zero keys → none; one research key → single; two → dual', () => {
  assert.equal(classifyKeyMode({}).mode, 'none');
  assert.deepEqual(classifyKeyMode({ openai: 'OPENAI_API_KEY' }), { mode: 'single', present: ['openai'] });
  assert.equal(classifyKeyMode({ anthropic: 'X' }).mode, 'single');
  assert.equal(classifyKeyMode({ openai: 'X', gemini: 'Y' }).mode, 'dual');
  assert.equal(classifyKeyMode({ gemini: 'X', anthropic: 'Y' }).mode, 'dual');
});

await test('classifyKeyMode: perplexity alone is NOT research-capable → none', () => {
  assert.equal(classifyKeyMode({ perplexity: 'PERPLEXITY_API_KEY' }).mode, 'none');
  assert.equal(RESEARCH_CAPABLE.includes('perplexity'), false);
});

// ─── extractWithTwoModels, secondary = null ───

const stubProvider = (text) => ({
  name: 'openai', apiKey: 'k', model: 'm', label: 'OpenAI',
  providerCall: async () => ({ text, raw: {} }),
});

await test('extractWithTwoModels(secondary=null): brands land in unverified, secondary marked skipped', async () => {
  const r = await extractWithTwoModels({
    text: 'Fresha and Vagaro dominate salon scheduling.',
    brand: 'typelessity', domain: 'typelessity.com', category: 'booking widget',
    primary: stubProvider('{"brands": ["Fresha", "Vagaro"]}'),
    secondary: null,
  });
  assert.equal(r.verified.length, 0, 'nothing can be verified without a second model');
  assert.deepEqual(r.unverified, ['Fresha', 'Vagaro']);
  assert.equal(r.sources.secondary.model, null);
  assert.match(r.sources.secondary.skipped, /single-key/);
});

await test('extractWithTwoModels(secondary=null): primary failure → empty result, no crash', async () => {
  const r = await extractWithTwoModels({
    text: 'some response',
    brand: 'b', domain: 'd.com', category: 'c',
    primary: { ...stubProvider(''), providerCall: async () => { throw new Error('auth'); } },
    secondary: null,
  });
  assert.deepEqual(r.verified, []);
  assert.deepEqual(r.unverified, []);
});

// ─── classifySentimentWithTwoModels, secondary = null ───

await test('classifySentimentWithTwoModels(secondary=null): primary label survives with confidence single-model', async () => {
  const r = await classifySentimentWithTwoModels({
    text: 'Typelessity is praised as a flexible option.',
    brand: 'typelessity', domain: 'typelessity.com',
    primary: stubProvider('{"label": "positive", "rationale": "praised"}'),
    secondary: null,
  });
  assert.equal(r.label, 'positive');
  assert.equal(r.confidence, 'single-model');
});

// ─── report renderer honesty (founder special-check: no «picked up in error» in single-key) ───

const gapSnapshot = (extractorMode) => [{
  brand: 'typelessity', domain: 'typelessity.com', extractorMode,
  topDomains: [],
  results: [{
    query: 'best appointment scheduling services for salons 2026',
    provider: 'openai', model: 'm', mention: 'no',
    competitors: [], competitorsUnverified: ['Fresha', 'Vagaro'],
  }],
}];

await test('report (single-key): unverified row says "no cross-model confirmation", NOT "picked up in error"', () => {
  const md = sectionActionableGaps(gapSnapshot('single'));
  assert.match(md, /single-key mode ran ONE extractor model/);
  assert.match(md, /not necessarily wrong/);
  assert.doesNotMatch(md, /picked up in error/);
  assert.doesNotMatch(md, /the other returned empty/);
});

await test('report (dual): legacy disagreement copy preserved bit-for-bit', () => {
  const md = sectionActionableGaps(gapSnapshot('dual'));
  assert.match(md, /only one extractor model flagged competitors here, the other returned empty/);
  assert.doesNotMatch(md, /single-key mode/);
});

// ─── Summary ───
console.log('');
for (const r of results) {
  console.log(r.ok ? `✓ ${r.name}` : `✗ ${r.name}\n    ${r.err}`);
}
console.log('');
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

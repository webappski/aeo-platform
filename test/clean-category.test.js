// Tests for the 1.1.8 category compressor (F5): turn inferCategory()'s
// title+meta marketing sentence into a 2-5 word noun phrase, falling back to
// null on ANY failure so callers keep the raw string.

import assert from 'node:assert/strict';
import { cleanCategory } from '../lib/init/clean-category.js';

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

const SITE = { title: 'Bookings through conversation, not forms', metaDesc: 'AI booking widget', h1: ['Talk, don\'t type'] };
const mkProvider = (text) => ({ providerCall: async () => ({ text }), apiKey: 'k', model: 'm' });

await test('happy path: returns trimmed noun phrase', async () => {
  const out = await cleanCategory({
    rawCategory: 'Bookings through conversation, not forms — · AI booking widget that replaces forms with chat',
    site: SITE, brand: 'typelessity',
    provider: mkProvider('  "AI conversational booking widget"\nextra line ignored'),
  });
  assert.equal(out, 'AI conversational booking widget');
});

await test('too many words → null (caller falls back to raw)', async () => {
  const out = await cleanCategory({
    rawCategory: 'x', site: SITE, brand: 'typelessity',
    provider: mkProvider('a very long marketing sentence that is definitely not a noun phrase'),
  });
  assert.equal(out, null);
});

await test('single word → null', async () => {
  const out = await cleanCategory({
    rawCategory: 'x', site: SITE, brand: 'typelessity',
    provider: mkProvider('widget'),
  });
  assert.equal(out, null);
});

await test('phrase containing the brand → null', async () => {
  const out = await cleanCategory({
    rawCategory: 'x', site: SITE, brand: 'typelessity',
    provider: mkProvider('typelessity booking widget'),
  });
  assert.equal(out, null);
});

await test('provider throws → null, never throws outward', async () => {
  const out = await cleanCategory({
    rawCategory: 'x', site: SITE, brand: 'typelessity',
    provider: { providerCall: async () => { throw new Error('boom'); }, apiKey: 'k', model: 'm' },
  });
  assert.equal(out, null);
});

await test('no provider → null', async () => {
  const out = await cleanCategory({ rawCategory: 'x', site: SITE, brand: 'b', provider: null });
  assert.equal(out, null);
});

// ─── Summary ───
console.log('');
for (const r of results) {
  console.log(r.ok ? `✓ ${r.name}` : `✗ ${r.name}\n    ${r.err}`);
}
console.log('');
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

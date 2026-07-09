// Tests for lib/providers/openai.js — focused on reasoning_effort gate behavior.
// The gate decides whether to inject `reasoning_effort` into request body based
// on model id family. Reasoning support is GPT-5+ and o-series only; sending
// it to gpt-4o/gpt-4o-search returns HTTP 400.
//
// We stub global fetch to capture the body OpenAI receives, then assert the
// gate did/didn't add reasoning_effort.

import assert from 'node:assert/strict';

process.env.AEO_NO_RETRY = '1';  // Make withRetry one-shot for predictable tests.
const { callOpenAI } = await import('../lib/providers/openai.js');

let passed = 0, failed = 0;
function test(name, fn) {
  return Promise.resolve().then(fn)
    .then(() => { passed++; console.log(`  ✓ ${name}`); })
    .catch((err) => { failed++; console.log(`  ✗ ${name}\n    ${err.message}`); });
}

let captured = [];
const originalFetch = globalThis.fetch;
function stubFetch(responseFactory) {
  captured = [];
  globalThis.fetch = async (url, init) => {
    captured.push({ url, init });
    return responseFactory();
  };
}
function restoreFetch() { globalThis.fetch = originalFetch; captured = []; }

const OK_RESPONSE = () => ({
  ok: true, status: 200,
  headers: { get: () => null },
  json: async () => ({
    choices: [{ message: { content: 'ok' } }],
    usage: { prompt_tokens: 5, completion_tokens: 5 },
  }),
});

console.log('\ncallOpenAI reasoning_effort gate');

await test('gpt-5-search-api + reasoning_effort=high → field DROPPED (1.0.7 search-variant fix)', async () => {
  stubFetch(OK_RESPONSE);
  await callOpenAI('hi', 'sk-test', 'gpt-5-search-api', { reasoning_effort: 'high' });
  const body = JSON.parse(captured[0].init.body);
  assert.equal(body.reasoning_effort, undefined,
    'search-variants do not accept reasoning_effort — must be dropped at the gate');
});

await test('gpt-5-mini-search-api + reasoning_effort=high → field DROPPED (1.0.7)', async () => {
  stubFetch(OK_RESPONSE);
  await callOpenAI('hi', 'sk-test', 'gpt-5-mini-search-api', { reasoning_effort: 'high' });
  const body = JSON.parse(captured[0].init.body);
  assert.equal(body.reasoning_effort, undefined);
});

await test('gpt-5 (no search) + reasoning_effort=high → body has reasoning_effort', async () => {
  stubFetch(OK_RESPONSE);
  await callOpenAI('hi', 'sk-test', 'gpt-5', { reasoning_effort: 'high', webSearch: false });
  const body = JSON.parse(captured[0].init.body);
  assert.equal(body.reasoning_effort, 'high');
});

await test('gpt-5-mini + reasoning_effort=medium → body has reasoning_effort (mini IS GPT-5 family)', async () => {
  stubFetch(OK_RESPONSE);
  await callOpenAI('hi', 'sk-test', 'gpt-5-mini', { reasoning_effort: 'medium', webSearch: false });
  const body = JSON.parse(captured[0].init.body);
  assert.equal(body.reasoning_effort, 'medium');
});

await test('o1-preview + reasoning_effort=high → body has reasoning_effort (o-series)', async () => {
  stubFetch(OK_RESPONSE);
  await callOpenAI('hi', 'sk-test', 'o1-preview', { reasoning_effort: 'high', webSearch: false });
  const body = JSON.parse(captured[0].init.body);
  assert.equal(body.reasoning_effort, 'high');
});

await test('o3 + reasoning_effort=high → body has reasoning_effort', async () => {
  stubFetch(OK_RESPONSE);
  await callOpenAI('hi', 'sk-test', 'o3', { reasoning_effort: 'high', webSearch: false });
  const body = JSON.parse(captured[0].init.body);
  assert.equal(body.reasoning_effort, 'high');
});

await test('gpt-4o-search + reasoning_effort=high → field DROPPED (legacy gen)', async () => {
  stubFetch(OK_RESPONSE);
  await callOpenAI('hi', 'sk-test', 'gpt-4o-search', { reasoning_effort: 'high' });
  const body = JSON.parse(captured[0].init.body);
  assert.equal(body.reasoning_effort, undefined, 'gpt-4o-search must not receive reasoning_effort');
});

await test('gpt-4o + reasoning_effort=high → field DROPPED (legacy gen)', async () => {
  stubFetch(OK_RESPONSE);
  await callOpenAI('hi', 'sk-test', 'gpt-4o', { reasoning_effort: 'high', webSearch: false });
  const body = JSON.parse(captured[0].init.body);
  assert.equal(body.reasoning_effort, undefined);
});

await test('gpt-3.5-turbo + reasoning_effort → field DROPPED', async () => {
  stubFetch(OK_RESPONSE);
  await callOpenAI('hi', 'sk-test', 'gpt-3.5-turbo', { reasoning_effort: 'high', webSearch: false });
  const body = JSON.parse(captured[0].init.body);
  assert.equal(body.reasoning_effort, undefined);
});

await test('future gpt-6-search-api → field DROPPED (1.0.7 search-variant future-proof)', async () => {
  stubFetch(OK_RESPONSE);
  await callOpenAI('hi', 'sk-test', 'gpt-6-search-api', { reasoning_effort: 'high' });
  const body = JSON.parse(captured[0].init.body);
  assert.equal(body.reasoning_effort, undefined,
    'gpt-6-search-api must inherit the search-variant exclude');
});

await test('future gpt-6 (NON-search) + reasoning_effort=high → body has reasoning_effort', async () => {
  // 1.0.7: non-search future generations still hit the include path.
  stubFetch(OK_RESPONSE);
  await callOpenAI('hi', 'sk-test', 'gpt-6', { reasoning_effort: 'high', webSearch: false });
  const body = JSON.parse(captured[0].init.body);
  assert.equal(body.reasoning_effort, 'high',
    'non-search future gpt-N generations still receive reasoning_effort');
});

await test('no reasoning_effort option → no field in body (backward compat)', async () => {
  stubFetch(OK_RESPONSE);
  await callOpenAI('hi', 'sk-test', 'gpt-5-search-api', {});
  const body = JSON.parse(captured[0].init.body);
  assert.equal(body.reasoning_effort, undefined);
});

await test('reasoning_effort=undefined option → no field in body', async () => {
  stubFetch(OK_RESPONSE);
  await callOpenAI('hi', 'sk-test', 'gpt-5-search-api', { reasoning_effort: undefined });
  const body = JSON.parse(captured[0].init.body);
  assert.equal(body.reasoning_effort, undefined);
});

restoreFetch();

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

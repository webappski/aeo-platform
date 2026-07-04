// Tests for lib/providers/anthropic.js — thinking gate behavior.
// The gate decides whether to inject `thinking` block into body. Extended
// thinking is supported by Claude 4.x+ (GA на cutoff 2026-01). Legacy gen-1/2/3
// reject the field outright. Defensive whitelist-by-exclusion ловит будущие
// gen-N автоматически.

import assert from 'node:assert/strict';

process.env.AEO_NO_RETRY = '1';
const { callAnthropic } = await import('../lib/providers/anthropic.js');

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
    content: [{ type: 'text', text: 'ok' }],
    usage: { input_tokens: 5, output_tokens: 5 },
  }),
});

const THINKING_OPTS = { thinking: { type: 'enabled', budget_tokens: 16000 } };

console.log('\ncallAnthropic thinking gate');

await test('claude-sonnet-4-6 + thinking → body has thinking + max_tokens bumped', async () => {
  stubFetch(OK_RESPONSE);
  await callAnthropic('hi', 'sk-test', 'claude-sonnet-4-6', { ...THINKING_OPTS, webSearch: false });
  const body = JSON.parse(captured[0].init.body);
  assert.deepStrictEqual(body.thinking, THINKING_OPTS.thinking);
  assert.ok(body.max_tokens >= 16000 + 2048, `max_tokens (${body.max_tokens}) must >= 18048`);
});

await test('claude-opus-4-6 + thinking → body has thinking', async () => {
  stubFetch(OK_RESPONSE);
  await callAnthropic('hi', 'sk-test', 'claude-opus-4-6', { ...THINKING_OPTS, webSearch: false });
  const body = JSON.parse(captured[0].init.body);
  assert.deepStrictEqual(body.thinking, THINKING_OPTS.thinking);
});

await test('claude-haiku-4-5 + thinking → body has thinking', async () => {
  stubFetch(OK_RESPONSE);
  await callAnthropic('hi', 'sk-test', 'claude-haiku-4-5', { ...THINKING_OPTS, webSearch: false });
  const body = JSON.parse(captured[0].init.body);
  assert.deepStrictEqual(body.thinking, THINKING_OPTS.thinking);
});

await test('claude-sonnet-5 + thinking → adaptive type (gen5 rejects "enabled"), max_tokens bumped', async () => {
  stubFetch(OK_RESPONSE);
  await callAnthropic('hi', 'sk-test', 'claude-sonnet-5', { ...THINKING_OPTS, webSearch: false });
  const body = JSON.parse(captured[0].init.body);
  assert.deepStrictEqual(body.thinking, { type: 'adaptive' }, 'gen5 must send adaptive, never enabled');
  assert.equal(body.max_tokens, 18048, 'budget hint still pads max_tokens (16000 + 2048)');
});

await test('claude-sonnet-5-20260615 (dated gen5 id) + thinking → adaptive type', async () => {
  stubFetch(OK_RESPONSE);
  await callAnthropic('hi', 'sk-test', 'claude-sonnet-5-20260615', { ...THINKING_OPTS, webSearch: false });
  const body = JSON.parse(captured[0].init.body);
  assert.deepStrictEqual(body.thinking, { type: 'adaptive' });
});

await test('claude-fable-5 + thinking → adaptive type (gen5 family variety)', async () => {
  stubFetch(OK_RESPONSE);
  await callAnthropic('hi', 'sk-test', 'claude-fable-5', { ...THINKING_OPTS, webSearch: false });
  const body = JSON.parse(captured[0].init.body);
  assert.deepStrictEqual(body.thinking, { type: 'adaptive' });
});

await test('claude-3-5-sonnet + thinking → field DROPPED (legacy gen)', async () => {
  stubFetch(OK_RESPONSE);
  await callAnthropic('hi', 'sk-test', 'claude-3-5-sonnet', { ...THINKING_OPTS, webSearch: false });
  const body = JSON.parse(captured[0].init.body);
  assert.equal(body.thinking, undefined, 'claude-3-X must not receive thinking');
  assert.equal(body.max_tokens, 2048, 'max_tokens should not be bumped when thinking dropped');
});

await test('claude-2.1 + thinking → field DROPPED', async () => {
  stubFetch(OK_RESPONSE);
  await callAnthropic('hi', 'sk-test', 'claude-2.1', { ...THINKING_OPTS, webSearch: false });
  const body = JSON.parse(captured[0].init.body);
  assert.equal(body.thinking, undefined);
});

await test('claude-1 + thinking → field DROPPED', async () => {
  stubFetch(OK_RESPONSE);
  await callAnthropic('hi', 'sk-test', 'claude-1', { ...THINKING_OPTS, webSearch: false });
  const body = JSON.parse(captured[0].init.body);
  assert.equal(body.thinking, undefined);
});

await test('no thinking option → no field in body (backward compat)', async () => {
  stubFetch(OK_RESPONSE);
  await callAnthropic('hi', 'sk-test', 'claude-sonnet-4-6', { webSearch: false });
  const body = JSON.parse(captured[0].init.body);
  assert.equal(body.thinking, undefined);
  assert.equal(body.max_tokens, 2048, 'max_tokens stays default when thinking absent');
});

await test('thinking option without budget_tokens → field added but max_tokens NOT bumped', async () => {
  stubFetch(OK_RESPONSE);
  await callAnthropic('hi', 'sk-test', 'claude-sonnet-4-6', {
    thinking: { type: 'enabled' },  // no budget_tokens
    webSearch: false,
  });
  const body = JSON.parse(captured[0].init.body);
  assert.deepStrictEqual(body.thinking, { type: 'enabled' });
  assert.equal(body.max_tokens, 2048);
});

await test('thinking option as non-object (string) → field NOT added (type check)', async () => {
  stubFetch(OK_RESPONSE);
  await callAnthropic('hi', 'sk-test', 'claude-sonnet-4-6', {
    thinking: 'invalid',
    webSearch: false,
  });
  const body = JSON.parse(captured[0].init.body);
  assert.equal(body.thinking, undefined);
});

restoreFetch();

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

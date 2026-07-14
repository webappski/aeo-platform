// Tests for lib/providers/openai.js — dual API routing + reasoning gate + parsing.
//
// callOpenAI routes by the webSearch flag (NOT the model name):
//   webSearch:true  → Responses API (/v1/responses) with the built-in web_search
//                     tool — bills against the general model's big TPM bucket.
//   webSearch:false → Chat Completions (/v1/chat/completions), no tool.
// Reasoning is forwarded as `reasoning.effort` (Responses) or `reasoning_effort`
// (Chat) for reasoning-capable models, and dropped for gpt-4o / search SKUs.
//
// We stub global fetch to capture the URL + body OpenAI receives, then assert
// routing, the reasoning gate, search_context_size, and response parsing.

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

const CHAT_OK = () => ({
  ok: true, status: 200,
  headers: { get: () => null },
  json: async () => ({
    choices: [{ message: { content: 'ok' } }],
    usage: { prompt_tokens: 5, completion_tokens: 5 },
  }),
});
const RESPONSES_OK = () => ({
  ok: true, status: 200,
  headers: { get: () => null },
  json: async () => ({
    output: [
      { type: 'reasoning' },
      { type: 'web_search_call' },
      { type: 'message', content: [{
        type: 'output_text',
        text: 'Paris is the capital.',
        annotations: [{ type: 'url_citation', url: 'https://example.com/a' }],
      }] },
    ],
    usage: { input_tokens: 9000, output_tokens: 100 },
  }),
});

console.log('\ncallOpenAI routing (webSearch flag decides the API surface)');

await test('webSearch default (true) → /v1/responses with web_search tool', async () => {
  stubFetch(RESPONSES_OK);
  await callOpenAI('hi', 'sk-test', 'gpt-5-mini', {});
  assert.match(captured[0].url, /\/v1\/responses$/);
  const body = JSON.parse(captured[0].init.body);
  assert.equal(body.input, 'hi');
  assert.deepStrictEqual(body.tools, [{ type: 'web_search' }]);
  assert.deepStrictEqual(body.tool_choice, { type: 'web_search' }, 'search is FORCED, not auto');
  assert.equal(body.messages, undefined, 'responses path uses input, not messages');
});

await test('webSearch:false → /v1/chat/completions, no tool, no web_search_options', async () => {
  stubFetch(CHAT_OK);
  await callOpenAI('hi', 'sk-test', 'gpt-5-mini', { webSearch: false });
  assert.match(captured[0].url, /\/v1\/chat\/completions$/);
  const body = JSON.parse(captured[0].init.body);
  assert.deepStrictEqual(body.messages, [{ role: 'user', content: 'hi' }]);
  assert.equal(body.tools, undefined);
  assert.equal(body.input, undefined);
  assert.equal(body.web_search_options, undefined);
});

await test('legacy search SKU + webSearch → Chat Completions + web_search_options (not Responses)', async () => {
  stubFetch(CHAT_OK);
  await callOpenAI('hi', 'sk-test', 'gpt-5-search-api', {});
  assert.match(captured[0].url, /\/v1\/chat\/completions$/, 'search SKUs can only search via chat completions');
  const body = JSON.parse(captured[0].init.body);
  assert.deepStrictEqual(body.web_search_options, {});
  assert.deepStrictEqual(body.messages, [{ role: 'user', content: 'hi' }]);
  assert.equal(body.tools, undefined);
});

console.log('\nreasoning gate — Responses path (reasoning.effort)');

await test('gpt-5-mini web search + reasoning_effort=high → reasoning.effort=high', async () => {
  stubFetch(RESPONSES_OK);
  await callOpenAI('hi', 'sk-test', 'gpt-5-mini', { reasoning_effort: 'high' });
  const body = JSON.parse(captured[0].init.body);
  assert.deepStrictEqual(body.reasoning, { effort: 'high' });
  assert.equal(body.reasoning_effort, undefined, 'Responses uses nested reasoning.effort, not the flat field');
});

await test('gpt-4o web search + reasoning_effort → DROPPED (legacy gen)', async () => {
  stubFetch(RESPONSES_OK);
  await callOpenAI('hi', 'sk-test', 'gpt-4o', { reasoning_effort: 'high' });
  const body = JSON.parse(captured[0].init.body);
  assert.equal(body.reasoning, undefined);
});

await test('search SKU + reasoning_effort → DROPPED (search-variant exclude; routes to chat)', async () => {
  stubFetch(CHAT_OK);
  await callOpenAI('hi', 'sk-test', 'gpt-5-search-api', { reasoning_effort: 'high' });
  const body = JSON.parse(captured[0].init.body);
  assert.equal(body.reasoning_effort, undefined, 'search SKUs reject reasoning');
  assert.equal(body.reasoning, undefined);
});

console.log('\nreasoning gate — Chat path (reasoning_effort)');

await test('gpt-5 chat (webSearch:false) + reasoning_effort=high → reasoning_effort=high', async () => {
  stubFetch(CHAT_OK);
  await callOpenAI('hi', 'sk-test', 'gpt-5', { reasoning_effort: 'high', webSearch: false });
  const body = JSON.parse(captured[0].init.body);
  assert.equal(body.reasoning_effort, 'high');
});

await test('o3 chat + reasoning_effort=high → present (o-series)', async () => {
  stubFetch(CHAT_OK);
  await callOpenAI('hi', 'sk-test', 'o3', { reasoning_effort: 'high', webSearch: false });
  const body = JSON.parse(captured[0].init.body);
  assert.equal(body.reasoning_effort, 'high');
});

await test('gpt-4o chat + reasoning_effort → DROPPED (legacy gen)', async () => {
  stubFetch(CHAT_OK);
  await callOpenAI('hi', 'sk-test', 'gpt-4o', { reasoning_effort: 'high', webSearch: false });
  const body = JSON.parse(captured[0].init.body);
  assert.equal(body.reasoning_effort, undefined);
});

await test('no reasoning_effort → no reasoning field (both paths)', async () => {
  stubFetch(RESPONSES_OK);
  await callOpenAI('hi', 'sk-test', 'gpt-5-mini', {});
  assert.equal(JSON.parse(captured[0].init.body).reasoning, undefined);
  stubFetch(CHAT_OK);
  await callOpenAI('hi', 'sk-test', 'gpt-5-mini', { webSearch: false });
  assert.equal(JSON.parse(captured[0].init.body).reasoning_effort, undefined);
});

console.log('\nsearch_context_size (TPM burn control)');

await test('searchContextSize option → tools[0].search_context_size', async () => {
  stubFetch(RESPONSES_OK);
  await callOpenAI('hi', 'sk-test', 'gpt-5-mini', { searchContextSize: 'low' });
  assert.equal(JSON.parse(captured[0].init.body).tools[0].search_context_size, 'low');
});

await test('AEO_OPENAI_SEARCH_CONTEXT env → tools[0].search_context_size', async () => {
  process.env.AEO_OPENAI_SEARCH_CONTEXT = 'high';
  stubFetch(RESPONSES_OK);
  await callOpenAI('hi', 'sk-test', 'gpt-5-mini', {});
  assert.equal(JSON.parse(captured[0].init.body).tools[0].search_context_size, 'high');
  delete process.env.AEO_OPENAI_SEARCH_CONTEXT;
});

await test('invalid searchContextSize → omitted (no bad value sent)', async () => {
  stubFetch(RESPONSES_OK);
  await callOpenAI('hi', 'sk-test', 'gpt-5-mini', { searchContextSize: 'ultra' });
  assert.equal(JSON.parse(captured[0].init.body).tools[0].search_context_size, undefined);
});

console.log('\nresponse parsing');

await test('Responses path → text + url_citation from output.message', async () => {
  stubFetch(RESPONSES_OK);
  const { text, citations } = await callOpenAI('hi', 'sk-test', 'gpt-5-mini', {});
  assert.equal(text, 'Paris is the capital.');
  assert.deepStrictEqual(citations, ['https://example.com/a']);
});

await test('Chat path → text + annotations from choices', async () => {
  stubFetch(() => ({
    ok: true, status: 200, headers: { get: () => null },
    json: async () => ({ choices: [{ message: {
      content: 'hello',
      annotations: [{ url_citation: { url: 'https://x.io' } }],
    } }] }),
  }));
  const { text, citations } = await callOpenAI('hi', 'sk-test', 'gpt-5-mini', { webSearch: false });
  assert.equal(text, 'hello');
  assert.deepStrictEqual(citations, ['https://x.io']);
});

restoreFetch();

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

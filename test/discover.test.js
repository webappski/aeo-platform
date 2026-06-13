// Tests for lib/providers/discover.js — HTTP discovery with selection rules.
//
// Each test stubs fetch with a representative /v1/models response (10-15 model
// IDs including edge cases: dated suffixes, audio variants, mini-search,
// preview suffixes, legacy gens) and asserts the correct top-pick.

import assert from 'node:assert/strict';

const { discoverModels, FALLBACK } = await import('../lib/providers/discover.js');
const { DEFAULT_CONFIG } = await import('../lib/config.js');

let passed = 0, failed = 0;
function test(name, fn) {
  return Promise.resolve().then(fn)
    .then(() => { passed++; console.log(`  ✓ ${name}`); })
    .catch((err) => { failed++; console.log(`  ✗ ${name}\n    ${err.message}`); });
}

const originalFetch = globalThis.fetch;
function stub(responseFactory) {
  globalThis.fetch = async (url, init) => responseFactory(url, init);
}
function restore() { globalThis.fetch = originalFetch; }

function ok(body) {
  return { ok: true, status: 200, json: async () => body };
}
function err(status, body = {}) {
  return { ok: false, status, statusText: `Err ${status}`, json: async () => body };
}

// Silence [discover-warn] noise from non-auth failures during tests.
const originalStderrWrite = process.stderr.write.bind(process.stderr);
process.stderr.write = (s, ...rest) => {
  if (typeof s === 'string' && s.includes('[discover-warn]')) return true;
  return originalStderrWrite(s, ...rest);
};

console.log('\ndiscoverModels OpenAI');

await test('openai: search-capable flagship picked over mini-search', async () => {
  stub(() => ok({ data: [
    { id: 'gpt-5-mini-search-api' },
    { id: 'gpt-5-search-api' },
    { id: 'gpt-4o-search' },
    { id: 'gpt-4o' },
    { id: 'gpt-5' },
    { id: 'gpt-3.5-turbo' },
  ]}));
  const { models, authError } = await discoverModels('openai', 'sk-test');
  assert.equal(authError, false);
  assert.deepStrictEqual(models, ['gpt-5-search-api']);  // gen 5 flagship search
});

await test('openai: gen-5 mini-search beats gen-4 flagship-search', async () => {
  // Newer generation wins primary; mini penalty applies WITHIN gen only.
  stub(() => ok({ data: [
    { id: 'gpt-5-mini-search-api' },
    { id: 'gpt-4o-search' },
  ]}));
  const { models } = await discoverModels('openai', 'sk-test');
  assert.deepStrictEqual(models, ['gpt-5-mini-search-api']);
});

await test('openai: undated > dated within same gen', async () => {
  stub(() => ok({ data: [
    { id: 'gpt-5-search-api-2026-01-15' },
    { id: 'gpt-5-search-api' },
  ]}));
  const { models } = await discoverModels('openai', 'sk-test');
  assert.deepStrictEqual(models, ['gpt-5-search-api']);
});

await test('openai: audio/realtime variants filtered out', async () => {
  stub(() => ok({ data: [
    { id: 'gpt-4o-audio-search' },
    { id: 'gpt-5-realtime-search' },
    { id: 'gpt-5-search-api' },
  ]}));
  const { models } = await discoverModels('openai', 'sk-test');
  assert.deepStrictEqual(models, ['gpt-5-search-api']);
});

await test('openai: 401 → authError=true, models=null', async () => {
  stub(() => err(401));
  const { models, authError } = await discoverModels('openai', 'bad-key');
  assert.equal(models, null);
  assert.equal(authError, true);
});

await test('openai: 403 → authError=true', async () => {
  stub(() => err(403));
  const { models, authError } = await discoverModels('openai', 'bad-key');
  assert.equal(authError, true);
});

await test('openai: 500 → models=null, authError=false (fallback path)', async () => {
  stub(() => err(500));
  const { models, authError } = await discoverModels('openai', 'sk-test');
  assert.equal(models, null);
  assert.equal(authError, false);
});

await test('openai: empty models list → null', async () => {
  stub(() => ok({ data: [] }));
  const { models } = await discoverModels('openai', 'sk-test');
  assert.equal(models, null);
});

console.log('\ndiscoverModels Anthropic');

await test('anthropic: latest sonnet by created_at', async () => {
  stub(() => ok({ data: [
    { id: 'claude-sonnet-4-5', created_at: '2025-08-01' },
    { id: 'claude-sonnet-4-6', created_at: '2026-01-15' },
    { id: 'claude-opus-4-6',   created_at: '2026-01-10' },
  ]}));
  const { models } = await discoverModels('anthropic', 'sk-test');
  assert.deepStrictEqual(models, ['claude-sonnet-4-6']);
});

await test('anthropic: filters out opus (only sonnet)', async () => {
  stub(() => ok({ data: [
    { id: 'claude-opus-4-6', created_at: '2026-01-15' },
    { id: 'claude-sonnet-4-5', created_at: '2025-08-01' },
  ]}));
  const { models } = await discoverModels('anthropic', 'sk-test');
  assert.deepStrictEqual(models, ['claude-sonnet-4-5']);
});

await test('anthropic: skips dated YYYYMMDD suffixes', async () => {
  stub(() => ok({ data: [
    { id: 'claude-sonnet-20260119', created_at: '2026-01-19' },
    { id: 'claude-sonnet-4-6', created_at: '2026-01-15' },
  ]}));
  const { models } = await discoverModels('anthropic', 'sk-test');
  assert.deepStrictEqual(models, ['claude-sonnet-4-6']);
});

await test('anthropic: date-in-id fallback when created_at missing', async () => {
  // Defensive: API shape change drops created_at field — sort by id-extracted date.
  // Skip canonical hyphenated dated suffixes (e.g. -2026-01-19) since the filter
  // strips those — only date-IN-MIDDLE-of-id passes (rare future naming).
  stub(() => ok({ data: [
    { id: 'claude-sonnet-2025-08-mid' },  // date in middle, not at end
    { id: 'claude-sonnet-2026-01-mid' },
  ]}));
  const { models } = await discoverModels('anthropic', 'sk-test');
  assert.deepStrictEqual(models, ['claude-sonnet-2026-01-mid']);
});

await test('anthropic: 401 → authError', async () => {
  stub(() => err(401));
  const { authError } = await discoverModels('anthropic', 'bad');
  assert.equal(authError, true);
});

console.log('\ndiscoverModels Gemini');

await test('gemini: newest gen flash preferred over pro', async () => {
  stub(() => ok({ models: [
    { name: 'models/gemini-3.1-pro-preview', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-3.1-flash', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-2.5-pro', supportedGenerationMethods: ['generateContent'] },
  ]}));
  const { models } = await discoverModels('gemini', 'AIzaSy');
  assert.deepStrictEqual(models, ['gemini-3.1-flash']);
});

await test('gemini: stable > preview within same gen', async () => {
  stub(() => ok({ models: [
    { name: 'models/gemini-3.1-flash-preview', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-3.1-flash', supportedGenerationMethods: ['generateContent'] },
  ]}));
  const { models } = await discoverModels('gemini', 'AIzaSy');
  assert.deepStrictEqual(models, ['gemini-3.1-flash']);
});

await test('gemini: preview-only newest-gen → falls back to previous-gen stable', async () => {
  // newest gen 3.1 only has preview; gen 2.5 has stable pro — switch to 2.5-pro.
  stub(() => ok({ models: [
    { name: 'models/gemini-3.1-pro-preview', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-3.1-flash-preview', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-2.5-pro', supportedGenerationMethods: ['generateContent'] },
  ]}));
  const { models } = await discoverModels('gemini', 'AIzaSy');
  // Should NOT be gen-3.1 preview. Should be gen-2.5 (flash preferred over pro).
  assert.equal(models[0].startsWith('gemini-2.5'), true, `expected gen-2.5 fallback, got ${models[0]}`);
});

await test('gemini: skips lite/embedding/aqa/exp', async () => {
  stub(() => ok({ models: [
    { name: 'models/gemini-3.1-flash-lite', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-3.1-flash-aqa', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-3.1-flash-exp', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-embedding-001', supportedGenerationMethods: ['embedContent'] },
    { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] },
  ]}));
  const { models } = await discoverModels('gemini', 'AIzaSy');
  assert.deepStrictEqual(models, ['gemini-2.5-flash']);
});

await test('gemini: 401 → authError', async () => {
  stub(() => err(401));
  const { authError } = await discoverModels('gemini', 'bad');
  assert.equal(authError, true);
});

console.log('\ndiscoverModels Perplexity');

await test('perplexity: prefers sonar-reasoning over sonar-pro', async () => {
  stub(() => ok({ data: [
    { id: 'sonar' },
    { id: 'sonar-pro' },
    { id: 'sonar-reasoning' },
    { id: 'sonar-reasoning-pro' },
  ]}));
  const { models } = await discoverModels('perplexity', 'pplx-test');
  assert.deepStrictEqual(models, ['sonar-reasoning']);
});

await test('perplexity: falls back to sonar-reasoning-pro if sonar-reasoning absent', async () => {
  stub(() => ok({ data: [{ id: 'sonar' }, { id: 'sonar-reasoning-pro' }, { id: 'sonar-pro' }] }));
  const { models } = await discoverModels('perplexity', 'pplx-test');
  assert.deepStrictEqual(models, ['sonar-reasoning-pro']);
});

await test('perplexity: 404 /models endpoint → preference chain fallback', async () => {
  stub(() => err(404));
  const { models, authError } = await discoverModels('perplexity', 'pplx-test');
  assert.equal(authError, false);
  assert.deepStrictEqual(models, ['sonar-reasoning']);
});

await test('perplexity: 401 → authError', async () => {
  stub(() => err(401));
  const { authError } = await discoverModels('perplexity', 'bad');
  assert.equal(authError, true);
});

console.log('\nFALLBACK ↔ DEFAULT_CONFIG drift catcher');

await test('FALLBACK.<provider> matches DEFAULT_CONFIG.providers.<provider>', () => {
  for (const p of ['openai', 'anthropic', 'gemini', 'perplexity']) {
    assert.equal(FALLBACK[p].main, DEFAULT_CONFIG.providers[p].model,
      `${p}.model drift: FALLBACK="${FALLBACK[p].main}" vs DEFAULT="${DEFAULT_CONFIG.providers[p].model}"`);
    assert.equal(FALLBACK[p].classify, DEFAULT_CONFIG.providers[p].classifyModel,
      `${p}.classifyModel drift: FALLBACK="${FALLBACK[p].classify}" vs DEFAULT="${DEFAULT_CONFIG.providers[p].classifyModel}"`);
  }
});

console.log('\ndiscoverModels unknown provider');

await test('unknown provider returns {models:null, authError:false}', async () => {
  const { models, authError } = await discoverModels('fake-provider', 'k');
  assert.equal(models, null);
  assert.equal(authError, false);
});

restore();
process.stderr.write = originalStderrWrite;

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

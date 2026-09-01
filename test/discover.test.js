// Tests for lib/providers/discover.js — HTTP discovery with selection rules.
//
// Each test stubs fetch with a representative /v1/models response (10-15 model
// IDs including edge cases: dated suffixes, audio variants, mini-search,
// preview suffixes, legacy gens) and asserts the correct top-pick.

import assert from 'node:assert/strict';

const { discoverModels, discoverClassifyModel, resolveClassifyModel, FALLBACK } = await import('../lib/providers/discover.js');
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

await test('openai: general mini picked; search SKUs + flagship excluded/outranked', async () => {
  stub(() => ok({ data: [
    { id: 'gpt-5-mini-search-api' },  // search SKU — excluded (tiny bucket)
    { id: 'gpt-5-search-api' },        // search SKU — excluded
    { id: 'gpt-5' },                   // flagship — outranked by the cheap-tier preference
    { id: 'gpt-5-mini' },              // ← winner
    { id: 'gpt-5-nano' },              // nano is NOT mini
    { id: 'gpt-4o' },
    { id: 'gpt-3.5-turbo' },
  ]}));
  const { models, authError } = await discoverModels('openai', 'sk-test');
  assert.equal(authError, false);
  assert.deepStrictEqual(models, ['gpt-5-mini']);
});

await test('openai: NEWEST GENERATION wins even when it ships no -mini at all', async () => {
  // THE regression this rule exists for. OpenAI's 5.6 line replaced size
  // suffixes with names (sol / terra / luna). Under the old "mini required"
  // filter the whole 5.6 generation fell out of the pool BEFORE the version
  // sort, so discovery reported a healthy pick of gpt-5.4-mini — two
  // generations behind — and the run measured a world that had moved on.
  // Founder ruling 2026-09-01: "надо брать последние модели… последняя
  // модель, но дешёвая модификация". Cheapness may not cost a generation.
  stub(() => ok({ data: [
    { id: 'gpt-5.6-sol' },      // newest gen, flagship
    { id: 'gpt-5.6-terra' },    // newest gen, balanced
    { id: 'gpt-5.6-luna' },     // ← winner: newest gen, cheapest tier
    { id: 'gpt-5.4-mini' },     // older gen — must NOT win on its suffix
    { id: 'gpt-5.4-nano' },
  ]}));
  const { models } = await discoverModels('openai', 'sk-test');
  assert.deepStrictEqual(models, ['gpt-5.6-luna']);
});

await test('openai: an unrecognised newest generation still wins, and says so on stderr', async () => {
  // The hint list is a PREFERENCE, never a gate: a generation whose tier names
  // we have never seen must still be picked over an older one we understand.
  // And the operator has to hear about it — a silent fallback pick is how the
  // NEXT naming change would cost three months of drifting numbers.
  const lines = [];
  const spy = (s, ...rest) => {
    if (typeof s === 'string' && s.includes('[discover-warn]')) { lines.push(s); return true; }
    return originalStderrWrite(s, ...rest);
  };
  const prevWrite = process.stderr.write;
  process.stderr.write = spy;
  try {
    stub(() => ok({ data: [
      { id: 'gpt-6-alpha' },
      { id: 'gpt-6-beta' },
      { id: 'gpt-5.6-luna' },
    ]}));
    const { models } = await discoverModels('openai', 'sk-test');
    assert.equal(models[0].startsWith('gpt-6-'), true, `expected a gen-6 pick, got ${models[0]}`);
  } finally {
    process.stderr.write = prevWrite;
  }
  assert.equal(lines.length, 1, 'expected exactly one [discover-warn] about the unrecognised tier');
  assert.match(lines[0], /no recognised cheap tier/);
  assert.match(lines[0], /MAIN_CHEAP_TIER/);
});

await test('openai: newest-gen mini wins (5.4-mini > 5-mini via parseFloat)', async () => {
  stub(() => ok({ data: [
    { id: 'gpt-5.4-mini' },
    { id: 'gpt-5-mini' },
  ]}));
  const { models } = await discoverModels('openai', 'sk-test');
  assert.deepStrictEqual(models, ['gpt-5.4-mini']);
});

await test('openai: newest generation wins even when nothing in it is a recognised cheap tier', async () => {
  stub(() => ok({ data: [
    { id: 'gpt-5' },
    { id: 'gpt-5.4' },
  ]}));
  const { models } = await discoverModels('openai', 'sk-test');
  assert.deepStrictEqual(models, ['gpt-5.4']);
});

await test('openai: undated > dated within same gen', async () => {
  stub(() => ok({ data: [
    { id: 'gpt-5-mini-2026-01-15' },
    { id: 'gpt-5-mini' },
  ]}));
  const { models } = await discoverModels('openai', 'sk-test');
  assert.deepStrictEqual(models, ['gpt-5-mini']);
});

await test('openai: audio/realtime/pro excluded', async () => {
  stub(() => ok({ data: [
    { id: 'gpt-5-audio' },
    { id: 'gpt-5-realtime' },
    { id: 'gpt-5.5-pro' },        // pro — low TPM (30k), excluded
    { id: 'gpt-5-mini' },         // ← winner
  ]}));
  const { models } = await discoverModels('openai', 'sk-test');
  assert.deepStrictEqual(models, ['gpt-5-mini']);
});

await test('openai: codex/chat-latest aliases excluded', async () => {
  stub(() => ok({ data: [
    { id: 'gpt-5.1-codex' },
    { id: 'gpt-5-chat-latest' },
    { id: 'gpt-5-mini' },
  ]}));
  const { models } = await discoverModels('openai', 'sk-test');
  assert.deepStrictEqual(models, ['gpt-5-mini']);
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

await test('perplexity main: prefers sonar-reasoning-pro (successor of retired sonar-reasoning)', async () => {
  stub(() => ok({ data: [
    { id: 'sonar' },
    { id: 'sonar-pro' },
    // Include the RETIRED sonar-reasoning so a partial revert (re-adding it to the
    // top of the preference chain) would flip this assertion and fail.
    { id: 'sonar-reasoning' },
    { id: 'sonar-reasoning-pro' },
  ]}));
  const { models } = await discoverModels('perplexity', 'pplx-test');
  assert.deepStrictEqual(models, ['sonar-reasoning-pro']);
});

await test('perplexity main: falls back to sonar-pro if sonar-reasoning-pro absent', async () => {
  stub(() => ok({ data: [{ id: 'sonar' }, { id: 'sonar-pro' }] }));
  const { models } = await discoverModels('perplexity', 'pplx-test');
  assert.deepStrictEqual(models, ['sonar-pro']);
});

await test('perplexity main: 404 /models endpoint → preference chain fallback (sonar-reasoning-pro)', async () => {
  stub(() => err(404));
  const { models, authError } = await discoverModels('perplexity', 'pplx-test');
  assert.equal(authError, false);
  assert.deepStrictEqual(models, ['sonar-reasoning-pro']);
});

await test('perplexity: 401 → authError', async () => {
  stub(() => err(401));
  const { authError } = await discoverModels('perplexity', 'bad');
  assert.equal(authError, true);
});

console.log('\ndiscoverClassifyModel OpenAI');

await test('openai classify: mini WINS within the gen one behind main (inverse of main policy)', async () => {
  stub(() => ok({ data: [
    { id: 'gpt-5-search-api' },  // anchors "newest search gen" = 5
    { id: 'gpt-5' },
    { id: 'gpt-5-mini' },
    { id: 'gpt-4o' },
    { id: 'gpt-4o-mini' },
    { id: 'gpt-3.5-turbo' },
  ]}));
  const { models } = await discoverClassifyModel('openai', 'sk-test');
  assert.deepStrictEqual(models, ['gpt-4o-mini']);  // gen 4 (= 5-1), mini wins
});

await test('openai classify: falls back to newest classify-eligible gen when the gen-behind has none', async () => {
  stub(() => ok({ data: [
    { id: 'gpt-5-search-api' },
    { id: 'gpt-5-mini' },
  ]}));
  const { models } = await discoverClassifyModel('openai', 'sk-test');
  assert.deepStrictEqual(models, ['gpt-5-mini']);
});

await test('openai classify: search variants excluded even as last resort', async () => {
  stub(() => ok({ data: [
    { id: 'gpt-5-search-api' },
    { id: 'gpt-5-mini-search-api' },
  ]}));
  const { models } = await discoverClassifyModel('openai', 'sk-test');
  assert.equal(models, null);
});

console.log('\ndiscoverClassifyModel Anthropic');

await test('anthropic classify: haiku one gen behind the newest sonnet', async () => {
  stub(() => ok({ data: [
    { id: 'claude-sonnet-5-1', created_at: '2026-06-01' },
    { id: 'claude-sonnet-4-6', created_at: '2026-01-15' },
    { id: 'claude-haiku-4-5', created_at: '2026-02-01' },
    { id: 'claude-haiku-3-5', created_at: '2025-05-01' },
  ]}));
  const { models } = await discoverClassifyModel('anthropic', 'sk-test');
  assert.deepStrictEqual(models, ['claude-haiku-4-5']);
});

await test('anthropic classify: falls back to newest haiku overall when none in the gen-behind', async () => {
  stub(() => ok({ data: [
    { id: 'claude-sonnet-5-1', created_at: '2026-06-01' },
    { id: 'claude-haiku-3-5', created_at: '2025-05-01' },
  ]}));
  const { models } = await discoverClassifyModel('anthropic', 'sk-test');
  assert.deepStrictEqual(models, ['claude-haiku-3-5']);
});

console.log('\ndiscoverClassifyModel Gemini (classify targets the cheapest live flash-lite tier — gemini-3.1-flash-lite, see discover.js. 2.5 generation retired by Google 2026-08-13.)');

await test('gemini classify: pins gemini-3.1-flash-lite while main picks the newest flash', async () => {
  const catalogue = () => ok({ models: [
    { name: 'models/gemini-3.5-flash',           supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-3.5-flash-lite',      supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-3.1-flash',           supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-3.1-flash-lite',      supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-3.1-flash-lite-preview', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-2.5-flash',           supportedGenerationMethods: ['generateContent'] },
  ]});
  stub(catalogue);
  const main = await discoverModels('gemini', 'AIzaSy');
  stub(catalogue);
  const classify = await discoverClassifyModel('gemini', 'AIzaSy');
  assert.deepStrictEqual(main.models, ['gemini-3.5-flash']);            // newest flash (answer tier)
  assert.deepStrictEqual(classify.models, ['gemini-3.1-flash-lite']);   // cheapest live flash-lite tier
  assert.notDeepStrictEqual(classify.models, main.models);
});

await test('gemini classify: excludes preview/image/tts — returns null when no plain 3.1-flash-lite exists', async () => {
  stub(() => ok({ models: [
    { name: 'models/gemini-3.1-flash-lite-preview', supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-3.1-flash-lite-image',   supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-2.5-flash',              supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-3.5-flash',              supportedGenerationMethods: ['generateContent'] },
  ]}));
  const classify = await discoverClassifyModel('gemini', 'AIzaSy');
  assert.deepStrictEqual(classify.models, null);  // → falls through to cfg/FALLBACK ('gemini-3.1-flash-lite')
});

console.log('\ndiscoverClassifyModel Perplexity');

await test('perplexity classify: prefers cheap plain sonar (≠ main; decision Alex 2026-07-13)', async () => {
  stub(() => ok({ data: [
    { id: 'sonar' },
    { id: 'sonar-pro' },
    { id: 'sonar-reasoning-pro' },
  ]}));
  const { models } = await discoverClassifyModel('perplexity', 'pplx-test');
  assert.deepStrictEqual(models, ['sonar']);  // cheap classify tier, not the reasoning main
});

await test('perplexity classify: falls back to sonar-pro when plain sonar absent', async () => {
  stub(() => ok({ data: [{ id: 'sonar-pro' }, { id: 'sonar-reasoning-pro' }] }));
  const { models } = await discoverClassifyModel('perplexity', 'pplx-test');
  assert.deepStrictEqual(models, ['sonar-pro']);
});

await test('perplexity classify: 404 /models endpoint → preference chain fallback (sonar)', async () => {
  stub(() => err(404));
  const { models, authError } = await discoverClassifyModel('perplexity', 'pplx-test');
  assert.equal(authError, false);
  assert.deepStrictEqual(models, ['sonar']);
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

// ─── resolveClassifyModel — the report path's classify tier ─────────────────
//
// cmdRun rediscovers both tiers every run; the report path read the config pin
// verbatim, so a model retired AFTER a project's config was written failed on
// every report from then on — silently, since the classification is only
// persisted on success. Google retired the whole gemini-2.5 generation on
// 2026-08-13 while still listing it in /v1beta/models, and seven local configs
// (four of them clients) still pinned gemini-2.5-flash there.
//
// Tested at this level ON PURPOSE, not end-to-end: exercising the real report
// path means a working classify model, which means a real billed API call.
// `discoverFn` is injected so nothing here reaches the network.
console.log('\nresolveClassifyModel — report path');

const CFG_STALE = { model: 'gemini-3.5-flash', classifyModel: 'gemini-2.5-flash', env: 'GEMINI_TEST_KEY' };
const ENV_WITH_KEY = { GEMINI_TEST_KEY: 'k-test' };

await test('live discovery overrides a stale model pinned in the config', async () => {
  const model = await resolveClassifyModel('gemini', CFG_STALE, {
    env: ENV_WITH_KEY,
    discoverFn: async () => ({ models: ['gemini-3.1-flash-lite'], authError: false }),
  });
  assert.equal(model, 'gemini-3.1-flash-lite',
    'a config pin that names a retired model must lose to what the catalogue actually serves');
});

await test('discovery returning nothing falls back to the config pin, not to undefined', async () => {
  const model = await resolveClassifyModel('gemini', CFG_STALE, {
    env: ENV_WITH_KEY,
    discoverFn: async () => ({ models: null, authError: false }),
  });
  assert.equal(model, 'gemini-2.5-flash',
    'an offline report must still classify with whatever the config names — same behaviour as before');
});

await test('a throwing discovery never takes the report down with it', async () => {
  const model = await resolveClassifyModel('gemini', CFG_STALE, {
    env: ENV_WITH_KEY,
    discoverFn: async () => { throw new Error('network down'); },
  });
  assert.equal(model, 'gemini-2.5-flash');
});

await test('no API key means no discovery call at all', async () => {
  let called = false;
  const model = await resolveClassifyModel('gemini', CFG_STALE, {
    env: {},
    discoverFn: async () => { called = true; return { models: ['x'], authError: false }; },
  });
  assert.equal(called, false, 'a keyless project must not fire a discovery request');
  assert.equal(model, 'gemini-2.5-flash');
});

await test('a config with no classify tier at all lands on FALLBACK, never undefined', async () => {
  const model = await resolveClassifyModel('gemini', { env: 'GEMINI_TEST_KEY' }, {
    env: {},
    discoverFn: async () => ({ models: null, authError: false }),
  });
  assert.equal(model, FALLBACK.gemini.classify,
    'passing undefined as the model would send the request with no model and 400');
});

await test('no shipped default names a retired gemini-2.5 model', async () => {
  // The generation is gone for new API access but is still LISTED by
  // /v1beta/models, so discovery cannot self-detect it — the only guard is
  // that we never ship it as a default again.
  for (const p of ['openai', 'anthropic', 'gemini', 'perplexity']) {
    assert.doesNotMatch(String(FALLBACK[p].classify), /^gemini-2\.5\b/);
    assert.doesNotMatch(String(FALLBACK[p].main), /^gemini-2\.5\b/);
  }
});

restore();
process.stderr.write = originalStderrWrite;

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

// Tests for lib/providers/discover.js — HTTP discovery with selection rules.
//
// Each test stubs fetch with a representative /v1/models response (10-15 model
// IDs including edge cases: dated suffixes, audio variants, mini-search,
// preview suffixes, legacy gens) and asserts the correct top-pick.

import assert from 'node:assert/strict';

const { discoverModels, discoverClassifyModel, resolveClassifyModel, resolveClassifyDecision, FALLBACK, isOpenAIChatId, isOpenAIClassifyCapableId, selectOpenAIMain, selectOpenAIClassify } = await import('../lib/providers/discover.js');
const { readFileSync } = await import('node:fs');
const { join, dirname } = await import('node:path');
const { fileURLToPath } = await import('node:url');
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
    const { models, selection } = await discoverModels('openai', 'sk-test');
    assert.equal(models[0].startsWith('gpt-6-'), true, `expected a gen-6 pick, got ${models[0]}`);
    // Discovery REPORTS the pick and says it is not a recognised cheap tier; the
    // decision not to run on it is the run loop's (lib/config.js
    // resolveRunModels, E2E in run-model-selection-safety.test.js).
    assert.equal(selection.cheapTier, false);
    assert.equal(selection.generation, 6);
    assert.ok(selection.catalogueIds.includes('gpt-5.6-luna'), 'the key\'s own catalogue travels with the pick');
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

await test('openai: newest generation is REPORTED even when nothing in it is a recognised cheap tier — flagged, not blessed', async () => {
  stub(() => ok({ data: [
    { id: 'gpt-5' },
    { id: 'gpt-5.4' },
  ]}));
  const { models, selection } = await discoverModels('openai', 'sk-test');
  assert.deepStrictEqual(models, ['gpt-5.4']);
  assert.equal(selection.cheapTier, false, 'a pick with no recognised cheap tier must say so');
});

await test('openai: a recognised cheap tier is flagged cheapTier:true', async () => {
  stub(() => ok({ data: [{ id: 'gpt-6.1-sol' }, { id: 'gpt-6.1-luna' }, { id: 'gpt-6-luna' }] }));
  const { models, selection } = await discoverModels('openai', 'sk-test');
  assert.deepStrictEqual(models, ['gpt-6.1-luna']);
  assert.equal(selection.cheapTier, true);
});

await test('openai main: non-chat ids from the live catalogue never enter the pool', async () => {
  // Real ids from the key, 2026-10-13. A bare `^gpt-` prefix lets every one of
  // these in; the newest "generation" among them would win by parseFloat.
  stub(() => ok({ data: [
    { id: 'gpt-live-1' }, { id: 'gpt-transcribe' }, { id: 'gpt-realtime-2.1' },
    { id: 'gpt-image-2.5-flare' }, { id: 'gpt-4o-transcribe-diarize' },
    { id: 'gpt-5.6-luna' },
  ]}));
  const { models } = await discoverModels('openai', 'sk-test');
  assert.deepStrictEqual(models, ['gpt-5.6-luna']);
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

console.log('\nOpenAI cheap tier — chat models only, same answer on every request (2026-10-11 defect)');

// The ids the live key lists, 2026-10-13, trimmed to the families that matter.
const LIVE_LIKE = [
  'gpt-4o-mini-transcribe', 'gpt-4o-mini-transcribe-2025-12-15', 'gpt-4o-mini-tts', 'gpt-4o-mini-tts-2025-12-15',
  'gpt-4.1-mini', 'gpt-4.1-mini-2025-04-14', 'gpt-4o-mini', 'gpt-4o-mini-2024-07-18', 'gpt-4o',
  'gpt-4o-mini-search-preview', 'gpt-5-search-api',
  'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-6.1-sol', 'gpt-6-luna',
];

await test('openai classify: tts / transcribe are never the extractor (was: the first -mini in catalogue order)', async () => {
  stub(() => ok({ data: LIVE_LIKE.map(id => ({ id })) }));
  const { models } = await discoverClassifyModel('openai', 'sk-test');
  assert.deepStrictEqual(models, ['gpt-4o-mini']);
});

await test('openai classify: the answer does not depend on the order the catalogue lists ids in', async () => {
  const picks = new Set();
  for (const order of [LIVE_LIKE, [...LIVE_LIKE].reverse(), [...LIVE_LIKE].sort(), [...LIVE_LIKE].sort().reverse()]) {
    stub(() => ok({ data: order.map(id => ({ id })) }));
    picks.add((await discoverClassifyModel('openai', 'sk-test')).models[0]);
  }
  assert.deepStrictEqual([...picks], ['gpt-4o-mini']);
});

await test('openai classify: no chat model at all → null (the run stops), never a non-chat id', async () => {
  stub(() => ok({ data: ['gpt-5-search-api', 'gpt-4o-mini-tts', 'gpt-4o-mini-transcribe', 'gpt-realtime-2.1', 'gpt-audio-mini'].map(id => ({ id })) }));
  const { models, selection } = await discoverClassifyModel('openai', 'sk-test');
  assert.equal(models, null);
  assert.deepStrictEqual(selection.pool, []);
});

await test('openai classify: a pool with no recognised cheap tier is flagged, not blessed', async () => {
  stub(() => ok({ data: [{ id: 'gpt-5-search-api' }, { id: 'gpt-4o' }, { id: 'gpt-4' }] }));
  const { selection } = await discoverClassifyModel('openai', 'sk-test');
  assert.equal(selection.cheapTier, false);
});

await test('selectOpenAIClassify / selectOpenAIMain are pure and agree with the fetchers', () => {
  const c = selectOpenAIClassify(LIVE_LIKE);
  assert.equal(c.picked, 'gpt-4o-mini');
  assert.equal(c.cheapTier, true);
  const m = selectOpenAIMain(LIVE_LIKE);
  assert.equal(m.picked, 'gpt-6.1-sol');
  assert.equal(m.cheapTier, false, 'generation 6.1 holds only gpt-6.1-sol — no recognised cheap tier');
});

await test('isOpenAIChatId: every non-chat family on the live key is rejected, chat ids pass', () => {
  const nonChat = [
    'gpt-4o-mini-tts', 'gpt-4o-mini-transcribe', 'gpt-4o-transcribe-diarize', 'gpt-transcribe',
    'gpt-realtime-2.1', 'gpt-realtime-whisper', 'gpt-realtime-translate', 'gpt-audio-mini',
    'gpt-image-2', 'gpt-image-2.5-sunburst', 'gpt-live-1', 'gpt-live-transcribe',
    'gpt-5-search-api', 'gpt-4o-mini-search-preview', 'gpt-5.1-codex-max', 'gpt-5-chat-latest',
    'gpt-5.5-pro', 'gpt-5-pro', 'gpt-3.5-turbo-instruct',
    // not `gpt-<N>` at all:
    'whisper-1', 'tts-1-hd', 'text-embedding-3-small', 'omni-moderation-latest', 'sora-2', 'o3', 'davinci-002', 'chat-latest',
  ];
  for (const id of nonChat) assert.equal(isOpenAIChatId(id), false, `${id} must not be a chat id`);
  const chat = ['gpt-4o-mini', 'gpt-4.1-mini', 'gpt-4.1-mini-2025-04-14', 'gpt-5-nano', 'gpt-5.6-luna', 'gpt-6-luna', 'gpt-6.1-sol', 'gpt-3.5-turbo'];
  for (const id of chat) assert.equal(isOpenAIChatId(id), true, `${id} must be a chat id`);
});

// ── The live catalogue, as a fixture (133 ids, GET /v1/models 2026-10-13) ────
//
// The selectors above are exercised on short hand-written lists, and the defect
// of 2026-10-11 was an UNKNOWN family reaching the pool — a list its author chose
// cannot show that. Here the whole catalogue goes through, and the expectation is
// a hand-labelled list, not the filter's own output: a new id on a refreshed
// fixture fails the first test until someone has said whether it is a chat model.
const LIVE_IDS = JSON.parse(readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'openai-models-2026-10-13.json'), 'utf-8')).ids;

// Hand-labelled 2026-10-13: the numbered gpt-N text/chat models, dated snapshots
// included. Everything else on the key is audio, speech, transcription, image,
// realtime, live, search, codex, *-chat-latest aliases, *-pro, completions-only
// (`instruct`), embeddings, moderation, video, or a pre-gpt legacy id.
const LIVE_USABLE = [
  'gpt-3.5-turbo', 'gpt-3.5-turbo-0125', 'gpt-3.5-turbo-1106', 'gpt-3.5-turbo-16k',
  'gpt-4', 'gpt-4-0613', 'gpt-4-turbo', 'gpt-4-turbo-2024-04-09',
  'gpt-4.1', 'gpt-4.1-2025-04-14', 'gpt-4.1-mini', 'gpt-4.1-mini-2025-04-14', 'gpt-4.1-nano', 'gpt-4.1-nano-2025-04-14',
  'gpt-4o', 'gpt-4o-2024-05-13', 'gpt-4o-2024-08-06', 'gpt-4o-2024-11-20', 'gpt-4o-mini', 'gpt-4o-mini-2024-07-18',
  'gpt-5', 'gpt-5-2025-08-07', 'gpt-5-mini', 'gpt-5-mini-2025-08-07', 'gpt-5-nano', 'gpt-5-nano-2025-08-07',
  'gpt-5.1', 'gpt-5.1-2025-11-13', 'gpt-5.2', 'gpt-5.2-2025-12-11',
  'gpt-5.4', 'gpt-5.4-2026-03-05', 'gpt-5.4-mini', 'gpt-5.4-mini-2026-03-17', 'gpt-5.4-nano', 'gpt-5.4-nano-2026-03-17',
  'gpt-5.5', 'gpt-5.5-2026-04-23', 'gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.6-terra',
  'gpt-6-astra', 'gpt-6-luna', 'gpt-6-sol', 'gpt-6.1-sol',
];
// Chat-capable but without a gpt-N number: the reasoning series. Usable when an
// operator NAMES one (config / fallback rung), never ranked by discovery.
const LIVE_REASONING = [
  'o1', 'o1-2024-12-17', 'o3', 'o3-2025-04-16', 'o3-mini', 'o3-mini-2025-01-31', 'o4-mini', 'o4-mini-2025-04-16',
];

// Deterministic shuffles (no Math.random: a flaky order is not an order).
function shuffled(list, seed) {
  const out = [...list];
  let x = seed;
  for (let i = out.length - 1; i > 0; i--) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    const j = x % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

await test('live catalogue: exactly the hand-labelled chat models pass isOpenAIChatId — an unlabelled family fails here', () => {
  assert.equal(LIVE_IDS.length, 133, 'the fixture is the 133-id listing');
  assert.deepStrictEqual(LIVE_IDS.filter(isOpenAIChatId).sort(), [...LIVE_USABLE].sort());
  // Nothing hand-labelled is missing from the listing (a stale label list would
  // otherwise pass by being a superset).
  for (const id of LIVE_USABLE) assert.ok(LIVE_IDS.includes(id), `${id} is labelled usable but is not in the fixture`);
});

await test('live catalogue: the reasoning series is classify-capable by name, pro/instruct/search are not', () => {
  assert.deepStrictEqual(
    LIVE_IDS.filter((id) => isOpenAIClassifyCapableId(id) && !isOpenAIChatId(id)).sort(),
    [...LIVE_REASONING].sort(),
  );
  for (const id of ['o1-pro', 'o1-pro-2025-03-19', 'omni-moderation-latest', 'o3-mini-search']) {
    assert.equal(isOpenAIClassifyCapableId(id), false, `${id}`);
  }
});

await test('live catalogue, 24 seeded orders: the cheap tier is gpt-4o-mini every time and always a chat model', () => {
  const picks = new Set();
  for (let seed = 1; seed <= 24; seed++) {
    const sel = selectOpenAIClassify(shuffled(LIVE_IDS, seed));
    assert.ok(isOpenAIChatId(sel.picked), `seed ${seed}: ${sel.picked} is not a chat model`);
    picks.add(sel.picked);
  }
  assert.deepStrictEqual([...picks], ['gpt-4o-mini']);
});

await test('live catalogue, leave-one-out: whichever id disappears, neither tier picks a non-chat model', () => {
  for (const gone of LIVE_IDS) {
    const rest = LIVE_IDS.filter((id) => id !== gone);
    const c = selectOpenAIClassify(rest).picked;
    const m = selectOpenAIMain(rest).picked;
    assert.ok(c === null || isOpenAIChatId(c), `without ${gone}: classify picked ${c}`);
    assert.ok(m === null || isOpenAIChatId(m), `without ${gone}: main picked ${m}`);
  }
});

await test('live catalogue, main tier: gpt-6.1-sol is the only 6.1 id and is reported as no cheap tier, in any order', () => {
  for (let seed = 1; seed <= 6; seed++) {
    const m = selectOpenAIMain(shuffled(LIVE_IDS, seed));
    assert.equal(m.picked, 'gpt-6.1-sol');
    assert.equal(m.cheapTier, false);
    assert.equal(m.generation, 6.1);
  }
});

await test('resolveClassifyDecision (run-manual / report): the same refusal as run — a listed config tts id is rejected, not taken', async () => {
  const sel = { cheapTier: false, catalogueIds: ['gpt-5-search-api', 'gpt-4o', 'gpt-4o-mini-tts'], pool: ['gpt-4o'] };
  const d = await resolveClassifyDecision('openai', { classifyModel: 'gpt-4o-mini-tts', env: 'OPENAI_API_KEY' }, {
    env: { OPENAI_API_KEY: 'sk-test' },
    discoverFn: async () => ({ models: ['gpt-4o'], selection: sel }),
  });
  assert.equal(d.model, null);
  assert.equal(d.refused, 'no-usable-classify-model');
  assert.deepStrictEqual(d.rejected, ['gpt-4o-mini-tts']);
  // The report path may not block: it returns the config pin — and says so.
  const lines = [];
  const prev = process.stderr.write;
  process.stderr.write = (s, ...rest) => { if (typeof s === 'string' && s.includes('[discover-warn]')) { lines.push(s); return true; } return prev.call(process.stderr, s, ...rest); };
  try {
    const model = await resolveClassifyModel('openai', { classifyModel: 'gpt-4o-mini-tts', env: 'OPENAI_API_KEY' }, {
      env: { OPENAI_API_KEY: 'sk-test' },
      discoverFn: async () => ({ models: ['gpt-4o'], selection: sel }),
    });
    assert.equal(model, 'gpt-4o-mini-tts', 'never-block: the configured id comes back');
  } finally { process.stderr.write = prev; }
  assert.equal(lines.length, 1, 'the report path must say why its classification may come back empty');
  assert.match(lines[0], /gpt-4o-mini-tts is listed but is not a chat model by name/);
});

await test('resolveClassifyModel (report path): a pick with no recognised cheap tier is NOT taken — the config pin stands', async () => {
  const cfg = { classifyModel: 'gpt-5-nano', env: 'OPENAI_API_KEY' };
  const out = await resolveClassifyModel('openai', cfg, {
    env: { OPENAI_API_KEY: 'sk-test' },
    discoverFn: async () => ({ models: ['gpt-6.1-sol'], selection: { cheapTier: false } }),
  });
  assert.equal(out, 'gpt-5-nano');
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

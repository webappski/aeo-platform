// Tests for lib/providers/discover.js — HTTP discovery with selection rules.
//
// Each test stubs fetch with a representative /v1/models response (10-15 model
// IDs including edge cases: dated suffixes, audio variants, mini-search,
// preview suffixes, legacy gens) and asserts the correct top-pick.

import assert from 'node:assert/strict';

const { discoverModels, discoverClassifyModel, resolveClassifyModel, resolveClassifyDecision, FALLBACK, isOpenAIChatId, isOpenAIClassifyCapableId, selectOpenAIMain, selectOpenAIClassify, MAIN_CHEAP_TIER } = await import('../lib/providers/discover.js');
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
    assert.equal(selection.generation, '6');
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
  assert.equal(m.picked, 'gpt-6-luna');
  assert.equal(m.cheapTier, true, 'generation 6.1 holds only gpt-6.1-sol; the family\'s cheap tier is gpt-6-luna (AP-7)');
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

// The catalogue of 2026-10-27: the same key, one id later — generation 6.1 now lists
// gpt-6.1-terra (the BALANCED tier, ten times a luna) next to gpt-6.1-sol.
const LIVE_27 = JSON.parse(readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'openai-models-2026-10-27.json'), 'utf-8')).ids;

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

await test('U9 · live catalogue, main tier: gpt-6.1-sol is the only 6.1 id, so the pick is the family\'s cheap tier gpt-6-luna, in any order', () => {
  for (let seed = 1; seed <= 6; seed++) {
    const m = selectOpenAIMain(shuffled(LIVE_IDS, seed));
    assert.equal(m.picked, 'gpt-6-luna');
    assert.equal(m.cheapTier, true);
    assert.strictEqual(m.generation, '6');
    assert.strictEqual(m.newestGeneration, '6.1');
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

// ─── AP-7 — the cheap tier of the NEWEST FAMILY, not of the newest generation ──
//
// Founder 2026-09-01: "the latest model, the cheap modification". 6.1 shipped
// `gpt-6.1-sol` alone, so the newest generation has no cheap tier — and the rule
// 10d2a7f (2026-10-13) then refused to pick anything on a new user's behalf, who
// ran on whatever init had frozen in the config (`gpt-5.6-luna`), a generation
// behind and twice the price. The expectations below come from the rule and the
// vendor's pages (developers.openai.com/api/docs/models, /deprecations,
// 2026-10-25), never from what selectOpenAIMain printed: OpenAI lists
// "GPT-6 Astra for complex reasoning and coding, GPT-6.1 Sol to balance
// intelligence and cost, or GPT-6 Luna for cost-sensitive, high-volume
// workloads" in one row of choices, and names gpt-6-luna as the replacement of
// every cheap id it retires after gen 6 — so gpt-6-luna is the cheap tier of the
// current family 6, not "the previous generation".
//
// Generation order is (major, minor) as NUMBERS (semver.org §11.2): 6.10 is newer
// than 6.9, and 6.10 is not 6.1. The three generation fields are STRINGS in the
// form the id spells them, because the number 6.10 cannot be told from 6.1.
console.log('\nAP-7 — cheap tier of the newest family; generation order is (major, minor)');

// LIVE minus every id the cheap-tier list recognises: the catalogue of a day on
// which a new generation ships no cheap tier at all. The list is IMPORTED and used
// only to build an input — an expectation built from it would agree with itself.
const NO_TIER = LIVE_IDS.filter((id) => !MAIN_CHEAP_TIER.some((re) => re.test(id)));
const live = (...extra) => [...LIVE_IDS, ...extra];

/** The `[discover-warn] openai` lines a discovery over `ids` writes to stderr. */
async function openaiWarnLines(ids) {
  const lines = [];
  const prev = process.stderr.write;
  process.stderr.write = (s, ...rest) => {
    if (typeof s === 'string' && s.includes('[discover-warn]')) { lines.push(s); return true; }
    return originalStderrWrite(s, ...rest);
  };
  try {
    stub(() => ok({ data: ids.map((id) => ({ id })) }));
    await discoverModels('openai', 'sk-test');
  } finally {
    process.stderr.write = prev;
  }
  return lines.filter((l) => l.includes('[discover-warn] openai'));
}

await test('U1·a · live catalogue: the pick is the cheap tier of family 6, gpt-6-luna', () => {
  const m = selectOpenAIMain(LIVE_IDS);
  assert.strictEqual(m.picked, 'gpt-6-luna');
  assert.strictEqual(m.cheapTier, true);
  assert.strictEqual(m.pool[0], 'gpt-6-luna');
  assert.ok(m.pool.every((id) => /^gpt-6-/.test(id)), `pool is the chosen generation only: ${m.pool}`);
});

await test('U1·b · live catalogue: chosen generation 6, newest 6.1, skipped [6.1 → gpt-6.1-sol]', () => {
  const m = selectOpenAIMain(LIVE_IDS);
  assert.strictEqual(m.generation, '6');
  assert.strictEqual(m.newestGeneration, '6.1');
  assert.deepStrictEqual(m.skipped, [{ generation: '6.1', ids: ['gpt-6.1-sol'] }]);
});

await test('U2a · a 5.x catalogue with luna in 5.6 picks gpt-5.6-luna, not 5.4-mini (mini ranks above luna: 5.x must not merge into one pool)', () => {
  const m = selectOpenAIMain(['gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.4-mini']);
  assert.strictEqual(m.picked, 'gpt-5.6-luna');
  assert.strictEqual(m.cheapTier, true);
});

await test('U2b · the same catalogue: generation 5.6 is also the newest, nothing skipped', () => {
  const m = selectOpenAIMain(['gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.4-mini']);
  assert.strictEqual(m.generation, '5.6');
  assert.strictEqual(m.newestGeneration, '5.6');
  assert.deepStrictEqual(m.skipped, []);
});

await test('U3 · live + gpt-6.2-ember (no recognised tier): descends through 6.2 and 6.1 to gpt-6-luna and names both', () => {
  const m = selectOpenAIMain(live('gpt-6.2-ember'));
  assert.strictEqual(m.picked, 'gpt-6-luna');
  assert.strictEqual(m.cheapTier, true);
  assert.strictEqual(m.generation, '6');
  assert.strictEqual(m.newestGeneration, '6.2');
  assert.strictEqual(m.balanced, false, 'a low-cost tier two generations down is found in the FIRST pass');
  assert.deepStrictEqual(m.skipped, [
    { generation: '6.2', ids: ['gpt-6.2-ember'] },
    { generation: '6.1', ids: ['gpt-6.1-sol'] },
  ]);
});

await test('U4·a · a catalogue with no cheap tier in the whole family: the pick is the flagship and says cheapTier:false', () => {
  const m = selectOpenAIMain(NO_TIER);
  assert.strictEqual(m.picked, 'gpt-6.1-sol');
  assert.strictEqual(m.cheapTier, false);
  assert.deepStrictEqual(m.pool, ['gpt-6.1-sol']);
});

await test('U4·b · …and the other generations of the family are named as skipped, in pool sort order', () => {
  const m = selectOpenAIMain(NO_TIER);
  assert.strictEqual(m.generation, '6.1');
  assert.strictEqual(m.newestGeneration, '6.1');
  // The id order inside `skipped` is the director\'s contract (card AP-7, V2:
  // "in the sort order of the pool"), not the founder\'s rule.
  assert.deepStrictEqual(m.skipped, [{ generation: '6', ids: ['gpt-6-sol', 'gpt-6-astra'] }]);
});

await test('U5·a · live + gpt-7-astra: family 7 has no tier, the descent does not cross into family 6', () => {
  const m = selectOpenAIMain(live('gpt-7-astra'));
  assert.strictEqual(m.picked, 'gpt-7-astra');
  assert.strictEqual(m.cheapTier, false);
  assert.deepStrictEqual(m.pool, ['gpt-7-astra']);
});

await test('U5·b · …family 7 holds one generation, so nothing is skipped', () => {
  const m = selectOpenAIMain(live('gpt-7-astra'));
  assert.strictEqual(m.generation, '7');
  assert.strictEqual(m.newestGeneration, '7');
  assert.deepStrictEqual(m.skipped, []);
});

await test('U6·a · 5.7 without a tier above 5.6 with one: the FIRST generation that has a tier wins, not the best tier of all lower ones', () => {
  const m = selectOpenAIMain(['gpt-5.7-sol', 'gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.4-mini']);
  assert.strictEqual(m.picked, 'gpt-5.6-luna');
  assert.strictEqual(m.cheapTier, true);
});

await test('U6·b · …generation 5.6, newest 5.7, skipped [5.7 → gpt-5.7-sol]', () => {
  const m = selectOpenAIMain(['gpt-5.7-sol', 'gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.4-mini']);
  assert.strictEqual(m.generation, '5.6');
  assert.strictEqual(m.newestGeneration, '5.7');
  assert.deepStrictEqual(m.skipped, [{ generation: '5.7', ids: ['gpt-5.7-sol'] }]);
});

await test('U7 · a non-chat id of a newer family (even one labelled mini) does not set the family', () => {
  const m = selectOpenAIMain(live('gpt-7-transcribe', 'gpt-7-pro', 'gpt-7-realtime-mini'));
  assert.strictEqual(m.picked, 'gpt-6-luna');
  assert.strictEqual(m.generation, '6');
  assert.strictEqual(m.newestGeneration, '6.1');
});

await test('U8 · a dated snapshot of the flagship is skipped with it, the undated id first', () => {
  const m = selectOpenAIMain(live('gpt-6.1-sol-2026-10-01'));
  assert.strictEqual(m.picked, 'gpt-6-luna');
  assert.deepStrictEqual(m.skipped, [{ generation: '6.1', ids: ['gpt-6.1-sol', 'gpt-6.1-sol-2026-10-01'] }]);
});

await test('U10·a · live + gpt-6.1-luna: a tier in the newest generation is taken directly (control)', () => {
  const m = selectOpenAIMain(live('gpt-6.1-luna'));
  assert.strictEqual(m.picked, 'gpt-6.1-luna');
  assert.strictEqual(m.cheapTier, true);
});

await test('U10·b · …nothing skipped', () => {
  const m = selectOpenAIMain(live('gpt-6.1-luna'));
  assert.strictEqual(m.generation, '6.1');
  assert.strictEqual(m.newestGeneration, '6.1');
  assert.deepStrictEqual(m.skipped, []);
});

await test('U11a · 6.10 is NEWER than 6.9: generations are ordered as (major, minor) numbers, not as decimals', () => {
  const m = selectOpenAIMain(['gpt-6.9-luna', 'gpt-6.10-luna']);
  assert.strictEqual(m.picked, 'gpt-6.10-luna');
  assert.strictEqual(m.generation, '6.10');
  assert.strictEqual(m.newestGeneration, '6.10');
});

await test('U11b · 6.10 is not 6.1: a 6.10 flagship does not join the 6.1 pool', () => {
  const m = selectOpenAIMain(['gpt-6.10-sol', 'gpt-6.1-luna', 'gpt-6.1-sol']);
  assert.strictEqual(m.picked, 'gpt-6.1-luna');
  assert.deepStrictEqual(m.pool, ['gpt-6.1-luna', 'gpt-6.1-sol']);
  assert.strictEqual(m.generation, '6.1');
  assert.strictEqual(m.newestGeneration, '6.10');
  assert.deepStrictEqual(m.skipped, [{ generation: '6.10', ids: ['gpt-6.10-sol'] }]);
});

await test('U17 · the live catalogue of 2026-10-27 (6.1 = sol + terra): terra is balanced, not cheap — the pick is gpt-6-luna and 6.1 is skipped with BOTH ids', () => {
  const m = selectOpenAIMain(LIVE_27);
  assert.strictEqual(m.picked, 'gpt-6-luna');
  assert.strictEqual(m.cheapTier, true);
  assert.strictEqual(m.balanced, false);
  assert.strictEqual(m.generation, '6');
  assert.strictEqual(m.newestGeneration, '6.1');
  assert.deepStrictEqual(m.skipped, [{ generation: '6.1', ids: ['gpt-6.1-terra', 'gpt-6.1-sol'] }]);
});

await test('U18 · terra and luna in the SAME generation: luna wins (the 5.6 precedent), nothing is skipped', () => {
  const m = selectOpenAIMain(['gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.4-mini']);
  assert.strictEqual(m.picked, 'gpt-5.6-luna');
  assert.strictEqual(m.balanced, false);
  assert.deepStrictEqual(m.skipped, []);
});

await test('U19 · a family with a balanced tier and NO low-cost tier anywhere: the second pass takes terra, and says so', async () => {
  const ids = [...LIVE_27.filter((id) => !/^gpt-6/.test(id)), 'gpt-7-sol', 'gpt-7-terra'];
  const m = selectOpenAIMain(ids);
  assert.strictEqual(m.picked, 'gpt-7-terra');
  assert.strictEqual(m.cheapTier, true);
  assert.strictEqual(m.balanced, true);
  const lines = await openaiWarnLines(ids);
  assert.strictEqual(lines.length, 1, `always one line for the balanced tier; got ${lines.length}:\n${lines.join('')}`);
  for (const must of ['family 7', 'gpt-7-terra', 'no low-cost tier', '--openai-model']) assert.ok(lines[0].includes(must), `the line must contain ${must}:\n${lines[0]}`);
  assert.ok(!lines[0].includes('will not take it on its own'), `the balanced tier IS taken:\n${lines[0]}`);
});

await test('U20 · discovery over the 2026-10-27 catalogue: ONE warning naming 6.1, gpt-6.1-terra, gpt-6.1-sol and the pick gpt-6-luna', async () => {
  const lines = await openaiWarnLines(LIVE_27);
  assert.strictEqual(lines.length, 1, `exactly one line; got ${lines.length}:\n${lines.join('')}`);
  for (const must of ['6.1', 'gpt-6.1-terra', 'gpt-6.1-sol', 'gpt-6-luna']) assert.ok(lines[0].includes(must), `the line must name ${must}:\n${lines[0]}`);
});

await test('U12 · the classifier pick is untouched by the family rule: gpt-4o-mini on the live catalogue', () => {
  assert.strictEqual(selectOpenAIClassify(LIVE_IDS).picked, 'gpt-4o-mini');
});

await test('U13 · discovery over live: ONE warning that names the skipped generation 6.1 / gpt-6.1-sol and the pick gpt-6-luna, and does not say "will not take it on its own"', async () => {
  const lines = await openaiWarnLines(LIVE_IDS);
  assert.strictEqual(lines.length, 1, `exactly one [discover-warn] openai line; got ${lines.length}:\n${lines.join('')}`);
  for (const must of ['6.1', 'gpt-6.1-sol', 'gpt-6-luna']) assert.ok(lines[0].includes(must), `the line must name ${must}:\n${lines[0]}`);
  assert.ok(!lines[0].includes('will not take it on its own'), `a pick that IS taken must not say it is not:\n${lines[0]}`);
  assert.ok(!lines[0].includes('balanced'), `the low-cost tier was found in the first pass; the line must not speak of the balanced tier:\n${lines[0]}`);
});

await test('U13b · discovery over live + gpt-6.2-ember: the warning names BOTH skipped generations and their ids', async () => {
  const lines = await openaiWarnLines(live('gpt-6.2-ember'));
  assert.strictEqual(lines.length, 1, `exactly one line; got ${lines.length}:\n${lines.join('')}`);
  for (const must of ['6.2', 'gpt-6.2-ember', '6.1', 'gpt-6.1-sol', 'gpt-6-luna']) {
    assert.ok(lines[0].includes(must), `the line must name ${must}:\n${lines[0]}`);
  }
  assert.ok(!lines[0].includes('will not take it on its own'));
  assert.ok(!lines[0].includes('balanced'), `a low-cost tier two generations down is a first-pass pick:\n${lines[0]}`);
});

await test('U14 · live + gpt-6.1-luna: a tier in the newest generation is silent (no warning)', async () => {
  assert.deepStrictEqual(await openaiWarnLines(live('gpt-6.1-luna')), []);
});

await test('U15 · a family with no tier: ONE warning naming family 6 and every id of it, and the promise of 10d2a7f stays true', async () => {
  const lines = await openaiWarnLines(NO_TIER);
  assert.strictEqual(lines.length, 1, `exactly one line; got ${lines.length}:\n${lines.join('')}`);
  for (const must of ['family 6', 'gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-astra', 'will not take it on its own']) {
    assert.ok(lines[0].includes(must), `the line must contain ${must}:\n${lines[0]}`);
  }
});

await test('U15b · a family with no tier and TWO more generations: the warning names the ids of all three', async () => {
  const lines = await openaiWarnLines([...NO_TIER, 'gpt-6.2-ember']);
  assert.strictEqual(lines.length, 1, `exactly one line; got ${lines.length}:\n${lines.join('')}`);
  for (const must of ['gpt-6.2-ember', 'gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-astra']) {
    assert.ok(lines[0].includes(must), `the line must name ${must}:\n${lines[0]}`);
  }
});

await test('U16 · the report path with no catalogue and no classifyModel in the config: gpt-6-luna', async () => {
  const model = await resolveClassifyModel('openai', { env: 'K' }, { env: { K: 'x' }, discoverFn: () => ({ models: null }) });
  assert.strictEqual(model, 'gpt-6-luna');
});

// ─── The shipped defaults: what a new user\'s init writes ─────────────────────
console.log('\nAP-7 — shipped defaults');

await test('F1 · FALLBACK.openai main and classify are both gpt-6-luna (the oracle: the family\'s cheap tier, the vendor\'s replacement of every retired cheap id)', () => {
  assert.strictEqual(FALLBACK.openai.main, 'gpt-6-luna');
  assert.strictEqual(FALLBACK.openai.classify, 'gpt-6-luna');
});

await test('F2 · FALLBACK.openai.main is what the rule picks on the last recorded live catalogues (a new fixture forces the default up)', () => {
  assert.strictEqual(FALLBACK.openai.main, selectOpenAIMain(LIVE_IDS).picked);
  assert.strictEqual(FALLBACK.openai.main, selectOpenAIMain(LIVE_27).picked);
});

await test('F3 · no openai id that init writes (FALLBACK, DEFAULT_CONFIG) is on the vendor\'s retirement schedule', () => {
  const sched = JSON.parse(readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'openai-deprecations-2026-10-25.json'), 'utf-8'));
  assert.ok(Array.isArray(sched.rows) && sched.rows.length > 0 && sched._provenance?.source, 'the fixture must carry rows and its provenance');
  // A page row R retires a default D when R is D, a dated snapshot of D, or D is a
  // dated snapshot of R. The date is a full YYYY-MM-DD, not any suffix.
  const DATED = /^-\d{4}-\d{2}-\d{2}$/;
  const retires = (R, D) => R === D || (R.startsWith(D) && DATED.test(R.slice(D.length))) || (D.startsWith(R) && DATED.test(D.slice(R.length)));
  // Controls first: a matcher that matches everything or nothing would pass or fail this test for no reason.
  assert.ok(retires('gpt-4o-mini-2024-07-18', 'gpt-4o-mini'), 'a dated snapshot of the default retires it');
  assert.ok(!retires('gpt-4o-mini-2024-07-18', 'gpt-4o'), 'a different model is not retired by another model\'s snapshot');
  const defaults = [
    FALLBACK.openai.main, FALLBACK.openai.classify,
    DEFAULT_CONFIG.providers.openai.model, DEFAULT_CONFIG.providers.openai.classifyModel,
  ];
  const names = sched.rows.flatMap((r) => [r.id, r.snapshot].filter(Boolean).map((n) => ({ n, r })));
  for (const d of defaults) {
    const hit = names.find(({ n }) => retires(n, d));
    assert.ok(!hit, `${d} is retired by OpenAI on ${hit?.r.shutdown} (replacement ${hit?.r.replacement}) — see ${sched._provenance.source}`);
  }
});

restore();
process.stderr.write = originalStderrWrite;

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

import assert from 'node:assert/strict';
import {
  extractYearMentions,
  detectCutoffPhrases,
  classifyResponseFreshness,
  aggregateFreshness,
  checkResponseFreshness,
} from '../lib/report/response-freshness.js';

let passed = 0;
let failed = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`  ✓ ${name}`); })
    .catch(err => { failed++; console.log(`  ✗ ${name}\n    ${err.message}`); });
}

console.log('\nextractYearMentions');

await test('extracts in-range years', () => {
  const r = extractYearMentions('In 2024 we launched, then in 2025 expanded, and 2026 brought growth.');
  assert.deepEqual(r, [2026, 2025, 2024]);
});

await test('skips out-of-range years', () => {
  const r = extractYearMentions('Founded in 1999. Updated 2024.');
  assert.deepEqual(r, [2024]);
});

await test('dedupes', () => {
  const r = extractYearMentions('2024 was big. In 2024 we did X.');
  assert.deepEqual(r, [2024]);
});

await test('skips numbers within larger numbers', () => {
  const r = extractYearMentions('Order #20240123. In 2024 we launched.');
  assert.deepEqual(r, [2024]);
});

await test('handles empty input', () => {
  assert.deepEqual(extractYearMentions(null), []);
  assert.deepEqual(extractYearMentions(''), []);
});

console.log('\ndetectCutoffPhrases');

await test('"as of my last update"', () => {
  const r = detectCutoffPhrases('As of my last update, the situation was unclear.');
  // Multiple overlapping patterns may match same disclosure — that's stronger signal, not a bug
  assert.ok(r.length >= 1);
});

await test('"my training data"', () => {
  const r = detectCutoffPhrases('Based on my training data through 2024.');
  assert.equal(r.length, 1);
});

await test('"knowledge cutoff"', () => {
  const r = detectCutoffPhrases('My knowledge cutoff is October 2024.');
  assert.equal(r.length, 1);
});

await test('"I don\'t have information after"', () => {
  const r = detectCutoffPhrases("I don't have information after 2024.");
  assert.equal(r.length, 1);
});

await test('no cutoff phrase → empty', () => {
  const r = detectCutoffPhrases('The answer is 42.');
  assert.deepEqual(r, []);
});

console.log('\nclassifyResponseFreshness');

await test('web-search active → fresh, high confidence', () => {
  const cell = {
    provider: 'openai',
    canonicalCitations: ['https://x.com/'],
  };
  const r = classifyResponseFreshness(cell);
  assert.equal(r.usedWebSearch, true);
  assert.equal(r.freshness, 'fresh');
  assert.equal(r.confidence, 'high');
});

await test('cutoff phrase → stale, high confidence', () => {
  const cell = {
    provider: 'anthropic',
    response: 'As of my last update in 2024, the market was different.',
  };
  const r = classifyResponseFreshness(cell);
  assert.equal(r.freshness, 'stale');
  assert.equal(r.confidence, 'high');
});

await test('latest year is current → fresh, med-high confidence', () => {
  const currentYear = new Date().getFullYear();
  const cell = {
    provider: 'anthropic',
    response: `In ${currentYear}, things changed. Also ${currentYear - 1} was busy. And ${currentYear} again.`,
  };
  const r = classifyResponseFreshness(cell);
  assert.equal(r.freshness, 'fresh');
  assert.ok(['med', 'high'].includes(r.confidence));
});

await test('latest year 3+ years ago → stale', () => {
  const currentYear = new Date().getFullYear();
  const cell = {
    provider: 'anthropic',
    response: `In ${currentYear - 3} the situation was X.`,
  };
  const r = classifyResponseFreshness(cell, { currentYear });
  assert.equal(r.freshness, 'stale');
});

await test('latest year within window → unknown', () => {
  const currentYear = new Date().getFullYear();
  const cell = {
    provider: 'anthropic',
    response: `${currentYear - 2} was a year of change.`,
  };
  const r = classifyResponseFreshness(cell, { currentYear });
  assert.equal(r.freshness, 'unknown');
});

await test('no years no cutoff → unknown', () => {
  const cell = { provider: 'anthropic', response: 'The answer is X.' };
  const r = classifyResponseFreshness(cell);
  assert.equal(r.freshness, 'unknown');
});

await test('null cell → defensive unknown', () => {
  const r = classifyResponseFreshness(null);
  assert.equal(r.freshness, 'unknown');
});

await test('Gemini groundingChunks → web-search detected', () => {
  const cell = {
    provider: 'gemini',
    raw: { candidates: [{ groundingMetadata: { groundingChunks: [{ web: {} }] } }] },
  };
  const r = classifyResponseFreshness(cell);
  assert.equal(r.usedWebSearch, true);
  assert.equal(r.freshness, 'fresh');
});

await test('OpenAI Responses web_search_call → web-search detected (new shape)', () => {
  // gpt-5-mini via the Responses web_search tool: the raw has an output[] with a
  // web_search_call item even before any url_citation is emitted.
  const cell = {
    provider: 'openai',
    raw: { output: [{ type: 'reasoning' }, { type: 'web_search_call' }, { type: 'message', content: [] }] },
  };
  const r = classifyResponseFreshness(cell);
  assert.equal(r.usedWebSearch, true);
  assert.equal(r.freshness, 'fresh');
});

console.log('\naggregateFreshness');

await test('per-provider verdicts', () => {
  const cells = [
    { provider: 'openai', freshness: 'fresh', latestYearMentioned: 2026 },
    { provider: 'openai', freshness: 'fresh', latestYearMentioned: 2026 },
    { provider: 'anthropic', freshness: 'stale', latestYearMentioned: 2024 },
    { provider: 'anthropic', freshness: 'stale', latestYearMentioned: 2024 },
    { provider: 'gemini', freshness: 'fresh', latestYearMentioned: 2026 },
    { provider: 'gemini', freshness: 'unknown', latestYearMentioned: null },
  ];
  const r = aggregateFreshness(cells);
  assert.equal(r.perProvider.openai.verdict, 'fresh');
  assert.equal(r.perProvider.anthropic.verdict, 'stale');
  assert.equal(r.perProvider.gemini.verdict, 'mixed');
  assert.equal(r.perProvider.openai.latestYear, 2026);
});

await test('overall verdict reflects majority', () => {
  const cells = [
    { provider: 'a', freshness: 'fresh' },
    { provider: 'a', freshness: 'fresh' },
    { provider: 'b', freshness: 'stale' },
  ];
  const r = aggregateFreshness(cells);
  assert.equal(r.overall, 'fresh');
});

await test('empty input → unknown', () => {
  const r = aggregateFreshness([]);
  assert.equal(r.overall, 'unknown');
});

console.log('\ncheckResponseFreshness (top-level)');

await test('summary with mixed cells → full output', () => {
  const summary = {
    results: [
      { provider: 'openai', canonicalCitations: ['https://x.com'] }, // fresh
      { provider: 'anthropic', response: 'As of my last update, X.' }, // stale
      { provider: 'gemini', raw: { candidates: [{ groundingMetadata: { groundingChunks: [{ web: {} }] } }] } }, // fresh
    ],
  };
  const r = checkResponseFreshness(summary);
  assert.equal(r.aggregate.counts.total, 3);
  assert.ok(r.caveats.length >= 3);
});

await test('null summary → defensive', () => {
  const r = checkResponseFreshness(null);
  assert.equal(r.aggregate.overall, 'unknown');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

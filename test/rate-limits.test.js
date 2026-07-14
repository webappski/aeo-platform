import assert from 'node:assert/strict';
import { matchModelFamily, getTier1Limit, TIER_1_LIMITS } from '../lib/providers/rate-limits.js';
import { estimateRunDuration, formatTpmHint } from '../lib/util/cost-estimate.js';

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n    ${err.message}`); }
}

console.log('\nmatchModelFamily (longest-prefix match)');

test('gpt-5-search-api matches its own family (longer wins over gpt-5)',
  () => assert.equal(matchModelFamily('openai', 'gpt-5-search-api'), 'gpt-5-search-api'));

test('gpt-5 matches gpt-5 alone',
  () => assert.equal(matchModelFamily('openai', 'gpt-5'), 'gpt-5'));

test('gpt-5-mini matches gpt-5-mini (longer wins over gpt-5)',
  () => assert.equal(matchModelFamily('openai', 'gpt-5-mini'), 'gpt-5-mini'));

test('claude-sonnet-4-6 matches claude-sonnet',
  () => assert.equal(matchModelFamily('anthropic', 'claude-sonnet-4-6'), 'claude-sonnet'));

test('claude-haiku-4-5 matches claude-haiku',
  () => assert.equal(matchModelFamily('anthropic', 'claude-haiku-4-5'), 'claude-haiku'));

test('unknown model returns null',
  () => assert.equal(matchModelFamily('openai', 'gpt-99-megalord'), null));

test('unknown provider returns null',
  () => assert.equal(matchModelFamily('fakeapi', 'whatever'), null));

console.log('\ngetTier1Limit');

test('OpenAI gpt-5-search-api: 6k TPM (its own tiny dedicated bucket, NOT the gpt-5 cap)',
  () => {
    const lim = getTier1Limit('openai', 'gpt-5-search-api');
    assert.equal(lim.tpm, 6000);
  });

test('OpenAI gpt-5: 500k TPM',
  () => {
    const lim = getTier1Limit('openai', 'gpt-5');
    assert.equal(lim.tpm, 500000);
  });

test('OpenAI gpt-5-search-api bucket is far smaller than base gpt-5 (6k vs 500k)',
  () => {
    const limSearch = getTier1Limit('openai', 'gpt-5-search-api');
    const limBase = getTier1Limit('openai', 'gpt-5');
    assert.equal(limSearch.tpm, 6000);
    assert.equal(limBase.tpm, 500000);
    assert.ok(limSearch.tpm < limBase.tpm, 'search SKU bucket must be smaller than the general gpt-5 bucket');
  });

test('Perplexity returns tpm=null (RPM-only by design)',
  () => {
    const lim = getTier1Limit('perplexity', 'sonar-pro');
    assert.equal(lim.tpm, null);
    assert.equal(lim.rpm, 150);
  });

console.log('\nestimateRunDuration');

test('mode=fast when estimate fits in tpm window with headroom (gpt-5, 7.5k vs 500k)', () => {
  const eta = estimateRunDuration('openai', 'gpt-5', 'run');
  assert.equal(eta.mode, 'fast');
  assert.equal(eta.etaSeconds, 5);
});

test('mode=paced for the tiny gpt-5-search-api bucket (7.5k run vs 6k TPM → 2 windows = 65s)', () => {
  const eta = estimateRunDuration('openai', 'gpt-5-search-api', 'run');
  assert.equal(eta.mode, 'paced');
  // budget = 6000 * 0.9 = 5400; ceil(7500/5400) = 2 windows → (2-1)*60 + 5 = 65s
  assert.equal(eta.etaSeconds, 65);
});

test('mode=fast for gpt-5-mini (the new web-search main, 7.5k vs 500k)', () => {
  const eta = estimateRunDuration('openai', 'gpt-5-mini', 'run');
  assert.equal(eta.mode, 'fast');
  assert.equal(eta.etaSeconds, 5);
});

test('mode=paced when estimate exceeds budget (gpt-4o-search-preview, thinkingActive: true, run-depth-full, 51k vs 27k budget)', () => {
  const eta = estimateRunDuration('openai', 'gpt-4o-search-preview', 'run-depth-full', { thinkingActive: true });
  assert.equal(eta.mode, 'paced');
  // 51000 / 27000 = 1.89 → ceil = 2 windows → (2-1)*60+5 = 65s
  assert.equal(eta.etaSeconds, 65);
});

test('mode=unknown when model not in table', () => {
  const eta = estimateRunDuration('openai', 'gpt-mystery-model', 'run');
  assert.equal(eta.mode, 'unknown');
});

test('mode=unknown when command not recognised', () => {
  const eta = estimateRunDuration('openai', 'gpt-5', 'run-fictional');
  assert.equal(eta.mode, 'unknown');
});

console.log('\nformatTpmHint');

test('formatTpmHint: tiny search bucket (gpt-5-search-api) shows a PACED hint (6k TPM)', () => {
  const hint = formatTpmHint('openai', 'gpt-5-search-api');
  assert.match(hint, /paced across/);
  // locale-agnostic: 6000 renders as "6,000" / "6000" / "6 000" depending on ICU/locale.
  const digitsOnly = hint.replace(/[\s,. ]/g, '');
  assert.ok(digitsOnly.includes('6000') && hint.includes('TPM'), `unexpected hint: ${hint}`);
});

test('non-search model shows "completes in" text', () => {
  const hint = formatTpmHint('openai', 'gpt-5');
  assert.match(hint, /completes in/);
  assert.ok(hint.includes('500') && hint.includes('TPM'));
});

test('perplexity shows RPM-only hint (no TPM mention)', () => {
  const hint = formatTpmHint('perplexity', 'sonar-pro');
  assert.match(hint, /RPM/);
  assert.doesNotMatch(hint, /TPM/);
});

test('unknown model returns empty string', () => {
  assert.equal(formatTpmHint('openai', 'gpt-mystery'), '');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

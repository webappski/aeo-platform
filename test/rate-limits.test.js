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

test('OpenAI gpt-5-search-api: 6k TPM (matches user error report)',
  () => {
    const lim = getTier1Limit('openai', 'gpt-5-search-api');
    assert.equal(lim.tpm, 6000);
  });

test('OpenAI gpt-5: 90k TPM (15× higher than search variant)',
  () => {
    const lim = getTier1Limit('openai', 'gpt-5');
    assert.equal(lim.tpm, 90000);
    // The "15× higher" claim in the docs:
    assert.equal(90000 / 6000, 15);
  });

test('Perplexity returns tpm=null (RPM-only by design)',
  () => {
    const lim = getTier1Limit('perplexity', 'sonar-pro');
    assert.equal(lim.tpm, null);
    assert.equal(lim.rpm, 50);
  });

console.log('\nestimateRunDuration');

test('mode=fast when estimate fits in tpm window with headroom (gpt-5, 7.5k vs 90k)', () => {
  const eta = estimateRunDuration('openai', 'gpt-5', 'run');
  assert.equal(eta.mode, 'fast');
  assert.equal(eta.etaSeconds, 5);
});

test('mode=paced when estimate exceeds budget (gpt-5-search-api, 7.5k vs 6k)', () => {
  const eta = estimateRunDuration('openai', 'gpt-5-search-api', 'run');
  assert.equal(eta.mode, 'paced');
  // 7500 / 5400 = 1.39 → ceil = 2 windows → (2-1)*60+5 = 65s
  assert.equal(eta.etaSeconds, 65);
});

test('mode=paced for run-depth-full on tier-1 search (15k vs 6k, 3 windows)', () => {
  const eta = estimateRunDuration('openai', 'gpt-5-search-api', 'run-depth-full');
  assert.equal(eta.mode, 'paced');
  // 15000 / 5400 = 2.78 → ceil = 3 windows → (3-1)*60+5 = 125s
  assert.equal(eta.etaSeconds, 125);
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

test('search model shows "paced across" text', () => {
  const hint = formatTpmHint('openai', 'gpt-5-search-api');
  assert.match(hint, /paced across/);
  // toLocaleString may use comma or non-breaking space depending on OS locale.
  assert.match(hint, /6.000 TPM/);
});

test('non-search model shows "completes in" text', () => {
  const hint = formatTpmHint('openai', 'gpt-5');
  assert.match(hint, /completes in/);
  assert.match(hint, /90.000 TPM/);
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

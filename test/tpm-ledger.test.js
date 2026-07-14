import assert from 'node:assert/strict';
import {
  reserve, confirm, release,
  learnTpmLimit,
  importLearnedLimits,
  forecastTokensInWindow,
  getFirstTokenTimestampInWindow,
  estimatePerRequest,
  shouldWait,
  getLearnedOrTierLimit,
  parseTpmLimitHeader,
  _resetForTests,
} from '../lib/providers/tpm-ledger.js';

let passed = 0, failed = 0;
function test(name, fn) {
  _resetForTests();
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (err) { failed++; console.log(`  ✗ ${name}\n    ${err.message}`); }
}

console.log('\ntpm-ledger reservation pattern');

test('reserve appends an entry visible to forecast', () => {
  const cd = 'openai:gpt-5';
  reserve(cd, 1000);
  assert.equal(forecastTokensInWindow(cd), 1000);
});

test('confirm replaces reservation tokens with actual', () => {
  const cd = 'openai:gpt-5';
  const id = reserve(cd, 2500);
  assert.equal(forecastTokensInWindow(cd), 2500);
  confirm(cd, id, 1800);
  assert.equal(forecastTokensInWindow(cd), 1800);
});

test('release removes the reservation entirely', () => {
  const cd = 'openai:gpt-5';
  const id = reserve(cd, 2500);
  release(cd, id);
  assert.equal(forecastTokensInWindow(cd), 0);
});

test('multiple reservations sum correctly', () => {
  const cd = 'openai:gpt-5';
  reserve(cd, 1000);
  reserve(cd, 1500);
  reserve(cd, 800);
  assert.equal(forecastTokensInWindow(cd), 3300);
});

test('confirm/release on unknown id is a no-op', () => {
  const cd = 'openai:gpt-5';
  confirm(cd, 9999, 500);
  release(cd, 9999);
  assert.equal(forecastTokensInWindow(cd), 0);
});

test('reservations on different cdKeys are isolated', () => {
  reserve('openai:gpt-5', 2000);
  reserve('openai:gpt-5-search-api', 3000);
  assert.equal(forecastTokensInWindow('openai:gpt-5'), 2000);
  assert.equal(forecastTokensInWindow('openai:gpt-5-search-api'), 3000);
});

test('entries older than 60s are GCed', () => {
  const cd = 'openai:gpt-5';
  const now = Date.now();
  // Manually inject an old reservation by mocking ts via direct API:
  // (we can't directly set ts, but we can verify GC via the now param).
  reserve(cd, 1000);
  // Forecasting at +90s should drop it.
  assert.equal(forecastTokensInWindow(cd, now + 90_000), 0);
});

console.log('\nlearnTpmLimit (kind-aware, shrink-only)');

test('learnTpmLimit sets initial value', () => {
  const cd = 'openai:gpt-5-search-api';
  learnTpmLimit(cd, 6000);
  assert.equal(getLearnedOrTierLimit('openai', 'gpt-5-search-api'), 6000);
});

test('learnTpmLimit shrinks (lower wins)', () => {
  const cd = 'openai:gpt-5-search-api';
  learnTpmLimit(cd, 6000);
  learnTpmLimit(cd, 4000);
  assert.equal(getLearnedOrTierLimit('openai', 'gpt-5-search-api'), 4000);
});

test('learnTpmLimit ignores larger value (no growth)', () => {
  const cd = 'openai:gpt-5-search-api';
  learnTpmLimit(cd, 6000);
  learnTpmLimit(cd, 10000);
  assert.equal(getLearnedOrTierLimit('openai', 'gpt-5-search-api'), 6000);
});

test('learnTpmLimit ignores invalid input', () => {
  const cd = 'openai:gpt-5-search-api';
  learnTpmLimit(cd, 0);
  learnTpmLimit(cd, -5);
  learnTpmLimit(cd, NaN);
  // Falls through to tier-1 table (search SKU's honest 6k bucket):
  assert.equal(getLearnedOrTierLimit('openai', 'gpt-5-search-api'), 6000);
});

test('learnTpmLimit: header source can overwrite a stale persisted value upward', () => {
  const cd = 'openai:gpt-5-mini';
  // Simulate a stale low persisted value (learned during a transient throttle)
  learnTpmLimit(cd, 100000, 'persisted');
  assert.equal(getLearnedOrTierLimit('openai', 'gpt-5-mini'), 100000);
  // Live 200 header confirms the real 500k bucket — overwrites the stale persisted value
  learnTpmLimit(cd, 500000, 'header');
  assert.equal(getLearnedOrTierLimit('openai', 'gpt-5-mini'), 500000);
});

test('learnTpmLimit: header source cannot overwrite an observed (429) value upward', () => {
  const cd = 'openai:gpt-5-search-api';
  // Real 429 was observed at 6000 — this is ground truth
  learnTpmLimit(cd, 6000, 'observed');
  // Header claims 500k — should NOT overwrite (observed beats header)
  learnTpmLimit(cd, 500000, 'header');
  assert.equal(getLearnedOrTierLimit('openai', 'gpt-5-search-api'), 6000);
});

test('importLearnedLimits: discards persisted values below static tier-1 table (stale guard)', () => {
  // A persisted value below the current tier-1 table (e.g. gpt-5-mini captured as
  // 6000 during a transient throttle) is stale — discard so we don't pace forever
  // on a floor the provider has since lifted.
  const count = importLearnedLimits({ 'openai:gpt-5-mini': { limit: 6000, source: 'persisted' } });
  assert.equal(count, 0, 'stale persisted value below tier-1 should be discarded');
  // Falls through to the 500k tier-1 table, not the stale 6000:
  assert.equal(getLearnedOrTierLimit('openai', 'gpt-5-mini'), 500000);
});

test('importLearnedLimits: accepts persisted values above or equal to tier-1 table', () => {
  // 500000 matches gpt-5-mini tier-1 — should be accepted
  const count = importLearnedLimits({ 'openai:gpt-5-mini': { limit: 500000, source: 'persisted' } });
  assert.equal(count, 1, 'valid persisted value at tier-1 level should be accepted');
  assert.equal(getLearnedOrTierLimit('openai', 'gpt-5-mini'), 500000);
});

test('importLearnedLimits: a lower observed value from current run beats an equal persisted one', () => {
  // Persisted at 500k
  importLearnedLimits({ 'openai:gpt-5-mini': { limit: 500000, source: 'persisted' } });
  // Current run observed a 429 at 300k (real throttle)
  learnTpmLimit('openai:gpt-5-mini', 300000, 'observed');
  assert.equal(getLearnedOrTierLimit('openai', 'gpt-5-mini'), 300000);
});

console.log('\nshouldWait threshold');

test('shouldWait returns {wait: false} when no limit learned', () => {
  // First run case — fire blindly, no throttle.
  const decision = shouldWait('openai:gpt-5');
  assert.equal(decision.wait, false);
});

test('shouldWait returns {wait: false} when below threshold', () => {
  const cd = 'openai:gpt-5-search-api';
  learnTpmLimit(cd, 6000);
  reserve(cd, 2000);  // sum=2000, est=2500, sum+est=4500 < 5400
  const decision = shouldWait(cd);
  assert.equal(decision.wait, false);
});

test('shouldWait returns {wait: true} when sum+est > 90%', () => {
  const cd = 'openai:gpt-5-search-api';
  learnTpmLimit(cd, 6000);
  reserve(cd, 2500);
  reserve(cd, 2500);  // sum=5000, est=2500, sum+est=7500 > 5400 → wait
  const decision = shouldWait(cd);
  assert.equal(decision.wait, true);
  assert.ok(decision.ms > 0);
  assert.ok(decision.ms <= 60_000);
});

console.log('\ngetFirstTokenTimestampInWindow');

test('returns null when no entries', () => {
  assert.equal(getFirstTokenTimestampInWindow('openai:gpt-5'), null);
});

test('returns earliest entry timestamp', () => {
  const cd = 'openai:gpt-5';
  const before = Date.now();
  reserve(cd, 1000);
  const after = Date.now();
  const ts = getFirstTokenTimestampInWindow(cd);
  assert.ok(ts >= before && ts <= after, `expected ts in [${before}, ${after}], got ${ts}`);
});

console.log('\nestimatePerRequest');

test('falls back to openai search default on first run', () => {
  assert.equal(estimatePerRequest('openai:gpt-5-search-api'), 2500);
});

test('falls back to openai non-search default', () => {
  assert.equal(estimatePerRequest('openai:gpt-5'), 1500);
});

test('falls back to anthropic default', () => {
  assert.equal(estimatePerRequest('anthropic:claude-sonnet'), 800);
});

test('moving average from confirmed actuals', () => {
  const cd = 'openai:gpt-5';
  const ids = [];
  for (let i = 0; i < 5; i++) ids.push(reserve(cd, 1500));
  ids.forEach((id, i) => confirm(cd, id, 1000 + i * 100));  // 1000,1100,1200,1300,1400 → avg=1200
  assert.equal(estimatePerRequest(cd), 1200);
});

console.log('\ngetLearnedOrTierLimit fallback');

test('prefers learned over tier-1 table', () => {
  learnTpmLimit('openai:gpt-5', 50000);  // learned (lower than 90k tier-1)
  assert.equal(getLearnedOrTierLimit('openai', 'gpt-5'), 50000);
});

test('falls back to tier-1 when no learned', () => {
  assert.equal(getLearnedOrTierLimit('openai', 'gpt-5-search-api'), 6000);
});

test('returns null for unknown model', () => {
  assert.equal(getLearnedOrTierLimit('openai', 'never-existed'), null);
});

console.log('\nparseTpmLimitHeader');

test('OpenAI: x-ratelimit-limit-tokens parsed from Map-like headers', () => {
  const headers = new Map([['x-ratelimit-limit-tokens', '90000']]);
  // Map's get() returns undefined for missing keys, matches Headers API enough.
  assert.equal(parseTpmLimitHeader(headers, 'openai'), 90000);
});

test('OpenAI: missing header returns null', () => {
  const headers = new Map();
  assert.equal(parseTpmLimitHeader(headers, 'openai'), null);
});

test('Anthropic: takes minimum of input/output limits', () => {
  const headers = new Map([
    ['anthropic-ratelimit-input-tokens-limit', '50000'],
    ['anthropic-ratelimit-output-tokens-limit', '8000'],
  ]);
  assert.equal(parseTpmLimitHeader(headers, 'anthropic'), 8000);
});

test('Gemini: returns null (no header support)', () => {
  const headers = new Map([['x-ratelimit-limit-tokens', '1000000']]);
  assert.equal(parseTpmLimitHeader(headers, 'gemini'), null);
});

test('invalid value returns null', () => {
  const headers = new Map([['x-ratelimit-limit-tokens', 'not-a-number']]);
  assert.equal(parseTpmLimitHeader(headers, 'openai'), null);
});

test('null headers returns null', () => {
  assert.equal(parseTpmLimitHeader(null, 'openai'), null);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

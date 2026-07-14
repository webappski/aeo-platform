// Regression tests for the init performance + quality fix:
//   1. withRetry retryability is driven by classifyProviderError (single source
//      of truth): rate-limit → retried, network → SMALL bounded retry, everything
//      else → fail fast. (Was: a divergent regex retried non-retryable errors 30×.)
//   2. Research caller loops (runSimulation) no longer double-retry provider
//      errors — only LlmParseError re-asks.
//   3. selectTopThree applies an absolute quality floor.
//   4. The brainstorm prompt expands only ambiguous acronyms, not universal ones.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { withRetry } from '../lib/providers/_retry.js';
import { runSimulation } from '../lib/init/research/simulate.js';
import { selectTopThree, applySelectionFloor, SELECTION_MIN_SCORE } from '../lib/init/research/select.js';
import { buildBrainstormPrompt } from '../lib/init/research/brainstorm.js';
import { LlmParseError } from '../lib/init/research/parse-error.js';

// ─── 1. withRetry gate ───────────────────────────────────────────────────────

test('withRetry retries rate-limit errors (until success)', async () => {
  let calls = 0;
  const res = await withRetry('Test', async () => {
    calls++;
    if (calls < 3) throw new Error('429 rate limit reached, please try again');
    return 'ok';
  });
  assert.equal(res, 'ok');
  assert.equal(calls, 3);
});

test('withRetry gives a bare 500 a bounded retry — not a 30× storm, not fail-fast', async () => {
  let calls = 0;
  await assert.rejects(
    () => withRetry('Test', async () => {
      calls++;
      throw new Error('500 Internal Server Error');
    }),
    /500 Internal Server Error/,
  );
  // server-error class → QUICK_RETRY_MAX_ATTEMPTS (3). The old code did 30; a naive
  // "fail fast on !rate-limit" would do 1 and also block provider fallback.
  assert.equal(calls, 3);
});

test('withRetry recovers when a transient 500 clears on retry', async () => {
  let calls = 0;
  const res = await withRetry('Test', async () => {
    calls++;
    if (calls < 2) throw new Error('500 Internal Server Error');
    return 'ok';
  });
  assert.equal(res, 'ok');
  assert.equal(calls, 2);
});

test('withRetry fails FAST on auth (retryable across providers, not in-loop)', async () => {
  let calls = 0;
  await assert.rejects(
    () => withRetry('Test', async () => {
      calls++;
      throw new Error('401 Unauthorized: invalid api key');
    }),
  );
  assert.equal(calls, 1);
});

test('withRetry fails FAST on a genuine bug (other)', async () => {
  let calls = 0;
  await assert.rejects(
    () => withRetry('Test', async () => {
      calls++;
      throw new TypeError("Cannot read properties of undefined (reading 'x')");
    }),
  );
  assert.equal(calls, 1); // real bug → single attempt, surfaces immediately
});

test('withRetry gives network a SMALL bounded retry, not 30', async () => {
  let calls = 0;
  await assert.rejects(
    () => withRetry('Test', async () => {
      calls++;
      throw new Error('socket hang up');
    }),
  );
  // NETWORK_MAX_ATTEMPTS = 3 (env AEO_NO_RETRY unset here). The old behaviour was
  // 30. Assert it's small and bounded, definitely not the old storm.
  assert.equal(calls, 3);
});

test('withRetry recovers when a network blip clears on retry', async () => {
  let calls = 0;
  const res = await withRetry('Test', async () => {
    calls++;
    if (calls < 2) throw Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    return 'ok';
  });
  assert.equal(res, 'ok');
  assert.equal(calls, 2);
});

// ─── 2. No nested double-retry of provider errors ────────────────────────────

test('runSimulation does NOT re-run providerCall on a provider error', async () => {
  let calls = 0;
  const providerCall = async () => { calls++; throw new Error('401 Unauthorized'); };
  await assert.rejects(() => runSimulation({
    candidates: [{ text: 'best ai voice tools', score: 90 }],
    brand: 'X', category: 'ai voice', providerCall, apiKey: 'k', model: 'm',
  }));
  assert.equal(calls, 1); // withRetry owns provider retries; simulate must not double them
});

test('runSimulation DOES re-ask on an un-parseable (LlmParseError) response', async () => {
  let calls = 0;
  const providerCall = async () => { calls++; return { text: 'definitely not json' }; };
  await assert.rejects(
    () => runSimulation({
      candidates: [{ text: 'best ai voice tools', score: 90 }],
      brand: 'X', category: 'ai voice', providerCall, apiKey: 'k', model: 'm',
    }),
    (err) => err instanceof LlmParseError,
  );
  assert.equal(calls, 2); // MAX_ATTEMPTS parse re-asks
});

// ─── 3. Selection quality floor ──────────────────────────────────────────────

test('applySelectionFloor demotes below-floor candidates when ≥3 clear the floor', () => {
  const pool = [
    { text: 'a', score: 90 },
    { text: 'b', score: 80 },
    { text: 'c', score: 70 },
    { text: 'd', score: 55 },
    { text: 'e', score: 50 },
  ];
  const { picks, rest, weakBasket } = applySelectionFloor(pool);
  assert.deepEqual(picks.map(c => c.text), ['a', 'b', 'c']);
  assert.deepEqual(rest.map(c => c.text), ['d', 'e']);
  assert.equal(weakBasket, false);
  assert.ok(picks.every(c => c.score >= SELECTION_MIN_SCORE));
});

test('selectTopThree still returns 3 + warns when the basket is weak', () => {
  // The exact observed case: 90, 90, 55, 50, 50 → only two clear the floor.
  const cands = [
    { text: 'a', score: 90, validation: 'ok' },
    { text: 'b', score: 90, validation: 'ok' },
    { text: 'c', score: 55, validation: 'ok' },
    { text: 'd', score: 50, validation: 'ok' },
    { text: 'e', score: 50, validation: 'ok' },
  ];
  const r = selectTopThree(cands);
  assert.equal(r.selected.length, 3); // never emit fewer than 3
  assert.ok(r.warnings.some(w => /quality floor/.test(w)), 'expected a weak-basket warning');
});

// ─── 4. Acronym rule anchored on the shared list ─────────────────────────────

test('brainstorm prompt expands ambiguous acronyms but keeps universal ones (AI)', () => {
  const site = { lang: 'en', title: 'AI voice forms', metaDesc: '', h1: [], h2: [], text: 'ai voice form filling' };
  const prompt = buildBrainstormPrompt({
    brand: 'Typelessform', domain: 'typelessform.com', site,
    categoryDescription: 'AI voice form filling',
  });
  assert.match(prompt, /AEO/);                              // ambiguous acronym listed
  assert.match(prompt, /Answer Engine Optimization/);       // with its expansion
  assert.match(prompt, /Do NOT expand universally-understood/); // new rule present
  assert.ok(prompt.includes('AI'), 'AI should appear in the keep-list');
  assert.doesNotMatch(prompt, /EVERY query must spell out/); // old blanket rule gone
});

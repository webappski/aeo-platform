/**
 * One re-ask on an un-parseable classify response — and nothing else retried.
 *
 * R37: unit, not E2E, and the tests are non-lying — they drive the REAL
 * `extractWithTwoModels` / `classifySentimentWithTwoModels` with the real
 * prompts and the real parsers. The only stand-in is the transport: a
 * `providerCall` function that returns a canned body, which is the same seam
 * every other classifier test in this repo uses. What is asserted is the
 * decision (retry / do not retry / who answers) and the record it leaves —
 * behaviour a fake could not fabricate, because the parse failure is produced
 * by feeding the real parser real garbage.
 *
 * Each block carries a mutation-sanity note: what has to break for it to go red.
 */
import test from 'node:test';
import assert from 'node:assert';

import { retryProviderFor, runWithParseRetry } from '../lib/report/classify-retry.js';
import { LlmParseError } from '../lib/init/research/parse-error.js';
import { extractWithTwoModels } from '../lib/report/extract-competitors-llm.js';
import { classifySentimentWithTwoModels } from '../lib/report/sentiment-classify.js';

const TEXT = 'For this, buyers usually pick Acme Corp or Globex. TestBrand is also an option.';

/**
 * A provider whose answer is scripted per call. `bodies` is consumed in order;
 * the last entry repeats, so a one-entry script means "always this".
 */
function scriptedProvider(name, bodies, { model = `${name}-classify` } = {}) {
  const calls = [];
  const queue = [...bodies];
  return {
    name,
    model,
    apiKey: 'test-key',
    calls,
    providerCall: async (prompt, apiKey, usedModel) => {
      calls.push({ model: usedModel });
      const body = queue.length > 1 ? queue.shift() : queue[0];
      if (body instanceof Error) throw body;
      return { text: body, raw: { usage: { prompt_tokens: 10, completion_tokens: 5 } } };
    },
  };
}

const brandsBody = (...names) => JSON.stringify({ brands: names });
const GARBAGE = 'I am afraid I cannot comply with that request.';

test('retryProviderFor prefers a DIFFERENT vendor, and answers with the slot itself when there is none', () => {
  const slot = { name: 'openai' };
  assert.strictEqual(retryProviderFor(slot, [{ name: 'anthropic' }]).name, 'anthropic');
  // A fallback list holding only the slot's own vendor is not a second opinion.
  assert.strictEqual(retryProviderFor(slot, [{ name: 'openai' }]).name, 'openai');
  assert.strictEqual(retryProviderFor(slot, []).name, 'openai');
  assert.strictEqual(retryProviderFor(slot).name, 'openai');
  // Mutation-sanity: drop the `p.name !== slot.name` filter and the first
  // assertion still passes but the second returns the wrong object identity —
  // asserted by name above, which is what the record downstream prints.
});

test('runWithParseRetry re-asks on LlmParseError and NOT on a provider error', async () => {
  let tries = 0;
  const parseThenOk = await runWithParseRetry({
    slot: { name: 'openai' },
    fallbacks: [{ name: 'anthropic' }],
    attempt: async (p) => {
      tries++;
      if (p.name === 'openai') throw new LlmParseError('not JSON');
      return { value: 'recovered', costInfo: null };
    },
  });
  assert.strictEqual(tries, 2);
  assert.deepStrictEqual(
    { ok: parseThenOk.ok, value: parseThenOk.value, retriedOn: parseThenOk.retriedOn },
    { ok: true, value: 'recovered', retriedOn: 'anthropic' },
  );

  let transportTries = 0;
  const transport = await runWithParseRetry({
    slot: { name: 'openai' },
    fallbacks: [{ name: 'anthropic' }],
    attempt: async () => { transportTries++; throw new Error('401 Unauthorized'); },
  });
  // The whole point of the typed error: a dead key must not be re-asked. The
  // transport layer already retried where retrying helps.
  assert.strictEqual(transportTries, 1);
  assert.strictEqual(transport.ok, false);
  assert.strictEqual(transport.errorKind, 'provider');
  assert.strictEqual(transport.retriedOn, undefined);
  // Mutation-sanity: remove the `instanceof LlmParseError` guard and
  // transportTries becomes 2.
});

test('runWithParseRetry reports the SECOND failure\'s kind, not the first\'s', async () => {
  const r = await runWithParseRetry({
    slot: { name: 'openai' },
    fallbacks: [{ name: 'anthropic' }],
    attempt: async (p) => {
      if (p.name === 'openai') throw new LlmParseError('not JSON');
      throw new Error('503 from the fallback');
    },
  });
  assert.strictEqual(r.ok, false);
  // A re-ask that died on the network is NOT evidence that the model cannot
  // produce JSON, and the marker downstream names the cause from this field.
  assert.strictEqual(r.errorKind, 'provider');
  assert.strictEqual(r.retriedOn, 'anthropic');
});

test('competitor extraction: a third vendor repairs the broken slot, and the cross-check stays slot-vs-slot', async () => {
  const primary = scriptedProvider('openai', [GARBAGE]);
  const secondary = scriptedProvider('gemini', [brandsBody('Acme Corp', 'Globex')]);
  const third = scriptedProvider('anthropic', [brandsBody('Acme Corp')]);

  const out = await extractWithTwoModels({
    text: TEXT, brand: 'TestBrand', domain: 'testbrand.com', category: 'widgets',
    primary, secondary, fallbacks: [third],
  });

  // The repaired primary (answering "Acme Corp") is merged against the
  // UNTOUCHED secondary — so Acme is verified by two different vendors and
  // Globex, named by one, is not. Independence is preserved: nowhere does one
  // model's two samples become "both models agreed".
  assert.deepStrictEqual(out.verified, ['Acme Corp']);
  assert.deepStrictEqual(out.unverified, ['Globex']);
  assert.strictEqual(third.calls.length, 1, 'the fallback vendor answered exactly once');
  assert.strictEqual(primary.calls.length, 1, 'the broken slot is not asked twice');
  assert.strictEqual(out.sources.primary.retriedOn, 'anthropic');
  assert.strictEqual(out.sources.primary.error, undefined);
  // Mutation-sanity: without the retry the primary slot fails, `verified` is
  // empty and both names land in `unverified` — the pre-1.15 result.
});

test('competitor extraction with no third key: the same model is re-asked once, and a second failure degrades honestly', async () => {
  const flaky = scriptedProvider('openai', [GARBAGE, brandsBody('Acme Corp')]);
  const secondary = scriptedProvider('gemini', [brandsBody('Acme Corp')]);
  const recovered = await extractWithTwoModels({
    text: TEXT, brand: 'TestBrand', domain: 'testbrand.com', category: 'widgets',
    primary: flaky, secondary, fallbacks: [],
  });
  assert.strictEqual(flaky.calls.length, 2, 'one re-ask, not a loop');
  assert.deepStrictEqual(recovered.verified, ['Acme Corp']);
  assert.strictEqual(recovered.sources.primary.retriedOn, 'same-model');

  const broken = scriptedProvider('openai', [GARBAGE]);
  const degraded = await extractWithTwoModels({
    text: TEXT, brand: 'TestBrand', domain: 'testbrand.com', category: 'widgets',
    primary: broken, secondary: scriptedProvider('gemini', [brandsBody('Acme Corp')]), fallbacks: [],
  });
  assert.strictEqual(broken.calls.length, 2, 'exactly two attempts, then give up');
  // Degraded, and SAID so with the typed cause the report renders.
  assert.deepStrictEqual(degraded.verified, []);
  assert.deepStrictEqual(degraded.unverified, ['Acme Corp']);
  assert.strictEqual(degraded.sources.primary.errorKind, 'parse');
  assert.strictEqual(degraded.sources.primary.retriedOn, 'same-model');
  assert.strictEqual(degraded.sources.primary.provider, 'openai');
});

test('sentiment: the same policy, and a failed seat records provider vs parse truthfully', async () => {
  const good = JSON.stringify({ label: 'positive', rationale: 'named as a top pick' });

  const repaired = await classifySentimentWithTwoModels({
    text: TEXT, brand: 'TestBrand', domain: 'testbrand.com',
    primary: scriptedProvider('openai', [GARBAGE, good]),
    secondary: scriptedProvider('gemini', [good]),
    fallbacks: [],
  });
  // Both seats ended up with a label, so this is a full cross-check again.
  assert.strictEqual(repaired.label, 'positive');
  assert.strictEqual(repaired.confidence, 'high');
  assert.strictEqual(repaired.slots.primary.retriedOn, 'same-model');
  assert.strictEqual(repaired.slots.primary.error, undefined);

  const dead = await classifySentimentWithTwoModels({
    text: TEXT, brand: 'TestBrand', domain: 'testbrand.com',
    primary: scriptedProvider('openai', [new Error('401 Unauthorized')]),
    secondary: scriptedProvider('gemini', [good]),
    fallbacks: [],
  });
  assert.strictEqual(dead.confidence, 'single-model');
  assert.strictEqual(dead.slots.primary.errorKind, 'provider');
  assert.strictEqual(dead.slots.primary.retriedOn, undefined, 'a dead key is never re-asked');
});

test('a clean run leaves no trace: no slots field, no retry record', async () => {
  const clean = await classifySentimentWithTwoModels({
    text: TEXT, brand: 'TestBrand', domain: 'testbrand.com',
    primary: scriptedProvider('openai', [JSON.stringify({ label: 'neutral', rationale: 'listed' })]),
    secondary: scriptedProvider('gemini', [JSON.stringify({ label: 'neutral', rationale: 'listed' })]),
  });
  // The common case must keep the exact shape every existing consumer reads —
  // a diagnostic field on every clean cell would bloat a year of summaries.
  assert.strictEqual(clean.slots, undefined);
  assert.strictEqual(clean.confidence, 'high');
});

/**
 * lib/report/model-change.js — the MODEL axis of a run-over-run comparison.
 *
 * WHY THESE ASSERTIONS AND NOT OTHERS
 * The module exists because a report told a customer a false causal story: the
 * index fell 18 points, five answers were "lost", and six competitors were named
 * as having taken the space — while four of those five answers had been measured
 * on a different model than the run they were compared against. So the tests
 * that matter are (a) the classifier distinguishes a product-line swap from a
 * minor version step, because those explain very different amounts of movement,
 * (b) "no overlap at all" is reported as its own state rather than folded into
 * "changed", and (c) the delta SURVIVES — the founder's ruling is that a
 * customer is always shown their own movement, so a regression that turned this
 * into a `coverageAllowsDelta`-style refusal must go red.
 *
 * R37 (E2E-first) justification: these are pure functions over plain objects
 * with no UI surface — the exact "non-lying unit" carve-out. The rendered
 * surface is covered separately in test/section-run-comparison.test.js, and the
 * whole chain runs against the REAL captured run pair in
 * test/e2e/report-model-change.test.js.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseModelId, classifyModelChange, modelsByProvider, buildModelChanges,
  formatModelTransition,
  CHANGE_NONE, CHANGE_SNAPSHOT, CHANGE_MINOR, CHANGE_GENERATION, CHANGE_LINE,
  CHANGE_SURFACE, CHANGE_UNKNOWN,
} from '../lib/report/model-change.js';

test('parseModelId splits vendor / version / variant across all three naming conventions', () => {
  assert.deepEqual(parseModelId('gpt-5.4-mini'), {
    vendor: 'gpt', major: 5, minor: 4, variant: 'mini', snapshot: null,
  });
  // A dated snapshot is never part of the variant — otherwise every OpenAI
  // pointer would read as a different product from its own pinned build.
  assert.deepEqual(parseModelId('gpt-5.4-mini-2026-03-17'), {
    vendor: 'gpt', major: 5, minor: 4, variant: 'mini', snapshot: '2026-03-17',
  });
  // OpenAI's 5.6 line has NAMES where the size suffix used to be.
  assert.deepEqual(parseModelId('gpt-5.6-luna'), {
    vendor: 'gpt', major: 5, minor: 6, variant: 'luna', snapshot: null,
  });
  // Anthropic puts the family first and splits the version across two tokens.
  assert.deepEqual(parseModelId('claude-haiku-4-5'), {
    vendor: 'claude', major: 4, minor: 5, variant: 'haiku', snapshot: null,
  });
  // Google, plus a multi-token tier.
  assert.deepEqual(parseModelId('gemini-3.1-flash-lite'), {
    vendor: 'gemini', major: 3, minor: 1, variant: 'flash-lite', snapshot: null,
  });
  // No version at all is legitimate (Perplexity), and must not throw.
  assert.deepEqual(parseModelId('sonar-reasoning-pro'), {
    vendor: 'sonar', major: null, minor: null, variant: 'reasoning-pro', snapshot: null,
  });
  // `gpt-4o`'s trailing letter belongs to the variant, not the number.
  assert.equal(parseModelId('gpt-4o').major, 4);
  assert.equal(parseModelId('gpt-4o').variant, 'o');
  assert.equal(parseModelId(''), null);
  assert.equal(parseModelId(null), null);
});

test('classifyModelChange — a product-line swap outranks the version numbers', () => {
  // THE case. Same brand, same three questions, same day (2026-08-13):
  // gpt-5-search-api answered 3/3 with 8.5k/6.5k/6.7k-char answers;
  // gpt-5.4-mini answered 1/3 with 2.7k/2.6k/1.8k. A "minor version step" is
  // the wrong description of that, and would understate the caveat the report
  // prints next to an 18-point drop.
  const c = classifyModelChange('gpt-5-search-api', 'gpt-5.4-mini');
  assert.equal(c.kind, CHANGE_LINE);
  assert.equal(c.strength, 'strong');
});

test('classifyModelChange — same family + tier, minor step is MODERATE, not strong', () => {
  // 2026-08-13, same day, same questions: 3.5-flash 11/26/0 mentions vs
  // 3.6-flash 3/9/0. Density moved; every yes/no verdict held. Calling that
  // "strong" would let a real presence loss hide behind the caveat.
  const c = classifyModelChange('gemini-3.5-flash', 'gemini-3.6-flash');
  assert.equal(c.kind, CHANGE_MINOR);
  assert.equal(c.strength, 'moderate');
});

test('classifyModelChange — a missing version is NOT a generation change', () => {
  // Anthropic has historically shipped family-only dated ids
  // (`claude-sonnet-2026-04-19`) alongside semver-like ones — the convention
  // discover.js's own recency sort is written to survive. Those parse to
  // `major: null`, and a naive `a.major !== b.major` reads `null !== 4` as
  // true, manufacturing a confident "generation change, strong" out of a
  // missing field. The report would then blame a strong instrument swap for
  // movement that may have none.
  const c = classifyModelChange('claude-sonnet-2026-04-19', 'claude-sonnet-4-6');
  assert.equal(c.kind, CHANGE_UNKNOWN);
  assert.notEqual(c.kind, CHANGE_GENERATION);
});

test('classifyModelChange — pasted ↔ API is a SURFACE change, not an unparseable one', () => {
  // `manual` is our own sentinel for a human-pasted app answer, not a vendor
  // id. Parsed as a model it comes out `unknown`, and the report would then
  // describe a change of measurement METHOD with the copy written for "we
  // could not tell how big this was" — or, worse, with the "smaller step
  // within the same model family" wording that shares its strength band.
  const c = classifyModelChange('manual', 'claude-sonnet-5');
  assert.equal(c.kind, CHANGE_SURFACE);
  assert.equal(c.strength, 'strong');
  assert.equal(classifyModelChange('sonar-reasoning-pro', 'manual').kind, CHANGE_SURFACE);
  // Both sides manual is still no change at all — the common case for the
  // Claude and Perplexity columns.
  assert.equal(classifyModelChange('manual', 'manual').kind, CHANGE_NONE);
});

test('classifyModelChange — generation step, snapshot pin, identity, unknown', () => {
  assert.equal(classifyModelChange('gemini-3.7-flash', 'gemini-4.0-flash').kind, CHANGE_GENERATION);
  assert.equal(classifyModelChange('gpt-5.4-mini', 'gpt-5.4-mini-2026-03-17').kind, CHANGE_SNAPSHOT);
  assert.equal(classifyModelChange('gpt-5.4-mini', 'gpt-5.4-mini-2026-03-17').strength, 'negligible');
  assert.equal(classifyModelChange('manual', 'manual').kind, CHANGE_NONE);
  assert.equal(classifyModelChange('gpt-5.4-mini', 'gemini-3.7-flash').kind, CHANGE_UNKNOWN);
  assert.equal(classifyModelChange(null, 'gpt-5.4-mini').kind, CHANGE_UNKNOWN);
});

test('modelsByProvider reads the pre-2026-09 shape too, and skips training cells', () => {
  const snap = { results: [
    // Old runs carry only `model`; a comparison blind to those would be blind
    // on exactly the historical pairs this feature is needed for.
    { provider: 'openai', model: 'gpt-5-search-api', mode: 'web' },
    { provider: 'gemini', model: 'gemini-3.5-flash', requestedModel: 'gemini-3.5-flash', mode: 'web' },
    // `--depth=full` measures the training pass on a deliberately different
    // base model — counting it would report a swap on every full run.
    { provider: 'openai', model: 'gpt-5.4', mode: 'training' },
  ]};
  const byProvider = modelsByProvider(snap);
  assert.deepEqual([...byProvider.get('openai')], ['gpt-5-search-api']);
  assert.deepEqual([...byProvider.get('gemini')], ['gemini-3.5-flash']);
});

test('buildModelChanges — the real 2026-08-13 → 2026-09-01 TypelessForm pair', () => {
  const prev = { results: [
    { provider: 'openai', model: 'gpt-5-search-api', mode: 'web' },
    { provider: 'gemini', model: 'gemini-3.5-flash', mode: 'web' },
    { provider: 'anthropic', model: 'manual' },
    { provider: 'perplexity', model: 'manual' },
  ]};
  const curr = { results: [
    { provider: 'openai', model: 'gpt-5.4-mini', mode: 'web' },
    { provider: 'gemini', model: 'gemini-3.7-flash', mode: 'web' },
    { provider: 'anthropic', model: 'manual' },
    { provider: 'perplexity', model: 'manual' },
  ]};
  const changes = buildModelChanges(prev, curr);

  assert.deepEqual(changes.changedProviders, ['gemini', 'openai']);
  // Both are eligible to explain movement; the manual columns are not changes
  // at all and must not dilute the flag.
  assert.deepEqual(changes.explanatoryProviders, ['gemini', 'openai']);
  // NOT the same statement as "changed": neither engine measured a single
  // answer on the same model twice, so nothing on them is like-for-like. The
  // findings insist this be named rather than folded in.
  assert.deepEqual(changes.noOverlapProviders, ['gemini', 'openai']);
  assert.equal(changes.hasExplanatoryChange, true);

  const openai = changes.entries.find((e) => e.provider === 'openai');
  assert.equal(openai.kind, CHANGE_LINE);
  assert.equal(formatModelTransition(openai), 'gpt-5-search-api → gpt-5.4-mini');
  const anthropic = changes.entries.find((e) => e.provider === 'anthropic');
  assert.equal(anthropic.changed, false);
});

test('buildModelChanges — a provider present in only one run is not an instrument swap', () => {
  // That is a coverage change, already reported by the segment model as
  // `indeterminate`. Reporting it here too would double-count it and would
  // attach a model caveat to cells that simply were not measured.
  const prev = { results: [{ provider: 'openai', model: 'gpt-5.4-mini', mode: 'web' }] };
  const curr = { results: [
    { provider: 'openai', model: 'gpt-5.4-mini', mode: 'web' },
    { provider: 'gemini', model: 'gemini-3.7-flash', mode: 'web' },
  ]};
  assert.deepEqual(buildModelChanges(prev, curr).changedProviders, []);
});

test('buildModelChanges — same engine held: no change, and a like-for-like exists', () => {
  const snap = { results: [{ provider: 'openai', model: 'gpt-5.6-luna', mode: 'web' }] };
  const changes = buildModelChanges(snap, snap);
  assert.deepEqual(changes.changedProviders, []);
  assert.equal(changes.hasExplanatoryChange, false);
  assert.equal(changes.entries[0].hasLikeForLike, true);
});

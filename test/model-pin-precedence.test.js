/**
 * lib/config.js — `--<provider>-model` must OUTRANK live model discovery.
 *
 * THE DEFECT THIS PINS
 * `--help` promised "Override providers.openai.model for this run". The run
 * loop read `r.models ?? (r.cfg.model ? [r.cfg.model] : null)`, and
 * `applyCliModelOverrides` writes the flag into `cfg.model` — so on any run
 * where discovery SUCCEEDED, `r.models` was non-empty, the `??` never reached
 * `cfg.model`, and the flag did nothing. It worked in exactly one situation:
 * when discovery had already failed.
 *
 * That is not a cosmetic bug. Re-measuring an earlier month like-for-like is
 * the whole reason the flag exists, and a documented flag that silently does
 * nothing costs a paid run to discover — which is how it was found, on
 * 2026-09-01, after two billed TypelessForm runs returned identical results.
 *
 * R37 (E2E-first) justification: `resolveRunModels` is a pure decision function
 * over three strings, with no UI surface and no I/O — the "non-lying unit"
 * carve-out. It is the same house pattern as lib/providers/model-drift.js: the
 * run loop is a thin caller of a unit-tested atom. The wiring itself (flag →
 * request → refusal on a dead pin) is covered end-to-end against the real CLI
 * in test/e2e/model-pin-beats-discovery.test.js.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyCliModelOverrides, cliModelPins, cliClassifyPins, resolveRunModels, resolveClassifyChoice, lastRunModelFromSummary,
} from '../lib/config.js';

test('cliModelPins reports only what the operator actually typed', () => {
  assert.deepEqual(
    cliModelPins({ openaiModel: 'gpt-5-search-api', geminiModel: undefined }),
    { openai: 'gpt-5-search-api' },
  );
  assert.deepEqual(cliModelPins({}), {});
  // An empty string is not a pin — `--openai-model=` must not silently blank
  // the model and take the "none" branch.
  assert.deepEqual(cliModelPins({ openaiModel: '' }), {});
});

test('a pin BEATS a successful discovery — the whole point of the flag', () => {
  const r = resolveRunModels({
    pinnedModel: 'gpt-5-search-api',
    discovered: ['gpt-5.6-luna'],   // discovery succeeded and disagrees
    cfgModel: 'gpt-5.4-mini',
  });
  assert.deepEqual(r.models, ['gpt-5-search-api']);
  assert.equal(r.source, 'cli-pin');
});

test('without a pin, discovery still walks a stale config forward', () => {
  // The pin must not be implemented by disabling discovery: overriding a stale
  // config pin is exactly what discovery is FOR (a config file outlives the
  // model it names — Google retired the whole gemini-2.5 generation under
  // seven live configs on 2026-08-13).
  const r = resolveRunModels({ discovered: ['gemini-3.7-flash'], cfgModel: 'gemini-3.5-flash' });
  assert.deepEqual(r.models, ['gemini-3.7-flash']);
  assert.equal(r.source, 'discovery');
});

test('discovery silence falls through to the config, then to nothing', () => {
  assert.deepEqual(
    resolveRunModels({ discovered: null, cfgModel: 'gemini-3.5-flash' }),
    { models: ['gemini-3.5-flash'], source: 'config' },
  );
  // An empty array is discovery answering "nothing usable", not answering.
  assert.deepEqual(
    resolveRunModels({ discovered: [], cfgModel: 'gemini-3.5-flash' }),
    { models: ['gemini-3.5-flash'], source: 'config' },
  );
  assert.deepEqual(resolveRunModels({}), { models: null, source: 'none' });
});

test('applyCliModelOverrides still writes the flag into the config it is given', () => {
  // The two functions are deliberately separate — but the mutation must keep
  // working, because downstream single-run consumers read providers.<n>.model.
  const config = { providers: { openai: { model: 'gpt-5.6-luna' } } };
  applyCliModelOverrides(config, { openaiModel: 'gpt-5-search-api' });
  assert.equal(config.providers.openai.model, 'gpt-5-search-api');
  // A provider absent from the config is skipped rather than invented.
  const bare = { providers: {} };
  applyCliModelOverrides(bare, { geminiModel: 'gemini-3.7-flash' });
  assert.deepEqual(bare.providers, {});
});

// ─── The newest generation ships no recognised cheap tier (2026-10-13) ───────
// Pure decision functions — same R37 carve-out as above; the wiring (a real run
// that reads its own last summary, refuses before a paid call, labels its
// source) is end-to-end in test/e2e/run-model-selection-safety.test.js.

test('discoveryUnsafe: the pick is not taken — last run, then config, then a refusal', () => {
  const base = { discovered: ['gpt-6.1-sol'], discoveryUnsafe: true };
  assert.deepEqual(
    resolveRunModels({ ...base, lastRunModel: 'gpt-6-luna', cfgModel: 'gpt-5-search-api' }),
    { models: ['gpt-6-luna'], source: 'last-run' },
    'the project\'s last run outranks the config: they disagree in practice',
  );
  assert.deepEqual(
    resolveRunModels({ ...base, cfgModel: 'gpt-5.6-luna' }),
    { models: ['gpt-5.6-luna'], source: 'config' },
  );
  assert.deepEqual(
    resolveRunModels(base),
    { models: null, source: 'none', refused: 'no-cheap-tier' },
  );
});

test('rejectedIds: a CONFIG model that is the turned-down pick is refused; a LAST-RUN model that is it is kept and flagged', () => {
  const base = { discovered: ['gpt-6.1-sol'], discoveryUnsafe: true, rejectedIds: ['gpt-6.1-sol'] };
  // config == the flagship: not taken — and the caller is told why (it can name the flag).
  assert.deepEqual(
    resolveRunModels({ ...base, cfgModel: 'gpt-6.1-sol' }),
    { models: null, source: 'none', refused: 'no-cheap-tier', configIsRejectedPick: true },
  );
  // last run == the flagship: kept (an earlier run was pinned to it on purpose),
  // with `isRejectedPick` so the log can say the model SENT is that id.
  assert.deepEqual(
    resolveRunModels({ ...base, lastRunModel: 'gpt-6.1-sol', cfgModel: 'gpt-5.6-luna' }),
    { models: ['gpt-6.1-sol'], source: 'last-run', isRejectedPick: true },
  );
  // last run != the flagship: no flag, ordinary last-run.
  assert.deepEqual(
    resolveRunModels({ ...base, lastRunModel: 'gpt-6-luna' }),
    { models: ['gpt-6-luna'], source: 'last-run' },
  );
  // A config model of the same rejected GENERATION (any id in the pool) is out too.
  assert.deepEqual(
    resolveRunModels({ discovered: ['gpt-6.1-sol'], discoveryUnsafe: true, rejectedIds: ['gpt-6.1-sol', 'gpt-6.1-x'], cfgModel: 'gpt-6.1-x' }),
    { models: null, source: 'none', refused: 'no-cheap-tier', configIsRejectedPick: true },
  );
  // A config model that is something else is the fallback, as before.
  assert.deepEqual(
    resolveRunModels({ ...base, cfgModel: 'gpt-5.6-luna' }),
    { models: ['gpt-5.6-luna'], source: 'config' },
  );
});

test('discoveryUnsafe never overrides a pin, and is inert when discovery was safe', () => {
  assert.deepEqual(
    resolveRunModels({ pinnedModel: 'gpt-6.1-sol', discovered: ['gpt-6.1-sol'], discoveryUnsafe: true, lastRunModel: 'gpt-6-luna' }),
    { models: ['gpt-6.1-sol'], source: 'cli-pin' },
  );
  assert.deepEqual(
    resolveRunModels({ discovered: ['gpt-6-luna'], discoveryUnsafe: false, lastRunModel: 'gpt-5.6-luna' }),
    { models: ['gpt-6-luna'], source: 'discovery' },
  );
  // Silence from discovery is not "unsafe": the old chain, untouched.
  assert.deepEqual(
    resolveRunModels({ discovered: null, discoveryUnsafe: true, cfgModel: 'gemini-3.5-flash' }),
    { models: ['gemini-3.5-flash'], source: 'config' },
  );
});

test('cliClassifyPins reports only the cheap-tier pins the operator typed', () => {
  assert.deepEqual(cliClassifyPins({ openaiClassifyModel: 'gpt-4.1-mini' }), { openai: 'gpt-4.1-mini' });
  assert.deepEqual(cliClassifyPins({}), {});
  assert.deepEqual(cliClassifyPins({ openaiClassifyModel: '' }), {});
  // `--openai-classify-model` typed without a value arrives as `true` under
  // `strict: false`; it is not a model id.
  assert.deepEqual(cliClassifyPins({ openaiClassifyModel: true }), {});
  // A classify pin is not a main pin.
  assert.deepEqual(cliModelPins({ openaiClassifyModel: 'gpt-4.1-mini' }), {});
});

test('resolveClassifyChoice: pin > safe discovery > config > fallback; refusal only when the catalogue was read', () => {
  const ids = ['gpt-5-nano', 'gpt-4o-mini'];
  const usable = (id) => !/tts|transcribe/.test(id);
  assert.deepEqual(
    resolveClassifyChoice({ pinnedModel: 'gpt-4.1-mini', discovered: ['gpt-4o-mini'], cfgModel: 'gpt-5-nano' }),
    { model: 'gpt-4.1-mini', source: 'cli-pin' });
  assert.deepEqual(
    resolveClassifyChoice({ discovered: ['gpt-4o-mini'], selection: { cheapTier: true, catalogueIds: ids }, cfgModel: 'gpt-5-nano' }),
    { model: 'gpt-4o-mini', source: 'discovery' });
  // No recognised tier → config, checked against the key.
  assert.deepEqual(
    resolveClassifyChoice({ discovered: ['gpt-4o'], selection: { cheapTier: false, catalogueIds: ids }, cfgModel: 'gpt-5-nano', isUsable: usable }),
    { model: 'gpt-5-nano', source: 'config' });
  // Config not on the key → the shipped fallback, if the key lists it.
  assert.deepEqual(
    resolveClassifyChoice({ discovered: null, selection: { cheapTier: false, catalogueIds: ids }, cfgModel: 'gpt-4.1-mini', fallbackModel: 'gpt-5-nano', isUsable: usable }),
    { model: 'gpt-5-nano', source: 'fallback' });
  // Catalogue read, nothing usable anywhere → refusal, not a guess.
  assert.deepEqual(
    resolveClassifyChoice({ discovered: null, selection: { cheapTier: false, catalogueIds: ['gpt-4o-mini-tts'] }, cfgModel: 'gpt-5-nano', fallbackModel: 'gpt-5-nano', isUsable: usable }),
    { model: null, source: 'none', refused: 'no-usable-classify-model', rejected: [] });
  // A config model the key LISTS but the chat filter turns down (the same defect
  // typed into a config file): not taken, and the refusal says it was listed.
  assert.deepEqual(
    resolveClassifyChoice({ discovered: ['gpt-4o'], selection: { cheapTier: false, catalogueIds: ['gpt-4o', 'gpt-4o-mini-tts'] }, cfgModel: 'gpt-4o-mini-tts', fallbackModel: 'gpt-5-nano', isUsable: usable }),
    { model: null, source: 'none', refused: 'no-usable-classify-model', rejected: ['gpt-4o-mini-tts'] });
  // …and with the predicate removed the same input would be taken: the filter,
  // not the catalogue check, is what stands between a config tts id and the run.
  assert.deepEqual(
    resolveClassifyChoice({ discovered: ['gpt-4o'], selection: { cheapTier: false, catalogueIds: ['gpt-4o', 'gpt-4o-mini-tts'] }, cfgModel: 'gpt-4o-mini-tts', fallbackModel: 'gpt-5-nano' }),
    { model: 'gpt-4o-mini-tts', source: 'config' });
  // Catalogue NOT read (network): nothing to check against — the old chain.
  assert.deepEqual(
    resolveClassifyChoice({ discovered: null, selection: null, cfgModel: 'gpt-5-nano', fallbackModel: 'gpt-5-nano' }),
    { model: 'gpt-5-nano', source: 'config' });
});

test('lastRunModelFromSummary: the model the run ASKED for, web cells only, per provider', () => {
  const summary = { results: [
    { provider: 'gemini', model: 'gemini-3.8-flash', mode: 'web' },
    { provider: 'openai', model: 'gpt-5', mode: 'training' },                       // derived id, not asked for
    { provider: 'openai', model: 'gpt-6-luna', requestedModel: 'gpt-6-luna', resolvedModel: 'gpt-6-luna-2026-10-01', mode: 'web' },
  ] };
  assert.equal(lastRunModelFromSummary(summary, 'openai'), 'gpt-6-luna');
  assert.equal(lastRunModelFromSummary(summary, 'gemini'), 'gemini-3.8-flash');
  assert.equal(lastRunModelFromSummary(summary, 'anthropic'), null);
  // Older summaries carry `model` only, and no `mode` on web cells.
  assert.equal(lastRunModelFromSummary({ results: [{ provider: 'openai', model: 'gpt-5.4-mini' }] }, 'openai'), 'gpt-5.4-mini');
  assert.equal(lastRunModelFromSummary({}, 'openai'), null);
  assert.equal(lastRunModelFromSummary(null, 'openai'), null);
});

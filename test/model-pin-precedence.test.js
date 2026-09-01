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

import { applyCliModelOverrides, cliModelPins, resolveRunModels } from '../lib/config.js';

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

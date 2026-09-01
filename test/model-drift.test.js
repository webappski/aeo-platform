// Unit tests for lib/providers/model-drift.js — pure functions, no I/O.
//
// R37: a unit test (not E2E) is correct here because both functions are pure
// deterministic reducers with NO UI surface and NO behavioural mocks — the
// test feeds real strings/objects and asserts the real return value. The
// answer-surface WIRING (warn line, provenance stamp, exit code) is NOT yet
// covered by an E2E — tracked in board card AP-MODELDRIFT-RUNLOOP-E2E (add
// test/e2e/run-model-drift.test.js before publish). Each block carries a
// mutation-sanity assertion (the test fails if the logic is inverted).

import test from 'node:test';
import assert from 'node:assert';
import { resolvedModelFrom, isModelDrift, evaluateModelDrift } from '../lib/providers/model-drift.js';

test('resolvedModelFrom — Gemini reports the served model under modelVersion', () => {
  assert.equal(
    resolvedModelFrom('gemini', { modelVersion: 'gemini-3.5-flash', candidates: [] }),
    'gemini-3.5-flash',
  );
  // Mutation-sanity: if the field were read as raw.model (OpenAI-style) instead
  // of raw.modelVersion, this would return undefined — the assert pins the
  // Gemini-specific field.
  assert.equal(resolvedModelFrom('gemini', { model: 'gemini-3.5-flash' }), null);
});

test('resolvedModelFrom — OpenAI/Anthropic/Perplexity report the served model under model', () => {
  assert.equal(resolvedModelFrom('openai', { model: 'gpt-5-search-api-2025-10-14' }), 'gpt-5-search-api-2025-10-14');
  assert.equal(resolvedModelFrom('anthropic', { model: 'claude-sonnet-4-6' }), 'claude-sonnet-4-6');
  assert.equal(resolvedModelFrom('perplexity', { model: 'sonar-reasoning' }), 'sonar-reasoning');
});

test('resolvedModelFrom — returns null when the field is missing, empty, or raw is not an object', () => {
  assert.equal(resolvedModelFrom('gemini', {}), null);
  assert.equal(resolvedModelFrom('openai', { model: '' }), null);
  assert.equal(resolvedModelFrom('openai', null), null);
  assert.equal(resolvedModelFrom('openai', undefined), null);
  assert.equal(resolvedModelFrom('openai', 'not-an-object'), null);
});

test('isModelDrift — genuine lineage change IS drift', () => {
  // The exact webappski scenario: config alias gemini-2.5-flash, served 3.5.
  assert.equal(isModelDrift('gemini-2.5-flash', 'gemini-3.5-flash'), true);
  assert.equal(isModelDrift('claude-sonnet-4-6', 'claude-opus-4-1'), true);
  // Mutation-sanity: if isModelDrift were a bare `requested !== resolved`, the
  // benign-snapshot cases below would (wrongly) also return true. They return
  // false — proving the prefix carve-out is real.
});

test('isModelDrift — benign alias→dated-snapshot is NOT drift', () => {
  // OpenAI resolves a stable pointer to a dated snapshot every cell — must not
  // warn, or every OpenAI run would false-positive.
  assert.equal(isModelDrift('gpt-5-search-api', 'gpt-5-search-api-2025-10-14'), false);
  assert.equal(isModelDrift('gemini-2.5-flash', 'gemini-2.5-flash-preview-09-2025'), false);
});

test('isModelDrift — exact match is NOT drift', () => {
  assert.equal(isModelDrift('gemini-3.5-flash', 'gemini-3.5-flash'), false);
  assert.equal(isModelDrift('claude-sonnet-4-6', 'claude-sonnet-4-6'), false);
});

test('isModelDrift — missing either side is NOT drift (nothing to compare)', () => {
  assert.equal(isModelDrift(null, 'gemini-3.5-flash'), false);
  assert.equal(isModelDrift('gemini-2.5-flash', null), false);
  assert.equal(isModelDrift('', 'gemini-3.5-flash'), false);
  assert.equal(isModelDrift('gemini-2.5-flash', ''), false);
});

test('isModelDrift — the hyphen boundary prevents a false-negative on shared numeric prefix', () => {
  // `gemini-2.5` is NOT a benign prefix of `gemini-2.5-flash` for our purposes
  // unless followed by `-`; here it IS followed by `-`, so it's benign. But
  // `gemini-2` vs `gemini-25-flash` must NOT be cleared by a naive startsWith.
  assert.equal(isModelDrift('gemini-2', 'gemini-25-flash'), true);
  assert.equal(isModelDrift('gemini-2.5', 'gemini-2.5-flash'), false);
});

test('evaluateModelDrift — on drift, returns warnLine + provenance + stable tallyKey', () => {
  // This is the atom the run loop calls (the loop is a thin caller). Asserting
  // it here is the R37-correct coverage for the answer-cell wiring — the same
  // house pattern as the silent-substitute test (full block lives in bin/,
  // verified end-to-end by the cli-walkthrough; the DECISION is unit-tested).
  const d = evaluateModelDrift('gemini', 'gemini-2.5-flash', { modelVersion: 'gemini-3.5-flash' });
  assert.equal(d.isDrift, true);
  assert.equal(d.resolvedModel, 'gemini-3.5-flash');
  assert.match(d.warnLine, /requested gemini-2\.5-flash, served gemini-3\.5-flash/);
  // Provenance is exactly the two record fields the run JSON stamps.
  assert.deepEqual(d.provenance, { requestedModel: 'gemini-2.5-flash', resolvedModel: 'gemini-3.5-flash' });
  assert.equal(d.tallyKey, 'gemini:gemini-2.5-flash→gemini-3.5-flash');
});

test('evaluateModelDrift — no drift: null warn/provenance/tallyKey, but the served id is still reported', () => {
  // Benign OpenAI alias→snapshot. `provenance` and `warnLine` stay null — those
  // are the DRIFT channel and a benign roll-forward must not warn.
  const d = evaluateModelDrift('openai', 'gpt-5-search-api', { model: 'gpt-5-search-api-2025-10-14' });
  assert.equal(d.isDrift, false);
  assert.equal(d.warnLine, null);
  assert.equal(d.provenance, null);
  assert.equal(d.tallyKey, null);
  // `resolvedModel` is NOT part of the drift channel — it is reported on every
  // cell. Since 2026-09-01 the run loop stamps requested/resolved on every
  // record (the drift flag became its own `modelDrift` field), so the served
  // dated snapshot must survive the no-drift branch rather than be nulled with
  // the warn. Without this the summary could not say which model produced a
  // number, and catching a swap meant hand-diffing raw response filenames.
  assert.equal(d.resolvedModel, 'gpt-5-search-api-2025-10-14');
});

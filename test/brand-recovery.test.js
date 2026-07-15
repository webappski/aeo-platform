/**
 * lib/init/brand-recovery.js — the "brand looks wrong" recovery prompts.
 *
 * Both prompts used to be a bare "Continue anyway? [y/N]" with no way to fix
 * a typo in place (short-brand even called process.exit(0) on decline). These
 * tests drive the prompt functions directly with a scripted fake `ask` —
 * no network/fetchSite mocking needed, since the module owns only the menu
 * + one round of interaction, not the retry loop (that's cmdInit's job).
 */

import test from 'node:test';
import assert from 'node:assert';
import { promptShortBrand, promptBrandNotFound } from '../lib/init/brand-recovery.js';

function scriptedAsk(responses) {
  let i = 0;
  return async (question, defaultValue) => {
    assert.ok(i < responses.length, `unexpected extra ask() call: ${question}`);
    return responses[i++];
  };
}

test('promptShortBrand: Enter (default) picks re-enter, then returns the typed name', async () => {
  const ask = scriptedAsk(['', 'newbrand']);
  const result = await promptShortBrand({ brand: 'ai', ask, useColor: false });
  assert.deepStrictEqual(result, { action: 'reenter', brand: 'newbrand' });
});

test('promptShortBrand: choice "2" continues without asking for a new name', async () => {
  const ask = scriptedAsk(['2']);
  const result = await promptShortBrand({ brand: 'ai', ask, useColor: false });
  assert.deepStrictEqual(result, { action: 'continue' });
});

test('promptShortBrand: re-enter with empty input falls back to the original brand', async () => {
  const ask = scriptedAsk(['1', '   ']);
  const result = await promptShortBrand({ brand: 'ai', ask, useColor: false });
  assert.deepStrictEqual(result, { action: 'reenter', brand: 'ai' });
});

test('promptBrandNotFound: Enter (default) picks re-enter, then returns the typed name', async () => {
  const ask = scriptedAsk(['', 'corrected-brand']);
  const result = await promptBrandNotFound({ brand: 'typoed', fullUrl: 'https://example.com', ask, useColor: false });
  assert.deepStrictEqual(result, { action: 'reenter', brand: 'corrected-brand' });
});

test('promptBrandNotFound: choice "2" requests manual query entry', async () => {
  const ask = scriptedAsk(['2']);
  const result = await promptBrandNotFound({ brand: 'typoed', fullUrl: 'https://example.com', ask, useColor: false });
  assert.deepStrictEqual(result, { action: 'manual' });
});

test('promptBrandNotFound: choice "3" continues with the unmatched brand', async () => {
  const ask = scriptedAsk(['3']);
  const result = await promptBrandNotFound({ brand: 'typoed', fullUrl: 'https://example.com', ask, useColor: false });
  assert.deepStrictEqual(result, { action: 'continue' });
});

test('promptBrandNotFound: re-enter with empty input falls back to the original brand', async () => {
  const ask = scriptedAsk(['1', '']);
  const result = await promptBrandNotFound({ brand: 'typoed', fullUrl: 'https://example.com', ask, useColor: false });
  assert.deepStrictEqual(result, { action: 'reenter', brand: 'typoed' });
});

test('promptBrandNotFound: prints the URL and brand so the user can spot the typo', async () => {
  const originalLog = console.log;
  const lines = [];
  console.log = (...args) => lines.push(args.join(' '));
  try {
    const ask = scriptedAsk(['3']);
    await promptBrandNotFound({ brand: 'typoed', fullUrl: 'https://example.com', ask, useColor: false });
  } finally {
    console.log = originalLog;
  }
  const text = lines.join('\n');
  assert.match(text, /typoed/);
  assert.match(text, /https:\/\/example\.com/);
});

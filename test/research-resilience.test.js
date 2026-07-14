// Tests for init research-provider resilience (v0.2.2+):
//   1) classifyProviderError — billing/auth/rate-limit detection
//   2) formatResearchFailurePanel — actionable output shape, option numbering
// The retry loop itself in bin/aeo-tracker.js isn't directly unit-tested
// (it's embedded in a long CLI pipeline); it's exercised end-to-end by
// manual verification + future integration tests.

import assert from 'node:assert/strict';
import { classifyProviderError, classifyAeoError, errToString, PROVIDER_BILLING_URLS } from '../lib/providers/classify-error.js';
import { formatResearchFailurePanel } from '../lib/init/research-failure-panel.js';
import { formatAllEnginesFailedPanel } from '../lib/errors/all-engines-failed-panel.js';
import { formatUnexpectedErrorPanel } from '../lib/errors/unexpected-error-panel.js';

let passed = 0;
let failed = 0;
const results = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    results.push({ name, ok: true });
  } catch (err) {
    failed++;
    results.push({ name, ok: false, err: err.message });
  }
}

// ─── classifyProviderError ───

test('Anthropic credit balance too low → billing + retryable', () => {
  const err = new Error('Anthropic: Your credit balance is too low to access the Anthropic API.');
  const c = classifyProviderError(err);
  assert.equal(c.category, 'billing');
  assert.equal(c.retryable, true);
  assert.match(c.reason, /billing|balance/i);
});

test('OpenAI quota exceeded → billing + retryable', () => {
  const err = new Error('You exceeded your current quota, please check your plan and billing details.');
  const c = classifyProviderError(err);
  assert.equal(c.category, 'billing');
  assert.equal(c.retryable, true);
});

test('OpenAI 401 Incorrect API key → auth + retryable', () => {
  const err = new Error('401 Incorrect API key provided: sk-proj-xxx.');
  const c = classifyProviderError(err);
  assert.equal(c.category, 'auth');
  assert.equal(c.retryable, true);
});

test('Google Gemini API key not valid → auth + retryable', () => {
  const err = new Error('API key not valid. Please pass a valid API key.');
  const c = classifyProviderError(err);
  assert.equal(c.category, 'auth');
  assert.equal(c.retryable, true);
});

test('Anthropic invalid x-api-key → auth + retryable', () => {
  const err = new Error('authentication_error: invalid x-api-key');
  const c = classifyProviderError(err);
  assert.equal(c.category, 'auth');
  assert.equal(c.retryable, true);
});

test('OpenAI 429 Rate limit → rate-limit + retryable', () => {
  const err = new Error('429 Rate limit reached for gpt-5.4 in organization org-xxx.');
  const c = classifyProviderError(err);
  assert.equal(c.category, 'rate-limit');
  assert.equal(c.retryable, true);
});

test('Gemini Resource exhausted → rate-limit + retryable', () => {
  const err = new Error('Resource has been exhausted (e.g. check quota).');
  const c = classifyProviderError(err);
  assert.equal(c.category, 'rate-limit');
  assert.equal(c.retryable, true);
});

test('TypeError (code bug) → other + NOT retryable', () => {
  const err = new TypeError("Cannot read properties of undefined (reading 'candidates')");
  const c = classifyProviderError(err);
  assert.equal(c.category, 'other');
  assert.equal(c.retryable, false);
});

test('Generic 500 without quota keyword → server-error + NOT retryable (cross-provider)', () => {
  // A bare 500 is a transient server-side hiccup: withRetry gives it a SMALL
  // bounded IN-LOOP retry (not the old 30× storm, not 0), but it stays
  // retryable:false so the init fallback loop does NOT switch providers on it —
  // retrying the same request elsewhere won't reliably help.
  const err = new Error('500 Internal Server Error');
  const c = classifyProviderError(err);
  assert.equal(c.category, 'server-error');
  assert.equal(c.retryable, false);
});

test('String error (not Error instance) → still classifies', () => {
  const c = classifyProviderError('credit balance too low');
  assert.equal(c.category, 'billing');
  assert.equal(c.retryable, true);
});

test('null/undefined → classifies as other without crashing', () => {
  const c1 = classifyProviderError(null);
  const c2 = classifyProviderError(undefined);
  assert.equal(c1.retryable, false);
  assert.equal(c2.retryable, false);
});

test('PROVIDER_BILLING_URLS covers all four providers', () => {
  assert.ok(PROVIDER_BILLING_URLS.openai.startsWith('https://'));
  assert.ok(PROVIDER_BILLING_URLS.anthropic.startsWith('https://'));
  assert.ok(PROVIDER_BILLING_URLS.gemini.startsWith('https://'));
  assert.ok(PROVIDER_BILLING_URLS.perplexity.startsWith('https://'));
});

// ─── formatResearchFailurePanel ───

test('panel shows all attempted providers with reasons', () => {
  const attempts = [
    {
      provider: 'openai', label: 'OpenAI (ChatGPT)', envVar: 'OPENAI_API_KEY_DEV',
      rawError: 'You exceeded your current quota',
      classified: { retryable: true, category: 'billing', reason: 'empty billing balance' },
    },
    {
      provider: 'gemini', label: 'Google (Gemini)', envVar: 'GEMINI_API_KEY_DEV',
      rawError: 'Resource has been exhausted',
      classified: { retryable: true, category: 'rate-limit', reason: 'rate-limit or quota exceeded' },
    },
  ];
  const lines = formatResearchFailurePanel({
    attempts, brand: 'typelessform', domain: 'https://typelessform.com', useColor: false,
  });
  const text = lines.join('\n');
  assert.match(text, /OpenAI \(ChatGPT\)/);
  assert.match(text, /Google \(Gemini\)/);
  assert.match(text, /empty billing balance/);
  assert.match(text, /rate-limit/);
});

test('panel shows top-up URL only for providers that hit billing errors', () => {
  const attempts = [
    {
      provider: 'openai', label: 'OpenAI (ChatGPT)', envVar: 'OPENAI_API_KEY',
      rawError: 'quota', classified: { category: 'billing', reason: 'empty billing' },
    },
    {
      provider: 'gemini', label: 'Google (Gemini)', envVar: 'GEMINI_API_KEY',
      rawError: '429', classified: { category: 'rate-limit', reason: 'rate-limit' },
    },
  ];
  const text = formatResearchFailurePanel({
    attempts, brand: 'x', domain: 'https://x.com', useColor: false,
  }).join('\n');
  assert.match(text, new RegExp(PROVIDER_BILLING_URLS.openai.replace(/[.]/g, '\\.')), 'OpenAI billing URL present (billing error)');
  assert.doesNotMatch(text, new RegExp(PROVIDER_BILLING_URLS.gemini.replace(/[.]/g, '\\.')), 'Gemini billing URL absent (rate-limit, not billing)');
});

test('panel always includes --keywords escape hatch', () => {
  const attempts = [{
    provider: 'openai', label: 'OpenAI (ChatGPT)', envVar: 'OPENAI_API_KEY',
    rawError: 'auth failed', classified: { category: 'auth', reason: 'invalid key' },
  }];
  const text = formatResearchFailurePanel({
    attempts, brand: 'typelessform', domain: 'https://typelessform.com', useColor: false,
  }).join('\n');
  assert.match(text, /--keywords/);
  assert.match(text, /brand=typelessform/);
  assert.match(text, /domain=https:\/\/typelessform\.com/);
});

test('panel shows env -u unset option when 2+ providers attempted', () => {
  const attempts = [
    {
      provider: 'openai', label: 'OpenAI (ChatGPT)', envVar: 'OPENAI_API_KEY_DEV',
      rawError: 'quota', classified: { category: 'billing', reason: 'empty billing' },
    },
    {
      provider: 'gemini', label: 'Google (Gemini)', envVar: 'GEMINI_API_KEY_DEV',
      rawError: '429', classified: { category: 'rate-limit', reason: 'rate-limit' },
    },
  ];
  const text = formatResearchFailurePanel({
    attempts, brand: 'x', domain: 'https://x.com', useColor: false,
  }).join('\n');
  assert.match(text, /env -u OPENAI_API_KEY_DEV/);
});

test('panel omits env -u option when only one provider attempted', () => {
  const attempts = [{
    provider: 'openai', label: 'OpenAI (ChatGPT)', envVar: 'OPENAI_API_KEY',
    rawError: 'x', classified: { category: 'billing', reason: 'empty billing' },
  }];
  const text = formatResearchFailurePanel({
    attempts, brand: 'x', domain: 'https://x.com', useColor: false,
  }).join('\n');
  assert.doesNotMatch(text, /env -u/);
});

test('panel truncates very long raw error messages', () => {
  const longErr = 'x'.repeat(500);
  const attempts = [{
    provider: 'openai', label: 'OpenAI', envVar: 'OPENAI_API_KEY',
    rawError: longErr, classified: { category: 'other', reason: 'unknown' },
  }];
  const text = formatResearchFailurePanel({
    attempts, brand: 'x', domain: 'https://x.com', useColor: false,
  }).join('\n');
  assert.match(text, /\.\.\./);
  assert.ok(text.length < 2000, 'output stays bounded even for very long errors');
});

test('panel produces color-free output when useColor=false', () => {
  const attempts = [{
    provider: 'openai', label: 'OpenAI', envVar: 'OPENAI_API_KEY',
    rawError: 'x', classified: { category: 'auth', reason: 'invalid' },
  }];
  const text = formatResearchFailurePanel({
    attempts, brand: 'x', domain: 'https://x.com', useColor: false,
  }).join('\n');
  assert.doesNotMatch(text, /\x1b\[/, 'no ANSI escape codes in non-color mode');
});

// ─── Environment-category classification (new in 0.2.2) ───

test('ECONNREFUSED via err.code → network + NOT retryable', () => {
  const err = new Error('connect ECONNREFUSED 127.0.0.1:443');
  err.code = 'ECONNREFUSED';
  const c = classifyProviderError(err);
  assert.equal(c.category, 'network');
  assert.equal(c.retryable, false);
});

test('ETIMEDOUT via message only → network + NOT retryable', () => {
  const err = new Error('request to https://api.openai.com timed out (ETIMEDOUT)');
  const c = classifyProviderError(err);
  assert.equal(c.category, 'network');
  assert.equal(c.retryable, false);
});

test('getaddrinfo ENOTFOUND → network', () => {
  const err = new Error('getaddrinfo ENOTFOUND api.openai.com');
  const c = classifyProviderError(err);
  assert.equal(c.category, 'network');
});

test('Cloudflare challenge page → bot-protection', () => {
  const err = new Error('Site returned Cloudflare challenge page (access denied)');
  const c = classifyProviderError(err);
  assert.equal(c.category, 'bot-protection');
  assert.equal(c.retryable, false);
});

test('SSL certificate error → site-fetch', () => {
  const err = new Error('unable to verify the first certificate');
  const c = classifyProviderError(err);
  assert.equal(c.category, 'site-fetch');
});

test('EACCES via err.code → filesystem', () => {
  const err = new Error('permission denied');
  err.code = 'EACCES';
  const c = classifyProviderError(err);
  assert.equal(c.category, 'filesystem');
  assert.match(c.reason, /permission/);
});

test('ENOENT on .aeo-tracker.json → config (not filesystem)', () => {
  const err = new Error('ENOENT: no such file or directory, open \'.aeo-tracker.json\'');
  err.code = 'ENOENT';
  const c = classifyProviderError(err);
  assert.equal(c.category, 'config');
  assert.match(c.reason, /init/);
});

test('ENOSPC → filesystem with "disk full" reason', () => {
  const err = new Error('ENOSPC: no space left on device');
  err.code = 'ENOSPC';
  const c = classifyProviderError(err);
  assert.equal(c.category, 'filesystem');
  assert.match(c.reason, /disk/);
});

test('SyntaxError with .aeo-tracker.json path → config', () => {
  // Only classify as config when the file path is mentioned. Bare JSON
  // SyntaxErrors could equally be a provider returning HTML instead of JSON.
  const err = new SyntaxError('Unexpected token } in .aeo-tracker.json at position 42');
  const c = classifyProviderError(err);
  assert.equal(c.category, 'config');
  assert.match(c.reason, /invalid JSON/);
});

test('Bare SyntaxError (no config path) → other, not config', () => {
  // e.g. provider returned a 5xx HTML page instead of JSON — that's a provider
  // issue, not a config issue. Classifier stays conservative.
  const err = new SyntaxError('Unexpected token < in JSON at position 0');
  const c = classifyProviderError(err);
  assert.equal(c.category, 'other');
});

test('Plain TypeError (real bug) still → other, NOT config', () => {
  const err = new TypeError('cannot read properties of undefined');
  const c = classifyProviderError(err);
  assert.equal(c.category, 'other');
});

test('classifyAeoError is alias for classifyProviderError', () => {
  assert.equal(classifyAeoError, classifyProviderError);
});

test('errToString never returns literal "null" or "undefined" — shows friendly text instead', () => {
  // Regression: earlier version returned `String(null)` = "null" which surfaced
  // in panels as "Error: null", reading like an aeo-tracker bug instead of the
  // real upstream failure. Test the honest behaviour.
  assert.equal(errToString(null),        '(no error details)');
  assert.equal(errToString(undefined),   '(no error details)');
  assert.equal(errToString(''),          '(no error details)');
  assert.equal(errToString(new Error()), '(no error details)');
  assert.equal(errToString({}),          '(no error details)');

  // Happy path — real messages pass through unchanged.
  assert.equal(errToString('plain string'),                 'plain string');
  assert.equal(errToString(new Error('boom')),              'boom');
  assert.equal(errToString({ message: 'object err' }),      'object err');
});

// ─── formatAllEnginesFailedPanel ───

test('all-engines panel groups errors by (provider, model)', () => {
  const errorResults = [
    { provider: 'openai', model: 'gpt-5-search-api', label: 'OpenAI (ChatGPT)', error: 'You exceeded your current quota' },
    { provider: 'openai', model: 'gpt-5-search-api', label: 'OpenAI (ChatGPT)', error: 'You exceeded your current quota' },
    { provider: 'openai', model: 'gpt-5-search-api', label: 'OpenAI (ChatGPT)', error: 'You exceeded your current quota' },
    { provider: 'anthropic', model: 'claude-sonnet-4-6', label: 'Anthropic (Claude)', error: 'credit balance is too low' },
  ];
  const text = formatAllEnginesFailedPanel({
    errorResults, providerConfig: {}, useColor: false,
  }).join('\n');
  // Two engines, not four rows — grouping worked
  const openaiMatches = text.match(/OpenAI \(ChatGPT\)/g) || [];
  assert.ok(openaiMatches.length >= 1 && openaiMatches.length <= 2, 'OpenAI appears once in grouped list (plus maybe in option text)');
  assert.match(text, /3 queries affected/);
  assert.match(text, /1 query affected/);
});

test('all-engines panel shows billing top-up URL when billing error present', () => {
  const errorResults = [
    { provider: 'openai', model: 'gpt-5-search-api', label: 'OpenAI (ChatGPT)', error: 'You exceeded your current quota' },
  ];
  const text = formatAllEnginesFailedPanel({ errorResults, providerConfig: {}, useColor: false }).join('\n');
  assert.match(text, new RegExp(PROVIDER_BILLING_URLS.openai.replace(/[.]/g, '\\.')));
});

test('all-engines panel shows auth guidance with env var name', () => {
  const errorResults = [
    { provider: 'gemini', model: 'gemini-2.5-pro', label: 'Google (Gemini)', error: 'API key not valid' },
  ];
  const text = formatAllEnginesFailedPanel({
    errorResults,
    providerConfig: { gemini: { env: 'MY_GEMINI_KEY' } },
    useColor: false,
  }).join('\n');
  assert.match(text, /Regenerate API keys/);
  assert.match(text, /MY_GEMINI_KEY/);
});

test('all-engines panel always shows fallback "remove engine" option', () => {
  const errorResults = [
    { provider: 'openai', model: 'gpt-5-search-api', label: 'OpenAI', error: 'some unexplained error' },
  ];
  const text = formatAllEnginesFailedPanel({ errorResults, providerConfig: {}, useColor: false }).join('\n');
  assert.match(text, /remove a failing engine from \.aeo-tracker\.json/);
});

// ─── formatUnexpectedErrorPanel ───

test('unexpected panel classifies config SyntaxError correctly', () => {
  // Classifier only treats JSON errors as config when .aeo-tracker.json is
  // explicitly in the message (otherwise it could be an API returning HTML).
  const err = new SyntaxError('Unexpected token } in .aeo-tracker.json at position 42');
  const text = formatUnexpectedErrorPanel({ err, command: 'run', useColor: false }).join('\n');
  assert.match(text, /Config file issue/);
  assert.match(text, /\.aeo-tracker\.json/);
  assert.match(text, /during `aeo-platform run`/);
});

test('unexpected panel classifies network errors', () => {
  const err = new Error('getaddrinfo ENOTFOUND api.openai.com');
  const text = formatUnexpectedErrorPanel({ err, command: 'init', useColor: false }).join('\n');
  assert.match(text, /Network error/);
  assert.match(text, /internet connection/);
});

test('unexpected panel falls back to bug-report link for "other" errors', () => {
  const err = new TypeError('Cannot read properties of undefined');
  const text = formatUnexpectedErrorPanel({ err, command: 'run', useColor: false }).join('\n');
  assert.match(text, /likely a bug/);
  assert.match(text, /github\.com\/webappski\/aeo-platform\/issues/);
});

test('unexpected panel truncates very long error messages', () => {
  const longMsg = 'x'.repeat(500);
  const err = new Error(longMsg);
  const text = formatUnexpectedErrorPanel({ err, useColor: false }).join('\n');
  assert.match(text, /\.\.\./);
});

// ─── Summary ───

for (const r of results) {
  const sym = r.ok ? '✓' : '✗';
  const msg = r.ok ? '' : `: ${r.err}`;
  console.log(`${sym} ${r.name}${msg}`);
}
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

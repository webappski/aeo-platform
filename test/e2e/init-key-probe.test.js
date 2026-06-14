// E2E — init live key-authentication probe (fail-branch #1 + #3,
// AP-FAILBRANCH-REMAINDER). The product must confirm each present key actually
// AUTHENTICATES before init declares success — a right-shaped but revoked /
// typo'd key must fail at INIT with ONE actionable step, never sail through to
// blow up later at `run`.
//
// R37 note (E2E-first, why the decision cases inject `discoverFn`): a real probe
// hits the provider's /v1/models endpoint. We cannot make a live 401 (case a) or
// a live network outage (case b) deterministic in CI without burning a real bad
// key or unplugging the network. The genuine EXTERNAL boundary is the provider
// HTTP layer — which `discoverModels` already isolates into a { models, authError }
// verdict — so the decision logic (probeKeys + summarizeProbe + authFailLines)
// is exercised against an injected `discoverFn` that simulates that boundary.
// This is NOT a behavioural mock of our own code: the functions under test run
// for real; only the network is stood in for. Case (c) `--no-key-check` is a
// REAL spawned-CLI assertion (no injection — proves the probe is not invoked).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnCli, withTmpProject } from './_helpers.js';
import { probeKeys, summarizeProbe, authFailLines } from '../../lib/init/key-probe.js';
import { PROVIDER_LABELS } from '../../lib/init/keys.js';

// ── Case (a): a broken key → one actionable step, hard fail ──
test('KP-a — auth-fail verdict yields exactly ONE actionable step + a fixable env var', async () => {
  const discoverFn = async (provider) =>
    provider === 'openai' ? { models: null, authError: true } : { models: ['m'], authError: false };

  const verdicts = await probeKeys(
    { openai: 'OPENAI_API_KEY', gemini: 'GEMINI_API_KEY' },
    { discoverFn, env: { OPENAI_API_KEY: 'sk-broken-but-right-shape-0000', GEMINI_API_KEY: 'AIzaSyGoodKeyValue000000' } },
  );
  const { authFailed, anyUnreachable, allOk } = summarizeProbe(verdicts);

  assert.equal(authFailed.length, 1, 'exactly the openai key failed auth');
  assert.equal(authFailed[0].provider, 'openai');
  assert.equal(anyUnreachable, false, 'a 401 is NOT unreachable — it is a definite reject');
  assert.equal(allOk, false);

  const lines = authFailLines(authFailed[0], PROVIDER_LABELS);
  // ONE problem statement + ONE fix step — never a wall of options.
  assert.equal(lines.length, 2, 'one problem line + one fix line');
  assert.match(lines[0], /did not authenticate/);
  assert.match(lines[1], /\$OPENAI_API_KEY/, 'fix names the exact env var to update');
  assert.match(lines[1], /aeo-platform init/, 'fix gives the single re-run command');
  assert.match(lines[1], /platform\.openai\.com/, 'fix links the provider key page');
});

// ── Case (b): network down → SILENT degrade, init must NOT fail ──
test('KP-b — unreachable verdict (network/5xx) degrades, never walls a possibly-good key', async () => {
  // Simulate the discoverModels contract for a network failure: models=null,
  // authError=false (exactly what discover.js returns on a timeout/5xx).
  const discoverFn = async () => ({ models: null, authError: false });

  const verdicts = await probeKeys(
    { openai: 'OPENAI_API_KEY' },
    { discoverFn, env: { OPENAI_API_KEY: 'sk-maybe-fine-cant-tell-0000' } },
  );
  const { authFailed, anyUnreachable, allOk } = summarizeProbe(verdicts);

  assert.equal(authFailed.length, 0, 'no auth failure — we just could not reach the provider');
  assert.equal(anyUnreachable, true, 'flagged unreachable → caller degrades silently and continues');
  assert.equal(allOk, false);
});

// ── Case (c): --no-key-check → probe is NOT invoked (real CLI) ──
test('KP-c — init --no-key-check never runs the live probe', async () => {
  await withTmpProject('aeo-no-key-check-', async (dir) => {
    const r = spawnCli(
      ['init', '--yes', '--no-key-check', '--brand=Acme', '--domain=acme.com',
       '--keywords=acme crm software,acme invoicing tool,acme expense tracker'],
      {
        cwd: dir,
        env: {
          OPENAI_API_KEY: 'sk-test-do-not-use-0123456789abcdef0123',
          GEMINI_API_KEY: 'AIzaSyTestDoNotUse0123456789abcdef00',
        },
      },
    );
    const out = `${r.stdout}\n${r.stderr}`;
    // The probe announces itself with this line; --no-key-check must skip it.
    assert.doesNotMatch(out, /Verifying your API key/, 'probe must not run under --no-key-check');
    // And it must NOT fail with an auth-probe error (the whole point of the flag).
    assert.doesNotMatch(out, /did not authenticate/, 'no live auth verdict under --no-key-check');
  });
});

// ── I-4: same-provider multi-candidate disambiguation (no telepathy) ──
test('KP-d — probeKeys gives a per-env-var verdict so the caller can drop a bad candidate', async () => {
  // Two look-alike env vars for openai; only the second authenticates.
  const env = { OPENAI_API_KEY_OLD: 'sk-revoked-000000000000000', OPENAI_API_KEY: 'sk-good-0000000000000000000' };
  const discoverFn = async (provider, apiKey) =>
    apiKey === env.OPENAI_API_KEY ? { models: ['gpt-x'], authError: false } : { models: null, authError: true };

  const v1 = (await probeKeys({ openai: 'OPENAI_API_KEY_OLD' }, { discoverFn, env }))[0];
  const v2 = (await probeKeys({ openai: 'OPENAI_API_KEY' }, { discoverFn, env }))[0];
  assert.equal(v1.status, 'auth-fail', 'the revoked candidate is rejected');
  assert.equal(v2.status, 'ok', 'the good candidate authenticates — caller keeps this one');
});

// ── I-6: parallelism — N keys probe concurrently, not serially ──
test('KP-e — probeKeys runs present keys in parallel (Promise.all), not sequentially', async () => {
  let concurrent = 0;
  let maxConcurrent = 0;
  const discoverFn = async () => {
    concurrent++;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    await new Promise(res => setTimeout(res, 30));
    concurrent--;
    return { models: ['m'], authError: false };
  };
  const env = { A: 'k1', B: 'k2', C: 'k3', D: 'k4' };
  await probeKeys({ openai: 'A', gemini: 'B', anthropic: 'C', perplexity: 'D' }, { discoverFn, env });
  assert.equal(maxConcurrent, 4, 'all four probes were in flight at once (parallel, not serial)');
});

// ── mutation-sanity: the test would CATCH a regression that drops the auth gate ──
test('KP-mutation-sanity — summarizeProbe must distinguish auth-fail from unreachable', () => {
  const authFail = summarizeProbe([{ provider: 'openai', envVar: 'X', status: 'auth-fail' }]);
  const unreachable = summarizeProbe([{ provider: 'openai', envVar: 'X', status: 'unreachable' }]);
  // If a regression collapsed auth-fail into unreachable (the silent-degrade
  // path), this assertion fails — guarding the never-let-a-bad-key-through gate.
  assert.equal(authFail.authFailed.length, 1);
  assert.equal(unreachable.authFailed.length, 0);
  assert.notEqual(authFail.authFailed.length, unreachable.authFailed.length);
});

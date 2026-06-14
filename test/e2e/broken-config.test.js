// E2E — failure branches a real client hits with a broken or absent config
// (AP-FAIL-BRANCHES). The product must answer with ONE plain next step and
// exit 1 — never a bare SyntaxError stack through the top-level panel.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { withTmpProject, spawnCli } from './_helpers.js';

const FAKE_KEYS = {
  OPENAI_API_KEY: 'test-key-do-not-use-real-0123456789abcdef',
  GEMINI_API_KEY: 'test-key-do-not-use-real-0123456789abcdef',
};

test('B1 — run with hand-broken .aeo-tracker.json → one-step message, exit 1, no raw stack', async () => {
  await withTmpProject('aeo-broken-cfg-', async (dir) => {
    writeFileSync(join(dir, '.aeo-tracker.json'), '{ "brand": "acme", "domain": "acme.com", }');
    const r = spawnCli(['run'], { cwd: dir, env: FAKE_KEYS });
    assert.equal(r.status, 1);
    const out = `${r.stdout}\n${r.stderr}`;
    assert.match(out, /JSON syntax error/);
    assert.match(out, /aeo-platform init/);
    assert.doesNotMatch(out, /SyntaxError:/, 'raw parser error must not reach the client');
  });
});

test('B2 — init --queries-only with broken config → same one-step message', async () => {
  await withTmpProject('aeo-broken-cfg-qo-', async (dir) => {
    writeFileSync(join(dir, '.aeo-tracker.json'), '{ not json at all');
    const r = spawnCli(['init', '--queries-only', '--yes'], { cwd: dir, env: FAKE_KEYS });
    assert.equal(r.status, 1);
    const out = `${r.stdout}\n${r.stderr}`;
    assert.match(out, /JSON syntax error/);
    assert.doesNotMatch(out, /SyntaxError:/);
  });
});

test('B3 — run with NO config keeps the classic one-liner', async () => {
  await withTmpProject('aeo-no-cfg-', async (dir) => {
    const r = spawnCli(['run'], { cwd: dir, env: FAKE_KEYS });
    assert.equal(r.status, 1);
    assert.match(`${r.stdout}\n${r.stderr}`, /No \.aeo-tracker\.json found\. Run: aeo-platform init/);
  });
});

test('B4 — --version prints a clean version, never a raw SyntaxError (fail-branch #7)', async () => {
  // --version is exactly the command a user runs to diagnose a broken install.
  // It must reuse the try/catch-guarded TRACKER_VERSION (degrades to 'unknown')
  // rather than re-parsing package.json with no guard.
  const r = spawnCli(['--version']);
  assert.equal(r.status, 0);
  const out = `${r.stdout}\n${r.stderr}`;
  assert.doesNotMatch(out, /SyntaxError:/, 'raw parser error must never reach the user');
  // Non-empty: either a real semver or the graceful 'unknown' sentinel.
  assert.match(r.stdout.trim(), /\S/, '--version must emit something');
});

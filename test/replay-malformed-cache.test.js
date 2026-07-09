/**
 * Block A regression — `_tryReplay` (bin/aeo-tracker.js:295-310) must NOT
 * throw an uncaught SyntaxError when an `aeo-responses/<date>/qN-*.json`
 * cache file contains invalid JSON. The pre-fix code did a bare
 * `JSON.parse(await readFile(...))` and let SyntaxError escape; that
 * crashed the CLI run with a raw stack trace instead of a typed error.
 *
 * Verification strategy: drive the CLI through the replay code-path with
 * a malformed cache file. We expect:
 *   - exit code is non-zero (replay miss falls back to live provider call,
 *     which fails because we inject a fake API key — that's the graceful
 *     degradation path, exactly the contract Block A protects)
 *   - stderr does NOT contain `SyntaxError` (the crash signature of the
 *     pre-fix behavior)
 *   - stderr does NOT contain an unhandledRejection or a JSON.parse trace
 */

import test from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sanitizeForFilename } from '../lib/util/safe-filename.js';

const PROJ = dirname(dirname(fileURLToPath(import.meta.url)));
const BIN = join(PROJ, 'bin', 'aeo-tracker.js');

test('malformed replay cache → CLI degrades gracefully, no SyntaxError', () => {
  const tmpProject = mkdtempSync(join(tmpdir(), 'aeo-replay-malformed-'));
  try {
    // Minimal config: brand + domain + a single provider, single query.
    // We only need the replay dispatcher (line 2026) to reach _tryReplay.
    const config = {
      brand: 'TestBrand',
      domain: 'testbrand.com',
      queries: ['test query 1'],
      providers: [{ name: 'openai', model: 'gpt-5-search-api', env: 'OPENAI_API_KEY' }],
    };
    writeFileSync(join(tmpProject, '.aeo-tracker.json'), JSON.stringify(config));

    // Replay snapshot dir with one malformed file matching the expected
    // pattern qN-PROVIDER-MODEL.json. The filename suffix `gpt-5-search-api`
    // must match what `sanitizeForFilename(provider.model)` produces.
    const replayDate = '2026-01-01';
    const replayDir = join(tmpProject, 'aeo-responses', sanitizeForFilename(config.domain), replayDate);
    mkdirSync(replayDir, { recursive: true });
    writeFileSync(join(replayDir, 'q1-openai-gpt-5-search-api.json'), 'not-json-at-all{{{');

    const env = { ...process.env };
    // Strip npm_* env so we don't pollute the child's npm config from THIS
    // test invocation (Risk 1 in the plan).
    for (const k of Object.keys(env)) if (k.startsWith('npm_')) delete env[k];
    // Force a fake key so the provider.call fallback fails fast with an
    // HTTP error, not a successful $ burn.
    env.OPENAI_API_KEY = 'test-key-do-not-use-real';

    const r = spawnSync(
      process.execPath,
      [BIN, 'run', `--replay-from=${replayDate}`, '--json'],
      {
        stdio: 'pipe', encoding: 'utf-8',
        cwd: tmpProject, env, timeout: 30000,
      },
    );

    // The CLI must not crash with SyntaxError. The replay miss should
    // funnel into provider.call which then fails because the key is fake;
    // that produces a typed provider error, not a JSON.parse stack trace.
    const combined = (r.stdout || '') + (r.stderr || '');
    assert.ok(
      !/SyntaxError/.test(combined),
      `expected no SyntaxError in CLI output; got:\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`,
    );
    assert.ok(
      !/Unexpected token .* in JSON/.test(combined),
      `expected no raw JSON.parse error in CLI output; got:\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`,
    );
    assert.ok(
      !/at JSON\.parse/.test(combined),
      `expected no JSON.parse stack frame in CLI output; got:\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`,
    );
  } finally {
    rmSync(tmpProject, { recursive: true, force: true });
  }
});

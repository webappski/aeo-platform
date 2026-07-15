/**
 * Product fix — `aeo-platform run --replay [--replay-from=DATE]` must SKIP the
 * live `/v1/models` discovery HTTP and build providers from `.aeo-tracker.json`
 * cfg.model directly.
 *
 * Background (PITFALLS.md 2026-05-20):
 * Prior code ran `discoverModels` (HTTP) unconditionally at the top of `run`,
 * BEFORE replay setup. With fake / dev keys, discovery 401-skipped every
 * provider → `activeProviders.length === 0` → `process.exit(1)` at line ~1780.
 * Replay code path was never reached, even though the user explicitly asked
 * for cached responses.
 *
 * Contract this test pins:
 *   1. stdout contains "Replay mode: skipping live model discovery" (new branch fired)
 *   2. stdout does NOT contain "Discovering current models" (live branch did NOT fire)
 *   3. exit code is NOT 1 (i.e. the run reached the per-cell stage; if all
 *      cells then error because the API key is fake, that's exit 3 — that's
 *      OK for THIS contract. Extraction LLM still hits live endpoints; making
 *      replay fully exit-0 would require extraction stubbing too, out of
 *      scope for this fix).
 */

import test from 'node:test';
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { domainStorageSlug } from '../lib/util/domain-storage.js';

const PROJ = dirname(dirname(fileURLToPath(import.meta.url)));
const BIN = join(PROJ, 'bin', 'aeo-tracker.js');

test('--replay skips live model discovery (uses cfg.model from config)', () => {
  const tmpProject = mkdtempSync(join(tmpdir(), 'aeo-replay-skips-disc-'));
  try {
    // Minimal config — single openai provider, three queries with cached
    // validation entries (so runValidationFlow doesn't hit LLM at start).
    const config = {
      brand: 'TestBrand',
      domain: 'testbrand.com',
      queries: [
        'best test brands 2026',
        'top test brand alternatives',
        'test brand vs competitor',
      ],
      providers: {
        openai: {
          model: 'gpt-5',
          classifyModel: 'gpt-5-mini',
          env: 'OPENAI_API_KEY',
        },
      },
      validationCache: [
        { query: 'best test brands 2026', valid: true, confidence: 0.9, search_behavior: 'retrieval-triggered' },
        { query: 'top test brand alternatives', valid: true, confidence: 0.9, search_behavior: 'retrieval-triggered' },
        { query: 'test brand vs competitor', valid: true, confidence: 0.9, search_behavior: 'retrieval-triggered' },
      ],
    };
    writeFileSync(join(tmpProject, '.aeo-tracker.json'), JSON.stringify(config));

    // Replay snapshot — malformed JSON is fine; we're only testing that the
    // run REACHES the per-cell loop (not that any cell succeeds). Filename
    // suffix `gpt-5` must match `sanitizeForFilename(cfg.model)`.
    const replayDate = '2026-01-15';
    const replayDir = join(tmpProject, 'aeo-responses', domainStorageSlug(config.domain), replayDate);
    mkdirSync(replayDir, { recursive: true });
    for (const q of [1, 2, 3]) {
      writeFileSync(join(replayDir, `q${q}-openai-gpt-5.json`), 'not-json-at-all');
    }

    const env = { ...process.env };
    // Strip npm_* so we don't pollute the child's npm config from THIS invocation.
    for (const k of Object.keys(env)) if (k.startsWith('npm_')) delete env[k];
    // Fake keys — would 401 the live `/v1/models` if discovery still ran.
    // After the fix, discovery is skipped → run reaches per-cell stage.
    env.OPENAI_API_KEY = 'test-key-fake';
    env.GEMINI_API_KEY = 'test-key-fake';
    env.TZ = 'UTC';

    const r = spawnSync(
      process.execPath,
      [BIN, 'run', '--replay', `--replay-from=${replayDate}`],
      {
        stdio: 'pipe', encoding: 'utf-8',
        cwd: tmpProject, env, timeout: 60000,
      },
    );

    const stdout = r.stdout || '';
    const stderr = r.stderr || '';
    const combined = stdout + '\n' + stderr;

    // Contract 1: replay branch fired
    assert.ok(
      /Replay mode: skipping live model discovery/.test(combined),
      `expected replay-skip message in output; got:\nstdout:\n${stdout}\nstderr:\n${stderr}`,
    );

    // Contract 2: live discovery branch did NOT fire
    assert.ok(
      !/Discovering current models/.test(combined),
      `expected live-discovery message NOT in output; got:\nstdout:\n${stdout}\nstderr:\n${stderr}`,
    );

    // Contract 3: run did NOT exit 1 with "No API keys found" (the failure
    // mode the PITFALLS.md entry describes). Exit 3 (per-cell errors from
    // fake extraction keys) is acceptable — that's downstream of this fix.
    assert.notStrictEqual(
      r.status, 1,
      `expected exit code !== 1 (replay reached per-cell stage); got exit ${r.status}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
    );
    assert.ok(
      !/No API keys found\. Set at least one:/.test(combined),
      `expected no "No API keys found" error (that's the pre-fix failure mode); got:\nstdout:\n${stdout}\nstderr:\n${stderr}`,
    );
  } finally {
    rmSync(tmpProject, { recursive: true, force: true });
  }
});

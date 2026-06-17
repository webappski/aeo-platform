/**
 * E2E test helpers — shared utilities for `node --test test/e2e/*.test.js`.
 *
 * Replay-mode call sites in bin/aeo-tracker.js (refreshed 2026-06-17 for the
 * AP-MEASURE-SAMPLING-CI trial-aware seam — line numbers approximate, grep to
 * confirm):
 *   ~300     — header comment block documenting replay mode
 *   ~306     — _extractFromRaw (provider-shape unpacker)
 *   ~344     — _tryReplay(qi, provider, srcDate, trialSuffix) — trial-aware read
 *   ~396     — _resolveReplaySource (latest-snapshot resolver)
 *  ~2416     — per-cell replay dispatch inside the run loop (passes trialSuffix)
 *  ~4513     — parseArgs flag definition (replay / replay-from / samples)
 *  ~4643     — argv → options mapping (replay / replayFrom / samples)
 *
 * Trial files: a sampled cell persists `q{n}…-{provider}-{model}.t{trial}.json`;
 * single-shot keeps the suffix-free filename. seedReplayProject copies both
 * verbatim (the rename rule only touches `-search-api.json`).
 *
 * When refactoring replay, sweep ALL of these sites.
 */

import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const BIN = join(REPO_ROOT, 'bin', 'aeo-tracker.js');
export const FIXTURE_ROOT = join(REPO_ROOT, 'test', 'fixtures');
export const FIXTURE_REPLAY_DATE = '2026-05-13';
export { REPO_ROOT };

/**
 * Create an isolated temp project directory, run `fn(tmpDir)`, and always
 * clean up the directory in `finally`. Async-aware — awaits the callback so
 * either sync or async `fn` works.
 */
export async function withTmpProject(prefix, fn) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  try { return await fn(dir); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}

/**
 * Spawn the CLI as a subprocess. Strips inherited npm_* env vars (Risk 1)
 * and injects a fake OPENAI_API_KEY when one is not provided (Risk 2) so
 * accidental live-API hits fail fast with key rejection instead of burning
 * credits.
 *
 * Pass `opts.cwd` to run inside a tmp project; `opts.env` to overlay extra
 * vars; `opts.timeout` to override the 30s default.
 */
export function spawnCli(args, opts = {}) {
  const env = { ...process.env, ...(opts.env || {}) };
  for (const k of Object.keys(env)) {
    if (k.startsWith('npm_')) delete env[k];
  }
  if (!env.OPENAI_API_KEY) env.OPENAI_API_KEY = 'test-key-do-not-use-real';
  // Belt-and-suspenders date determinism (R2.2 in
  // webappski-ops/plans/2026-05-20-aeo-platform-e2e-redesign.md). Product
  // code never reads process.env.TZ directly — it's consumed by Node's
  // Date / Intl runtime — so this is NOT a test-only product hook.
  if (!env.TZ) env.TZ = 'UTC';

  return spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf-8',
    stdio: 'pipe',
    env,
    cwd: opts.cwd,
    timeout: opts.timeout || 30000,
  });
}

/**
 * Spawn an arbitrary subprocess (npm, npx, etc.) with the same env hygiene
 * as `spawnCli`. Used by `installFromPack` which needs to invoke `npm`.
 */
export function spawnProc(cmd, args, opts = {}) {
  const env = { ...process.env, ...(opts.env || {}) };
  for (const k of Object.keys(env)) {
    if (k.startsWith('npm_')) delete env[k];
  }
  return spawnSync(cmd, args, {
    encoding: 'utf-8',
    stdio: 'pipe',
    env,
    cwd: opts.cwd,
    timeout: opts.timeout || 120000,
  });
}

/**
 * Assert exit code with verbose diagnostics. spawnSync result mismatches are
 * notoriously hard to debug from a bare `assert.equal(r.status, 0)` — surface
 * stdout/stderr in the error message so the failure is self-explaining.
 */
export function assertExitCode(result, expected, msg = '') {
  if (result.status !== expected) {
    const where = msg ? ` (${msg})` : '';
    const err = new Error(
      `expected exit code ${expected}, got ${result.status}${where}\n` +
      `--- stdout ---\n${result.stdout || '(empty)'}\n` +
      `--- stderr ---\n${result.stderr || '(empty)'}\n`,
    );
    throw err;
  }
}

/**
 * Install a pre-packed tarball into `intoDir`. Uses --ignore-scripts to avoid
 * the prepublishOnly recursion (Risk 5: the package's prepublishOnly runs
 * `npm test`, which would re-enter the E2E suite and loop indefinitely).
 *
 * `npm install` requires a package.json in cwd — create a stub first.
 */
/**
 * Seed a tmp project for replay-mode E2E tests.
 *
 * Copies a fixture variant (stable/regression/all-invisible/malformed) into
 * `<tmpDir>/aeo-responses/<date>/`. Writes a minimal `.aeo-tracker.json` that
 * declares one openai provider on the `gpt-5` (90k TPM) model — explicitly NOT
 * `gpt-5-search-api` (6k TPM) which would trip the scheduler pacing trap and
 * stall each test by 60s (see PITFALLS 2026-05-19 entry 5). The companion
 * fixture files in stable/regression/all-invisible directories are renamed
 * on the way in: any `q{N}-openai-gpt-5-search-api.json` is copied as
 * `q{N}-openai-gpt-5.json`. `_extractFromRaw` reads only `choices[0]…` /
 * `annotations[].url_citation.url` from the JSON body — it ignores the
 * `model` field — so the rename is shape-safe (verified bin/aeo-tracker.js:
 * 257-293 in design plan 2026-05-20 v2).
 *
 * `malformed/` variant ships files containing literally invalid JSON. They
 * cause `_tryReplay` (bin/aeo-tracker.js:295-310) to swallow the
 * SyntaxError and return null — caller falls through to live `provider.call`
 * → fake-key 401 → catch block sets mention='error' → exit 3. Verified
 * end-to-end in Phase 0 manual gate.
 *
 * @param {string} tmpDir  destination project root (from withTmpProject)
 * @param {object} opts
 * @param {('stable'|'regression'|'all-invisible'|'malformed')} opts.variant
 * @param {string} [opts.date]   replay date (default: FIXTURE_REPLAY_DATE)
 * @param {string} [opts.model]  openai model in config (default: 'gpt-5')
 * @param {string[]} [opts.queries]  query list (default: 3-query TestBrand set)
 * @returns {{ replayDate: string, configPath: string }}
 */
export function seedReplayProject(tmpDir, opts = {}) {
  const variant = opts.variant || 'stable';
  const replayDate = opts.date || FIXTURE_REPLAY_DATE;
  const model = opts.model || 'gpt-5';
  const queries = opts.queries || [
    'best test brands 2026',
    'top test brand alternatives',
    'test brand vs competitor',
  ];

  const srcDir = join(FIXTURE_ROOT, 'aeo-responses', variant);
  const destDir = join(tmpDir, 'aeo-responses', replayDate);
  mkdirSync(destDir, { recursive: true });

  // Copy every fixture file EXCEPT `_summary.json`. The summary file in the
  // fixture tree is a captured historical score (50% for `stable/`, 80% for
  // `regression/`, etc.). If we copied it into the replay directory inside
  // the tmp project, the CLI's previous-run lookup at
  // `bin/aeo-tracker.js:2444-2453` would discover it and treat it as the
  // baseline against which today's regenerated summary regresses — false
  // exit-1 from the regression-threshold check. The summary is only useful
  // for downstream `diff`/`export` tests, which inject it explicitly.
  //
  // For openai files captured under `gpt-5-search-api`, rename to the
  // requested `model` filename so the replay seam (keyed on q, provider,
  // model) finds them.
  for (const name of readdirSync(srcDir)) {
    if (name === '_summary.json') continue;
    const src = join(srcDir, name);
    let destName = name;
    if (/^q\d+-openai-gpt-5-search-api\.json$/.test(name)) {
      destName = name.replace('-search-api.json', '.json');
    }
    cpSync(src, join(destDir, destName));
  }

  // Minimal config. One openai provider on a no-pacing model. validationCache
  // pre-populates every query → run skips the LLM validator (which would
  // otherwise hit live API on every test boot).
  const config = {
    brand: 'TestBrand',
    domain: 'testbrand.com',
    queries,
    providers: {
      openai: {
        model,
        classifyModel: 'gpt-5-mini',
        env: 'OPENAI_API_KEY',
      },
    },
    validationCache: queries.map(q => ({
      query: q,
      valid: true,
      confidence: 0.9,
      search_behavior: 'retrieval-triggered',
    })),
  };
  const configPath = join(tmpDir, '.aeo-tracker.json');
  writeFileSync(configPath, JSON.stringify(config, null, 2));

  return { replayDate, configPath };
}

/**
 * Compute today's UTC date in YYYY-MM-DD form. Tests use this to read back
 * report.html / report.md / _summary.json from `aeo-responses/<today>/`
 * AFTER the CLI subprocess finishes (so test process and subprocess share
 * the same UTC second under `TZ=UTC` injection above).
 */
export function todayDateString() {
  return new Date().toISOString().slice(0, 10);
}

export function installFromPack(tarballPath, intoDir) {
  // Minimal stub package.json so `npm install` has a target.
  writeFileSync(join(intoDir, 'package.json'), JSON.stringify({
    name: 'aeo-platform-e2e-host',
    version: '0.0.0',
    private: true,
  }));
  return spawnProc('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', tarballPath], {
    cwd: intoDir,
    timeout: 120000,
  });
}

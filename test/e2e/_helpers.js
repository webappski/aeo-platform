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
import { fileURLToPath, pathToFileURL } from 'node:url';
import { domainStorageSlug } from '../../lib/util/domain-storage.js';
import { degradationsFor } from '../../lib/report/section-degradation.js';
import { queryText } from '../../lib/config/queries-normalize.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const BIN = join(REPO_ROOT, 'bin', 'aeo-tracker.js');
export const FIXTURE_ROOT = join(REPO_ROOT, 'test', 'fixtures');

// When this test helper is loaded as a subprocess preload, fail provider HTTP
// immediately and deterministically. Product code has no test branch/hook.
if (process.env.AEO_E2E_OFFLINE_FETCH === '1') {
  const unauthorized = () => ({
    ok: false,
    status: 401,
    headers: { get: () => null },
    json: async () => ({ error: { message: 'offline E2E fixture' } }),
    text: async () => JSON.stringify({ error: { message: 'offline E2E fixture' } }),
  });
  // Optional model-CATALOGUE stub: `AEO_E2E_CATALOGUE` is a JSON array of
  // OpenAI model ids served from `/v1/models`, so a test can exercise the real
  // discovery + pin-resolution path (which needs a SUCCESSFUL discovery to be
  // meaningful — the pin defect only ever showed itself when discovery worked)
  // while every answer call still fails closed at 401. Absent → unchanged
  // offline behaviour for every existing E2E.
  let catalogue = null;
  try { catalogue = JSON.parse(process.env.AEO_E2E_CATALOGUE || 'null'); }
  catch { catalogue = null; }
  // Optional ANSWER stub: `AEO_E2E_ANSWER` is a JSON body served for OpenAI
  // Responses calls, so a test can drive a whole run to a written
  // `_summary.json` without a live engine. Extraction/classify calls still 401
  // and are swallowed by the extractor (same as the run-manual E2E), which is
  // what keeps the stub to one endpoint instead of a fake OpenAI.
  let answer = null;
  try { answer = JSON.parse(process.env.AEO_E2E_ANSWER || 'null'); }
  catch { answer = null; }
  const okJson = (body) => ({
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
  globalThis.fetch = async (url) => {
    const href = typeof url === 'string' ? url : String(url?.url || url);
    if (Array.isArray(catalogue) && href.includes('/v1/models')) {
      return okJson({ data: catalogue.map((id) => ({ id })) });
    }
    if (answer && href.includes('/v1/responses')) return okJson(answer);
    return unauthorized();
  };
}

// ─── Domain-scoped storage paths ───
// Storage is namespaced by domain: aeo-responses/<slug>/<date>/ and
// aeo-reports/<slug>/<date>/. Tests MUST build read-back paths through these
// helpers (never `join(dir, 'aeo-responses', date)`) so the layout has a single
// source of truth shared with bin/aeo-tracker.js's domainSlug().
export function responsesDateDir(projectDir, domain, date) {
  return join(projectDir, 'aeo-responses', domainStorageSlug(domain), date);
}
export function legacyResponsesDateDir(projectDir, date) {
  return join(projectDir, 'aeo-responses', date);
}
export function reportsDateDir(projectDir, domain, date) {
  return join(projectDir, 'aeo-reports', domainStorageSlug(domain), date);
}
export const FIXTURE_REPLAY_DATE = '2026-05-13';
export { REPO_ROOT };

export function offlineFetchEnv(extra = {}) {
  const preloadUrl = pathToFileURL(fileURLToPath(import.meta.url)).href;
  const nodeOptions = [process.env.NODE_OPTIONS, `--import=${preloadUrl}`].filter(Boolean).join(' ');
  return {
    ...extra,
    NODE_OPTIONS: nodeOptions,
    AEO_NO_RETRY: '1',
    AEO_E2E_OFFLINE_FETCH: '1',
  };
}

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
  const finalCmd = process.platform === 'win32' && cmd === 'npm' ? 'npm.cmd' : cmd;
  return spawnSync(finalCmd, args, {
    encoding: 'utf-8',
    stdio: 'pipe',
    env,
    cwd: opts.cwd,
    shell: process.platform === 'win32',
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
 * declares one openai provider on the `gpt-5` (non-search) model — explicitly
 * NOT `gpt-5-search-api` which hits real OpenAI search endpoints during live
 * replay (fixtures don't stub network calls). The companion fixture files in
 * stable/regression/all-invisible directories are renamed on the way in: any
 * `q{N}-openai-gpt-5-search-api.json` is copied as `q{N}-openai-gpt-5.json`.
 * `_extractFromRaw` reads only `choices[0]…` / `annotations[].url_citation.url`
 * from the JSON body — it ignores the `model` field — so the rename is
 * shape-safe (verified bin/aeo-tracker.js: 257-293 in design plan 2026-05-20 v2).
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
  const domain = opts.domain || 'testbrand.com';
  const queries = opts.queries || [
    'best test brands 2026',
    'top test brand alternatives',
    'test brand vs competitor',
  ];

  const srcDir = join(FIXTURE_ROOT, 'aeo-responses', variant);
  // Domain-namespaced: fixtures land under aeo-responses/<slug>/<date>/ exactly
  // where the domain-scoped replay reader in bin/aeo-tracker.js looks.
  const destDir = opts.legacyLayout
    ? legacyResponsesDateDir(tmpDir, replayDate)
    : responsesDateDir(tmpDir, domain, replayDate);
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

  // Flat legacy reads require a recorded domain so commands can reject
  // cross-brand snapshots deterministically. Keep the source summary minimal:
  // raw replay files remain the behavior under test, not historical score data.
  if (opts.legacyLayout) {
    writeFileSync(join(destDir, '_summary.json'), JSON.stringify({
      date: replayDate,
      brand: 'TestBrand',
      domain,
      score: 0,
      mentions: 0,
      total: 0,
      errors: 0,
      results: [],
      ...(opts.lastFullRun ? { lastFullRun: opts.lastFullRun } : {}),
    }, null, 2));
  }

  // Minimal config. One openai provider on a no-pacing model. validationCache
  // pre-populates every query → run skips the LLM validator (which would
  // otherwise hit live API on every test boot).
  const config = {
    brand: 'TestBrand',
    domain,
    queries,
    providers: {
      openai: {
        model,
        classifyModel: 'gpt-5-mini',
        env: 'OPENAI_API_KEY',
      },
    },
    // Keyed by query TEXT, via the same reader the product uses. A basket entry
    // may be a bare string or `{q, tag, brandFit}`; the validator matches its
    // cache on `verdict.query === candidate.text`, so seeding the raw entry put
    // an OBJECT in that slot for a tagged basket, every lookup missed, and the
    // run fell through to the LIVE validator. Measured 2026-09-21: a tagged-
    // basket probe made a real paid OpenAI call (~$0.0022) because of this line.
    // `spawnCli` only substitutes a fake OPENAI_API_KEY when the environment has
    // none, so on any machine that carries a real key a cache miss here spends
    // money. Read the text; never seed the entry.
    validationCache: queries.map(q => ({
      query: queryText(q),
      valid: true,
      confidence: 0.9,
      search_behavior: 'retrieval-triggered',
    })),
  };
  const configPath = join(tmpDir, '.aeo-tracker.json');
  writeFileSync(configPath, JSON.stringify(config, null, 2));

  return { replayDate, configPath, domain };
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

// ─── Conditional report surfaces (AP-LEAKTEST-BLIND-FIXTURES) ───────────────
//
// A leak denylist checks not what it lists, but what the FIXTURE is able to
// produce. The leak E2Es seeded runs carrying none of the fields that gate the
// report's CONDITIONAL surfaces — no `extractionSources`, no `degraded`, no
// `errorKind`, no `declaredSubsets`, no per-cell `sentiment`, no `modelDrift` /
// `resolvedModel`, no `costTracked:false` — so those surfaces never rendered
// and the denylists never touched them. Whole blocks of client-facing copy were
// green because they were ABSENT, not because they were clean.
//
// This is the one seed that closes that: ONE CELL PER CONDITION, appended to
// whatever results a host test already tuned, so each test's own preconditions
// (the advisory branches in white-label, the cost card in public) stay intact.
//
// `degraded` is NOT hand-written here. It is derived by the SAME
// `degradationsFor()` the live run and the run-manual path call
// (bin/aeo-tracker.js — grep `degradationsFor`), from `extractionSources` /
// `sentiment` shaped exactly as extract-competitors-llm.js and
// sentiment-classify.js write them. A hand-typed `degraded` array would be a
// fixture agreeing with itself.

/** The classify-tier seats a real run records — cross-check grading, not the answer engines. */
const GRADER_PRIMARY = { provider: 'openai', model: 'gpt-5-nano' };
const GRADER_SECONDARY = { provider: 'gemini', model: 'gemini-3.1-flash-lite' };

/**
 * One result cell per conditional surface, built on the host test's own cell
 * shape so nothing else about its run changes.
 *
 * @param {Object} template a representative result row from the host fixture
 * @returns {Array<Object>} cells to append to `summary.results`
 */
export function conditionalSurfaceCells(template) {
  const base = (n, extra) => ({
    ...template,
    query: `C${n}`,
    queryText: `conditional surface probe ${n}`,
    mention: 'no',
    position: null,
    citationCount: 0,
    canonicalCitations: [],
    competitors: [],
    competitorsUnverified: [],
    responseExcerpt: `Conditional surface probe ${n}.`,
    ...extra,
  });

  // C1 — a classify seat that came back unreadable: `extractionSources` with a
  // typed `errorKind`, which is what makes the degradation caveat name a cause.
  const c1Sources = {
    primary: { ...GRADER_PRIMARY, brands: [], error: 'unparseable response', errorKind: 'parse' },
    secondary: { ...GRADER_SECONDARY, brands: ['RivalCo'] },
  };
  // C2 — the seat that failed once and was recovered by a re-ask. Same field,
  // different branch: the caveat's "recovered" half only renders from this.
  const c2Sources = {
    primary: { ...GRADER_PRIMARY, brands: ['RivalCo'], retriedOn: GRADER_SECONDARY.provider },
    secondary: { ...GRADER_SECONDARY, brands: ['RivalCo'] },
  };
  // C3 — a scored cell whose OTHER grading seat was unreachable: carries both a
  // per-cell `sentiment.label` (the sentiment section renders only from this)
  // and `sentiment.slots` with the second typed cause a real run records.
  const c3Sentiment = {
    label: 'negative',
    confidence: 'single-model',
    rationale: 'The answer lists the brand below two rivals.',
    slots: {
      primary: { ...GRADER_PRIMARY },
      secondary: { ...GRADER_SECONDARY, error: 'connection reset', errorKind: 'provider' },
    },
  };

  return [
    base(1, { extractionSources: c1Sources, degraded: degradationsFor({ extractionSources: c1Sources }) }),
    base(2, { extractionSources: c2Sources, degraded: degradationsFor({ extractionSources: c2Sources }) }),
    base(3, {
      mention: 'yes', position: 3,
      sentiment: c3Sentiment,
      degraded: degradationsFor({ sentiment: c3Sentiment }),
    }),
    // C4 — a floating alias served a different model than requested.
    base(4, { resolvedModel: 'gpt-5-search-api-2026-09-01', modelDrift: true }),
    // C5 — a model with no pricing-table entry: its $0 is "not tracked", not free.
    base(5, { costTracked: false, costUsd: 0 }),
  ];
}

/**
 * `summary.declaredSubsets` — an engine that deliberately answered part of the
 * basket. Gates the first block of the representativeness section (markdown
 * only; the HTML report has no site for it).
 */
// Shape checked against the real writer, not invented: run-manual keys the map
// by provider id and fills the stamp's `provider` field with
// `PROVIDERS[name].label` — the DISPLAY name (`Claude`), not the id. The field
// name says id and the value is a label; getting that backwards here would have
// made this fixture agree with itself instead of with the product.
export const CONDITIONAL_DECLARED_SUBSETS = Object.freeze({
  anthropic: {
    name: 'claude-manual-15',
    provider: 'Claude',
    covered: 2,
    total: 5,
    questions: [1, 3],
    warning: 'The subsample was chosen by hand, so it is not a random sample of the basket.',
  },
});

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

/**
 * E2E — `run --replay --replay-from=DATE` across the four exit-code contracts.
 *
 *   P0-5  — stable fixtures → exit 0, _summary.json on disk with non-zero
 *           `score` and a `results[]` array of length 3.
 *   P0-6  — same as P0-5 but specifically pins the exit-0 happy path under
 *           --json mode (silent stdout, machine-readable JSON last line).
 *   P0-7  — all-invisible fixtures → mentions === 0 → exit 2.
 *   P0-8  — stable fixtures with a pre-staged previous-day summary forced
 *           80% → today's 33% regresses by 47pp > threshold(10pp) → exit 1.
 *   P0-9  — malformed fixtures → _tryReplay returns null → live fallback →
 *           fake-key 401 → mention='error' for every cell → exit 3.
 *           Verified end-to-end in Phase 0 manual gate 2026-05-20.
 *   P0-10 — `--force --replay` cache-bust. A pre-staged today-summary
 *           (all-'no', model 'gpt-5') would normally populate skipKeys and
 *           skip every cell. `--force` MUST blow that cache away: existingSummary
 *           stays null, skipKeys=0, every cell is re-served from the offline
 *           replay fixtures, and _summary.json is REWRITTEN with the fresh
 *           replay pattern (Q1='yes'). The offline guarantee is structural —
 *           a COMPLETE openai fixture set (q1/q2/q3-openai-gpt-5.json) + dummy
 *           keys — NOT seam independence: _tryReplay returns null on a missing
 *           OR malformed fixture and falls through to a LIVE provider.call, so a
 *           single absent cell would burn a real API call. We assert zero such
 *           live calls via zero mention='error' (a fake-key live call 401s) AND
 *           we pass explicit dummy keys so a real OPENAI_API_KEY in the runner's
 *           shell can never silently succeed-and-bill.
 *
 * Every test passes BOTH --replay AND --replay-from (PITFALLS entry 4):
 * --replay-from alone is a no-op for the replay code path.
 *
 * The model in `.aeo-tracker.json` is hard-coded to `gpt-5` (90k TPM) by the
 * `seedReplayProject` helper, NOT `gpt-5-search-api` (6k TPM) — the latter
 * would trip the scheduler's 60s/test pacing stall (PITFALLS entry 5).
 */
import test from 'node:test';
import assert from 'node:assert';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  withTmpProject,
  spawnCli,
  assertExitCode,
  seedReplayProject,
  todayDateString,
} from './_helpers.js';

// Extractor needs both OPENAI + GEMINI keys for buildExtractionProviders.
// Both fakes are fine: extractWithTwoModels catches per-provider 401s
// internally and returns empty verified/unverified — the cell's `mention`
// has already been set by detectMention() before extraction runs.
const KEYS = { GEMINI_API_KEY: 'test-key-do-not-use-real' };

test('P0-5 — stable replay run exits 0 and writes _summary.json', async () => {
  await withTmpProject('aeo-e2e-replay-stable-', (dir) => {
    seedReplayProject(dir, { variant: 'stable' });
    const r = spawnCli(
      ['run', '--replay', '--replay-from=2026-05-13'],
      { cwd: dir, env: KEYS },
    );
    assertExitCode(r, 0, 'stable replay should exit 0');
    const summaryPath = join(dir, 'aeo-responses', todayDateString(), '_summary.json');
    assert.ok(existsSync(summaryPath), `expected _summary.json at ${summaryPath}`);
    const summary = JSON.parse(readFileSync(summaryPath, 'utf-8'));
    assert.ok(Array.isArray(summary.results) && summary.results.length === 3,
      `expected 3 results, got ${summary.results?.length}`);
    assert.ok(typeof summary.score === 'number' && summary.score > 0,
      `expected positive score, got ${summary.score}`);
  });
});

test('P0-6 — stable replay --json prints final JSON blob to stdout, exits 0', async () => {
  await withTmpProject('aeo-e2e-replay-json-', (dir) => {
    seedReplayProject(dir, { variant: 'stable' });
    const r = spawnCli(
      ['run', '--replay', '--replay-from=2026-05-13', '--json'],
      { cwd: dir, env: KEYS },
    );
    assertExitCode(r, 0, 'stable replay --json should exit 0');
    // Last non-blank stdout line must be a JSON object whose `exitCode` is 0.
    const lines = r.stdout.trim().split('\n').filter(Boolean);
    // Find the JSON blob — it may span multiple lines (pretty-printed).
    const firstBrace = r.stdout.indexOf('{');
    const jsonText = r.stdout.slice(firstBrace);
    let payload;
    try { payload = JSON.parse(jsonText); }
    catch (e) {
      throw new Error(`stdout did not end with parseable JSON. last lines: ${lines.slice(-5).join(' | ')}`);
    }
    assert.equal(payload.exitCode, 0, '--json blob exitCode field must match process exit');
    assert.ok(Array.isArray(payload.results) && payload.results.length === 3);
  });
});

test('P0-7 — all-invisible fixtures (zero mentions) → exit 2', async () => {
  await withTmpProject('aeo-e2e-replay-invisible-', (dir) => {
    seedReplayProject(dir, { variant: 'all-invisible' });
    const r = spawnCli(
      ['run', '--replay', '--replay-from=2026-05-13'],
      { cwd: dir, env: KEYS },
    );
    assertExitCode(r, 2, 'all-invisible should exit 2 (zero mentions)');
  });
});

test('P0-8 — score regresses by > threshold vs pre-staged previous run → exit 1', async () => {
  await withTmpProject('aeo-e2e-replay-regress-', (dir) => {
    seedReplayProject(dir, { variant: 'stable' });
    // Pre-stage a fake "previous run" with score 80. The CLI's previous-run
    // scan (bin/aeo-tracker.js:2443-2453) picks the LATEST date strictly
    // less than today — so we put the fake summary one day BEFORE the
    // dynamically computed today, NOT before the replay-from date. Using a
    // date below replay-from (e.g. 2020-01-01) would let 2026-05-13/ win
    // the latest-prev sort, and that directory has no _summary.json — the
    // try/catch then swallows the read, previousScore stays null, and the
    // regression check never fires.
    function dayBefore(yyyymmdd) {
      const d = new Date(yyyymmdd + 'T00:00:00Z');
      d.setUTCDate(d.getUTCDate() - 1);
      return d.toISOString().slice(0, 10);
    }
    const prevDate = dayBefore(todayDateString());
    const fakePrevDir = join(dir, 'aeo-responses', prevDate);
    mkdirSync(fakePrevDir, { recursive: true });
    writeFileSync(
      join(fakePrevDir, '_summary.json'),
      JSON.stringify({
        date: prevDate,
        brand: 'TestBrand', domain: 'testbrand.com',
        score: 80, mentions: 8, total: 10, errors: 0,
        regressionThreshold: 10,
        results: [],
      }),
    );
    const r = spawnCli(
      ['run', '--replay', '--replay-from=2026-05-13'],
      { cwd: dir, env: KEYS },
    );
    assertExitCode(r, 1, 'stable score 33 vs prev 80 (delta -47) should exit 1 (regression)');
  });
});

test('P0-9 — malformed fixtures → all cells error → exit 3 (Phase 0 gate)', async () => {
  await withTmpProject('aeo-e2e-replay-malformed-', (dir) => {
    seedReplayProject(dir, { variant: 'malformed' });
    const r = spawnCli(
      ['run', '--replay', '--replay-from=2026-05-13'],
      { cwd: dir, env: KEYS },
    );
    assertExitCode(r, 3, 'malformed fixtures + fake key → all-errored contract → exit 3');
    // The actionable panel should name the failing engine and the env var
    // it reads its key from. Stable substring check; do not over-pin copy.
    assert.match(
      r.stderr, /OPENAI_API_KEY/,
      'all-engines-failed panel should reference $OPENAI_API_KEY for recovery',
    );
  });
});

// Force-mode offline guarantee. spawnCli injects a dummy OPENAI_API_KEY only
// `if (!env.OPENAI_API_KEY)` — so we pass BOTH keys explicitly here (opts.env
// is spread AFTER process.env, overriding it). Without this, a real
// OPENAI_API_KEY in the runner's shell would pass through, and a hypothetical
// fixture miss would make a live call that SUCCEEDS (mention='yes', not
// 'error') — silently billing while the "zero live calls" assertion passes.
const DUMMY_KEYS = {
  OPENAI_API_KEY: 'test-key-do-not-use-real',
  GEMINI_API_KEY: 'test-key-do-not-use-real',
};

test('P0-10 — --force --replay busts today\'s cache, rewrites _summary.json offline', async () => {
  await withTmpProject('aeo-e2e-replay-force-', (dir) => {
    seedReplayProject(dir, { variant: 'stable' });

    // Pre-stage a today-summary that, WITHOUT --force, would populate skipKeys
    // for all 3 openai cells and skip them. The 5-part skipKey is built as
    // `Q{n}::openai:gpt-5:web` (bin/aeo-tracker.js:2020) — so each result must
    // carry query='Q{n}', provider='openai', model='gpt-5' (NOT
    // 'gpt-5-search-api'), mode='web', mention != 'error'. An all-'no' summary
    // means: if --force is (wrongly) ignored, every cell is skipped, the merge
    // block re-injects the 3 'no' cells → mentions=0 → exit 2. With --force
    // honoured, the cache is bypassed, replay re-serves Q1='yes' → exit 0.
    // That contrast is the mutation-sanity discriminator.
    const todayDir = join(dir, 'aeo-responses', todayDateString());
    mkdirSync(todayDir, { recursive: true });
    const sentinelResults = ['Q1', 'Q2', 'Q3'].map((q, i) => ({
      query: q,
      queryText: ['best test brands 2026', 'top test brand alternatives', 'test brand vs competitor'][i],
      provider: 'openai',
      label: 'ChatGPT',
      model: 'gpt-5',
      mode: 'web',
      mention: 'no',
      position: null,
      citationCount: 0,
    }));
    writeFileSync(
      join(todayDir, '_summary.json'),
      JSON.stringify({
        date: todayDateString(),
        brand: 'TestBrand', domain: 'testbrand.com',
        score: 0, mentions: 0, total: 3, errors: 0,
        regressionThreshold: 10,
        _sentinel: 'stale-cache-must-be-overwritten-by-force',
        results: sentinelResults,
      }, null, 2),
    );

    const r = spawnCli(
      ['run', '--force', '--replay', '--replay-from=2026-05-13'],
      { cwd: dir, env: DUMMY_KEYS },
    );
    assertExitCode(r, 0, '--force --replay should re-serve replay (Q1=yes) and exit 0, not skip-all → exit 2');

    // skipKeys must be empty under --force: the CLI must NOT print the
    // "N checks already succeeded today" line. If it does, force was ignored
    // and the cells were served from the stale cache, not from replay.
    assert.doesNotMatch(
      r.stdout + r.stderr, /already succeeded today/,
      '--force must bypass the response cache (skipKeys=0), never reuse today\'s summary',
    );

    const summaryPath = join(todayDir, '_summary.json');
    assert.ok(existsSync(summaryPath), `expected _summary.json at ${summaryPath}`);
    const summary = JSON.parse(readFileSync(summaryPath, 'utf-8'));

    // Sanity that the file is a freshly-built summary object (the writer never
    // carries `_sentinel` forward in either path). NOTE: this alone does NOT
    // discriminate force-respected from force-ignored — the discriminator is
    // the exit-code contract above + the Q1='yes' assertion below.
    assert.ok(!('_sentinel' in summary),
      '_summary.json must be a freshly-built object (sentinel field must not survive)');
    assert.ok(Array.isArray(summary.results) && summary.results.length === 3,
      `expected 3 re-served results, got ${summary.results?.length}`);

    // Zero live calls: a fixture miss falls through to live provider.call,
    // which with the dummy key 401s → mention='error'. Zero errors == the
    // complete fixture set served every cell offline.
    const errors = summary.results.filter(r => r.mention === 'error');
    assert.equal(errors.length, 0,
      `--force --replay must serve every cell offline; ${errors.length} cell(s) fell through to a live call`);

    // Proof of rewrite-from-replay (not from sentinel): Q1 is 'yes' in the
    // replay fixture but 'no' in the sentinel. Seeing 'yes' proves the summary
    // came from the replayed fixtures.
    const yesCells = summary.results.filter(r => r.mention === 'yes');
    assert.ok(yesCells.length >= 1,
      'replay fixture has Q1=yes; a rewritten-from-replay summary must surface it (sentinel was all-no)');
    assert.equal(summary.mentions, yesCells.length,
      'summary.mentions must reflect the re-served replay results, not the stale sentinel');
  });
});

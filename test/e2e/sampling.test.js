/**
 * E2E — AP-MEASURE-SAMPLING-CI plumbing, via offline replay (no live API).
 *
 * Covers the gate caveats that unit tests cannot reach (they need the real run
 * loop, the real per-trial persist seam, and the real scheduler):
 *
 *   T-E2E-1  — R39 byte-identity. `run --replay` (no flag) and
 *              `run --replay --samples 1` produce byte-identical _summary.json
 *              (after normalising only date + timing). Includes an ANTI-GREEDY
 *              normaliser guard: the normaliser must NOT mask a real field
 *              difference (proven by mutating one field and re-comparing).
 *
 *   T-E2E-2  — fractional path end-to-end with DISTINCT per-trial fixtures
 *              (Q1 = yes/no/yes). Proves: 3 different trial files are each read
 *              (not one file replayed 3×), trials.length===3, presence.hits===2,
 *              presence.n===3, rate≈0.667, a Wilson CI is on the record, the
 *              report renders the CI, and sampling.samples===3. This single test
 *              closes BOTH caveat #1 (trial-aware replay seam) and caveat #2
 *              (fractional frequency end-to-end).
 *
 *   T-E2E-pacing — the multi-trial run completes well under the no-pacing-stall
 *              budget (PITFALLS #5). Model is gpt-5 (90k TPM), NOT search-api.
 *
 * All multi-trial work runs on `gpt-5` per the PITFALLS #5 / design constraint.
 */
import test from 'node:test';
import assert from 'node:assert';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  withTmpProject,
  spawnCli,
  assertExitCode,
  seedReplayProject,
  todayDateString,
  BIN,
} from './_helpers.js';

const KEYS = { GEMINI_API_KEY: 'test-key-do-not-use-real' };

/**
 * Normalise the volatile parts of a _summary.json so two runs are comparable.
 * Deliberately NARROW — scrubs ONLY:
 *   - the date stamp,
 *   - per-call wall-clock timings (elapsedMs),
 *   - results[] ORDER (sorted by stable cell key).
 *
 * results[] order has NEVER been deterministic: the scheduler fires cells
 * concurrently and pushes each in completion order, so two single-shot runs
 * already differ only by which replay read resolved first. Order is therefore
 * not part of the data contract; sorting before comparison is the honest
 * normalisation. Everything ELSE (scores, mentions, the per-cell data) must
 * match exactly or the R39 contract is broken. The anti-greedy guard below
 * proves this normaliser does not also mask a real field difference.
 */
function cellKey(r) {
  return `${r.query}|${r.region || ''}|${r.provider}|${r.model}|${r.mode || ''}`;
}
function normaliseSummary(raw) {
  const s = JSON.parse(raw);
  s.date = '<DATE>';
  const scrubTiming = (o) => {
    if (!o || typeof o !== 'object') return;
    for (const k of Object.keys(o)) {
      if (k === 'elapsedMs') o[k] = '<MS>';
      else if (o[k] && typeof o[k] === 'object') scrubTiming(o[k]);
    }
  };
  scrubTiming(s);
  if (Array.isArray(s.results)) {
    s.results = [...s.results].sort((a, b) => cellKey(a).localeCompare(cellKey(b)));
  }
  return JSON.stringify(s, null, 2);
}

test('T-E2E-1 — `--samples 1` is byte-identical to no flag (R39)', async () => {
  let noFlag, samples1;

  await withTmpProject('aeo-e2e-samples-identity-a-', (dir) => {
    seedReplayProject(dir, { variant: 'stable' });
    const r = spawnCli(['run', '--replay', '--replay-from=2026-05-13'], { cwd: dir, env: KEYS });
    assertExitCode(r, 0, 'no-flag replay should exit 0');
    noFlag = readFileSync(join(dir, 'aeo-responses', todayDateString(), '_summary.json'), 'utf-8');
  });

  await withTmpProject('aeo-e2e-samples-identity-b-', (dir) => {
    seedReplayProject(dir, { variant: 'stable' });
    const r = spawnCli(['run', '--replay', '--replay-from=2026-05-13', '--samples', '1'], { cwd: dir, env: KEYS });
    assertExitCode(r, 0, '--samples 1 replay should exit 0');
    samples1 = readFileSync(join(dir, 'aeo-responses', todayDateString(), '_summary.json'), 'utf-8');
  });

  const a = normaliseSummary(noFlag);
  const b = normaliseSummary(samples1);
  assert.equal(a, b, '--samples 1 must produce a byte-identical summary to the single-shot default');

  // No sampling artefacts may appear on the default path.
  const parsed = JSON.parse(samples1);
  assert.ok(!('sampling' in parsed), '--samples 1 must NOT write a sampling block');
  assert.ok(parsed.results.every(r => !('trials' in r)), '--samples 1 must NOT write trials[]');
  assert.ok(parsed.results.every(r => !('presence' in r)), '--samples 1 must NOT write presence{}');

  // ANTI-GREEDY normaliser guard (two probes): the normaliser must scrub ONLY
  // date + timing + result ORDER, never real data.
  //   (1) a top-level score change must surface;
  const tamperedScore = JSON.parse(noFlag);
  tamperedScore.score = (tamperedScore.score ?? 0) + 1;
  assert.notEqual(
    normaliseSummary(JSON.stringify(tamperedScore)),
    a,
    'normaliser is too greedy — it masked a score difference it must surface',
  );
  //   (2) a per-cell mention flip must surface DESPITE the sort (sort reorders
  //       cells, it must not erase a value difference within a cell).
  const tamperedCell = JSON.parse(noFlag);
  tamperedCell.results[0].mention = tamperedCell.results[0].mention === 'yes' ? 'no' : 'yes';
  assert.notEqual(
    normaliseSummary(JSON.stringify(tamperedCell)),
    a,
    'normaliser/sort is too greedy — it masked a per-cell mention difference',
  );
});

test('T-E2E-2 — distinct per-trial fixtures drive the fractional path end-to-end', async () => {
  await withTmpProject('aeo-e2e-samples-fraction-', (dir) => {
    // mixed-trials fixtures: Q1 = yes/no/yes, Q2 = no/no/no, Q3 = yes/yes/yes.
    // gpt-5 model (no rename needed — files are named -gpt-5.t{n}.json).
    seedReplayProject(dir, { variant: 'mixed-trials' });

    const r = spawnCli(
      ['run', '--replay', '--replay-from=2026-05-13', '--samples', '3'],
      { cwd: dir, env: KEYS, timeout: 30000 },
    );
    assertExitCode(r, 0, 'mixed-trials replay --samples 3 should exit 0');

    const summaryDir = join(dir, 'aeo-responses', todayDateString());
    const summary = JSON.parse(readFileSync(join(summaryDir, '_summary.json'), 'utf-8'));

    // Exactly ONE record per cell — the load-bearing invariant.
    assert.equal(summary.results.length, 3, `expected 3 cell records, got ${summary.results.length}`);

    // sampling block records the config.
    assert.equal(summary.sampling?.samples, 3, 'summary.sampling.samples must be 3');

    // Q1 cell: yes/no/yes → 2 of 3 trials are a hit.
    const q1 = summary.results.find(r => r.query === 'Q1');
    assert.ok(q1, 'Q1 record present');
    assert.ok(Array.isArray(q1.trials) && q1.trials.length === 3,
      `Q1 must carry 3 trials, got ${q1.trials?.length}`);
    assert.equal(q1.presence.hits, 2, 'Q1 presence.hits must be 2 (yes/no/yes)');
    assert.equal(q1.presence.n, 3, 'Q1 presence.n must be 3');
    assert.ok(Math.abs(q1.presence.rate - 2 / 3) < 1e-9, `Q1 rate ≈ 0.667, got ${q1.presence.rate}`);
    assert.ok(q1.presence.ci && q1.presence.ci.low < q1.presence.ci.high,
      'Q1 presence carries a non-degenerate Wilson CI');
    // The trial outcomes themselves prove the THREE DISTINCT files were read:
    // a single file replayed 3× would give [yes,yes,yes] (hits 3), not [yes,no,yes].
    const q1Mentions = q1.trials.map(t => t.mention).sort();
    assert.deepEqual(q1Mentions, ['no', 'yes', 'yes'],
      'Q1 trial mentions must be the THREE DISTINCT fixtures (yes/no/yes), not one file ×3');
    // Representative mention is the modal value (2 yes vs 1 no → yes).
    assert.equal(q1.mention, 'yes', 'Q1 representative mention is modal yes');

    // Q2 cell: no/no/no → 0 of 3 hits, representative no.
    const q2 = summary.results.find(r => r.query === 'Q2');
    assert.equal(q2.presence.hits, 0, 'Q2 all-no → 0 hits');
    assert.equal(q2.presence.n, 3);
    assert.equal(q2.mention, 'no');

    // Q3 cell: yes/yes/yes → 3 of 3 hits.
    const q3 = summary.results.find(r => r.query === 'Q3');
    assert.equal(q3.presence.hits, 3, 'Q3 all-yes → 3 hits');
    assert.equal(q3.presence.n, 3);

    // The distinct trial RAW files are on disk (proves the writer used .t{n}).
    const files = readdirSync(summaryDir);
    for (const t of [0, 1, 2]) {
      assert.ok(
        files.includes(`q1-openai-gpt-5.t${t}.json`),
        `expected per-trial raw file q1-openai-gpt-5.t${t}.json on disk; have ${files.join(', ')}`,
      );
    }

    // The report renders the presence CI (additive surface). Generate it and
    // grep for the "trials · …% CI" hint that sampledPresenceHint emits.
    const rep = execFileSync(process.execPath, [BIN, 'report', '--no-open', '--no-html'], {
      cwd: dir, encoding: 'utf-8',
      env: { ...process.env, ...KEYS, TZ: 'UTC' },
    });
    void rep; // report writes to disk; assert on the markdown file
    const reportMd = readFileSync(
      join(dir, 'aeo-reports', todayDateString(), 'report.md'), 'utf-8',
    );
    assert.match(reportMd, /trials/, 'report Presence hint should mention trials when sampled');
    assert.match(reportMd, /CI \[/, 'report Presence hint should render a confidence interval');
    assert.match(reportMd, /trials\/cell/, 'UVI score-block should note trials/cell when sampled');
  });
});

test('T-E2E-resume — same-day re-run with sampling keeps exactly 1 record/cell', async () => {
  // CAVEAT #3: a carried-over record from an earlier run today must NOT create a
  // SECOND record for a cell, which would break the «1 record/cell» invariant
  // the whole feature rests on. Run --samples 3 twice; the second run resumes
  // from the first's summary. Every cell must survive as exactly one (sampled)
  // record — never duplicated, never downgraded.
  await withTmpProject('aeo-e2e-samples-resume-', (dir) => {
    seedReplayProject(dir, { variant: 'mixed-trials' });
    const summaryPath = join(dir, 'aeo-responses', todayDateString(), '_summary.json');

    const r1 = spawnCli(['run', '--replay', '--replay-from=2026-05-13', '--samples', '3'], { cwd: dir, env: KEYS });
    assertExitCode(r1, 0, 'first sampled run should exit 0');
    const s1 = JSON.parse(readFileSync(summaryPath, 'utf-8'));
    assert.equal(s1.results.length, 3, 'first run writes 3 cell records');

    // Second run, SAME day, no --force → resume path merges with s1.
    const r2 = spawnCli(['run', '--replay', '--replay-from=2026-05-13', '--samples', '3'], { cwd: dir, env: KEYS });
    assertExitCode(r2, 0, 'second sampled run (resume) should exit 0');
    const s2 = JSON.parse(readFileSync(summaryPath, 'utf-8'));

    // The invariant: still exactly ONE record per (query, provider, model, mode)
    // — no duplicate cell rows leaked from the merge.
    assert.equal(s2.results.length, 3,
      `resume must keep exactly 3 records (1/cell), got ${s2.results.length}`);
    const keys = s2.results.map(r => `${r.query}:${r.provider}:${r.model}:${r.mode || 'web'}`);
    assert.equal(new Set(keys).size, keys.length, `duplicate cell records after resume: ${keys.join(', ')}`);

    // The carried-over Q1 record must still be the sampled record (trials +
    // presence intact — not downgraded to a single-shot shape).
    const q1 = s2.results.find(r => r.query === 'Q1');
    assert.ok(Array.isArray(q1.trials) && q1.trials.length === 3, 'Q1 keeps its 3 trials after resume');
    assert.equal(q1.presence.n, 3, 'Q1 keeps presence.n=3 after resume');
  });
});

test('T-E2E-pacing — multi-trial replay completes well under the stall budget', async () => {
  await withTmpProject('aeo-e2e-samples-pacing-', (dir) => {
    // 3 trials per cell × 3 cells = 9 offline reads. All fixtures present
    // (.t0..t2) so every trial is served offline — no fake-key live fallback.
    seedReplayProject(dir, { variant: 'mixed-trials' });
    const t0 = Date.now();
    const r = spawnCli(
      ['run', '--replay', '--replay-from=2026-05-13', '--samples', '3'],
      { cwd: dir, env: KEYS, timeout: 30000 },
    );
    const elapsed = Date.now() - t0;
    assertExitCode(r, 0, 'samples=3 mixed-trials replay should exit 0');
    // PITFALLS #5: an inner-loop / wrong-model pacing stall would push a tiny
    // offline replay past ~60s. Offline replay of 9 trials must be near-instant.
    assert.ok(elapsed < 25000, `multi-trial replay took ${elapsed}ms — possible pacing stall (PITFALLS #5)`);
  });
});
